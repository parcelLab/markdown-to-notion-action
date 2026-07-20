import type { Client } from "@notionhq/client";

import { appendBlocksSafe, syncPageBlocks } from "./block-sync.js";
import { createLogContext } from "./logging.js";
import {
  listAllChildren,
  normalizeNotionId,
  notionPageUrl,
  notionRequest,
  toDashedId,
} from "./notion-api.js";
import { createPage } from "./page-sync.js";
import type { LogContext } from "./logging.js";
import type { NotionBlock, NotionRichText } from "./notion-types.js";
import type { PartialBlockObjectResponse } from "./notion-api.js";
import type { SyncStateEntry } from "./sync-types.js";

const SYNC_STATE_PAGE_TITLE = "_Markdown to Notion Sync Data (do not edit)";
const MAX_CODE_BLOCK_CHARS = 1500;

type SyncStateRecord = {
  h?: unknown;
  i?: unknown;
  p?: unknown;
  t?: unknown;
  type?: unknown;
};

export type SyncStateHandle = {
  childPageIds: Set<string>;
  childPageIdsByTitle: Map<string, string>;
  entries: Map<string, SyncStateEntry>;
  pageId: string;
};

export async function loadSyncState(
  notion: Client,
  parentPageId: string,
  logContext: LogContext = createLogContext("sync-state"),
): Promise<SyncStateHandle> {
  const parentChildren = await listAllChildren(notion, parentPageId);
  const childPageIds = collectChildPageIds(parentChildren);
  const childPageIdsByTitle = collectUniqueChildPageIdsByTitle(parentChildren, logContext);
  const existingPageId = findSyncStatePageId(parentChildren, logContext);
  if (existingPageId) {
    const entries = await readSyncStateEntries(notion, existingPageId, logContext);
    logContext.info(`Loaded ${entries.size} sync state records from Notion.`);
    return { childPageIds, childPageIdsByTitle, entries, pageId: existingPageId };
  }

  const created = await createPage(notion, parentPageId, SYNC_STATE_PAGE_TITLE);
  const pageId = normalizeNotionId(created.id);
  childPageIds.add(pageId);
  childPageIdsByTitle.set(SYNC_STATE_PAGE_TITLE, pageId);
  logContext.info(`Created sync state page: ${SYNC_STATE_PAGE_TITLE}`);
  if (created.url) {
    logContext.info(`Sync state page URL: ${created.url}`);
  }
  await writeSyncState(notion, pageId, new Map(), logContext);
  return { childPageIds, childPageIdsByTitle, entries: new Map(), pageId };
}

export async function appendSyncStateRecord(
  notion: Client,
  syncStatePageId: string,
  documentPath: string,
  entry: SyncStateEntry,
  logContext: LogContext = createLogContext("sync-state"),
): Promise<void> {
  const record = serializeSyncStateRecord(documentPath, entry);
  if (record.length > MAX_CODE_BLOCK_CHARS) {
    logContext.warn(
      `Sync state record for ${documentPath} is ${record.length} characters, which is above the ${MAX_CODE_BLOCK_CHARS} character target.`,
    );
  }

  await appendBlocksSafe(notion, syncStatePageId, [buildCodeBlock(record)], logContext);
  logContext.info(`Saved immediate sync state record for ${documentPath}.`);
}

export async function writeSyncState(
  notion: Client,
  syncStatePageId: string,
  entries: Map<string, SyncStateEntry>,
  logContext: LogContext = createLogContext("sync-state"),
): Promise<void> {
  const blocks = buildSyncStateBlocks(entries);
  logContext.info(`Writing ${entries.size} sync state records to Notion.`);
  await updatePageTitle(notion, syncStatePageId);
  await syncPageBlocks(notion, syncStatePageId, blocks, logContext);
}

function findSyncStatePageId(
  children: PartialBlockObjectResponse[],
  logContext: LogContext,
): string | null {
  const matches = children.filter(isSyncStateChildPage);
  if (matches.length > 1) {
    logContext.warn(
      `Found ${matches.length} sync state pages named ${SYNC_STATE_PAGE_TITLE}. Using the first one.`,
    );
  }

  const match = matches[0];
  if (!match) {
    return null;
  }
  return normalizeNotionId(match.id);
}

function collectChildPageIds(children: PartialBlockObjectResponse[]): Set<string> {
  const ids = new Set<string>();
  for (const child of children) {
    const pageId = getChildPageId(child);
    if (pageId) {
      ids.add(pageId);
    }
  }
  return ids;
}

function getChildPageId(block: PartialBlockObjectResponse): string | null {
  if (!("type" in block) || block.type !== "child_page") {
    return null;
  }
  if (!("id" in block) || typeof block.id !== "string") {
    return null;
  }
  return normalizeNotionId(block.id);
}

function collectUniqueChildPageIdsByTitle(
  children: PartialBlockObjectResponse[],
  logContext: LogContext,
): Map<string, string> {
  const pageIdsByTitle = new Map<string, string>();
  const duplicatedTitles = new Set<string>();

  for (const child of children) {
    const title = getChildPageTitle(child);
    const pageId = getChildPageId(child);
    if (!title || !pageId) {
      continue;
    }

    if (pageIdsByTitle.has(title)) {
      pageIdsByTitle.delete(title);
      duplicatedTitles.add(title);
      continue;
    }
    if (!duplicatedTitles.has(title)) {
      pageIdsByTitle.set(title, pageId);
    }
  }

  if (duplicatedTitles.size > 0) {
    logContext.warn(
      `Ignoring ${duplicatedTitles.size} duplicate child page title(s) when matching existing pages to markdown files.`,
    );
  }

  return pageIdsByTitle;
}

function getChildPageTitle(block: PartialBlockObjectResponse): string | null {
  if (!("type" in block) || block.type !== "child_page") {
    return null;
  }
  if (!("child_page" in block) || typeof block.child_page !== "object" || !block.child_page) {
    return null;
  }

  const childPage = block.child_page as { title?: unknown };
  return typeof childPage.title === "string" ? childPage.title : null;
}

function isSyncStateChildPage(
  block: PartialBlockObjectResponse,
): block is PartialBlockObjectResponse & {
  child_page: { title: string };
  id: string;
  type: "child_page";
} {
  return getChildPageTitle(block) === SYNC_STATE_PAGE_TITLE && getChildPageId(block) !== null;
}

async function readSyncStateEntries(
  notion: Client,
  syncStatePageId: string,
  logContext: LogContext,
): Promise<Map<string, SyncStateEntry>> {
  const entries = new Map<string, SyncStateEntry>();
  const blocks = await listAllChildren(notion, syncStatePageId);
  for (const block of blocks) {
    const content = getCodeBlockContent(block);
    if (!content) {
      continue;
    }

    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      const parsed = parseSyncStateRecord(trimmed, logContext);
      if (!parsed) {
        continue;
      }
      entries.set(parsed.path, parsed.entry);
    }
  }
  return entries;
}

function getCodeBlockContent(block: PartialBlockObjectResponse): string | null {
  if (!("type" in block) || block.type !== "code") {
    return null;
  }
  if (!("code" in block) || typeof block.code !== "object" || !block.code) {
    return null;
  }

  const code = block.code as { rich_text?: unknown };
  if (!Array.isArray(code.rich_text)) {
    return null;
  }

  return code.rich_text.map((value) => getRichTextContent(value)).join("");
}

function getRichTextContent(value: unknown): string {
  if (!value || typeof value !== "object") {
    return "";
  }

  const richText = value as { plain_text?: unknown; text?: { content?: unknown } };
  if (typeof richText.plain_text === "string") {
    return richText.plain_text;
  }
  if (typeof richText.text?.content === "string") {
    return richText.text.content;
  }
  return "";
}

function parseSyncStateRecord(
  line: string,
  logContext: LogContext,
): { entry: SyncStateEntry; path: string } | null {
  let record: SyncStateRecord;
  try {
    record = JSON.parse(line) as SyncStateRecord;
  } catch {
    logContext.warn("Ignoring invalid sync state JSONL record.");
    return null;
  }

  if (record.type === "meta") {
    return null;
  }
  if (typeof record.p !== "string" || typeof record.i !== "string") {
    logContext.warn("Ignoring sync state record without path or page id.");
    return null;
  }

  try {
    return {
      entry: {
        pageId: normalizeNotionId(record.i),
        sourceHash: typeof record.h === "string" && record.h ? record.h : undefined,
        title: typeof record.t === "string" && record.t ? record.t : undefined,
      },
      path: record.p,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logContext.warn(`Ignoring sync state record for ${record.p}: ${message}`);
    return null;
  }
}

function buildSyncStateBlocks(entries: Map<string, SyncStateEntry>): NotionBlock[] {
  return [buildWarningCallout(), ...buildCodeBlocks(entries)];
}

function buildWarningCallout(): NotionBlock {
  return {
    type: "callout",
    callout: {
      icon: { type: "emoji", emoji: "⚠️" },
      color: "red_background",
      rich_text: [
        buildText(
          "Do not edit this page. It is managed by markdown-to-notion-action and stores sync state.",
        ),
      ],
    },
  };
}

function buildCodeBlocks(entries: Map<string, SyncStateEntry>): NotionBlock[] {
  const lines = [buildMetaRecord(), ...buildSortedRecords(entries)];
  const chunks = chunkLines(lines);
  return chunks.map((chunk) => buildCodeBlock(chunk));
}

function buildSortedRecords(entries: Map<string, SyncStateEntry>): string[] {
  return [...entries]
    .sort(([firstPath], [secondPath]) => firstPath.localeCompare(secondPath))
    .map(([documentPath, entry]) => serializeSyncStateRecord(documentPath, entry));
}

function buildMetaRecord(): string {
  return JSON.stringify({
    type: "meta",
    version: 1,
    updated_at: new Date().toISOString(),
  });
}

function chunkLines(lines: string[]): string[] {
  const chunks: string[] = [];
  let current = "";

  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (!current || next.length <= MAX_CODE_BLOCK_CHARS) {
      current = next;
      continue;
    }

    chunks.push(current);
    current = line;
  }

  if (current) {
    chunks.push(current);
  }
  return chunks;
}

function buildCodeBlock(content: string): NotionBlock {
  return {
    type: "code",
    code: {
      language: "json",
      rich_text: [buildText(content)],
    },
  };
}

function serializeSyncStateRecord(documentPath: string, entry: SyncStateEntry): string {
  return JSON.stringify({
    p: documentPath,
    i: normalizeNotionId(entry.pageId),
    h: entry.sourceHash,
    t: entry.title,
    u: notionPageUrl(entry.pageId),
  });
}

function buildText(content: string): NotionRichText {
  return {
    type: "text",
    text: { content },
  };
}

async function updatePageTitle(notion: Client, syncStatePageId: string): Promise<void> {
  await notionRequest(
    () =>
      notion.pages.update({
        page_id: toDashedId(syncStatePageId),
        properties: {
          title: {
            title: [
              {
                type: "text",
                text: { content: SYNC_STATE_PAGE_TITLE },
              },
            ],
          },
        },
      }),
    `pages.update ${syncStatePageId}`,
  );
}
