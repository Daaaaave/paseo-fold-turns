import { ActivityIndicator, Text, View } from "react-native";
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import type { z } from "zod";
import { compactionSchema } from "../shared/contracts.ts";
import { compactionLabel, resolveCompaction } from "../shared/model.ts";
import { TurnDisclosure } from "./disclosure.tsx";
import type { TurnRuntime } from "./runtime.ts";

type Props = PluginTimelineItemProps<z.output<typeof compactionSchema>> & { runtime: TurnRuntime };

export function TurnCompaction(props: Props) {
  const { agentId, timestamp, item, theme } = props;
  const target = resolveCompaction(item.data.targets, agentId, timestamp.getTime());
  if (target?.anchors.length) return <TurnDisclosure {...props} item={{ type: "plugin", kind: "turn-disclosure", version: 1,
    data: { key: target.key, anchors: target.anchors, source: compactionLabel(item.data.source) } }} />;
  if (target?.hidden) return <View nativeID={`completed-turns-hidden-${encodeURIComponent(target.key)}`} style={{ height: 0 }} accessible={false} />;
  // Equal payloads in other turns (including live/manual compaction) stay visible.
  return <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 12 }}>
    <View style={{ flex: 1, height: 1, backgroundColor: theme.colors.border }} />
    {item.data.source.status === "loading" ? <ActivityIndicator size="small" color={theme.colors.foregroundMuted} />
      : <Icon name="Scissors" size={12} color={theme.colors.foregroundMuted} />}
    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, flexShrink: 1 }}>{compactionLabel(item.data.source)}</Text>
    <View style={{ flex: 1, height: 1, backgroundColor: theme.colors.border }} />
  </View>;
}
