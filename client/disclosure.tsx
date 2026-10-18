import { Pressable, Text, View } from "react-native";
import { useLayoutEffect, useRef } from "react";
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import type { z } from "zod";
import { rowSchema } from "../shared/contracts.ts";
import { summary } from "../shared/model.ts";
import type { TurnRuntime } from "./runtime.ts";
import { keepFoldPosition, tidyFoldBoundary } from "./web.ts";
import { InlineProcess } from "./inline-process.tsx";

type Props = PluginTimelineItemProps<z.output<typeof rowSchema>> & { runtime: TurnRuntime };
const ICONS: Record<string, string> = { read: "FileText", edit: "FilePenLine", search: "Search", web: "Globe", command: "Terminal", tool: "Wrench", compaction: "Scissors" };

export function TurnDisclosure(props: Props) {
  return props.runtime.inline ? <InlineProcess {...props}/> : <RowDisclosure {...props}/>;
}

function RowDisclosure({ agentId, item, timestamp, theme, layout, runtime }: Props) {
  const headerRef = useRef<View>(null);
  const candidates = item.data.anchors.filter(anchor => anchor.agentId === agentId);
  const anchor = candidates.find(value => value.group.at === timestamp.getTime()) ?? (candidates.length === 1 ? candidates[0] : undefined);
  useLayoutEffect(() => anchor && !anchor.expanded ? tidyFoldBoundary(headerRef.current) : undefined, [anchor?.group.id, anchor?.expanded]);
  // Identity conflicts never erase a source row.
  if (!anchor) return <Text style={{ color: theme.colors.foreground, fontSize: 14, lineHeight: 21 }} selectable>{item.data.source}</Text>;
  const { group, expanded } = anchor;
  const compact = layout.compact;
  const details = expanded ? <View style={{ borderLeftWidth: 1, borderLeftColor: theme.colors.border, paddingLeft: compact ? 14 : 20, marginLeft: 6, paddingVertical: 8, marginBottom: 8 }}>
    <Text selectable style={{ color: theme.colors.foreground, fontSize: 14, lineHeight: 22 }}>{item.data.source}</Text>
  </View> : null;
  return <View style={{ minWidth: 0 }}>
    <Pressable ref={headerRef} nativeID={`completed-turns-${encodeURIComponent(group.id)}`}
      accessibilityRole="button" accessibilityLabel={`${expanded ? "Hide" : "Show"} process: ${summary(group)}`}
      accessibilityState={{ expanded }} onPress={() => runtime.toggle(group.id, change => keepFoldPosition(headerRef.current, change))}
      style={({ pressed }) => ({ minHeight: compact ? 44 : 36, flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 6, opacity: pressed ? 0.65 : 1 })}>
      <Icon name={expanded ? "ChevronDown" : "ChevronRight"} color={theme.colors.foregroundMuted} size={14} />
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: compact ? 13 : 14, lineHeight: 20, flexShrink: 1 }}>{summary(group)}</Text>
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ flexDirection: "row", gap: 7, flexShrink: 0 }}>
        {(compact ? group.kinds.slice(0, 4) : group.kinds).map(kind => <Icon key={kind} name={ICONS[kind] ?? "Wrench"} color={theme.colors.foregroundMuted} size={14} />)}
      </View>
    </Pressable>
    {details}
  </View>;
}
