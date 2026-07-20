import assert from "node:assert/strict";
import test from "node:test";

import { extractTitle, markdownToNotionBlocks } from "../src/markdown-to-notion.js";
import type { NotionBlock } from "../src/notion-types.js";

test("extractTitle returns the first non-empty H1", () => {
  assert.equal(extractTitle("## Intro\n\n# Getting Started\n\nContent"), "Getting Started");
});

test("markdownToNotionBlocks converts table of contents placeholders", () => {
  const blocks = markdownToNotionBlocks("# Guide\n\n[TOC]");

  assert.equal(
    blocks.some((block) => block.type === "table_of_contents"),
    true,
  );
});

test("markdownToNotionBlocks resolves relative markdown links and drops unsafe links", () => {
  const blocks = markdownToNotionBlocks("[Next](next.md) and [Bad](javascript:alert(1))", {
    resolveLink: (href) => (href === "next.md" ? "https://www.notion.so/abc123" : null),
  });
  const richText = getFirstRichText(blocks);

  assert.equal(richText[0]?.text.link?.url, "https://www.notion.so/abc123");
  assert.equal(richText.at(-1)?.text.link, null);
});

test("markdownToNotionBlocks restores standalone markdown images as Notion image blocks", () => {
  const blocks = markdownToNotionBlocks("![Diagram](assets/flow.png)", {
    resolveLink: (href) => `https://raw.githubusercontent.com/example/repo/main/docs/${href}`,
  });

  assert.deepEqual(blocks[0], {
    type: "image",
    image: {
      type: "external",
      external: {
        url: "https://raw.githubusercontent.com/example/repo/main/docs/assets/flow.png",
      },
      caption: [{ type: "text", text: { content: "Diagram" } }],
    },
  });
});

function getFirstRichText(
  blocks: NotionBlock[],
): Array<{ text: { link: { url: string } | null } }> {
  const firstBlock = blocks[0];
  assert.equal(firstBlock?.type, "paragraph");
  return firstBlock.paragraph?.rich_text as Array<{ text: { link: { url: string } | null } }>;
}
