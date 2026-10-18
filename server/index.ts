import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { entryKey, indexTurns, projectIndexes, type Entry } from "../shared/model.ts";
import { PAGE_SIZE, processRecord, processRows } from "../shared/process.ts";
import type { ProcessItem, ProcessPage } from "../shared/contracts.ts";
import { parseMarkdown } from "./markdown.ts";

const diagnostics = { requests: 0, lastSuccessfulAt: null as number | null, lastGroupCount: 0 };
const pendingReads = new WeakMap<PluginHandlerContext["paseo"], Map<string, ReturnType<typeof fetchIndexedUncached>>>();
export function status() { return { ...diagnostics }; }

/** Read only the opened agent. No filesystem reads, model calls or stored chat copies. */
export async function readIndex({ agentId }: { agentId: string }, { paseo }: PluginHandlerContext) {
  diagnostics.requests++;
  const unavailable = { status: "unavailable" as const, agentId, epoch: "", groups: [], protected: [] };
  try {
    const result = await fetchIndexed(agentId, paseo);
    if (!result) return unavailable;
    diagnostics.lastSuccessfulAt = Date.now(); diagnostics.lastGroupCount = result.indexed.groups.length;
    return { status: "ok" as const, ...result.indexed };
  } catch { return unavailable; }
}

async function fetchIndexed(agentId: string, paseo: PluginHandlerContext["paseo"]) {
  let reads = pendingReads.get(paseo);
  if (!reads) {reads = new Map(); pendingReads.set(paseo, reads);}
  let task = reads.get(agentId);
  if (!task) {task = fetchIndexedUncached(agentId, paseo); reads.set(agentId, task);}
  try {return await task;} finally {if (reads.get(agentId) === task) reads.delete(agentId);}
}

async function fetchIndexedUncached(agentId: string, paseo: PluginHandlerContext["paseo"]) {
    const agent = paseo.agents.ref(agentId);
    let page = await agent.timeline.refetch({ direction: "tail", limit: 400, projection: "projected" });
    if (page.error) return null;
    const epoch = page.epoch;
    let entries = [...page.entries];
    // A bounded history read; a partial oldest turn stays unfolded.
    for (let pages = 1; page.hasOlder && page.startCursor && pages < 20; pages++) {
      const previous = await agent.timeline.refetch({ direction: "before", cursor: page.startCursor, limit: 400, projection: "projected" });
      if (previous.epoch !== epoch || previous.error) return null;
      if (!previous.entries.length) break;
      entries = [...previous.entries, ...entries]; page = previous;
    }
    const snapshot = await agent.refresh();
    if (!snapshot) return null;
    const latest = await agent.timeline.refetch({ direction: "tail", limit: 1, projection: "projected" });
    if (latest.epoch !== epoch || latest.error) return null;
    const changedDuringRead = latest.endCursor?.seq !== entries.at(-1)?.seqEnd;
    const current = snapshot.agent;
    const indexed = indexTurns(agentId, epoch, entries as unknown as Entry[], {
      running: changedDuringRead || current.status === "running" || current.status === "initializing" || !!current.activeTurn,
      activeTurnId: current.activeTurn?.turnId,
      pending: !!current.pendingPermissions?.length,
      failed: current.status === "error", hasOlder: page.hasOlder,
    });
    // While history grows, keep the latest observed row native without unfolding
    // earlier proven turns. A retry after completion classifies the trailing turn.
    for (const entry of latest.entries) {
      const key = entryKey(agentId, entry as unknown as Entry);
      if (changedDuringRead && key && !indexed.protected.includes(key)) indexed.protected.push(key);
    }
    return { indexed, entries: entries as unknown as Entry[] };
}

/** Same authenticated timeline access as the index. No disk cache or external calls. */
export async function readProcess({ agentId, groupId, cursor }: { agentId: string; groupId: string; cursor: number }, { paseo }: PluginHandlerContext): Promise<ProcessPage> {
  const empty = { items: [], nextCursor: null };
  try {
    const snapshot = await fetchIndexed(agentId, paseo);
    const group = snapshot?.indexed.groups.find(group => group.id === groupId);
    if (!snapshot || !group || !projectIndexes([snapshot.indexed], new Set()).get(group.anchor)?.anchors.length) return {status: "stale", ...empty};
    const rows = processRows(agentId, snapshot.indexed.epoch, snapshot.entries, group);
    if (!rows.length || cursor > rows.length) return {status: "stale", ...empty};
    const items: ProcessItem[] = []; let bytes = 0, next = cursor;
    for (const row of rows.slice(cursor, cursor + PAGE_SIZE)) {
      const item = processRecord(agentId, row);
      for (const section of item.sections) if (section.format === "markdown") section.blocks = parseMarkdown(section.text);
      const size = JSON.stringify(item).length;
      if (items.length && bytes + size > 180_000) break;
      items.push(item); bytes += size; next++;
    }
    return {status: "ok", items, nextCursor: next < rows.length ? next : null};
  } catch { return {status: "unavailable", ...empty}; }
}
