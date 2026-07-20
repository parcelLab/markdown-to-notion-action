import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@notionhq/client";
import nock from "nock";

import { uploadImageBlocks } from "../src/image-uploads.js";
import type { LogContext } from "../src/logging.js";
import type { NotionBlock } from "../src/notion-types.js";

const GITHUB_API_URL = "https://api.github.com";

const logContext: LogContext = {
  info: () => {},
  warn: () => {},
};

test("uploadImageBlocks uploads GitHub raw image blocks to Notion file uploads", async () => {
  const imageBytes = Buffer.from("fake png bytes");
  const notion = createNotionClientStub();
  const blocks: NotionBlock[] = [
    {
      type: "image",
      image: {
        type: "external",
        external: {
          url: "https://raw.githubusercontent.com/owner/repo/main/docs/assets/example.png",
        },
        caption: [{ type: "text", text: { content: "Example" } }],
      },
    },
  ];

  nock(GITHUB_API_URL, {
    reqheaders: {
      authorization: "Bearer test-token",
    },
  })
    .get("/repos/owner/repo/contents/docs/assets/example.png")
    .query({ ref: "main" })
    .reply(200, imageBytes, { "content-type": "image/png" });

  await uploadImageBlocks(notion, blocks, "test-token", logContext);

  assert.equal(notion.createdUpload?.filename, "example.png");
  assert.equal(notion.createdUpload?.content_type, "image/png");
  assert.equal(notion.sentUpload?.file_upload_id, "upload-id");
  assert.equal(notion.sentUpload?.file.filename, "example.png");
  assert.deepEqual(blocks[0], {
    type: "image",
    image: {
      type: "file_upload",
      file_upload: { id: "upload-id" },
      caption: [{ type: "text", text: { content: "Example" } }],
    },
  });
});

function createNotionClientStub(): Client & {
  createdUpload?: { content_type: string; filename: string; mode: "single_part" };
  sentUpload?: { file: { data: Blob; filename: string }; file_upload_id: string };
} {
  const stub = {
    fileUploads: {
      create: async (request: { content_type: string; filename: string; mode: "single_part" }) => {
        stub.createdUpload = request;
        return { id: "upload-id" };
      },
      send: async (request: { file: { data: Blob; filename: string }; file_upload_id: string }) => {
        stub.sentUpload = request;
        return { id: request.file_upload_id };
      },
    },
  } as Client & {
    createdUpload?: { content_type: string; filename: string; mode: "single_part" };
    sentUpload?: { file: { data: Blob; filename: string }; file_upload_id: string };
  };
  return stub;
}
