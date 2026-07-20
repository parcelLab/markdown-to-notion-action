import assert from "node:assert/strict";
import test from "node:test";

import { buildDatabasePageProperties } from "../src/database-sync-state.js";
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
