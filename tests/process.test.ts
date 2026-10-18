import test from "node:test";
import assert from "node:assert/strict";
import { indexTurns, type Entry, type Item } from "../shared/model.ts";
import { processRecord, processRows } from "../shared/process.ts";
import { processRpc } from "../shared/contracts.ts";
import { createTurnRuntime } from "../client/runtime.ts";
import { readIndex, readProcess } from "../server/index.ts";
import { parseMarkdown } from "../server/markdown.ts";

const idle = {running: false, pending: false, failed: false, hasOlder: false};
function fixture(items: Item[]) {
  const rows: Entry[] = items.map((item, i) => ({item, seqStart: i + 1, seqEnd: i + 1, timestamp: new Date(1000 * (i + 1)).toISOString(), turnId: "turn"}));
  const index = indexTurns("agent", "epoch", rows, idle);
  const agent = {timeline: {refetch: async (input: {limit: number}) => ({epoch: "epoch", entries: input.limit === 1 ? rows.slice(-1) : rows,
    hasOlder: false, endCursor: {seq: rows.at(-1)!.seqEnd}})}, refresh: async () => ({agent: {status: "idle", pendingPermissions: [], activeTurn: null}})};
  const context = {paseo: {agents: {ref: (id: string) => {assert.equal(id, "agent"); return agent;}}}} as any;
  return {rows, index, agent, context};
}
const input: Item[] = [{type: "user_message", text: "Request"}, {type: "assistant_message", messageId: "progress", text: "**Checking** `code`"},
  {type: "tool_call", callId: "tool", name: "exec_command", status: "completed", detail: {type: "shell", command: "pwd", cwd: "/workspace", output: "Result"}},
  {type: "assistant_message", messageId: "final", text: "Final answer"}];

test("inline expansion never replaces outer rows or re-registers transformers", async () => {
  const f = fixture(input); let registrations = 0, removals = 0, reads = 0;
  const transforms = new Map<string, any>();
  const runtime = createTurnRuntime({rpc: async (rpc: any) => {reads++; assert.equal(rpc.name, "turns.index"); return {status: "ok", ...f.index};},
    addTimelineTransformer: (value: any) => {registrations++; transforms.set(value.query.itemType, value); return () => {removals++;};}} as any, true);
  await runtime.refresh("agent");
  const original = transforms.get("assistant_message"), payload = original.transform({item: input[1], phase: "complete"});
  let notifications = 0; const stop = runtime.subscribe(f.index.groups[0].id, () => notifications++);
  for (let i = 0; i < 50; i++) runtime.toggle(f.index.groups[0].id);
  assert.equal(registrations, 4); assert.equal(removals, 0); assert.equal(reads, 1); assert.equal(notifications, 50);
  assert.equal(transforms.get("assistant_message"), original); assert.deepEqual(original.transform({item: input[1], phase: "complete"}), payload);
  assert.deepEqual(transforms.get("tool_call").transform({item: input[2], phase: "complete"}), {items: []});
  assert.equal(original.transform({item: input[3], phase: "complete"}), undefined);
  stop(); runtime.dispose(); assert.equal(removals, 4);
});
test("inline global controls notify existing blocks while leaving the projection untouched", async () => {
  const f = fixture(input); let registrations = 0, updates = 0;
  const runtime = createTurnRuntime({rpc: async () => ({status: "ok", ...f.index}), addTimelineTransformer: () => {registrations++; return () => {};}} as any, true);
  await runtime.refresh("agent"); const id = f.index.groups[0].id;
  runtime.subscribe(id, () => updates++); runtime.toggleAgent("agent"); assert.equal(runtime.isExpanded(id), true);
  runtime.toggleAgent("agent"); assert.equal(runtime.isExpanded(id), false); assert.equal(updates, 2); assert.equal(registrations, 4); runtime.dispose();
});
test("process pages are scoped to a proven completed turn and exclude final and user text", async () => {
  const f = fixture(input), groupId = f.index.groups[0].id;
  const result = await readProcess({agentId: "agent", groupId, cursor: 0}, f.context);
  assert.equal(result.status, "ok"); assert.equal(result.items.length, 2); assert.equal(result.nextCursor, null);
  assert.equal(result.items[1].sections[0].text, "pwd"); assert.ok(result.items[0].sections[0].blocks?.length);
  assert.equal(JSON.stringify(result).includes("Final answer"), false); assert.equal(JSON.stringify(result).includes("Request"), false);
  assert.equal((await readProcess({agentId: "agent", groupId: "other:epoch:1", cursor: 0}, f.context)).status, "stale");
  assert.equal((await readProcess({agentId: "agent", groupId, cursor: 999}, f.context)).status, "stale");
  assert.throws(() => processRpc.input.parse({agentId: "agent", groupId, cursor: -1}));
  assert.throws(() => processRpc.input.parse({agentId: "agent", groupId, cursor: 0, path: "/etc/passwd"}));
});
test("process reading fails closed if the turn becomes active or the epoch changes", async () => {
  const f = fixture(input), groupId = f.index.groups[0].id;
  f.agent.refresh = async () => ({agent: {status: "running", pendingPermissions: [], activeTurn: null}});
  assert.equal((await readProcess({agentId: "agent", groupId, cursor: 0}, f.context)).status, "stale");
  const other = fixture(input), refetch = other.agent.timeline.refetch;
  other.agent.timeline.refetch = async query => ({...await refetch(query), epoch: query.limit === 1 ? "changed" : "epoch"});
  assert.equal((await readProcess({agentId: "agent", groupId, cursor: 0}, other.context)).status, "stale");
});
test("large process pages are bounded, preserve chronology and expose the remaining cursor", async () => {
  const tools = Array.from({length: 70}, (_, i) => ({type: "tool_call", callId: `call-${i}`, name: "read_file", status: "completed", detail: {type: "read", filePath: `file-${i}`, content: "x".repeat(20_000)}}));
  const f = fixture([input[0], ...tools, input[3]]), groupId = f.index.groups[0].id;
  const first = await readProcess({agentId: "agent", groupId, cursor: 0}, f.context);
  assert.equal(first.status, "ok"); assert.ok(first.items.length > 0 && first.items.length < 40); assert.ok(first.nextCursor);
  assert.ok(JSON.stringify(first).length < 181_000); assert.equal(first.items[0].sections[1].text.length, 16_000); assert.equal(first.items[0].sections[1].truncated, true);
  const second = await readProcess({agentId: "agent", groupId, cursor: first.nextCursor!}, f.context);
  assert.equal(second.items[0].summary, `file-${first.nextCursor}`);
});
test("compaction is represented once and later turns with reused identities stay outside the process", () => {
  const f = fixture([input[0], input[1], {type: "compaction", status: "loading", trigger: "auto"}, {type: "compaction", status: "completed"}, input[3]]);
  const later: Entry[] = [{item: input[0], seqStart: 20, seqEnd: 20, timestamp: new Date(20_000).toISOString(), turnId: "later"},
    {item: {...input[3], messageId: "progress", text: "A different final"}, seqStart: 21, seqEnd: 21, timestamp: new Date(21_000).toISOString(), turnId: "later"}];
  const rows = processRows("agent", "epoch", [...f.rows, ...later], f.index.groups[0]);
  assert.equal(rows.length, 2); assert.equal(rows[1].item.status, "completed"); assert.equal(rows[1].item.trigger, "auto");
  assert.equal(JSON.stringify(rows).includes("A different final"), false);
});
test("tool details retain useful command, file, diff and unknown input/output fields", () => {
  for (const detail of [{type: "shell", command: "pwd", output: "out"}, {type: "edit", filePath: "a.ts", unifiedDiff: "+ new"},
    {type: "unknown", input: {query: "needle"}, output: "result"}]) {
    const item = processRecord("agent", {item: {...input[2], detail}, seqStart: 1, seqEnd: 1, timestamp: new Date().toISOString()});
    assert.ok(item.sections.length >= 2); assert.ok(item.sections.every(section => section.format === "code"));
  }
});
test("Markdown is parsed into native data without HTML execution or unsafe links", () => {
  const nodes = parseMarkdown("## Heading\n\n**Bold** and `code` [link](https://example.com).\n\n- first\n- second\n\n```ts\nconst x = 1;\n```\n\n<script>alert(1)</script>\n\n[bad](javascript:alert(1))");
  const serialized = JSON.stringify(nodes);
  for (const type of ["heading", "strong", "code_inline", "link", "bullet_list", "code_block"]) assert.ok(serialized.includes(`\"type\":\"${type}\"`));
  assert.equal(nodes.some(node => node.type === "html_block"), false);
  assert.equal(serialized.includes('"href":"javascript:'), false);
});
test("process cache coalesces requests and preserves loaded pages across remounts", async () => {
  let reads = 0;
  const item = (id: string) => ({id, kind: "tool", title: id, summary: "", sections: []});
  const runtime = createTurnRuntime({rpc: async (_rpc: unknown, {cursor}: {cursor: number}) => {reads++; await Promise.resolve(); return {status: "ok", items: [item(String(cursor))], nextCursor: cursor === 0 ? 1 : null};}, addTimelineTransformer: () => () => {}} as any, true);
  await Promise.all([runtime.readProcess("agent", "group"), runtime.readProcess("agent", "group")]); assert.equal(reads, 1);
  await runtime.readProcess("agent", "group", 1); assert.equal(reads, 2);
  assert.deepEqual(runtime.cachedProcess("agent", "group")?.items.map(item => item.id), ["0", "1"]);
  assert.equal((await runtime.readProcess("agent", "group")).items.length, 2); assert.equal(reads, 2); runtime.dispose();
});

test("concurrent requests share one timeline scan without retaining a server transcript cache", async () => {
  const f = fixture(input), refetch = f.agent.timeline.refetch; let reads = 0;
  f.agent.timeline.refetch = async query => {reads++; await Promise.resolve(); return refetch(query);};
  const query = {agentId: "agent", groupId: f.index.groups[0].id, cursor: 0};
  const [index, process] = await Promise.all([readIndex({agentId: "agent"}, f.context), readProcess(query, f.context)]);
  assert.equal(index.status, "ok"); assert.equal(process.status, "ok"); assert.equal(reads, 2);
  await readProcess(query, f.context); assert.equal(reads, 4, "completed scans are not stored on the server");
});
