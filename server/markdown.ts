import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
import type { MarkdownNode } from "../shared/markdown.ts";

const options = { html: false, linkify: true, maxNesting: 16 };
const parser = new MarkdownIt(options);
/** JSON structure only. Never emit HTML or execute content on the client. */
export function parseMarkdown(text: string): MarkdownNode[] {
  let budget = 1500;
  const convert = (tokens: Token[]): MarkdownNode[] => {
    const root: MarkdownNode[] = [], stack = [root];
    for (const token of tokens) {
      if (--budget < 0) return [];
      if (token.nesting === -1) { if (stack.length > 1) stack.pop(); continue; }
      const node: MarkdownNode = { type: token.type.replace(/_open$/, "") };
      if (token.nesting === 1) {
        node.children = [];
        if (token.type === "heading_open") node.level = Number(token.tag.slice(1));
        if (token.type === "ordered_list_open") node.start = Number(token.attrGet("start") ?? 1);
        if (token.type === "link_open") node.href = token.attrGet("href") ?? undefined;
        stack.at(-1)!.push(node); stack.push(node.children); continue;
      }
      if (token.type === "inline") node.children = convert(token.children ?? []);
      else if (token.type === "softbreak" || token.type === "hardbreak") { node.type = "text"; node.text = "\n"; }
      else if (token.type === "fence" || token.type === "code_block") { node.type = "code_block"; node.text = token.content; }
      else if (token.type === "image") { node.type = "link"; node.href = token.attrGet("src") ?? undefined; node.children = [{type: "text", text: token.content || "Image"}]; }
      else node.text = token.content;
      stack.at(-1)!.push(node);
    }
    return root;
  };
  const blocks = convert(parser.parse(text, {}));
  return budget < 0 ? [{type: "paragraph", children: [{type: "text", text}]}] : blocks;
}
