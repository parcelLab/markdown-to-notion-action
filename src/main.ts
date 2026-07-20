import * as core from "@actions/core";
import { Client } from "@notionhq/client";

import { appendBlocksSafe, appendPageLinksAfterAnchor } from "./block-sync.js";
import {
  buildDatabasePageProperties,
  buildSourceUrl,
  loadDatabaseSyncState,
} from "./database-sync-state.js";
import {
  buildBlocksForDocument,
  buildNotionPageTitle,
  collectMarkdownFiles,
  ensureDirectoryExists,
  loadMarkdownDocuments,
  normalizeDocumentPath,
} from "./documents.js";
import { createLogContext, describeError } from "./logging.js";
import { appendSyncStateRecord, loadSyncState, writeSyncState } from "./notion-sync-state.js";
import {
  isNotionArchivedError,
  isNotionNotFoundError,
  normalizeNotionId,
  notionPageUrl,
} from "./notion-api.js";
import {
  archivePageIfPresent,
  createDataSourcePage,
  createPage,
  getSyncDecision,
  resolveParentPageId,
  updateDataSourcePageContent,
  updateDataSourcePageProperties,
  updatePageContent,
} from "./page-sync.js";
import { resolveInsideRoot } from "./path-utils.js";
import {
  normalizePrivateMarkdownPrefix,
  normalizeTitlePrefixSeparator,
  readInput,
} from "./action-inputs.js";
import type { DatabaseSyncState } from "./database-sync-state.js";
import type { MarkdownDocument, SyncStateEntry, SyncedPage } from "./sync-types.js";

type RuntimeContext = {
  docsFolderPath: string;
  githubToken: string | null;
  notion: Client;
  privateMarkdownPrefix: string | null;
  titlePrefixSeparator: string;
  workspaceRoot: string;
};

async function run(): Promise<void> {
  try {
    const actionRef = process.env.ACTION_SOURCE_REF || process.env.GITHUB_ACTION_REF || "unknown";
    const actionRepo =
      process.env.ACTION_SOURCE_REPOSITORY || process.env.GITHUB_ACTION_REPOSITORY || "unknown";
    core.info(`Action source: ${actionRepo}@${actionRef}`);

    const notionToken = readInput("notion_token", ["NOTION_TOKEN"]);
    const docsFolder = readInput("docs_folder", ["DOCS_FOLDER"]);
    const pageBlockInput = readInput("page_block_id", ["PAGE_BLOCK_ID"]);
    const pageInput = readInput("page_id", ["PAGE_ID"]);
    const databaseInput = readInput("database_id", ["DATABASE_ID"]);
    const privateMarkdownPrefixInput = readInput("private_markdown_prefix", [
      "PRIVATE_MARKDOWN_PREFIX",
    ]);
    const titlePrefixSeparatorInput = readInput("title_prefix_separator", [
      "TITLE_PREFIX_SEPARATOR",
    ]);
    const githubToken = readInput("github_token", ["GITHUB_TOKEN"]);

    if (!notionToken || !docsFolder) {
      throw new Error("Missing required inputs. Check notion_token and docs_folder.");
    }

    core.setSecret(notionToken);
    if (githubToken) {
      core.setSecret(githubToken);
    }

    const notion = new Client({ auth: notionToken });
    const workspaceRoot = process.env.GITHUB_WORKSPACE || process.cwd();
    const docsFolderPath = resolveInsideRoot(workspaceRoot, docsFolder, "docs_folder");
    await ensureDirectoryExists(docsFolderPath);

    const privateMarkdownPrefix = normalizePrivateMarkdownPrefix(privateMarkdownPrefixInput);
    if (privateMarkdownPrefix) {
      core.info(`Skipping markdown files whose file name starts with '${privateMarkdownPrefix}'.`);
    } else {
      core.info("Private markdown file prefix disabled; all markdown files can be synced.");
    }

    const context: RuntimeContext = {
      docsFolderPath,
      githubToken,
      notion,
      privateMarkdownPrefix,
      titlePrefixSeparator: normalizeTitlePrefixSeparator(titlePrefixSeparatorInput),
      workspaceRoot,
    };

    if (databaseInput) {
      const pageBlockId = pageBlockInput ? normalizeNotionId(pageBlockInput) : null;
      const pageBlockParentId = pageBlockId ? await resolveParentPageId(notion, pageBlockId) : null;
      await syncDatabaseMode(context, databaseInput, pageBlockId, pageBlockParentId);
      return;
    }

    await syncPageMode(context, pageInput, pageBlockInput);
  } catch (error) {
    core.setFailed(describeError(error));
  }
}

async function syncDatabaseMode(
  context: RuntimeContext,
  databaseInput: string,
  pageBlockId: string | null,
  pageBlockParentId: string | null,
): Promise<void> {
  const repository = process.env.GITHUB_REPOSITORY || "local";
  const databaseState = await loadDatabaseSyncState(
    context.notion,
    databaseInput,
    repository,
    createLogContext("database"),
  );
  const documents = await loadDocuments(context, databaseState.entries);
  const knownPageUrls = buildKnownPageUrls(documents);
  const syncedPages: SyncedPage[] = [];

  for (const documentEntry of documents) {
    try {
      const syncedPage = await syncDocumentToDatabase(
        context,
        databaseState,
        repository,
        documentEntry,
        knownPageUrls,
      );
      if (syncedPage) {
        syncedPages.push(syncedPage);
      }
    } catch (error) {
      core.warning(`Failed to sync ${documentEntry.relPath}: ${describeError(error)}`);
    }
  }

  if (pageBlockId && pageBlockParentId && syncedPages.length) {
    await appendPageLinksAfterAnchor(
      context.notion,
      pageBlockParentId,
      pageBlockId,
      syncedPages,
      createLogContext("index"),
    );
  }

  const currentDocumentPaths = getCurrentDocumentPaths(documents);
  await removeStaleSyncStateEntries(context.notion, databaseState.entries, currentDocumentPaths);
}

async function syncDocumentToDatabase(
  context: RuntimeContext,
  databaseState: DatabaseSyncState,
  repository: string,
  documentEntry: MarkdownDocument,
  knownPageUrls: Map<string, string>,
): Promise<SyncedPage | null> {
  const documentLog = createLogContext(documentEntry.relPath);
  documentLog.info(`Sync start: ${documentEntry.title}`);

  const documentPath = normalizeDocumentPath(documentEntry.relPath);
  const pageTitle = buildNotionPageTitle(documentEntry, context.titlePrefixSeparator);
  const existingSyncStateEntry = databaseState.entries.get(documentPath);
  let pageId = documentEntry.notionPageId;
  let pageUrl = documentEntry.notionUrl;

  if (!pageId) {
    const matchedPageId = databaseState.pageIdsByTitle.get(pageTitle);
    if (matchedPageId) {
      pageId = matchedPageId;
      pageUrl = notionPageUrl(matchedPageId);
      documentLog.info(`Matched existing Notion database page by generated title: ${pageTitle}`);
    }
  }

  const requiresForcedSync =
    !existingSyncStateEntry?.sourceHash || existingSyncStateEntry.title !== pageTitle;

  if (pageId) {
    const unchanged =
      existingSyncStateEntry?.sourceHash === documentEntry.sourceHash &&
      existingSyncStateEntry.title === pageTitle;
    if (unchanged) {
      documentLog.info("Skipping sync: source hash unchanged.");
      pageUrl = pageUrl ?? notionPageUrl(pageId);
    } else {
      const decision = await getSyncDecision(
        context.notion,
        pageId,
        documentEntry.absPath,
        context.githubToken,
        context.workspaceRoot,
        documentLog,
      );

      if (decision.archivedOrMissing) {
        documentLog.warn(`Notion page missing or archived, recreating: ${pageTitle}`);
        pageId = undefined;
      } else if (decision.skipSync && !requiresForcedSync) {
        documentLog.info("Skipping sync: Notion is up to date.");
        pageUrl = pageUrl ?? notionPageUrl(pageId);
      } else {
        try {
          await updateDatabasePage(
            context,
            databaseState,
            repository,
            documentEntry,
            pageTitle,
            pageId,
            knownPageUrls,
          );
          pageUrl = notionPageUrl(pageId);
          documentLog.info(`Updated page: ${pageTitle}`);
        } catch (error) {
          if (!isNotionArchivedError(error) && !isNotionNotFoundError(error)) {
            throw error;
          }
          documentLog.warn(`Notion page missing or archived, recreating: ${pageTitle}`);
          pageId = undefined;
        }
      }
    }
  }

  if (!pageId) {
    const created = await createDatabasePage(
      context,
      databaseState,
      repository,
      documentEntry,
      pageTitle,
      knownPageUrls,
    );
    pageId = created.pageId;
    pageUrl = created.pageUrl;
  }

  if (!pageId || !pageUrl) {
    return null;
  }

  const normalizedPageId = normalizeNotionId(pageId);
  databaseState.entries.set(documentPath, {
    pageId: normalizedPageId,
    sourceHash: documentEntry.sourceHash,
    title: pageTitle,
  });
  knownPageUrls.set(documentEntry.absPath, pageUrl);
  return { pageId: normalizedPageId, title: pageTitle };
}

async function updateDatabasePage(
  context: RuntimeContext,
  databaseState: DatabaseSyncState,
  repository: string,
  documentEntry: MarkdownDocument,
  pageTitle: string,
  pageId: string,
  knownPageUrls: Map<string, string>,
): Promise<void> {
  const documentPath = normalizeDocumentPath(documentEntry.relPath);
  const documentLog = createLogContext(documentEntry.relPath);
  const propertiesBeforeContent = buildDatabasePageProperties(
    databaseState.propertyNames,
    repository,
    documentPath,
    pageTitle,
    undefined,
    buildSourceUrl(context.workspaceRoot, documentEntry.absPath),
  );
  const blocks = await buildBlocksForDocument(
    context.notion,
    documentEntry,
    context.docsFolderPath,
    context.workspaceRoot,
    knownPageUrls,
    context.githubToken,
    documentLog,
  );
  await updateDataSourcePageContent(
    context.notion,
    pageId,
    propertiesBeforeContent,
    blocks,
    documentLog,
  );
  await updateDataSourcePageProperties(
    context.notion,
    pageId,
    buildDatabasePageProperties(
      databaseState.propertyNames,
      repository,
      documentPath,
      pageTitle,
      documentEntry.sourceHash,
      buildSourceUrl(context.workspaceRoot, documentEntry.absPath),
    ),
  );
}

async function createDatabasePage(
  context: RuntimeContext,
  databaseState: DatabaseSyncState,
  repository: string,
  documentEntry: MarkdownDocument,
  pageTitle: string,
  knownPageUrls: Map<string, string>,
): Promise<{ pageId: string; pageUrl: string }> {
  const documentPath = normalizeDocumentPath(documentEntry.relPath);
  const documentLog = createLogContext(documentEntry.relPath);
  const created = await createDataSourcePage(
    context.notion,
    databaseState.dataSourceId,
    buildDatabasePageProperties(
      databaseState.propertyNames,
      repository,
      documentPath,
      pageTitle,
      undefined,
      buildSourceUrl(context.workspaceRoot, documentEntry.absPath),
    ),
  );
  const pageId = normalizeNotionId(created.id);
  const pageUrl = created.url || notionPageUrl(pageId);
  documentLog.info(`Created database page: ${pageTitle}`);
  documentLog.info(`Page URL: ${pageUrl}`);

  databaseState.entries.set(documentPath, {
    pageId,
    title: pageTitle,
  });

  const blocks = await buildBlocksForDocument(
    context.notion,
    documentEntry,
    context.docsFolderPath,
    context.workspaceRoot,
    knownPageUrls,
    context.githubToken,
    documentLog,
  );
  await appendBlocksSafe(context.notion, pageId, blocks, documentLog);
  await updateDataSourcePageProperties(
    context.notion,
    pageId,
    buildDatabasePageProperties(
      databaseState.propertyNames,
      repository,
      documentPath,
      pageTitle,
      documentEntry.sourceHash,
      buildSourceUrl(context.workspaceRoot, documentEntry.absPath),
    ),
  );
  return { pageId, pageUrl };
}

async function syncPageMode(
  context: RuntimeContext,
  pageInput: string,
  pageBlockInput: string,
): Promise<void> {
  const pageBlockId = pageBlockInput ? normalizeNotionId(pageBlockInput) : null;
  const pageBlockParentId = pageBlockId
    ? await resolveParentPageId(context.notion, pageBlockId)
    : null;
  const pagesParentId = pageInput ? normalizeNotionId(pageInput) : pageBlockParentId;
  if (!pagesParentId) {
    throw new Error("Either database_id, page_block_id, or page_id must be provided.");
  }

  const syncState = await loadSyncState(context.notion, pagesParentId);
  const documents = await loadDocuments(context, syncState.entries);
  const knownPageUrls = buildKnownPageUrls(documents);
  const syncedPages: SyncedPage[] = [];
  let syncStateDirty = false;

  for (const documentEntry of documents) {
    try {
      const result = await syncDocumentToPage(
        context,
        syncState,
        pagesParentId,
        documentEntry,
        knownPageUrls,
      );
      if (result.syncedPage) {
        syncedPages.push(result.syncedPage);
      }
      syncStateDirty = syncStateDirty || result.syncStateDirty;
    } catch (error) {
      core.warning(`Failed to sync ${documentEntry.relPath}: ${describeError(error)}`);
    }
  }

  if (pageBlockId && pageBlockParentId && syncedPages.length) {
    await appendPageLinksAfterAnchor(
      context.notion,
      pageBlockParentId,
      pageBlockId,
      syncedPages,
      createLogContext("index"),
    );
  }

  const removedStaleEntries = await removeStaleSyncStateEntries(
    context.notion,
    syncState.entries,
    getCurrentDocumentPaths(documents),
  );
  syncStateDirty = syncStateDirty || removedStaleEntries;

  if (syncStateDirty) {
    await writeSyncState(context.notion, syncState.pageId, syncState.entries);
  } else {
    core.info("Sync state unchanged.");
  }
}

type PageSyncState = Awaited<ReturnType<typeof loadSyncState>>;

async function syncDocumentToPage(
  context: RuntimeContext,
  syncState: PageSyncState,
  pagesParentId: string,
  documentEntry: MarkdownDocument,
  knownPageUrls: Map<string, string>,
): Promise<{ syncStateDirty: boolean; syncedPage: SyncedPage | null }> {
  const documentLog = createLogContext(documentEntry.relPath);
  documentLog.info(`Sync start: ${documentEntry.title}`);
  const documentPath = normalizeDocumentPath(documentEntry.relPath);
  const pageTitle = buildNotionPageTitle(documentEntry, context.titlePrefixSeparator);
  let pageId = documentEntry.notionPageId;
  let pageUrl = documentEntry.notionUrl;
  const existingSyncStateEntry = syncState.entries.get(documentPath);
  let syncStateDirty = false;

  const requiresForcedSync =
    !existingSyncStateEntry?.sourceHash || existingSyncStateEntry.title !== pageTitle;
  if (
    pageId &&
    existingSyncStateEntry?.pageId &&
    !syncState.childPageIds.has(normalizeNotionId(pageId))
  ) {
    documentLog.warn("Notion page no longer exists under the target parent, recreating.");
    pageId = undefined;
    pageUrl = undefined;
  }

  if (!pageId) {
    const matchedPageId = syncState.childPageIdsByTitle.get(pageTitle);
    if (matchedPageId) {
      pageId = matchedPageId;
      pageUrl = notionPageUrl(matchedPageId);
      documentLog.info(`Matched existing Notion child page by generated title: ${pageTitle}`);
    }
  }

  if (pageId) {
    if (
      existingSyncStateEntry?.sourceHash === documentEntry.sourceHash &&
      existingSyncStateEntry.title === pageTitle
    ) {
      documentLog.info("Skipping sync: source hash unchanged.");
      pageUrl = pageUrl ?? notionPageUrl(pageId);
    } else {
      const decision = await getSyncDecision(
        context.notion,
        pageId,
        documentEntry.absPath,
        context.githubToken,
        context.workspaceRoot,
        documentLog,
      );

      if (decision.archivedOrMissing) {
        documentLog.warn(`Notion page missing or archived, recreating: ${pageTitle}`);
        pageId = undefined;
      } else if (decision.skipSync && !requiresForcedSync) {
        documentLog.info("Skipping sync: Notion is up to date.");
        pageUrl = pageUrl ?? notionPageUrl(pageId);
      } else {
        try {
          const blocks = await buildBlocksForDocument(
            context.notion,
            documentEntry,
            context.docsFolderPath,
            context.workspaceRoot,
            knownPageUrls,
            context.githubToken,
            documentLog,
          );
          await updatePageContent(context.notion, pageId, pageTitle, blocks, documentLog);
          pageUrl = notionPageUrl(pageId);
          documentLog.info(`Updated page: ${pageTitle}`);
        } catch (error) {
          if (!isNotionArchivedError(error) && !isNotionNotFoundError(error)) {
            throw error;
          }
          documentLog.warn(`Notion page missing or archived, recreating: ${pageTitle}`);
          pageId = undefined;
        }
      }
    }
  }

  if (!pageId) {
    const created = await createPage(context.notion, pagesParentId, pageTitle);
    pageId = normalizeNotionId(created.id);
    syncState.childPageIds.add(pageId);
    syncState.childPageIdsByTitle.set(pageTitle, pageId);
    pageUrl = created.url || notionPageUrl(pageId);
    documentLog.info(`Created page: ${pageTitle}`);
    documentLog.info(`Page URL: ${pageUrl}`);

    syncState.entries.set(documentPath, {
      pageId,
      title: pageTitle,
    });
    syncStateDirty = true;
    await appendSyncStateRecord(context.notion, syncState.pageId, documentPath, {
      pageId,
      title: pageTitle,
    });

    const blocks = await buildBlocksForDocument(
      context.notion,
      documentEntry,
      context.docsFolderPath,
      context.workspaceRoot,
      knownPageUrls,
      context.githubToken,
      documentLog,
    );
    await appendBlocksSafe(context.notion, pageId, blocks, documentLog);
  }

  if (!pageId || !pageUrl) {
    return { syncStateDirty, syncedPage: null };
  }

  const normalizedPageId = normalizeNotionId(pageId);
  if (
    !existingSyncStateEntry ||
    normalizeNotionId(existingSyncStateEntry.pageId) !== normalizedPageId ||
    existingSyncStateEntry.sourceHash !== documentEntry.sourceHash ||
    existingSyncStateEntry.title !== pageTitle
  ) {
    syncState.entries.set(documentPath, {
      pageId: normalizedPageId,
      sourceHash: documentEntry.sourceHash,
      title: pageTitle,
    });
    syncStateDirty = true;
  }

  knownPageUrls.set(documentEntry.absPath, pageUrl);
  return { syncStateDirty, syncedPage: { pageId: normalizedPageId, title: pageTitle } };
}

async function loadDocuments(
  context: RuntimeContext,
  syncStateEntries: Map<string, SyncStateEntry>,
): Promise<MarkdownDocument[]> {
  const markdownFiles = await collectMarkdownFiles(
    context.docsFolderPath,
    context.privateMarkdownPrefix,
  );
  if (!markdownFiles.length) {
    core.warning(`No markdown files found in ${context.docsFolderPath}.`);
  }
  return loadMarkdownDocuments(markdownFiles, context.docsFolderPath, syncStateEntries);
}

function buildKnownPageUrls(documents: MarkdownDocument[]): Map<string, string> {
  const knownPageUrls = new Map<string, string>();
  for (const documentEntry of documents) {
    if (documentEntry.notionPageId) {
      knownPageUrls.set(documentEntry.absPath, notionPageUrl(documentEntry.notionPageId));
    }
  }
  return knownPageUrls;
}

function getCurrentDocumentPaths(documents: MarkdownDocument[]): Set<string> {
  return new Set(documents.map((documentEntry) => normalizeDocumentPath(documentEntry.relPath)));
}

async function removeStaleSyncStateEntries(
  notion: Client,
  syncStateEntries: Map<string, SyncStateEntry>,
  currentDocumentPaths: Set<string>,
): Promise<boolean> {
  const staleEntries = Array.from(syncStateEntries.entries()).filter(
    ([documentPath]) => !currentDocumentPaths.has(documentPath),
  );
  if (!staleEntries.length) {
    return false;
  }

  const activePageIds = new Set<string>();
  for (const [documentPath, syncStateEntry] of syncStateEntries.entries()) {
    if (!currentDocumentPaths.has(documentPath)) {
      continue;
    }
    activePageIds.add(normalizeNotionId(syncStateEntry.pageId));
  }

  let removedEntries = false;
  for (const [stalePath, staleEntry] of staleEntries) {
    const staleLog = createLogContext(stalePath);
    const normalizedPageId = normalizeNotionId(staleEntry.pageId);
    if (activePageIds.has(normalizedPageId)) {
      staleLog.info(
        `Removing stale sync state record for path that no longer exists. Page ${normalizedPageId} is still referenced by another active markdown file.`,
      );
    } else {
      staleLog.info(
        "Markdown file no longer exists. Archiving the mapped Notion page and removing the stale sync state record.",
      );
      await archivePageIfPresent(notion, normalizedPageId, staleLog);
    }
    syncStateEntries.delete(stalePath);
    removedEntries = true;
  }

  return removedEntries;
}

run();
