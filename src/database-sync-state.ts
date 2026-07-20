import type { Client } from "@notionhq/client";

import { normalizeNotionId, notionRequest, toDashedId } from "./notion-api.js";
import type { LogContext } from "./logging.js";
import type { SyncStateEntry } from "./sync-types.js";

const PROPERTY_PATH = "Path";
const PROPERTY_REPOSITORY = "Repository";
const PROPERTY_DOCS_FOLDER = "Docs Folder";
const PROPERTY_SOURCE_HASH = "Source Hash";
const PROPERTY_LAST_SYNCED_AT = "Last Synced At";
const REQUIRED_PROPERTY_TYPES = {
  [PROPERTY_PATH]: "rich_text",
  [PROPERTY_REPOSITORY]: "rich_text",
  [PROPERTY_DOCS_FOLDER]: "rich_text",
  [PROPERTY_SOURCE_HASH]: "rich_text",
  [PROPERTY_LAST_SYNCED_AT]: "date",
} as const;

type DataSourceRetrieveResponse = Awaited<ReturnType<Client["dataSources"]["retrieve"]>>;
type DataSourceQueryResult = Awaited<ReturnType<Client["dataSources"]["query"]>>["results"][number];
type ViewRetrieveResponse = Awaited<ReturnType<Client["views"]["retrieve"]>>;
type ViewPropertyConfig = {
  card_property_width_mode?: "full_line" | "inline";
  date_format?:
    | "full"
    | "short"
    | "month_day_year"
    | "day_month_year"
    | "year_month_day"
    | "relative";
  property_id: string;
  status_show_as?: "select" | "checkbox";
  time_format?: "12_hour" | "24_hour" | "hidden";
  visible?: boolean;
  width?: number;
  wrap?: boolean;
};
type DataSourceProperties = Extract<
  DataSourceRetrieveResponse,
  { properties: Record<string, unknown> }
>["properties"];
type ResolvedDatabaseTarget = {
  databaseId: string;
  dataSourceId: string;
};
type TableViewResponse = ViewRetrieveResponse & {
  configuration: {
    properties?: ViewPropertyConfig[];
    type: "table";
  };
};
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
  docsFolder: string;
  path: string;
  repository: string;
  sourceHash: string;
  title: string;
};

export async function loadDatabaseSyncState(
  notion: Client,
  dataSourceOrDatabaseId: string,
  repo: string,
  logContext: LogContext,
): Promise<DatabaseSyncState> {
  const { databaseId, dataSourceId } = await resolveDatabaseTarget(
    notion,
    dataSourceOrDatabaseId,
    logContext,
  );
  const dataSource = await ensureDataSourceProperties(notion, dataSourceId, logContext);
  const propertyNames = getPropertyNames(dataSource.properties);
  await ensureTableViewColumnVisibility(
    notion,
    databaseId,
    dataSource.properties,
    propertyNames,
    logContext,
  );
  const pages = await queryAllDataSourcePages(notion, dataSourceId);
  const entries = new Map<string, SyncStateEntry>();
  const pageIdsByTitle = collectUniquePageIdsByTitle(pages, propertyNames, repo, logContext);

  for (const page of pages) {
    const pageInfo = readManagedPageInfo(page, propertyNames);
    if (!pageInfo || pageInfo.repository !== repo) {
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
  repo: string,
  docsFolder: string,
  documentPath: string,
  title: string,
  sourceHash: string | undefined,
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
          text: { content: repo },
        },
      ],
    },
    [propertyNames.docsFolder]: {
      rich_text: [
        {
          type: "text",
          text: { content: docsFolder },
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
    [propertyNames.lastSyncedAt]: {
      date: {
        start: new Date().toISOString(),
      },
    },
  };
}

async function resolveDatabaseTarget(
  notion: Client,
  databaseIdInput: string,
  logContext: LogContext,
): Promise<ResolvedDatabaseTarget> {
  const databaseId = normalizeNotionId(databaseIdInput);
  const database = await notionRequest(
    () => notion.databases.retrieve({ database_id: toDashedId(databaseId) }),
    `databases.retrieve ${databaseId}`,
  );
  if (!("data_sources" in database) || database.data_sources.length === 0) {
    throw new Error(`Notion database ${databaseId} does not expose any data sources.`);
  }

  const dataSourceId = normalizeNotionId(database.data_sources[0].id);
  logContext.info(`Resolved Notion database ${databaseId} to data source ${dataSourceId}.`);
  return { databaseId, dataSourceId };
}

async function ensureDataSourceProperties(
  notion: Client,
  dataSourceId: string,
  logContext: LogContext,
): Promise<Extract<DataSourceRetrieveResponse, { properties: DataSourceProperties }>> {
  const dataSource = await retrieveFullDataSource(notion, dataSourceId);
  assertDataSourcePropertyTypes(dataSource.properties);
  const missingProperties = getMissingDataSourceProperties(dataSource.properties);
  if (Object.keys(missingProperties).length === 0) {
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

async function ensureTableViewColumnVisibility(
  notion: Client,
  databaseId: string,
  properties: DataSourceProperties,
  propertyNames: DatabasePropertyNames,
  logContext: LogContext,
): Promise<void> {
  const hiddenPropertyIds = getHiddenColumnPropertyIds(properties, propertyNames);
  const viewIds = await listAllDatabaseViewIds(notion, databaseId);
  let updatedViews = 0;

  for (const viewId of viewIds) {
    const view = await retrieveView(notion, viewId);
    if (!isTableView(view)) {
      continue;
    }

    const propertiesConfiguration = buildHiddenColumnConfiguration(
      view.configuration.properties,
      hiddenPropertyIds,
    );
    if (!propertiesConfiguration) {
      continue;
    }

    await notionRequest(
      () =>
        notion.views.update({
          view_id: toDashedId(viewId),
          configuration: {
            type: "table",
            properties: propertiesConfiguration,
          },
        }),
      `views.update ${viewId}`,
    );
    updatedViews += 1;
  }

  if (updatedViews > 0) {
    logContext.info(`Updated ${updatedViews} Notion table view(s) to hide internal sync columns.`);
  }
}

function getHiddenColumnPropertyIds(
  properties: DataSourceProperties,
  propertyNames: DatabasePropertyNames,
): Set<string> {
  return new Set(
    [propertyNames.sourceHash, propertyNames.repository, propertyNames.docsFolder]
      .map((propertyName) => getDataSourcePropertyId(properties, propertyName))
      .filter((propertyId): propertyId is string => Boolean(propertyId)),
  );
}

function getDataSourcePropertyId(
  properties: DataSourceProperties,
  propertyName: string,
): string | null {
  const property = properties[propertyName] as { id?: unknown } | undefined;
  return typeof property?.id === "string" ? property.id : null;
}

async function listAllDatabaseViewIds(notion: Client, databaseId: string): Promise<string[]> {
  const results: string[] = [];
  let cursor: string | undefined;

  do {
    const response = await notionRequest(
      () =>
        notion.views.list({
          database_id: toDashedId(databaseId),
          page_size: 100,
          start_cursor: cursor,
        }),
      `views.list ${databaseId}`,
    );
    results.push(...response.results.map((view) => normalizeNotionId(view.id)));
    cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined;
  } while (cursor);

  return results;
}

async function retrieveView(notion: Client, viewId: string): Promise<ViewRetrieveResponse> {
  return notionRequest(
    () => notion.views.retrieve({ view_id: toDashedId(viewId) }),
    `views.retrieve ${viewId}`,
  );
}

function isTableView(view: ViewRetrieveResponse): view is TableViewResponse {
  return (
    "configuration" in view && Boolean(view.configuration) && view.configuration?.type === "table"
  );
}

function buildHiddenColumnConfiguration(
  currentProperties: ViewPropertyConfig[] | undefined,
  hiddenPropertyIds: Set<string>,
): ViewPropertyConfig[] | null {
  const existingProperties = currentProperties ?? [];
  const nextProperties = existingProperties.map((property) =>
    hiddenPropertyIds.has(property.property_id) ? { ...property, visible: false } : property,
  );
  const configuredPropertyIds = new Set(nextProperties.map((property) => property.property_id));
  for (const propertyId of hiddenPropertyIds) {
    if (!configuredPropertyIds.has(propertyId)) {
      nextProperties.push({ property_id: propertyId, visible: false });
    }
  }

  return areViewPropertiesEqual(existingProperties, nextProperties) ? null : nextProperties;
}

function areViewPropertiesEqual(
  currentProperties: ViewPropertyConfig[],
  nextProperties: ViewPropertyConfig[],
): boolean {
  return JSON.stringify(currentProperties) === JSON.stringify(nextProperties);
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
  if (!Object.hasOwn(properties, PROPERTY_PATH)) {
    missing[PROPERTY_PATH] = { rich_text: {} };
  }
  if (!Object.hasOwn(properties, PROPERTY_REPOSITORY)) {
    missing[PROPERTY_REPOSITORY] = { rich_text: {} };
  }
  if (!Object.hasOwn(properties, PROPERTY_DOCS_FOLDER)) {
    missing[PROPERTY_DOCS_FOLDER] = { rich_text: {} };
  }
  if (!Object.hasOwn(properties, PROPERTY_SOURCE_HASH)) {
    missing[PROPERTY_SOURCE_HASH] = { rich_text: {} };
  }
  if (!Object.hasOwn(properties, PROPERTY_LAST_SYNCED_AT)) {
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
    docsFolder: PROPERTY_DOCS_FOLDER,
    lastSyncedAt: PROPERTY_LAST_SYNCED_AT,
    path: PROPERTY_PATH,
    repository: PROPERTY_REPOSITORY,
    sourceHash: PROPERTY_SOURCE_HASH,
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
  repo: string,
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

    const pageRepo = getRichTextProperty(page, propertyNames.repository);
    if (pageRepo && pageRepo !== repo) {
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
  const repo = getRichTextProperty(page, propertyNames.repository);
  if (!pageId || !path || !repo) {
    return null;
  }

  return {
    pageId,
    path,
    repository: repo,
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
