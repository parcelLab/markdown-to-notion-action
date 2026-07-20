import assert from "node:assert/strict";
import test from "node:test";

import { normalizeNotionId, notionPageUrl, toDashedId } from "../src/notion-api.js";

const PAGE_ID = "387aa331d0584c82ba09feaa972a7550";
const BLOCK_ID = "6ba23314f3084d8fbd9867b7286c9460";

test("normalizeNotionId extracts the block fragment before page and query ids", () => {
  const url = `https://www.notion.so/notion/sample-url-${PAGE_ID}#${BLOCK_ID}`;

  assert.equal(normalizeNotionId(url), BLOCK_ID);
});

test("normalizeNotionId extracts inline database ids before view ids", () => {
  const url =
    "https://app.notion.com/p/parcellab/3a3c37dcb4c480d2ac6df52801c367c3?v=3a3c37dcb4c480f1a72e000c76faf235&source=copy_link";

  assert.equal(normalizeNotionId(url), "3a3c37dcb4c480d2ac6df52801c367c3");
});

test("toDashedId normalizes compact ids for Notion API requests", () => {
  assert.equal(toDashedId(PAGE_ID), "387aa331-d058-4c82-ba09-feaa972a7550");
});

test("notionPageUrl builds a stable page URL from dashed or compact ids", () => {
  assert.equal(notionPageUrl(toDashedId(PAGE_ID)), `https://www.notion.so/${PAGE_ID}`);
});

test("normalizeNotionId rejects values without a Notion id", () => {
  assert.throws(() => normalizeNotionId("not-a-notion-id"), /Invalid Notion id/);
});
