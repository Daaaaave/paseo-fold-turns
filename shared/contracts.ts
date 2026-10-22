import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import type { MarkdownNode } from "./markdown.ts";

export const groupSchema = z.object({ id: z.string(), anchor: z.string(), at: z.number(), keys: z.array(z.string()), nativeAnchor: z.object({ key: z.string(), at: z.number() }).optional(), tools: z.number(), messages: z.number(), thinking: z.number(), compactions: z.number(), kinds: z.array(z.string()), markers: z.array(z.object({ key: z.string(), at: z.number(), signature: z.string() })) });
export const indexRpc = defineRpc({
  name: "turns.index",
  input: z.object({ agentId: z.string().min(1).max(256) }).strict(),
  output: z.object({ status: z.enum(["ok", "unavailable"]), agentId: z.string(), epoch: z.string(), groups: z.array(groupSchema), protected: z.array(z.string()),
    supersededTools: z.array(z.object({key: z.string(), signature: z.string()})).optional() }),
});
export const statusRpc = defineRpc({ name: "turns.status", input: z.object({}).strict(), output: z.object({ requests: z.number(), lastSuccessfulAt: z.number().nullable(), lastGroupCount: z.number() }) });
const markdownNodeSchema: z.ZodType<MarkdownNode> = z.lazy(() => z.object({
  type: z.string(), text: z.string().optional(), href: z.string().optional(),
  level: z.number().optional(), start: z.number().optional(), children: z.array(markdownNodeSchema).optional(),
}));
export const processItemSchema = z.object({
  id: z.string(), kind: z.enum(["message", "thinking", "tool", "compaction"]),
  title: z.string(), summary: z.string(), status: z.string().optional(),
  sections: z.array(z.object({ label: z.string(), text: z.string(), format: z.enum(["markdown", "code"]), truncated: z.boolean(), blocks: z.array(markdownNodeSchema).optional() })),
});
export const processPageSchema = z.object({
  status: z.enum(["ok", "stale", "unavailable"]), items: z.array(processItemSchema),
  nextCursor: z.number().int().nonnegative().nullable(),
});
export const processRpc = defineRpc({
  name: "turns.process",
  input: z.object({ agentId: z.string().min(1).max(256), groupId: z.string().min(1).max(1024), cursor: z.number().int().min(0).max(8000).default(0) }).strict(),
  output: processPageSchema,
});
export type ProcessItem = z.output<typeof processItemSchema>;
export type ProcessPage = z.output<typeof processPageSchema>;
const anchorsSchema = z.array(z.object({ agentId: z.string(), group: groupSchema.omit({ keys: true, anchor: true, markers: true, nativeAnchor: true }), expanded: z.boolean() }));
export const rowSchema = z.object({
  key: z.string(),
  anchors: anchorsSchema,
  source: z.string(),
});
export const compactionSchema = z.object({
  source: z.object({ type: z.literal("compaction"), status: z.enum(["loading", "completed"]), trigger: z.enum(["auto", "manual"]).optional(), preTokens: z.number().optional() }),
  targets: z.array(z.object({ key: z.string(), agentId: z.string(), at: z.number(), hidden: z.boolean(), anchors: anchorsSchema })),
});
