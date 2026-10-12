import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { recordPageChange, writeSyncSummary } from "../src/sync-summary.js";

const TEST_ROOT = path.join(process.cwd(), "tmp", "test-sync-summary");

test("writeSyncSummary lists changed pages as escaped Notion links", async () => {
  await rm(TEST_ROOT, { force: true, recursive: true });
  await mkdir(TEST_ROOT, { recursive: true });
  const summaryPath = path.join(TEST_ROOT, "summary.md");
  await writeFile(summaryPath, "");
  process.env.GITHUB_STEP_SUMMARY = summaryPath;

  recordPageChange({
    action: "Created",
    title: "Guides <draft> & notes",
    url: "https://www.notion.so/387aa331d0584c82ba09feaa972a7550",
  });
  await writeSyncSummary();

  const summary = await readFile(summaryPath, "utf8");
  assert.match(summary, /<td>Created<\/td>/);
  assert.match(
    summary,
    /<a href="https:\/\/www\.notion\.so\/387aa331d0584c82ba09feaa972a7550">Guides &lt;draft&gt; &amp; notes<\/a>/,
  );
});
