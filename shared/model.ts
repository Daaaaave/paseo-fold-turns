export interface Item {
  type: string;
  text?: string;
  messageId?: string;
  callId?: string;
  name?: string;
  status?: string;
  [key: string]: unknown;
}
export interface Entry { item: Item; seqStart: number; seqEnd: number; timestamp: string; turnId?: string | null }
export interface Group {
  id: string; anchor: string; at: number; keys: string[];
  tools: number; messages: number; thinking: number; compactions: number; kinds: string[];
  markers: { key: string; at: number; signature: string }[];
}
export interface TurnIndex { agentId: string; epoch: string; groups: Group[]; protected: string[] }
export type DisplayGroup = Omit<Group, "anchor" | "keys" | "markers">;
export interface CompactionTarget {
  key: string; agentId: string; at: number; hidden: boolean;
  anchors: { agentId: string; group: DisplayGroup; expanded: boolean }[];
}

/** Content lookup only; never used for authentication or authorization. */
export function fingerprint(text: string): string {
  let a = 2166136261; let b = 5381;
  for (let i = 0; i < text.length; i++) { const n = text.charCodeAt(i); a = Math.imul(a ^ n, 16777619); b = Math.imul(b, 33) ^ n; }
  return `${text.length}:${(a >>> 0).toString(36)}:${(b >>> 0).toString(36)}`;
}
export function itemKey(item: Item): string | null {
  if (item.type === "assistant_message") return item.messageId ? `a:${item.messageId}` : `a-text:${fingerprint(item.text ?? "")}`;
  if (item.type === "reasoning") return `r:${fingerprint(item.text ?? "")}`;
  if (item.type === "tool_call") return item.callId ? `t:${item.callId}` : null;
  return null;
}
export function compactionSignature(item: Item): string {
  return JSON.stringify([item.status, item.trigger ?? null, item.preTokens ?? null]);
}
/** Compaction has no item ID; its renderer supplies the missing agent and time. */
export function entryKey(agentId: string, entry: Entry): string | null {
  if (entry.item.type !== "compaction") return itemKey(entry.item);
  const at = Date.parse(entry.timestamp);
  return Number.isFinite(at) ? `c:${agentId}:${at}:${compactionSignature(entry.item)}` : null;
}
export function resolveCompaction(targets: CompactionTarget[], agentId: string, at: number): CompactionTarget | undefined {
  const matches = targets.filter(target => target.agentId === agentId && target.at === at);
  return matches.length === 1 ? matches[0] : undefined;
}
export function compactionLabel(item: Item): string {
  if (item.status === "loading") return "Compacting context…";
  if (item.trigger === "auto") return "Context auto-compacted";
  if (item.trigger === "manual") return "Context manually compacted";
  return item.preTokens ? `Context compacted (${Math.round(Number(item.preTokens) / 1000)}k tokens)` : "Context compacted";
}
function compactionMarkers(agentId: string, rows: Entry[]): Group["markers"] {
  const markers = new Map<string, Group["markers"][number]>();
  const pending: Entry[] = [];
  const add = (entry: Entry, item = entry.item) => {
    const key = entryKey(agentId, entry);
    if (!key) return;
    const marker = { key, at: Date.parse(entry.timestamp), signature: compactionSignature(item) };
    const identity = `${marker.at}:${marker.signature}`;
    if (!markers.has(identity)) markers.set(identity, marker);
  };
  for (const row of rows) if (row.item.type === "compaction") {
    if (row.item.status === "loading") pending.push(row);
    else if (row.item.status === "completed") {
      const loading = pending.shift();
      // Paseo replaces the loading marker in place: completion keeps its start
      // timestamp and inherits metadata absent from the completion event.
      if (loading) add(loading, { ...loading.item, ...row.item,
        trigger: row.item.trigger ?? loading.item.trigger, preTokens: row.item.preTokens ?? loading.item.preTokens });
    }
    add(row);
  }
  return [...markers.values()];
}
export function toolCategory(name = ""): string {
  if (/search|find|rg\b/i.test(name)) return "search";
  if (/web|browse|fetch/i.test(name)) return "web";
  if (/edit|write|patch/i.test(name)) return "edit";
  if (/read|open|view/i.test(name)) return "read";
  if (/exec|command|shell|terminal|stdin/i.test(name)) return "command";
  return "tool";
}

export function turnSegments(entries: Entry[]): Entry[][] {
  const segments: Entry[][] = [];
  let segment: Entry[] = [];
  let turnId: string | null = null;
  for (const entry of entries) {
    const next = entry.turnId ?? null;
    if (segment.length && ((entry.item.type === "user_message" && (!next || next !== turnId)) || (next && turnId && next !== turnId))) {
      segments.push(segment); segment = []; turnId = null;
    }
    segment.push(entry); if (next) turnId = next;
  }
  if (segment.length) segments.push(segment);
  return segments;
}

/** Only complete turns with a proven final text response are eligible. */
export function indexTurns(agentId: string, epoch: string, entries: Entry[], state: { running: boolean; activeTurnId?: string | null; pending: boolean; failed: boolean; hasOlder: boolean }): TurnIndex {
  const result: TurnIndex = { agentId, epoch, groups: [], protected: [] };
  const keyOf = (entry: Entry) => entryKey(agentId, entry);
  const markerKeys = new Set<string>();
  for (const entry of entries) if (entry.item.type === "compaction") {
    const key = keyOf(entry);
    if (key && markerKeys.has(key)) result.protected.push(key);
    if (key) markerKeys.add(key);
  }
  const segments = turnSegments(entries);
  for (const [position, rows] of segments.entries()) {
    const isLast = position === segments.length - 1;
    const hasStart = rows[0].item.type === "user_message" || position > 0 || !state.hasOlder;
    const final = rows.findLastIndex(row => row.item.type === "assistant_message" && !!row.item.text?.trim());
    const busy = (isLast && (state.running || state.pending || state.failed)) || rows.some(row => row.turnId && row.turnId === state.activeTurnId);
    const runningTool = (row: Entry) => row.item.type === "tool_call" && row.item.status === "running";
    const broken = rows.some(row => row.item.type === "error") || rows.slice(final + 1).some(runningTool);
    if (!hasStart || final < 0 || busy || broken) {
      for (const row of rows) { const key = keyOf(row); if (key) result.protected.push(key); }
      continue;
    }
    // The final answer, and any later notices, always retain native rendering.
    for (const row of rows.slice(final)) { const key = keyOf(row); if (key) result.protected.push(key); }
    // A finished answer may leave a preview server or other background command
    // running. Keep that command native without blocking the completed work's fold.
    for (const row of rows.filter(runningTool)) { const key = keyOf(row); if (key) result.protected.push(key); }
    const process = rows.slice(0, final).filter(row => keyOf(row) && !runningTool(row));
    if (!process.length) continue;
    const anchor = process[0];
    if (!Number.isFinite(Date.parse(anchor.timestamp))) {
      for (const row of process) result.protected.push(keyOf(row)!);
      continue;
    }
    result.groups.push({
      id: `${agentId}:${epoch}:${rows[0].seqStart}`, anchor: keyOf(anchor)!, at: Date.parse(anchor.timestamp),
      keys: [...new Set(process.map(row => keyOf(row)!))],
      tools: process.filter(row => row.item.type === "tool_call").length,
      messages: process.filter(row => row.item.type === "assistant_message").length,
      thinking: process.filter(row => row.item.type === "reasoning").length,
      compactions: process.filter(row => row.item.type === "compaction" && row.item.status === "completed").length,
      markers: compactionMarkers(agentId, process),
      kinds: [...new Set(process.flatMap(row => row.item.type === "tool_call" ? [toolCategory(row.item.name)] : row.item.type === "compaction" ? ["compaction"] : []))].slice(0, 7),
    });
  }
  result.protected = [...new Set(result.protected)];
  return result;
}

export interface Role { hidden: boolean; anchors: { agentId: string; group: Group; expanded: boolean }[] }
/** Conflicting identities are left native, especially when any occurrence is a final reply. */
export function projectIndexes(indexes: TurnIndex[], expanded: ReadonlySet<string>): Map<string, Role> {
  const protectedKeys = new Set(indexes.flatMap(index => index.protected));
  const groups = indexes.flatMap(index => index.groups);
  // Never hide followers if their disclosure anchor must remain native.
  let changed = true;
  while (changed) {
    changed = false;
    for (const group of groups) if (protectedKeys.has(group.anchor)) for (const key of group.keys) {
      if (!protectedKeys.has(key)) { protectedKeys.add(key); changed = true; }
    }
  }
  const roles = new Map<string, Role>();
  for (const index of indexes) for (const group of index.groups) {
    const open = expanded.has(group.id);
    for (const key of group.keys) {
      if (protectedKeys.has(key)) continue;
      const role = roles.get(key) ?? { hidden: true, anchors: [] };
      if (key === group.anchor) role.anchors.push({ agentId: index.agentId, group, expanded: open });
      else if (open) role.hidden = false;
      roles.set(key, role);
    }
  }
  return roles;
}

export function summary(group: Pick<Group, "tools" | "messages" | "thinking" | "compactions">): string {
  const parts = [];
  if (group.tools) parts.push(`${group.tools} tool call${group.tools === 1 ? "" : "s"}`);
  if (group.messages) parts.push(`${group.messages} message${group.messages === 1 ? "" : "s"}`);
  if (!parts.length && group.thinking) parts.push(`${group.thinking} thinking block${group.thinking === 1 ? "" : "s"}`);
  if (!parts.length) parts.push(`${group.compactions || 1} context compaction${group.compactions > 1 ? "s" : ""}`);
  return parts.join(", ");
}
