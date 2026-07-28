import type { NotionBlock } from "./notion-types.js";

export function getBlockChildren(block: NotionBlock): NotionBlock[] {
  const content = (block as Record<string, unknown>)[block.type];
  if (!content || typeof content !== "object") {
    return [];
  }

  const children = (content as { children?: unknown }).children;
  return Array.isArray(children) ? (children as NotionBlock[]) : [];
}
