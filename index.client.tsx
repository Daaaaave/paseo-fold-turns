import { useEffect } from "react";
import { Platform, Text } from "react-native";
import { useAgent, type PluginButtonIconProps, type PluginClientContext, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { compactionSchema, rowSchema } from "./shared/contracts.ts";
import { createTurnRuntime } from "./client/runtime.ts";
import { TurnDisclosure } from "./client/disclosure.tsx";
import { TurnCompaction } from "./client/compaction.tsx";
import type { z } from "zod";

export default function contribute(client: PluginClientContext) {
  const runtime = createTurnRuntime(client, Platform.OS !== "web");
  const lifetime = new AbortController();
  const pills = new Map<string, { remove(): void }>();
  function Observer(props: PluginButtonIconProps) {
    const agentId = props.context === "agent" ? props.agentId : "";
    const state = useAgent(agentId, agent => `${agent.status}:${agent.requiresAttention}:${agent.status === "idle" ? agent.lastActivityAt : ""}`);
    useEffect(() => agentId ? runtime.mount(agentId) : undefined, [agentId]);
    useEffect(() => {
      if (!agentId) return;
      void runtime.refresh(agentId);
      // Growing turns remain native. Re-index on completion rather than copying
      // their whole history for every tool or streamed update.
      if (state?.startsWith("running")) return;
      const retry = setTimeout(() => void runtime.refresh(agentId), 1500);
      const timer = setInterval(() => void runtime.refresh(agentId), 60_000);
      return () => { clearTimeout(retry); clearInterval(timer); };
    }, [agentId, state]);
    return <Text style={{ color: props.color, fontSize: props.size }}>≡</Text>;
  }
  client.addTimelineRenderer({ kind: "turn-disclosure", version: 1, schema: rowSchema,
    Component: (props: PluginTimelineItemProps<z.output<typeof rowSchema>>) => <TurnDisclosure {...props} runtime={runtime} /> });
  client.addTimelineRenderer({ kind: "turn-compaction", version: 1, schema: compactionSchema,
    Component: (props: PluginTimelineItemProps<z.output<typeof compactionSchema>>) => <TurnCompaction {...props} runtime={runtime} /> });
  const register = (agent: { id: string; workspaceId?: string | null }) => {
    if (lifetime.signal.aborted || !agent.workspaceId || pills.has(agent.id)) return;
    pills.set(agent.id, client.addComposerPill({ id: "fold-turns", workspaceId: agent.workspaceId, agentId: agent.id,
      button: { title: "Expand or collapse completed turns", label: "Process", icon: Observer, behavior: { kind: "action", onPress: () => runtime.toggleAgent(agent.id) } } }));
  };
  void client.paseo.agents.list({ subscribe: {}, signal: lifetime.signal }).then(({ subscription }) => {
    if (lifetime.signal.aborted) { void subscription.release().catch(() => {}); return; }
    const unsubscribe = subscription.subscribe({
      snapshot: ({ entries }) => {
        const ids = new Set(entries.map(({ agent }) => agent.id));
        for (const [id, pill] of pills) if (!ids.has(id)) { pill.remove(); pills.delete(id); }
        for (const { agent } of entries) register(agent);
      },
      update: (message) => {
        if (message.type !== "agent_update") return;
        const update = message.payload;
        if (update.kind === "upsert") register(update.agent);
        else { pills.get(update.agentId)?.remove(); pills.delete(update.agentId); }
      },
    });
    lifetime.signal.addEventListener("abort", () => { unsubscribe(); void subscription.release().catch(() => {}); }, { once: true });
  }).catch(() => { /* Existing native rendering remains available. */ });
  return () => { lifetime.abort(); runtime.dispose(); for (const pill of pills.values()) pill.remove(); pills.clear(); };
}
