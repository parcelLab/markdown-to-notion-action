import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  isInsidePath,
  resolveChildPath,
  resolveFromDirectory,
  resolveInsideRoot,
} from "../src/path-utils.js";

const ROOT_PATH = path.resolve("/repo/workspace");

test("resolveInsideRoot accepts paths inside the workspace", () => {
  assert.equal(
    resolveInsideRoot(ROOT_PATH, "docs/api.md", "docs_folder"),
    path.join(ROOT_PATH, "docs/api.md"),
  );
});

test("resolveInsideRoot rejects absolute paths outside the workspace", () => {
  assert.throws(
    () => resolveInsideRoot(ROOT_PATH, "/etc/passwd", "docs_folder"),
    /must resolve inside/,
  );
});

test("resolveChildPath rejects child names that escape the parent", () => {
  assert.throws(() => resolveChildPath(ROOT_PATH, "../outside.md"), /escapes/);
});

test("resolveFromDirectory rejects absolute links", () => {
  assert.throws(
    () => resolveFromDirectory(ROOT_PATH, "/outside.md"),
    /Absolute paths are not allowed/,
  );
});

test("isInsidePath treats nested files and the root itself as inside", () => {
  assert.equal(isInsidePath(ROOT_PATH, ROOT_PATH), true);
  assert.equal(isInsidePath(ROOT_PATH, path.join(ROOT_PATH, "docs/api.md")), true);
  assert.equal(isInsidePath(ROOT_PATH, path.resolve("/repo/other/api.md")), false);
});
