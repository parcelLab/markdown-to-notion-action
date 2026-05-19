# Markdown to Notion GitHub Action

Sync a folder of Markdown files to Notion pages and optionally maintain an index list block inside an existing Notion page.

This action:

- Creates or updates one Notion page per Markdown file.
- Stores sync state inside Notion in a child page named `_Markdown to Notion Sync Data (do not edit)`.
- Archives stale Notion pages when their Markdown file no longer exists.
- Adds optional shortcut links after an anchor block.
- Skips private Markdown files by file-name prefix, `_` by default.
- Validates links to avoid Notion "Invalid URL" errors.

## Quick Start (Beginner)

1. **Create a Notion Integration**

- Go to Notion settings → Connections → Develop or manage integrations.
- Create a new integration and copy the **Internal Integration Token**.

2. **Share the target Notion page** with the integration

- Open the page in Notion.
- Click **Share** and invite the integration.

3. **Decide where pages will be created**

- **Default:** Provide `page_id`. Pages are created under this parent and will appear at the end of the page (Notion API limitation).
- **Optional:** Provide `page_block_id` to insert **shortcut links** after a specific block. Pages are still created under the parent page; only the shortcut list is inserted after the block.

4. **Add a GitHub workflow**

```yaml
name: Sync Docs to Notion

on:
  push:
    branches:
      - "main"
    paths:
      - "docs/**"

permissions:
  contents: read

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - name: Sync markdown to Notion
        uses: cvscarlos/markdown-to-notion-action@v2
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          notion_token: ${{ secrets.NOTION_TOKEN }}

          # Use either page_id or page_block_id.
          # page_id creates pages under this Notion page.
          page_id: ${{ secrets.NOTION_PAGE_ID }}
          # page_block_id creates pages under the block's parent page and inserts shortcut links after this block.
          # page_block_id: ${{ secrets.NOTION_PAGE_BLOCK_ID }}

          # Optional: folder containing markdown files (default: docs)
          docs_folder: docs
          # Optional: skip markdown files whose file name starts with this prefix (default: _)
          private_markdown_prefix: "_"
          # Optional: separator used between folder names and title (default: →)
          title_prefix_separator: "→"
```

## Inputs

| Input                     | Required | Description                                                                                                |
| ------------------------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| `notion_token`            | Yes      | Notion Integration Secret.                                                                                 |
| `docs_folder`             | No       | Folder containing Markdown files (relative to the repository root). Default: `docs`.                       |
| `page_block_id`           | No       | Anchor block ID/URL. The action appends shortcut (`link_to_page`) blocks after this block.                 |
| `page_id`                 | No       | Parent page ID/URL for new pages. Pages are created at the end of the parent page (Notion API limitation). |
| `private_markdown_prefix` | No       | Markdown file-name prefix to skip. Default: `_`. Set to `"null"`, `"none"`, or `"false"` to disable.       |
| `title_prefix_separator`  | No       | Separator used between folder names and the title. Default: `→`.                                           |
| `github_token`            | No       | Used to read private GitHub repository files for image uploads and file commit timestamps.                 |

**Requirement:** You must provide either `page_block_id` **or** `page_id`.

Deprecated inputs accepted for backward compatibility but ignored: `notion_mapping_file`, `commit_strategy`, `pr_branch_prefix`.

## How It Works

### 1) Identification

The action uses Notion as the durable source of truth.

On the first run, it creates a child page under the target parent:

```text
_Markdown to Notion Sync Data (do not edit)
```

That page contains a warning callout and compact JSONL code blocks with one record per Markdown file. The sync records store:

- Markdown path
- Notion page ID
- source hash
- page title
- Notion URL

When a new Markdown page is created, the action immediately appends a sync-state record to this Notion page before uploading the Markdown content. This prevents duplicate page creation when a later workflow run starts before any repository PR or branch update could be merged.

If the sync-state page does not have a record yet, the action first tries to match an existing child page by the generated Notion page title. Matching only happens for unique child page titles; duplicate titles are ignored to avoid attaching a Markdown file to the wrong page.

### 2) Private Markdown Files

By default, markdown files whose file name starts with `_` are skipped.

Examples skipped by default:

```text
docs/_draft.md
docs/platform/_internal.md
```

To disable this behavior:

```yaml
with:
  private_markdown_prefix: "null"
```

### 3) Title Selection

The page title is chosen in this order:

1. First Markdown H1 heading
2. File name (without extension)

### 4) Markdown to Notion Blocks

Supported conversions include:

- Headings (H1/H2/H3)
- Paragraphs
- Bulleted and numbered lists (with nesting)
- Code fences
- Blockquotes (paragraphs inside)
- Horizontal rules
- Tables
- `Table of Contents` / `[TOC]` placeholders → Notion `table_of_contents` block

**Folder titles:**

- `docs/platform/overview.md` becomes a page titled `platform → Overview` (separator configurable).

**Safety rules:**

- Text is split into chunks ≤ 2000 characters.
- Sync-state code blocks are kept below 1500 characters per block.
- Links are validated. Invalid or relative links are dropped (text is preserved).

### 5) Index Block (Optional)

If `page_block_id` is provided, the action replaces the contiguous `link_to_page` shortcut blocks **after** that block. The anchor block itself is not modified, and full pages are still created at the end of the parent page.

### 6) Deleted or Renamed Markdown Files

If a path exists in the Notion sync-state page but the Markdown file no longer exists in `docs_folder`, the action treats that path as stale.

- The stale Notion page is archived.
- The stale sync-state record is removed.
- If the page was already deleted or archived manually in Notion, the action just removes the stale record and continues.

A rename is treated the same as delete + create because the action cannot safely know whether a missing path was renamed or deleted.

## Version Tags

This repository uses Git tags for versions. GitHub does not always show tag labels on the commits list, so use the Tags page to find the latest version:

- GitHub → **Releases → Tags** or **Code → Tags**
- The manual release workflow attempts to move the floating `v2` tag to the latest `v2.x.x` release.
- If that step fails or GitHub keeps the wrong ref cached, run `./.github/update-v2-tag.sh` locally as a fallback.

## Notion ID Tips

You can pass a block/page ID **or** a Notion URL. The action extracts the ID automatically.

Example formats:

- `b3c7a87c7eaa4ec4a23e1e6c20a12345`
- `b3c7a87c-7eaa-4ec4-a23e-1e6c20a12345`
- `https://www.notion.so/7754cf02251f4bc9ab2f9cc897765336` (URL that contains the ID)

To get a block ID:

- In Notion, click **Copy Link to Block**.

### Useful Scripts

- `npm run lint`
- `npm run format`
- `npm run format:check`
- `npm run typecheck`
- `npm run knip`
- `npm run precommit`
- `npm run hooks:install` to enable the local Git pre-commit hook
- `./.github/update-v2-tag.sh`

## Troubleshooting

### "Invalid URL for link"

This action validates links and drops invalid/relative URLs instead of crashing. If you want relative links to resolve to Notion pages, make sure those files have already been synced so their page IDs exist in the Notion sync-state page.

### "Either page_block_id or page_id must be provided"

Set one of the two inputs. `page_block_id` is only needed if you want links inserted after a specific block.

### "Not found" errors from Notion

Make sure the integration has access to the target page/block (Share → invite the integration).

### "Nothing syncs even though I expected changes"

The action skips syncing a page if its `source_hash` in the Notion sync-state page matches the current Markdown content.

If the hash changed but Notion is newer than the file's last commit time, the action also skips syncing to avoid overwriting manual Notion edits.

In GitHub Actions it checks the latest commit for that file via the GitHub commits API first, so a full clone is not required.

If the GitHub API lookup is unavailable, it falls back to local `git log`, which may require enough local history to reach the file's last change.

## Behavior Notes

- The Notion sync-state page is the source of truth for page IDs and hashes.
- The index link list after `page_block_id` is replaced each run (contiguous `link_to_page` blocks only).
- Pages are skipped when the source hash is unchanged.
- Pages are also skipped when Notion is newer than the last Git commit time.
- If a Markdown path is renamed or deleted, the old Notion page is archived unless that same page ID is still referenced by another active Markdown file.
- If a block append fails, the action logs a warning and continues.
- HTML in Markdown is not preserved.

## License

MIT
