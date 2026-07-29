import assert from "node:assert/strict";
import test from "node:test";

import type { Client } from "@notionhq/client";

import { buildDatabasePageProperties, loadDatabaseSyncState } from "../src/database-sync-state.js";
import type { DatabasePropertyNames } from "../src/database-sync-state.js";

const PROPERTY_NAMES: DatabasePropertyNames = {
  docsFolder: "Docs Folder",
  lastSyncedAt: "Last Synced At",
  path: "Path",
  repository: "Repository",
  sourceHash: "Source Hash",
  title: "Name",
};

test("buildDatabasePageProperties stores all sync fields on the database item", () => {
  const properties = buildDatabasePageProperties(
    PROPERTY_NAMES,
    "owner/repo",
    "docs",
    "docs/api/auth.md",
    "Authentication",
    "abc123",
  );
  assert.ok(properties);

  assert.deepEqual(properties.Name, {
    title: [{ type: "text", text: { content: "Authentication" } }],
  });
  assert.deepEqual(properties.Repository, {
    rich_text: [{ type: "text", text: { content: "owner/repo" } }],
  });
  assert.deepEqual(properties["Docs Folder"], {
    rich_text: [{ type: "text", text: { content: "docs" } }],
  });
  assert.deepEqual(properties.Path, {
    rich_text: [{ type: "text", text: { content: "docs/api/auth.md" } }],
  });
  assert.deepEqual(properties["Source Hash"], {
    rich_text: [{ type: "text", text: { content: "abc123" } }],
  });
  const lastSyncedAt = properties["Last Synced At"];
  assert.ok(lastSyncedAt && "date" in lastSyncedAt);
  assert.ok(lastSyncedAt.date);
  assert.equal(typeof lastSyncedAt.date.start, "string");
});

test("buildDatabasePageProperties clears Source Hash when content was not synced", () => {
  const properties = buildDatabasePageProperties(
    PROPERTY_NAMES,
    "owner/repo",
    "docs",
    "docs/api/auth.md",
    "Authentication",
    undefined,
  );
  assert.ok(properties);

  assert.deepEqual(properties["Source Hash"], { rich_text: [] });
});

test("loadDatabaseSyncState scopes database rows by repo and docs folder", async () => {
  const queryRequests: Array<Parameters<Client["dataSources"]["query"]>[0]> = [];
  const viewUpdates: Array<{ configuration: { properties?: Array<{ property_id: string }> } }> = [];
  const warnings: string[] = [];
  const notion = createDatabaseStateNotionStub(viewUpdates, queryRequests, [
    createDatabasePage({
      docsFolder: "docs",
      pageId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      path: "docs/api.md",
      repo: "owner/repo",
      sourceHash: "hash-1",
      title: "API",
    }),
    createDatabasePage({
      docsFolder: "docs",
      pageId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      path: "docs/api.md",
      repo: "other/repo",
      sourceHash: "hash-2",
      title: "API",
    }),
    createDatabasePage({
      docsFolder: "other-docs",
      pageId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
      path: "other-docs/api.md",
      repo: "owner/repo",
      sourceHash: "hash-3",
      title: "API",
    }),
  ]);

  const state = await loadDatabaseSyncState(notion, NOTION_DATABASE_ID, "owner/repo", "docs", {
    info: () => {},
    warn: (message) => {
      warnings.push(message);
    },
  });

  assert.equal(state.dataSourceId, NOTION_DATA_SOURCE_ID);
  assert.equal(state.entries.size, 1);
  assert.deepEqual(state.entries.get("docs/api.md"), {
    pageId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    sourceHash: "hash-1",
    title: "API",
  });
  assert.equal(queryRequests.length, 1);
  assert.deepEqual(queryRequests[0]?.filter, {
    and: [
      { property: "Repository", rich_text: { equals: "owner/repo" } },
      { property: "Docs Folder", rich_text: { equals: "docs" } },
    ],
  });
  assert.equal(viewUpdates.length, 1);
  assert.deepEqual(viewUpdates[0]?.configuration.properties, [
    { property_id: "repo-id", visible: false },
    { property_id: "docs-id", visible: true },
    { property_id: "source-id", visible: false },
    { property_id: "order-id", visible: true },
    { property_id: "path-id", visible: true },
  ]);
  assert.equal(
    warnings.some((message) => message.includes("Unable to update column visibility")),
    true,
  );
});

const NOTION_DATABASE_ID = "3a3c37dcb4c480d2ac6df52801c367c3";
const NOTION_DATA_SOURCE_ID = "3a3c37dcb4c480d9acc4000bd6c6d46f";
const NOTION_VIEW_ID = "3a3c37dcb4c480f1a72e000c76faf235";

function createDatabasePage(input: {
  docsFolder: string;
  pageId: string;
  path: string;
  repo: string;
  sourceHash: string;
  title: string;
}): Record<string, unknown> {
  return {
    id: input.pageId,
    object: "page",
    properties: {
      Name: { title: [{ plain_text: input.title }], type: "title" },
      "Docs Folder": richTextProperty(input.docsFolder),
      Path: richTextProperty(input.path),
      Repository: richTextProperty(input.repo),
      "Source Hash": richTextProperty(input.sourceHash),
    },
  };
}

function richTextProperty(value: string): {
  rich_text: Array<{ plain_text: string }>;
  type: "rich_text";
} {
  return { rich_text: [{ plain_text: value }], type: "rich_text" };
}

function createDatabaseStateNotionStub(
  viewUpdates: Array<{ configuration: { properties?: Array<{ property_id: string }> } }>,
  queryRequests: Array<Parameters<Client["dataSources"]["query"]>[0]> = [],
  queryResults: Array<Record<string, unknown>> = [],
): Client {
  return {
    databases: {
      retrieve: async () => ({ data_sources: [{ id: NOTION_DATA_SOURCE_ID }] }),
    },
    dataSources: {
      retrieve: async () => ({
        properties: {
          Name: { id: "title-id", type: "title" },
          "Docs Folder": { id: "docs-id", type: "rich_text" },
          "Last Synced At": { id: "date-id", type: "date" },
          Path: { id: "path-id", type: "rich_text" },
          Repository: { id: "repo-id", type: "rich_text" },
          "Source Hash": { id: "source-id", type: "rich_text" },
          Order: { id: "order-id", type: "number" },
        },
      }),
      query: async (request: Parameters<Client["dataSources"]["query"]>[0]) => {
        queryRequests.push(request);
        return { has_more: false, next_cursor: null, results: queryResults };
      },
    },
    views: {
      list: async () => ({ has_more: false, next_cursor: null, results: [{ id: NOTION_VIEW_ID }] }),
      retrieve: async () => ({
        configuration: {
          type: "table",
          properties: [
            { property_id: "repo-id", visible: false },
            { property_id: "docs-id", visible: true },
            { property_id: "source-id", visible: true },
            { property_id: "order-id", visible: true },
            { property_id: "path-id", visible: true },
          ],
        },
      }),
      update: async (request: {
        configuration?: { properties?: Array<{ property_id: string }> };
      }) => {
        viewUpdates.push({ configuration: { properties: request.configuration?.properties } });
        throw new Error("Property rejected by Notion view configuration.");
      },
    },
  } as unknown as Client;
}
