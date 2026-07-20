import type { Client } from "@notionhq/client";

import {
  isNotionArchivedError,
  isNotionNotFoundError,
  normalizeNotionId,
  notionRequest,
  toDashedId,
} from "./notion-api.js";
import type { LogContext } from "./logging.js";
import type { SyncStateEntry } from "./sync-types.js";

const PROPERTY_PATH = "Path";
const PROPERTY_REPOSITORY = "Repository";
const PROPERTY_SOURCE_HASH = "Source Hash";
const PROPERTY_SOURCE_URL = "Source URL";
const PROPERTY_LAST_SYNCED_AT = "Last Synced At";
const REQUIRED_PROPERTY_TYPES = {
  [PROPERTY_PATH]: "rich_text",
  [PROPERTY_REPOSITORY]: "rich_text",
  [PROPERTY_SOURCE_HASH]: "rich_text",
  [PROPERTY_SOURCE_URL]: "url",
  [PROPERTY_LAST_SYNCED_AT]: "date",
} as const;

type DataSourceRetrieveResponse = Awaited<ReturnType<Client["dataSources"]["retrieve"]>>;
type DataSourceQueryResult = Awaited<ReturnType<Client["dataSources"]["query"]>>["results"][number];
type DataSourceProperties = Extract<
  DataSourceRetrieveResponse,
  { properties: Record<string, unknown> }
>["properties"];
type PageProperties = Parameters<Client["pages"]["create"]>[0]["properties"];
type PagePropertyValue = {
  rich_text?: Array<{ plain_text: string }>;
  title?: Array<{ plain_text: string }>;
  type?: string;
};

export type DatabaseSyncState = {
  dataSourceId: string;
  entries: Map<string, SyncStateEntry>;
  pageIdsByTitle: Map<string, string>;
  propertyNames: DatabasePropertyNames;
};

export type DatabasePropertyNames = {
  lastSyncedAt: string;
  path: string;
  repository: string;
  sourceHash: string;
  sourceUrl: string;
  title: string;
};

export async function loadDatabaseSyncState(
  notion: Client,
  dataSourceOrDatabaseId: string,
  repository: string,
  logContext: LogContext,
): Promise<DatabaseSyncState> {
  const dataSourceId = await resolveDataSourceId(notion, dataSourceOrDatabaseId, logContext);
  const dataSource = await ensureDataSourceProperties(notion, dataSourceId, logContext);
  const propertyNames = getPropertyNames(dataSource.properties);
  const pages = await queryAllDataSourcePages(notion, dataSourceId);
  const entries = new Map<string, SyncStateEntry>();
  const pageIdsByTitle = collectUniquePageIdsByTitle(pages, propertyNames, repository, logContext);

  for (const page of pages) {
    const pageInfo = readManagedPageInfo(page, propertyNames);
    if (!pageInfo || pageInfo.repository !== repository) {
      continue;
    }

    entries.set(pageInfo.path, {
      pageId: pageInfo.pageId,
      sourceHash: pageInfo.sourceHash,
      title: pageInfo.title,
    });
  }

  logContext.info(
    `Loaded ${entries.size} database sync records from Notion data source ${dataSourceId}.`,
  );
  return { dataSourceId, entries, pageIdsByTitle, propertyNames };
}

export function buildDatabasePageProperties(
  propertyNames: DatabasePropertyNames,
  repository: string,
  documentPath: string,
  title: string,
  sourceHash: string | undefined,
  sourceUrl: string | null,
): PageProperties {
  return {
    [propertyNames.title]: {
      title: [
        {
          type: "text",
          text: { content: title },
        },
      ],
    },
    [propertyNames.path]: {
      rich_text: [
        {
          type: "text",
          text: { content: documentPath },
        },
      ],
    },
    [propertyNames.repository]: {
      rich_text: [
        {
          type: "text",
          text: { content: repository },
        },
      ],
    },
    [propertyNames.sourceHash]: {
      rich_text: sourceHash
        ? [
            {
              type: "text",
              text: { content: sourceHash },
            },
          ]
        : [],
    },
    [propertyNames.sourceUrl]: {
      url: sourceUrl,
    },
    [propertyNames.lastSyncedAt]: {
      date: {
        start: new Date().toISOString(),
      },
    },
  };
}

async function resolveDataSourceId(
  notion: Client,
  dataSourceOrDatabaseId: string,
  logContext: LogContext,
): Promise<string> {
  const normalizedId = normalizeNotionId(dataSourceOrDatabaseId);
  try {
    await notionRequest(
      () => notion.dataSources.retrieve({ data_source_id: toDashedId(normalizedId) }),
      `dataSources.retrieve ${normalizedId}`,
    );
    logContext.info(`Using Notion data source: ${normalizedId}`);
    return normalizedId;
  } catch (error) {
    if (!isNotionNotFoundError(error) && !isNotionArchivedError(error)) {
      throw error;
    }
  }

  const database = await notionRequest(
    () => notion.databases.retrieve({ database_id: toDashedId(normalizedId) }),
    `databases.retrieve ${normalizedId}`,
  );
  if (!("data_sources" in database) || !database.data_sources.length) {
    throw new Error(`Notion database ${normalizedId} does not expose any data sources.`);
  }

  const dataSourceId = normalizeNotionId(database.data_sources[0].id);
  logContext.info(`Resolved Notion database ${normalizedId} to data source ${dataSourceId}.`);
  return dataSourceId;
}

async function ensureDataSourceProperties(
  notion: Client,
  dataSourceId: string,
  logContext: LogContext,
): Promise<Extract<DataSourceRetrieveResponse, { properties: DataSourceProperties }>> {
  const dataSource = await retrieveFullDataSource(notion, dataSourceId);
  assertDataSourcePropertyTypes(dataSource.properties);
  const missingProperties = getMissingDataSourceProperties(dataSource.properties);
  if (!Object.keys(missingProperties).length) {
    return dataSource;
  }

  logContext.info(
    `Adding missing Notion database properties: ${Object.keys(missingProperties).join(", ")}.`,
  );
  await notionRequest(
    () =>
      notion.dataSources.update({
        data_source_id: toDashedId(dataSourceId),
        properties: missingProperties,
      }),
    `dataSources.update ${dataSourceId}`,
  );
  const updatedDataSource = await retrieveFullDataSource(notion, dataSourceId);
  assertDataSourcePropertyTypes(updatedDataSource.properties);
  return updatedDataSource;
}

async function retrieveFullDataSource(
  notion: Client,
  dataSourceId: string,
): Promise<Extract<DataSourceRetrieveResponse, { properties: DataSourceProperties }>> {
  const dataSource = await notionRequest(
    () => notion.dataSources.retrieve({ data_source_id: toDashedId(dataSourceId) }),
    `dataSources.retrieve ${dataSourceId}`,
  );
  if (!("properties" in dataSource)) {
    throw new Error(`Notion data source ${dataSourceId} did not return properties.`);
  }
  return dataSource;
}

function getMissingDataSourceProperties(
  properties: DataSourceProperties,
): NonNullable<Parameters<Client["dataSources"]["update"]>[0]["properties"]> {
  const missing: NonNullable<Parameters<Client["dataSources"]["update"]>[0]["properties"]> = {};
  if (!findPropertyNameByType(properties, "title")) {
    missing.Name = { title: {} };
  }
  if (!properties[PROPERTY_PATH]) {
    missing[PROPERTY_PATH] = { rich_text: {} };
  }
  if (!properties[PROPERTY_REPOSITORY]) {
    missing[PROPERTY_REPOSITORY] = { rich_text: {} };
  }
  if (!properties[PROPERTY_SOURCE_HASH]) {
    missing[PROPERTY_SOURCE_HASH] = { rich_text: {} };
  }
  if (!properties[PROPERTY_SOURCE_URL]) {
    missing[PROPERTY_SOURCE_URL] = { url: {} };
  }
  if (!properties[PROPERTY_LAST_SYNCED_AT]) {
    missing[PROPERTY_LAST_SYNCED_AT] = { date: {} };
  }
  return missing;
}

function assertDataSourcePropertyTypes(properties: DataSourceProperties): void {
  for (const [propertyName, expectedType] of Object.entries(REQUIRED_PROPERTY_TYPES)) {
    const property = properties[propertyName];
    if (property && property.type !== expectedType) {
      throw new Error(
        `Notion database property "${propertyName}" must be ${expectedType}, found ${property.type}.`,
      );
    }
  }
}

function getPropertyNames(properties: DataSourceProperties): DatabasePropertyNames {
  const title = findPropertyNameByType(properties, "title");
  if (!title) {
    throw new Error("Notion data source must have a title property.");
  }

  return {
    lastSyncedAt: PROPERTY_LAST_SYNCED_AT,
    path: PROPERTY_PATH,
    repository: PROPERTY_REPOSITORY,
    sourceHash: PROPERTY_SOURCE_HASH,
    sourceUrl: PROPERTY_SOURCE_URL,
    title,
  };
}

function findPropertyNameByType(properties: DataSourceProperties, type: string): string | null {
  for (const [name, property] of Object.entries(properties)) {
    if (property.type === type) {
      return name;
    }
  }
  return null;
}

async function queryAllDataSourcePages(
  notion: Client,
  dataSourceId: string,
): Promise<DataSourceQueryResult[]> {
  const results: DataSourceQueryResult[] = [];
  let cursor: string | undefined;

  do {
    const response = await notionRequest(
      () =>
        notion.dataSources.query({
          data_source_id: toDashedId(dataSourceId),
          page_size: 100,
          result_type: "page",
          start_cursor: cursor,
        }),
      `dataSources.query ${dataSourceId}`,
    );
    results.push(...response.results);
    cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined;
  } while (cursor);

  return results;
}

function collectUniquePageIdsByTitle(
  pages: DataSourceQueryResult[],
  propertyNames: DatabasePropertyNames,
  repository: string,
  logContext: LogContext,
): Map<string, string> {
  const pageIdsByTitle = new Map<string, string>();
  const duplicatedTitles = new Set<string>();

  for (const page of pages) {
    const pageId = getPageId(page);
    const title = pageId ? getTitleProperty(page, propertyNames.title) : null;
    if (!pageId || !title) {
      continue;
    }

    const pageRepository = getRichTextProperty(page, propertyNames.repository);
    if (pageRepository && pageRepository !== repository) {
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

  if (duplicatedTitles.size) {
    logContext.warn(
      `Ignoring ${duplicatedTitles.size} duplicate database page title(s) when matching existing pages to markdown files.`,
    );
  }
  return pageIdsByTitle;
}

function readManagedPageInfo(
  page: DataSourceQueryResult,
  propertyNames: DatabasePropertyNames,
): {
  pageId: string;
  path: string;
  repository: string;
  sourceHash?: string;
  title?: string;
} | null {
  const pageId = getPageId(page);
  const path = getRichTextProperty(page, propertyNames.path);
  const repository = getRichTextProperty(page, propertyNames.repository);
  if (!pageId || !path || !repository) {
    return null;
  }

  return {
    pageId,
    path,
    repository,
    sourceHash: getRichTextProperty(page, propertyNames.sourceHash) ?? undefined,
    title: getTitleProperty(page, propertyNames.title) ?? undefined,
  };
}

function getPageId(page: DataSourceQueryResult): string | null {
  if (page.object !== "page") {
    return null;
  }
  if (!("id" in page)) {
    return null;
  }
  return normalizeNotionId(page.id);
}

function getTitleProperty(page: DataSourceQueryResult, propertyName: string): string | null {
  const property = getPageProperty(page, propertyName);
  if (!property?.title || property.type !== "title") {
    return null;
  }
  return property.title.map((item) => item.plain_text).join("");
}

function getRichTextProperty(page: DataSourceQueryResult, propertyName: string): string | null {
  const property = getPageProperty(page, propertyName);
  if (!property?.rich_text || property.type !== "rich_text") {
    return null;
  }
  const value = property.rich_text.map((item) => item.plain_text).join("");
  return value || null;
}

function getPageProperty(
  page: DataSourceQueryResult,
  propertyName: string,
): PagePropertyValue | null {
  if (!("properties" in page)) {
    return null;
  }
  return (page.properties as Record<string, PagePropertyValue | undefined>)[propertyName] ?? null;
}

export function buildSourceUrl(workspaceRoot: string, absolutePath: string): string | null {
  const repository = process.env.GITHUB_REPOSITORY;
  const serverUrl = (process.env.GITHUB_SERVER_URL || "https://github.com").replace(/\/+$/, "");
  const ref = process.env.GITHUB_SHA || process.env.GITHUB_REF_NAME;
  if (!repository || !ref) {
    return null;
  }

  const relativePath = absolutePath
    .slice(workspaceRoot.length)
    .replace(/^[/\\]+/, "")
    .replaceAll("\\", "/");
  return `${serverUrl}/${repository}/blob/${ref}/${relativePath}`;
}
