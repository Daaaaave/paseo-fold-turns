import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import { Alert, Linking, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { copyText, Icon } from "@getpaseo/plugin/client/react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import type { ProcessItem } from "../shared/contracts.ts";
import type { MarkdownNode } from "../shared/markdown.ts";
import { toolCategory } from "../shared/model.ts";

type Resize = (change: () => void) => void;
type Colors = PluginTheme["colors"];
const monospace = Platform.OS === "ios" ? "Menlo" : "monospace";
const TOOL_ICONS: Record<string, string> = {read: "FileText", edit: "FilePenLine", search: "Search", web: "Globe", command: "Terminal", tool: "Wrench"};
export function safeProcessLink(href = ""): boolean { return /^(https?:\/\/|mailto:)[^\s\u0000-\u001f]+$/i.test(href); }
function openLink(href: string) {
  if (safeProcessLink(href)) void Linking.openURL(href).catch(() => Alert.alert("Link unavailable", "This link could not be opened."));
}
function CopyButton({text, colors}: {text: string; colors: Colors}) {
  const [copied, setCopied] = useState(false), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return <Pressable accessibilityRole="button" accessibilityLabel={copied ? "Copied" : "Copy text"}
    hitSlop={6} onPress={() => { void copyText(text).then(() => {setCopied(true); clearTimeout(timer.current); timer.current = setTimeout(() => setCopied(false), 1500);})
      .catch(() => Alert.alert("Copy unavailable", "Select the text to copy it.")); }}
    style={({pressed}) => ({minWidth: 44, minHeight: 36, alignItems: "center", justifyContent: "center", backgroundColor: pressed ? colors.surface2 : "transparent", borderRadius: 6})}>
    <Icon name={copied ? "Check" : "Copy"} size={14} color={colors.foregroundMuted} />
  </Pressable>;
}
function CodeBlock({text, label, colors, resize}: {text: string; label?: string; colors: Colors; resize: Resize}) {
  const [all, setAll] = useState(false);
  const lines = text.split("\n"), shortened = lines.length > 18 || text.length > 2400;
  const shown = all || !shortened ? text : lines.slice(0, 18).join("\n").slice(0, 2400);
  return <View style={{backgroundColor: colors.surface1, borderRadius: 8, overflow: "hidden", marginVertical: 4}}>
    <View style={{flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingLeft: 12}}>
      <Text style={{fontSize: 11, color: colors.foregroundMuted}}>{label || "Code"}</Text><CopyButton text={text} colors={colors}/>
    </View>
    <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={{paddingHorizontal: 12, paddingBottom: 12}}>
      <Text selectable style={{fontFamily: monospace, fontSize: 12, lineHeight: 19, color: colors.foreground}}>{shown}</Text>
    </ScrollView>
    {shortened && <Pressable accessibilityRole="button" onPress={() => resize(() => setAll(!all))}
      style={{minHeight: 44, justifyContent: "center", paddingHorizontal: 12, borderTopWidth: 1, borderColor: colors.border}}>
      <Text style={{fontSize: 12, color: colors.foregroundMuted}}>{all ? "Show less" : `Show full text · ${lines.length} lines`}</Text>
    </Pressable>}
  </View>;
}
function InlineText({nodes, colors}: {nodes: MarkdownNode[]; colors: Colors}): ReactNode {
  return nodes.map((node, i) => {
    const children = node.children ? <InlineText nodes={node.children} colors={colors}/> : node.text;
    if (node.type === "inline") return <Text key={i}>{children}</Text>;
    return <Text key={i} onPress={node.type === "link" && safeProcessLink(node.href) ? () => openLink(node.href!) : undefined}
      accessibilityRole={node.type === "link" && safeProcessLink(node.href) ? "link" : undefined}
      style={node.type === "strong" ? {fontWeight: "700"} : node.type === "em" ? {fontStyle: "italic"} : node.type === "s" ? {textDecorationLine: "line-through"}
        : node.type === "code_inline" ? {fontFamily: monospace, backgroundColor: colors.surface1, fontSize: 13}
        : node.type === "link" ? {color: colors.accent, textDecorationLine: "underline"} : undefined}>{children}</Text>;
  });
}
function MarkdownContent({nodes, colors, resize}: {nodes: MarkdownNode[]; colors: Colors; resize: Resize}): ReactNode {
  return nodes.map((node, i) => {
    if (node.type === "code_block") return <CodeBlock key={i} text={node.text ?? ""} colors={colors} resize={resize}/>;
    if (node.type === "hr") return <View key={i} style={{height: 1, backgroundColor: colors.border, marginVertical: 10}}/>;
    if (node.type === "paragraph" || node.type === "heading" || node.type === "inline" || node.type === "text") return <Text key={i} selectable
      style={{fontSize: node.type === "heading" ? node.level! <= 2 ? 18 : 15 : 14, fontWeight: node.type === "heading" ? "600" : "400", lineHeight: 22,
        color: colors.foreground, marginVertical: 4}}><InlineText nodes={node.children ?? [{type: "text", text: node.text}]} colors={colors}/></Text>;
    if (node.type === "bullet_list" || node.type === "ordered_list") return <View key={i} style={{gap: 2, marginVertical: 4}}>
      {node.children?.map((child, at) => <View key={at} style={{flexDirection: "row", gap: 8}}>
        <Text style={{width: node.type === "bullet_list" ? 12 : 24, fontSize: 14, lineHeight: 30, color: colors.foregroundMuted}}>{node.type === "bullet_list" ? "•" : `${(node.start ?? 1) + at}.`}</Text>
        <View style={{flex: 1, minWidth: 0}}><MarkdownContent nodes={child.children ?? []} colors={colors} resize={resize}/></View>
      </View>)}
    </View>;
    if (node.type === "table") return <ScrollView horizontal key={i} style={{marginVertical: 8}}><View style={{borderWidth: 1, borderColor: colors.border, borderRadius: 6}}>
      <MarkdownContent nodes={node.children ?? []} colors={colors} resize={resize}/></View></ScrollView>;
    if (node.type === "tr") return <View key={i} style={{flexDirection: "row"}}><MarkdownContent nodes={node.children ?? []} colors={colors} resize={resize}/></View>;
    if (node.type === "th" || node.type === "td") return <View key={i} style={{width: 180, padding: 8, borderBottomWidth: 1, borderColor: colors.border, backgroundColor: node.type === "th" ? colors.surface1 : "transparent"}}>
      <Text selectable style={{fontSize: 13, lineHeight: 20, fontWeight: node.type === "th" ? "600" : "400", color: colors.foreground}}><InlineText nodes={node.children ?? []} colors={colors}/></Text></View>;
    return <View key={i} style={node.type === "blockquote" ? {borderLeftWidth: 2, borderColor: colors.border, paddingLeft: 12, marginVertical: 4} : undefined}>
      <MarkdownContent nodes={node.children ?? []} colors={colors} resize={resize}/></View>;
  });
}
export const ProcessRecord = memo(function ProcessRecord({item, colors, resize}: {item: ProcessItem; colors: Colors; resize: Resize}) {
  const [open, setOpen] = useState(false);
  if (item.kind === "message") return <View style={{paddingVertical: 6}}>
    <View style={{flexDirection: "row", alignItems: "center", gap: 7}}><Icon name="MessageSquare" color={colors.foregroundMuted} size={12}/>
      <Text style={{fontSize: 11, color: colors.foregroundMuted}}>Update</Text></View>
    {item.sections.map((section, i) => <View key={i}><MarkdownContent nodes={section.blocks ?? [{type: "paragraph", children: [{type: "text", text: section.text}]}]} colors={colors} resize={resize}/>
      {section.truncated && <Text style={{fontSize: 11, color: colors.foregroundMuted}}>Long update shortened to 16,000 characters.</Text>}</View>)}
  </View>;
  if (item.kind === "compaction") return <View style={{flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 12}}>
    <Icon name="Scissors" color={colors.foregroundMuted} size={13}/><Text style={{fontSize: 12, color: colors.foregroundMuted}}>{item.title}</Text></View>;
  return <View style={{borderWidth: 1, borderColor: colors.border, borderRadius: 8, overflow: "hidden"}}>
    <Pressable accessibilityRole="button" accessibilityLabel={`${open ? "Hide" : "Show"} ${item.title} details`} accessibilityState={{expanded: open}}
      onPress={() => resize(() => setOpen(!open))} style={({pressed}) => ({minHeight: 48, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10,
        paddingVertical: 8, backgroundColor: pressed ? colors.surface1 : "transparent"})}>
      <Icon name={open ? "ChevronDown" : "ChevronRight"} size={12} color={colors.foregroundMuted}/>
      <Icon name={item.kind === "thinking" ? "Brain" : TOOL_ICONS[toolCategory(item.title)]} size={14} color={colors.foregroundMuted}/>
      <View style={{flex: 1, minWidth: 0, gap: 2}}><Text numberOfLines={1} style={{fontSize: 13, fontWeight: "500", color: colors.foreground}}>{item.title}</Text>
        {!!item.summary && <Text numberOfLines={1} style={{fontFamily: monospace, fontSize: 11, color: colors.foregroundMuted}}>{item.summary}</Text>}</View>
      {item.status === "completed" && <Icon name="Check" size={12} color={colors.foregroundMuted}/>}
    </Pressable>
    {open && <View style={{padding: 10, paddingTop: 0, gap: 6}}>
      {item.sections.length ? item.sections.map((section, i) => <View key={i}>
        {section.format === "code" ? <CodeBlock text={section.text} label={section.label} colors={colors} resize={resize}/>
          : <MarkdownContent nodes={section.blocks ?? [{type: "paragraph", children: [{type: "text", text: section.text}]}]} colors={colors} resize={resize}/>}
        {section.truncated && <Text style={{fontSize: 11, color: colors.foregroundMuted, marginTop: 4}}>Long output shortened to 16,000 characters.</Text>}
      </View>) : <Text style={{fontSize: 12, color: colors.foregroundMuted}}>No additional output was recorded.</Text>}
    </View>}
  </View>;
});
