import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  buildNotionPageTitle,
  collectMarkdownFiles,
  loadMarkdownDocuments,
  normalizeDocumentPath,
} from "../src/documents.js";
import type { MarkdownDocument, SyncStateEntry } from "../src/sync-types.js";

const TEST_ROOT = path.join(process.cwd(), "tmp", "test-documents");
const NOTION_PAGE_ID = "387aa331d0584c82ba09feaa972a7550";

test("collectMarkdownFiles skips private markdown files, hidden folders, and node_modules", async () => {
  await resetTestRoot();
  await writeFixture("docs/public.md", "# Public");
  await writeFixture("docs/_private.md", "# Private");
  await writeFixture("docs/.hidden/hidden.md", "# Hidden");
  await writeFixture("docs/node_modules/package/readme.md", "# Dependency");
  await writeFixture("docs/nested/guide.MD", "# Nested");

  const files = await collectMarkdownFiles(path.join(TEST_ROOT, "docs"), "_");
  const relativeFiles = files
    .map((file) => normalizeDocumentPath(path.relative(TEST_ROOT, file)))
    .sort((firstPath, secondPath) => firstPath.localeCompare(secondPath));

  assert.deepEqual(relativeFiles, ["docs/nested/guide.MD", "docs/public.md"]);
});

test("loadMarkdownDocuments prefers sync state ids and hashes markdown body only", async () => {
  await resetTestRoot();
  const docsRoot = path.join(TEST_ROOT, "docs");
  const filePath = await writeFixture(
    "docs/api.md",
    `---\nnotion_page_id: ${NOTION_PAGE_ID}\n---\n# API Guide\n\nBody`,
  );
  const syncEntries = new Map<string, SyncStateEntry>([
    ["api.md", { pageId: "6ba23314f3084d8fbd9867b7286c9460", title: "Old" }],
  ]);

  const [documentEntry] = await loadMarkdownDocuments([filePath], docsRoot, syncEntries);

  assert.equal(documentEntry.relPath, "api.md");
  assert.equal(documentEntry.title, "API Guide");
  assert.equal(documentEntry.notionPageId, "6ba23314f3084d8fbd9867b7286c9460");
  assert.equal(documentEntry.sourceHash, hash("# API Guide\n\nBody"));
});

test("buildNotionPageTitle prefixes nested document folders", () => {
  const documentEntry = {
    relPath: "integrations/payments/adyen.md",
    title: "Adyen Setup",
  } as MarkdownDocument;

  assert.equal(buildNotionPageTitle(documentEntry, "→"), "integrations → payments → Adyen Setup");
});

async function resetTestRoot(): Promise<void> {
  await rm(TEST_ROOT, { force: true, recursive: true });
  await mkdir(TEST_ROOT, { recursive: true });
}

async function writeFixture(relativePath: string, content: string): Promise<string> {
  const filePath = path.join(TEST_ROOT, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
  return filePath;
}

function hash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}
