export interface MarkdownNode {
  type: string;
  text?: string;
  href?: string;
  level?: number;
  start?: number;
  children?: MarkdownNode[];
}
