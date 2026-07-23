import * as core from "@actions/core";
import { Client } from "@notionhq/client";
import { createHash } from "node:crypto";
import { load as loadYaml } from "js-yaml";
import * as fs from "node:fs/promises";
import path from "node:path";
import { markdownToNotionBlocks, extractTitle } from "./markdown-to-notion.js";
import { uploadImageBlocks } from "./image-uploads.js";
import { normalizeNotionId, notionPageUrl } from "./notion-api.js";
import { isInsidePath, resolveChildPath, resolveFromDirectory } from "./path-utils.js";
import type { LogContext } from "./logging.js";
import type { NotionBlock } from "./notion-types.js";
import type { MarkdownDocument, SyncStateEntry } from "./sync-types.js";

export async function ensureDirectoryExists(dirPath: string): Promise<void> {
  const stats = await fs.stat(dirPath);
  if (!stats.isDirectory()) {
    throw new Error(`${dirPath} is not a directory.`);
  }
}

export async function collectMarkdownFiles(
  dirPath: string,
  privateMarkdownPrefix: string | null,
): Promise<string[]> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = resolveChildPath(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) {
        continue;
      }
      files.push(...(await collectMarkdownFiles(fullPath, privateMarkdownPrefix)));
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      if (isPrivateMarkdownFile(entry.name, privateMarkdownPrefix)) {
        continue;
      }
      files.push(fullPath);
    }
  }
  return files;
}

export function normalizeDocumentPath(relPath: string): string {
  return relPath.replaceAll("\\", "/");
}

function isPrivateMarkdownFile(fileName: string, privateMarkdownPrefix: string | null): boolean {
  if (!privateMarkdownPrefix) {
    return false;
  }
  return fileName.startsWith(privateMarkdownPrefix);
}

export async function loadMarkdownDocuments(
  markdownFiles: string[],
  docsRoot: string,
  syncStateEntries: Map<string, SyncStateEntry>,
): Promise<MarkdownDocument[]> {
  const documents: MarkdownDocument[] = [];
  for (const filePath of markdownFiles) {
    const markdownContent = await fs.readFile(filePath, "utf8");
    const parsedFrontMatter = parseFrontMatter(markdownContent);
    const frontMatterAttributes = parsedFrontMatter.attributes;
    const markdownBody = parsedFrontMatter.body;

    const relPath = normalizeDocumentPath(path.relative(docsRoot, filePath));
    let notionPageId: string | undefined;
    const syncStateEntry = syncStateEntries.get(relPath);
    if (syncStateEntry?.pageId) {
      notionPageId = normalizeNotionId(syncStateEntry.pageId);
    } else if (
      typeof frontMatterAttributes.notion_page_id === "string" &&
      frontMatterAttributes.notion_page_id.trim().length > 0
    ) {
      try {
        notionPageId = normalizeNotionId(frontMatterAttributes.notion_page_id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        core.warning(`Invalid notion_page_id in ${filePath}: ${message}`);
      }
    }

    const title = extractTitle(markdownBody) || path.basename(filePath, ".md");
    documents.push({
      absPath: filePath,
      attributes: frontMatterAttributes,
      body: markdownBody,
      relPath,
      sourceHash: hashMarkdownBody(markdownBody),
      title,
      notionPageId,
      notionUrl: notionPageId ? notionPageUrl(notionPageId) : undefined,
    });
  }
  return documents;
}

export async function buildBlocksForDocument(
  notion: Client,
  documentEntry: MarkdownDocument,
  docsFolderPath: string,
  workspaceRoot: string,
  knownPageUrls: Map<string, string>,
  githubToken: string | null,
  logContext: LogContext,
): Promise<NotionBlock[]> {
  const blocks = markdownToNotionBlocks(documentEntry.body, {
    logger: (message) => logContext.info(message),
    resolveLink: (href) =>
      resolveRelativeLink(
        href,
        documentEntry.absPath,
        docsFolderPath,
        workspaceRoot,
        knownPageUrls,
      ),
  });
  await uploadImageBlocks(notion, blocks, githubToken, logContext);
  return blocks;
}

export function buildNotionPageTitle(documentEntry: MarkdownDocument, separator: string): string {
  const baseTitle = documentEntry.title || "Untitled";
  const folderPath = normalizeFolderPath(documentEntry.relPath);
  if (!folderPath) {
    return baseTitle;
  }

  const normalizedSeparator = separator.trim();
  const separatorText = normalizedSeparator ? ` ${normalizedSeparator} ` : " ";
  return `${folderPath.split("/").join(separatorText)}${separatorText}${baseTitle}`;
}

function normalizeFolderPath(relPath: string): string {
  const normalized = relPath.replaceAll("\\", "/");
  const dir = path.posix.dirname(normalized);
  if (dir === "." || dir === "/") {
    return "";
  }
  return dir.replace(/^\/+/, "");
}

function resolveRelativeLink(
  href: string,
  currentFilePath: string,
  docsRoot: string,
  workspaceRoot: string,
  knownPageUrls: Map<string, string>,
): string | null {
  const cleaned = href.split("#", 1)[0].split("?", 1)[0];
  if (!cleaned) {
    return null;
  }

  let resolvedPath: string;
  try {
    resolvedPath = resolveFromDirectory(path.dirname(currentFilePath), cleaned);
  } catch {
    return null;
  }
  if (!isInsidePath(docsRoot, resolvedPath)) {
    return null;
  }

  if (path.extname(resolvedPath).toLowerCase() === ".md") {
    return knownPageUrls.get(resolvedPath) || null;
  }

  const repoRelativePath = path.relative(workspaceRoot, resolvedPath);
  if (!isInsidePath(workspaceRoot, resolvedPath)) {
    return null;
  }

  return buildGitHubRawUrl(repoRelativePath);
}

function buildGitHubRawUrl(repoRelativePath: string): string | null {
  const ownerRepo = process.env.GITHUB_REPOSITORY;
  if (!ownerRepo) {
    return null;
  }

  const reference = process.env.GITHUB_SHA || process.env.GITHUB_REF_NAME;
  if (!reference) {
    return null;
  }

  const normalizedPath = repoRelativePath.split(path.sep).join("/");
  const serverUrl = (process.env.GITHUB_SERVER_URL || "https://github.com").replace(/\/+$/, "");
  if (serverUrl === "https://github.com") {
    return `https://raw.githubusercontent.com/${ownerRepo}/${reference}/${normalizedPath}`;
  }
  return `${serverUrl}/raw/${ownerRepo}/${reference}/${normalizedPath}`;
}

function hashMarkdownBody(markdownBody: string): string {
  return createHash("sha256").update(markdownBody, "utf8").digest("hex");
}

function parseFrontMatter(markdownContent: string): {
  attributes: Record<string, unknown>;
  body: string;
} {
  const lines = markdownContent.split(/\r?\n/);
  if (lines[0] !== "---") {
    return { attributes: {}, body: markdownContent };
  }

  const endIndex = lines.indexOf("---", 1);
  if (endIndex === -1) {
    return { attributes: {}, body: markdownContent };
  }

  const yamlContent = lines.slice(1, endIndex).join("\n");
  const parsedYaml = loadYaml(yamlContent);
  const attributes = isRecord(parsedYaml) ? parsedYaml : {};
  return { attributes, body: lines.slice(endIndex + 1).join("\n") };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
