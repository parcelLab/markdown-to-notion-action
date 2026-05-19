import * as core from "@actions/core";
import { Client } from "@notionhq/client";

import {
  normalizePrivateMarkdownPrefix,
  normalizeTitlePrefixSeparator,
  readInput,
} from "./action-inputs.js";
import { appendBlocksSafe, appendPageLinksAfterAnchor } from "./block-sync.js";
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
  createPage,
  getSyncDecision,
  resolveParentPageId,
  updatePageContent,
} from "./page-sync.js";
import { resolveInsideRoot } from "./path-utils.js";
import type { SyncStateEntry, SyncedPage } from "./sync-types.js";

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

    const pageBlockId = pageBlockInput ? normalizeNotionId(pageBlockInput) : null;
    const pageBlockParentId = pageBlockId ? await resolveParentPageId(notion, pageBlockId) : null;
    const pagesParentId = pageInput ? normalizeNotionId(pageInput) : pageBlockParentId;
    if (!pagesParentId) {
      throw new Error("Either page_block_id or page_id must be provided.");
    }

    const titlePrefixSeparator = normalizeTitlePrefixSeparator(titlePrefixSeparatorInput);
    const privateMarkdownPrefix = normalizePrivateMarkdownPrefix(privateMarkdownPrefixInput);
    const syncState = await loadSyncState(notion, pagesParentId);

    if (privateMarkdownPrefix) {
      core.info(`Skipping markdown files whose file name starts with '${privateMarkdownPrefix}'.`);
    } else {
      core.info("Private markdown file prefix disabled; all markdown files can be synced.");
    }

    const markdownFiles = await collectMarkdownFiles(docsFolderPath, privateMarkdownPrefix);
    if (!markdownFiles.length) {
      core.warning(`No markdown files found in ${docsFolderPath}.`);
    }

    const documents = await loadMarkdownDocuments(markdownFiles, docsFolderPath, syncState.entries);

    const knownPageUrls = new Map<string, string>();
    for (const documentEntry of documents) {
      if (documentEntry.notionPageId) {
        knownPageUrls.set(documentEntry.absPath, notionPageUrl(documentEntry.notionPageId));
      }
    }

    const syncedPages: SyncedPage[] = [];
    let syncStateDirty = false;
    const currentDocumentPaths = new Set<string>(
      documents.map((documentEntry) => normalizeDocumentPath(documentEntry.relPath)),
    );

    for (const documentEntry of documents) {
      try {
        const documentLog = createLogContext(documentEntry.relPath);
        documentLog.info(`Sync start: ${documentEntry.title}`);
        const documentPath = normalizeDocumentPath(documentEntry.relPath);
        const pageTitle = buildNotionPageTitle(documentEntry, titlePrefixSeparator);
        let pageId = documentEntry.notionPageId;
        let pageUrl = documentEntry.notionUrl;
        const existingSyncStateEntry = syncState.entries.get(documentPath);
        const requiresForcedSync =
          !existingSyncStateEntry?.sourceHash || existingSyncStateEntry.title !== pageTitle;
        if (
          pageId &&
          existingSyncStateEntry?.pageId &&
          !syncState.childPageIds.has(normalizeNotionId(pageId))
        ) {
          documentLog.warn(`Notion page no longer exists under the target parent, recreating.`);
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
              notion,
              pageId,
              documentEntry.absPath,
              githubToken,
              workspaceRoot,
              documentLog,
            );

            if (decision.archivedOrMissing) {
              documentLog.warn(`Notion page missing or archived, recreating: ${pageTitle}`);
              pageId = undefined;
            } else if (decision.skipSync && !requiresForcedSync) {
              documentLog.info("Skipping sync: Notion is up to date.");
              pageUrl = pageUrl ?? notionPageUrl(pageId);
            } else {
              const blocks = await buildBlocksForDocument(
                notion,
                documentEntry,
                docsFolderPath,
                workspaceRoot,
                knownPageUrls,
                githubToken,
                documentLog,
              );

              try {
                await updatePageContent(notion, pageId, pageTitle, blocks, documentLog);
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
          const created = await createPage(notion, pagesParentId, pageTitle);
          pageId = normalizeNotionId(created.id);
          syncState.childPageIds.add(pageId);
          syncState.childPageIdsByTitle.set(pageTitle, pageId);
          pageUrl = created.url || notionPageUrl(pageId);
          documentLog.info(`Created page: ${pageTitle}`);
          if (pageUrl) {
            documentLog.info(`Page URL: ${pageUrl}`);
          }

          syncState.entries.set(documentPath, {
            pageId,
            title: pageTitle,
          });
          syncStateDirty = true;
          await appendSyncStateRecord(notion, syncState.pageId, documentPath, {
            pageId,
            title: pageTitle,
          });

          const blocks = await buildBlocksForDocument(
            notion,
            documentEntry,
            docsFolderPath,
            workspaceRoot,
            knownPageUrls,
            githubToken,
            documentLog,
          );
          await appendBlocksSafe(notion, pageId, blocks, documentLog);
        }

        if (pageId && pageUrl) {
          knownPageUrls.set(documentEntry.absPath, pageUrl);
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

          syncedPages.push({ pageId, title: pageTitle });
        }
      } catch (error) {
        core.warning(`Failed to sync ${documentEntry.relPath}: ${describeError(error)}`);
      }
    }

    if (pageBlockId && pageBlockParentId && syncedPages.length > 0) {
      await appendPageLinksAfterAnchor(
        notion,
        pageBlockParentId,
        pageBlockId,
        syncedPages,
        createLogContext("index"),
      );
    }

    const removedStaleEntries = await removeStaleSyncStateEntries(
      notion,
      syncState.entries,
      currentDocumentPaths,
    );
    if (removedStaleEntries) {
      syncStateDirty = true;
    }

    if (syncStateDirty) {
      await writeSyncState(notion, syncState.pageId, syncState.entries);
    } else {
      core.info("Sync state unchanged.");
    }
  } catch (error) {
    core.setFailed(describeError(error));
  }
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
