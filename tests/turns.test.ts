import test from "node:test";
import assert from "node:assert/strict";
import { indexTurns, itemKey, entryKey, projectIndexes, resolveCompaction, summary, type Entry, type Item } from "../shared/model.ts";
import { createTurnRuntime } from "../client/runtime.ts";
import { readIndex } from "../server/index.ts";
import contribute from "../index.server.ts";

const idle = { running: false, pending: false, failed: false, hasOlder: false };
function entries(items: Item[], turnId = "turn", offset = 0): Entry[] {
  return items.map((item, i) => ({ item, turnId, seqStart: offset + i + 1, seqEnd: offset + i + 1, timestamp: new Date(1000 * (offset + i + 1)).toISOString() }));
}
const source: Item[] = [
  { type: "user_message", text: "Investigate" },
  { type: "assistant_message", messageId: "progress", text: "Checking the source now" },
  { type: "reasoning", text: "Thinking about this turn" },
  ...["read_file", "web_search", "exec_command"].map((name, i) => ({ type: "tool_call", callId: `call-${i}`, name, status: "completed", detail: { type: "unknown", output: "Done" } })),
  { type: "assistant_message", messageId: "final", text: "**The final answer**" },
];

test("the server entry registers its RPCs and satisfies the Paseo cleanup contract", () => {
  const names: string[] = [];
  const cleanup = contribute({ handle: (contract: { name: string }) => { names.push(contract.name); } } as unknown as Parameters<typeof contribute>[0]);
  assert.deepEqual(names, ["turns.index", "turns.status", "turns.process"]);
  assert.equal(typeof cleanup, "function"); cleanup();
});

test("the Conductor example becomes one row including progress messages, with the final answer native", () => {
  const index = indexTurns("agent", "epoch", entries(source), idle);
  assert.equal(index.groups.length, 1);
  const group = index.groups[0];
  assert.equal(summary(group), "3 tool calls, 1 message");
  assert.deepEqual([group.tools, group.messages, group.thinking], [3, 1, 1]);
  const roles = projectIndexes([index], new Set());
  assert.equal(roles.size, 5);
  assert.equal(roles.get("a:progress")?.anchors.length, 1);
  assert.equal(roles.get(itemKey(source[2])!)?.hidden, true);
  assert.equal(roles.has("a:final"), false);
  assert.equal(roles.has(itemKey(source[0])!), false);
});

test("running, waiting, failed and incomplete turns remain visible", () => {
  for (const state of [{ ...idle, running: true }, { ...idle, pending: true }, { ...idle, failed: true }, { ...idle, activeTurnId: "turn" }]) {
    assert.equal(indexTurns("agent", "epoch", entries(source), state).groups.length, 0);
  }
  assert.equal(indexTurns("agent", "epoch", entries(source.slice(1)), { ...idle, hasOlder: true }).groups.length, 0);
  assert.equal(indexTurns("agent", "epoch", entries(source.slice(0, -1)), { ...idle, running: true }).groups.length, 0);
  assert.equal(indexTurns("agent", "epoch", entries([...source, { type: "error", message: "Failure" }]), idle).groups.length, 0);
});

test("long examples count every intermediate message and tool call once", () => {
  for (const tools of [30, 66]) {
    const rows: Item[] = [{ type: "user_message", text: "Compare the options" },
      ...Array.from({ length: 5 }, (_, i) => ({ type: "assistant_message", messageId: `progress-${i}`, text: `Update ${i}` })),
      ...Array.from({ length: tools }, (_, i) => ({ type: "tool_call", callId: `tool-${i}`, name: "exec_command", status: "completed" })),
      { type: "assistant_message", messageId: "final", text: "Final comparison" }];
    const index = indexTurns("agent", "epoch", entries(rows), idle);
    assert.equal(index.groups.length, 1);
    assert.equal(summary(index.groups[0]), `${tools} tool calls, 5 messages`);
    assert.equal(projectIndexes([index], new Set()).size, tools + 5);
  }
});

test("older completed turns still fold while the next turn is running", () => {
  const rows = [...entries(source, "old"), ...entries(source.map(item => item.messageId ? { ...item, messageId: `new-${item.messageId}` } : item.type === "tool_call" ? { ...item, callId: `new-${item.callId}` } : item), "new", 20)];
  const index = indexTurns("agent", "epoch", rows, { ...idle, running: true, activeTurnId: "new" });
  assert.equal(index.groups.length, 1);
  const roles = projectIndexes([index], new Set());
  assert.equal(roles.has("a:final"), false); assert.equal(roles.has("a:new-final"), false);
});

test("expanding restores all intermediate rows in their original order and preserves final text", () => {
  const index = indexTurns("agent", "epoch", entries(source), idle);
  const roles = projectIndexes([index], new Set([index.groups[0].id]));
  assert.equal(roles.get("a:progress")?.anchors[0].expanded, true);
  for (const item of source.slice(2, -1)) assert.equal(roles.get(itemKey(item)!)?.hidden, false);
  assert.equal(roles.has("a:final"), false);
});

test("reused message identities never hide a final answer or leave a group without its disclosure", () => {
  const first = indexTurns("one", "epoch", entries(source), idle);
  const second = indexTurns("two", "epoch", entries([{ type: "user_message" }, { type: "assistant_message", messageId: "progress", text: "This is a different final" }]), idle);
  const roles = projectIndexes([first, second], new Set());
  assert.equal(roles.size, 0, "a protected disclosure identity protects its whole group");
});

test("the runtime keeps final/user/streaming rows native and removes its registrations on dispose", async () => {
  const index = indexTurns("agent", "epoch", entries(source), idle);
  const transforms = new Map<string, { transform: (input: { item: Item; phase: string }) => any }>();
  const client = { rpc: async () => ({ status: "ok", ...index }), addTimelineTransformer: (value: any) => { transforms.set(value.query.itemType, value); return () => transforms.delete(value.query.itemType); } };
  const runtime = createTurnRuntime(client as unknown as Parameters<typeof createTurnRuntime>[0]);
  await runtime.refresh("agent");
  assert.equal(transforms.get("assistant_message")!.transform({ item: source.at(-1)!, phase: "complete" }), undefined);
  assert.equal(transforms.get("assistant_message")!.transform({ item: source[1], phase: "streaming" }), undefined);
  const row = transforms.get("assistant_message")!.transform({ item: source[1], phase: "complete" });
  assert.equal(row.items.length, 1); assert.equal(row.items[0].kind, "turn-disclosure");
  assert.deepEqual(transforms.get("tool_call")!.transform({ item: source[3], phase: "complete" }), { items: [] });
  runtime.toggle(index.groups[0].id);
  assert.equal(transforms.get("tool_call")!.transform({ item: source[3], phase: "complete" }), undefined);
  runtime.dispose(); assert.equal(transforms.size, 0);
});

test("an unavailable history index restores native rendering", async () => {
  let unavailable = false; let registrations = 0;
  const transforms = new Map<string, any>();
  const index = indexTurns("agent", "epoch", entries(source), idle);
  const client = { rpc: async () => unavailable ? { status: "unavailable", agentId: "agent", epoch: "", groups: [], protected: [] } : { status: "ok", ...index },
    addTimelineTransformer: (value: any) => { registrations++; transforms.set(value.query.itemType, value); return () => { registrations--; transforms.delete(value.query.itemType); }; } };
  const runtime = createTurnRuntime(client as unknown as Parameters<typeof createTurnRuntime>[0]);
  await runtime.refresh("agent"); assert.equal(registrations, 4);
  unavailable = true; await runtime.refresh("agent");
  assert.equal(transforms.get("tool_call").transform({ item: source[3], phase: "complete" }), undefined);
  runtime.dispose(); assert.equal(registrations, 0);
});

test("history growing during a read cannot make a newly completed reply disappear", async () => {
  const rows = entries(source);
  const late = entries([{ type: "assistant_message", messageId: "progress", text: "A newly completed answer" }], "new", 20);
  const agent = { timeline: { refetch: async (input: { limit: number }) => ({ epoch: "epoch", entries: input.limit === 1 ? late : rows, hasOlder: false, endCursor: { seq: input.limit === 1 ? 21 : rows.at(-1)!.seqEnd } }) }, refresh: async () => ({ agent: { status: "idle", pendingPermissions: [], activeTurn: null } }) };
  const result = await readIndex({ agentId: "agent" }, { paseo: { agents: { ref: () => agent } } } as unknown as Parameters<typeof readIndex>[1]);
  assert.equal(result.status, "ok"); assert.equal(result.groups.length, 0);
  assert.ok(result.protected.includes("a:progress"));
});

test("the server uses exact turn metadata, without returning transcript text", async () => {
  const rows = entries(source);
  const agent = { timeline: { refetch: async (input: { limit: number }) => ({ epoch: "epoch", entries: input.limit === 1 ? rows.slice(-1) : rows, hasOlder: false, endCursor: { seq: rows.at(-1)!.seqEnd } }) }, refresh: async () => ({ agent: { status: "idle", pendingPermissions: [], activeTurn: null } }) };
  const result = await readIndex({ agentId: "agent" }, { paseo: { agents: { ref: () => agent } } } as unknown as Parameters<typeof readIndex>[1]);
  assert.equal(result.status, "ok"); assert.equal(result.groups.length, 1);
  assert.equal(JSON.stringify(result).includes("Checking the source now"), false);
  assert.equal(JSON.stringify(result).includes("The final answer"), false);
});

test("context compaction joins the same fold and reappears when expanded", () => {
  const rows = entries([...source.slice(0, -1), { type: "compaction", status: "loading" }, { type: "compaction", status: "completed" }, source.at(-1)!]);
  const index = indexTurns("agent", "epoch", rows, idle);
  assert.equal(index.groups.length, 1);
  assert.equal(index.groups[0].compactions, 1, "loading and completion describe one compaction");
  assert.ok(index.groups[0].kinds.includes("compaction"));
  assert.equal(summary(index.groups[0]), "3 tool calls, 1 message");
  for (const row of rows.filter(row => row.item.type === "compaction")) {
    const key = entryKey("agent", row)!;
    assert.equal(projectIndexes([index], new Set()).get(key)?.hidden, true);
    assert.equal(projectIndexes([index], new Set([index.groups[0].id])).get(key)?.hidden, false);
  }
  assert.equal(projectIndexes([index], new Set()).has("a:final"), false);
});

test("a turn containing only context compaction still has an accessible fold", () => {
  const rows = entries([source[0], { type: "compaction", status: "completed" }, source.at(-1)!]);
  const index = indexTurns("agent", "epoch", rows, idle);
  assert.equal(index.groups.length, 1);
  assert.equal(index.groups[0].anchor, entryKey("agent", rows[1]));
  assert.equal(summary(index.groups[0]), "1 context compaction");
});

test("identical compaction payloads resolve by chat and timestamp without hiding active or manual markers", async () => {
  const first = entries([source[0], source[1], { type: "compaction", status: "completed" }, source.at(-1)!], "old");
  const manual = entries([{ type: "compaction", status: "completed" }], "old", 10);
  const live = entries([source[0], { type: "compaction", status: "completed" }], "new", 20);
  const index = indexTurns("agent", "epoch", [...first, ...manual, ...live], { ...idle, running: true, activeTurnId: "new" });
  const transforms = new Map<string, any>();
  const runtime = createTurnRuntime({ rpc: async () => ({ status: "ok", ...index }), addTimelineTransformer: (value: any) => { transforms.set(value.query.itemType, value); return () => transforms.delete(value.query.itemType); } } as any);
  await runtime.refresh("agent");
  const transform = () => transforms.get("compaction").transform({ item: first[2].item, phase: "complete" });
  let data = transform().items[0].data;
  assert.equal(resolveCompaction(data.targets, "agent", Date.parse(first[2].timestamp))?.hidden, true);
  assert.equal(resolveCompaction(data.targets, "other-agent", Date.parse(first[2].timestamp)), undefined);
  assert.equal(resolveCompaction(data.targets, "agent", Date.parse(manual[0].timestamp)), undefined);
  assert.equal(resolveCompaction(data.targets, "agent", Date.parse(live[1].timestamp)), undefined);
  runtime.toggle(index.groups[0].id);
  assert.equal(transform(), undefined, "fully expanded markers use Paseo's native renderer");
  assert.equal(transforms.get("assistant_message").transform({ item: source.at(-1), phase: "complete" }), undefined);
  runtime.dispose();
});

test("indistinguishable compaction timestamps never leave a hidden group without a disclosure", () => {
  const rows = entries([source[0], { type: "compaction", status: "completed" }, { type: "compaction", status: "completed" }, source[1], source.at(-1)!]);
  rows[2].timestamp = rows[1].timestamp;
  const index = indexTurns("agent", "epoch", rows, idle);
  assert.equal(projectIndexes([index], new Set()).size, 0);
});

test("Paseo's merged completed marker retains its loading timestamp and metadata", async () => {
  const rows = entries([source[0], { type: "compaction", status: "loading", trigger: "auto", preTokens: 128000 }, { type: "compaction", status: "completed" }, source.at(-1)!]);
  const index = indexTurns("agent", "epoch", rows, idle);
  const transforms = new Map<string, any>();
  const runtime = createTurnRuntime({ rpc: async () => ({ status: "ok", ...index }), addTimelineTransformer: (value: any) => { transforms.set(value.query.itemType, value); return () => transforms.delete(value.query.itemType); } } as any);
  await runtime.refresh("agent");
  const merged = { type: "compaction", status: "completed", trigger: "auto", preTokens: 128000 };
  const data = transforms.get("compaction").transform({ item: merged, phase: "complete" }).items[0].data;
  const target = resolveCompaction(data.targets, "agent", Date.parse(rows[1].timestamp));
  assert.equal(target?.anchors[0].group.id, index.groups[0].id);
  assert.equal(target?.key, index.groups[0].anchor, "the merged marker still hosts its disclosure");
  runtime.toggle(index.groups[0].id);
  const expanded = transforms.get("compaction").transform({ item: merged, phase: "complete" }).items[0].data;
  assert.equal(resolveCompaction(expanded.targets, "agent", Date.parse(rows[1].timestamp))?.anchors[0].expanded, true);
  runtime.dispose();
});

test("a new fold interaction and plugin teardown cancel the previous viewport anchor", async () => {
  const index = indexTurns("agent", "epoch", entries(source), idle);
  const runtime = createTurnRuntime({ rpc: async () => ({ status: "ok", ...index }), addTimelineTransformer: () => () => {} } as any);
  await runtime.refresh("agent");
  let captured = 0; let stopped = 0;
  const around = (change: () => void) => { captured++; change(); return () => { stopped++; }; };
  runtime.toggle(index.groups[0].id, around);
  runtime.toggle(index.groups[0].id, around);
  assert.equal(captured, 2); assert.equal(stopped, 1);
  runtime.dispose(); assert.equal(stopped, 2);
});
