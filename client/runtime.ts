import type { PluginClientContext, PluginTimelineTransformerContribution } from "@getpaseo/plugin/client";
import { indexRpc, processRpc, type ProcessPage } from "../shared/contracts.ts";
import { compactionSignature, itemKey, projectIndexes, runningToolSignature, type CompactionTarget, type Item, type Role, type TurnIndex } from "../shared/model.ts";
import type { NativeFoldChange } from "../shared/native-anchor.ts";

const TYPES = ["assistant_message", "reasoning", "tool_call", "compaction"] as const;
const displayAnchors = (anchors: Role["anchors"]) => anchors.map(({ agentId, expanded, group: { id, at, tools, messages, thinking, compactions, kinds } }) => ({ agentId, expanded, group: { id, at, tools, messages, thinking, compactions, kinds } }));
export interface TurnRuntime {
  readonly inline: boolean;
  mount(agentId: string): () => void;
  refresh(agentId: string): Promise<void>;
  toggle(groupId: string, around?: (change: NativeFoldChange) => (finish?: boolean) => void): void;
  toggleAgent(agentId: string): void;
  isExpanded(groupId: string): boolean;
  subscribe(groupId: string, listener: () => void): () => void;
  readProcess(agentId: string, groupId: string, cursor?: number): Promise<ProcessPage>;
  cachedProcess(agentId: string, groupId: string): ProcessPage | undefined;
  anchor(groupId: string, around: (change: NativeFoldChange) => (finish?: boolean) => void, change: () => void): () => void;
  dispose(): void;
}

// Paseo evaluates plugin bundles directly; Hermes does not accept class syntax.
export function createTurnRuntime(client: PluginClientContext, inline = false): TurnRuntime {
  const indexes = new Map<string, TurnIndex>();
  const expanded = new Set<string>();
  const mounted = new Map<string, number>();
  const loading = new Map<string, Promise<void>>();
  const dirty = new Set<string>();
  const listeners = new Map<string, Set<() => void>>();
  const processCache = new Map<string, {page: ProcessPage; size: number}>();
  const processLoading = new Map<string, Promise<ProcessPage>>();
  let registrations: (() => void | Promise<void>)[] = [];
  let cancelViewportAnchor: ((finish?: boolean) => void) | undefined;
  let anchoredGroup: string | undefined;
  let disposed = false;

  const notify = (id: string) => { for (const listener of listeners.get(id) ?? []) listener(); };
  function subscribe(id: string, listener: () => void) {
    const set = listeners.get(id) ?? new Set(); set.add(listener); listeners.set(id, set);
    return () => { set.delete(listener); if (!set.size) listeners.delete(id); };
  }
  async function readProcess(agentId: string, groupId: string, cursor = 0): Promise<ProcessPage> {
    const key = JSON.stringify([agentId, groupId]);
    const cached = processCache.get(key);
    if (cached && (cursor === 0 || cached.page.nextCursor !== cursor)) { processCache.delete(key); processCache.set(key, cached); return cached.page; }
    const pending = processLoading.get(key); if (pending) return pending;
    const task = client.rpc(processRpc, {agentId, groupId, cursor}).then(result => {
      const page = cached && cursor > 0 && result.status === "ok" ? {...result,
        items: [...cached.page.items, ...result.items.filter(item => !cached.page.items.some(previous => previous.id === item.id))]} : result;
      if (!disposed && page.status === "ok") {
        processCache.set(key, {page, size: JSON.stringify(page).length});
        let size = [...processCache.values()].reduce((total, value) => total + value.size, 0);
        for (const [id, value] of processCache) {
          if (size <= 2_000_000 && processCache.size <= 32) break;
          const cachedGroup = JSON.parse(id)[1] as string;
          if (listeners.get(cachedGroup)?.size) continue;
          processCache.delete(id); size -= value.size;
        }
      }
      return page;
    });
    processLoading.set(key, task);
    try { return await task; } finally { if (processLoading.get(key) === task) processLoading.delete(key); }
  }
  function anchor(groupId: string, around: (change: NativeFoldChange) => (finish?: boolean) => void, change: () => void) {
    cancelViewportAnchor?.(anchoredGroup !== groupId);
    anchoredGroup = groupId;
    const stop = around(change); cancelViewportAnchor = stop;
    return () => { if (cancelViewportAnchor === stop) { stop(false); cancelViewportAnchor = undefined; } };
  }

  function mount(agentId: string): () => void {
    mounted.set(agentId, (mounted.get(agentId) ?? 0) + 1);
    void refresh(agentId);
    return () => {
      const count = (mounted.get(agentId) ?? 1) - 1;
      if (count) mounted.set(agentId, count); else mounted.delete(agentId);
    };
  }
  async function refresh(agentId: string): Promise<void> {
    if (disposed) return;
    const pending = loading.get(agentId);
    if (pending) { dirty.add(agentId); return pending; }
    const task = (async () => {
      try {
        const index = await client.rpc(indexRpc, { agentId });
        if (disposed) return;
        if (index.status !== "ok") { indexes.delete(agentId); rebuild(); return; }
        if (JSON.stringify(indexes.get(agentId)) === JSON.stringify(index)) return;
        indexes.delete(agentId); indexes.set(agentId, index);
        // No permanent copy of conversations; keep at most 24 viewed indexes.
        for (const key of indexes.keys()) {
          if (indexes.size <= 24) break;
          if (!mounted.has(key)) indexes.delete(key);
        }
        rebuild();
      } catch {
        if (!disposed) { indexes.delete(agentId); rebuild(); }
      }
    })();
    loading.set(agentId, task);
    try { await task; }
    finally {
      loading.delete(agentId);
      if (dirty.delete(agentId) && mounted.has(agentId) && !disposed) void refresh(agentId);
    }
  }
  function toggle(groupId: string, around?: (change: NativeFoldChange) => (finish?: boolean) => void): void {
    if (inline) {
      if (expanded.has(groupId)) expanded.delete(groupId); else expanded.add(groupId);
      notify(groupId); return;
    }
    cancelViewportAnchor?.();
    cancelViewportAnchor = undefined;
    anchoredGroup = groupId;
    const opening = !expanded.has(groupId);
    const change = () => {
      if (expanded.has(groupId) === opening) return;
      if (opening) expanded.add(groupId); else expanded.delete(groupId);
      rebuild();
    };
    if (around) cancelViewportAnchor = around(change); else change();
  }
  function toggleAgent(agentId: string): void {
    cancelViewportAnchor?.(); cancelViewportAnchor = undefined;
    const groups = indexes.get(agentId)?.groups ?? [];
    const open = groups.some(group => !expanded.has(group.id));
    for (const group of groups) { if (open) expanded.add(group.id); else expanded.delete(group.id); }
    if (inline) { for (const group of groups) notify(group.id); }
    else rebuild();
  }
  function rebuild(): void {
    if (disposed) return;
    // Inline expansion is local state inside ONE existing cell. Outer rows and
    // transformer registrations remain identical across every disclosure click.
    const sourceIndexes = [...indexes.values()];
    const obsoleteTools = new Map<string, Set<string>>();
    for (const index of sourceIndexes) for (const tool of index.supersededTools ?? []) {
      // Transformer input omits agent identity. Conflicting live occurrences in
      // other viewed chats must keep their native controls.
      if (sourceIndexes.some(other => other.protected.includes(tool.key) &&
        !other.supersededTools?.some(candidate => candidate.key === tool.key && candidate.signature === tool.signature))) continue;
      const signatures = obsoleteTools.get(tool.key) ?? new Set<string>();
      signatures.add(tool.signature); obsoleteTools.set(tool.key, signatures);
    }
    const sourceRoles = projectIndexes(sourceIndexes, inline ? new Set() : expanded);
    const viewedIndexes = inline ? sourceIndexes.map(index => ({ ...index,
      groups: index.groups
        // Preserve the server's eligibility and identity-conflict protection
        // before relocating a native disclosure to its loaded history tail.
        .filter(group => sourceRoles.get(group.anchor)?.anchors.some(anchor => anchor.group.id === group.id))
        .map(group => group.nativeAnchor
          ? { ...group, anchor: group.nativeAnchor.key, at: group.nativeAnchor.at } : group),
    })) : sourceIndexes;
    const roles = inline ? projectIndexes(viewedIndexes, new Set()) : sourceRoles;
    const compactions = new Map<string, CompactionTarget[]>();
    for (const index of indexes.values()) for (const group of index.groups) for (const marker of group.markers) {
      const role = roles.get(marker.key);
      if (!role) continue;
      const targets = compactions.get(marker.signature) ?? [];
      targets.push({ key: marker.key, agentId: index.agentId, at: marker.at, hidden: role.hidden, anchors: displayAnchors(role.anchors) });
      compactions.set(marker.signature, targets);
    }
    for (const remove of registrations) void remove();
    registrations = TYPES.map(itemType => client.addTimelineTransformer({
      id: `fold-${itemType.replaceAll("_", "-")}`, query: { itemType },
      // Each registration closes over an immutable snapshot, so host memoization
      // is invalidated through the public registration lifecycle when roles change.
      transform: ({ item, phase }: { item: Item; phase: "streaming" | "complete" }) => {
        const signature = runningToolSignature(item), toolKey = signature ? itemKey(item) : null;
        if (toolKey && signature && obsoleteTools.get(toolKey)?.has(signature)) return {items: []};
        if (phase === "streaming") return undefined;
        if (item.type === "compaction") {
          const targets = compactions.get(compactionSignature(item));
          if (!targets?.length || targets.every(target => !target.hidden && !target.anchors.length)) return undefined;
          // The transformer lacks agent/time. Defer identity resolution to the
          // public renderer props instead of hiding every equal compaction.
          return { items: [{ type: "plugin", kind: "turn-compaction", version: 1, data: { source: item, targets } }] };
        }
        const key = itemKey(item);
        const role = key ? roles.get(key) : undefined;
        if (!key || !role) return undefined;
        if (!role.anchors.length) return role.hidden ? { items: [] } : undefined;
        const source = item.type === "tool_call" ? `${item.name ?? "Tool call"}\n${JSON.stringify(item.detail ?? {}, null, 2)}` : item.text ?? "";
        const anchors = displayAnchors(role.anchors);
        return { items: [{ type: "plugin", kind: "turn-disclosure", version: 1, data: { key, anchors, source } }] };
      },
    } as PluginTimelineTransformerContribution));
  }
  function dispose(): void {
    disposed = true;
    cancelViewportAnchor?.(); cancelViewportAnchor = undefined;
    for (const remove of registrations) void remove();
    registrations = []; indexes.clear(); expanded.clear(); mounted.clear(); dirty.clear();
    listeners.clear(); processCache.clear(); processLoading.clear();
  }
  return { inline, mount, refresh, toggle, toggleAgent, isExpanded: id => expanded.has(id), subscribe, readProcess,
    cachedProcess: (agentId, groupId) => processCache.get(JSON.stringify([agentId, groupId]))?.page, anchor, dispose };
}
