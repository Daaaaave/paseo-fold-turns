import type { ProcessItem } from "./contracts.ts";
import { coalesceCompactions, compactionLabel, entryKey, turnSegments, type Entry, type Group } from "./model.ts";

const FIELD_LIMIT = 16_000;
export const PAGE_SIZE = 40;
const text = (value: unknown): string => typeof value === "string" ? value : value == null ? "" : JSON.stringify(value, null, 2) ?? "";
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
export function processRecord(agentId: string, row: Entry): ProcessItem {
  const item = row.item;
  const kind = item.type === "assistant_message" ? "message" : item.type === "reasoning" ? "thinking" : item.type === "compaction" ? "compaction" : "tool";
  const record: ProcessItem = { id: `${entryKey(agentId, row)}:${row.seqStart}`, kind,
    title: kind === "message" ? "Update" : kind === "thinking" ? "Thinking" : kind === "compaction" ? compactionLabel(item) : (item.name ?? "Tool").slice(0, 240),
    summary: "", status: item.status, sections: [] };
  const add = (label: string, value: unknown, format: "markdown" | "code" = "code") => {
    const raw = text(value); if (!raw) return;
    record.sections.push({label, text: raw.slice(0, FIELD_LIMIT), format, truncated: raw.length > FIELD_LIMIT});
  };
  if (kind === "message" || kind === "thinking") { add("", item.text, "markdown"); return record; }
  if (kind === "compaction") return record;
  const d = object(item.detail);
  record.summary = text(d.command ?? d.filePath ?? d.query ?? d.url ?? d.description ?? d.label ?? "").split("\n")[0].slice(0, 240);
  switch (d.type) {
    case "shell": add("Command", d.command); add("Working directory", d.cwd); add("Output", d.output); break;
    case "read": case "write": add("File", d.filePath); add("Content", d.content); break;
    case "edit": add("File", d.filePath); if (d.unifiedDiff) add("Diff", d.unifiedDiff); else { add("Before", d.oldString); add("After", d.newString); } break;
    case "search": add("Query", d.query); add("Results", d.content ?? d.filePaths ?? d.webResults); break;
    case "fetch": add("URL", d.url); add("Result", d.result, "markdown"); break;
    case "plan": add("Plan", d.text, "markdown"); break;
    case "plain_text": add("", d.text, "markdown"); break;
    case "sub_agent": add("Description", d.description); add("Output", d.log); break;
    case "worktree_setup": add("Branch", d.branchName); add("Directory", d.worktreePath); add("Output", d.log); break;
    default: add("Input", d.input); add("Output", d.output); if (!record.sections.length && Object.keys(d).length) add("Details", d);
  }
  if (item.error) add("Error", item.error);
  return record;
}

/** Keep original chronology and count a loading/completed compaction only once. */
export function processRows(agentId: string, epoch: string, entries: Entry[], group: Group): Entry[] {
  const keys = new Set(group.keys);
  const segment = turnSegments(entries).find(rows => group.id === `${agentId}:${epoch}:${rows[0].seqStart}`) ?? [];
  const final = segment.findLastIndex(row => row.item.type === "assistant_message" && !!row.item.text?.trim());
  const rows = segment.slice(0, Math.max(0, final)).filter(row => { const key = entryKey(agentId, row); return key && keys.has(key); });
  return coalesceCompactions(rows);
}
