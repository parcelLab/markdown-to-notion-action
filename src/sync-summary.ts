import * as core from "@actions/core";

type PageChange = { action: "Archived" | "Created" | "Updated"; title: string; url: string };

const pageChanges: PageChange[] = [];

export function recordPageChange(change: PageChange): void {
  pageChanges.push(change);
}

// core.summary writes cells as raw HTML, so titles from markdown must be escaped.
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export async function writeSyncSummary(): Promise<void> {
  if (!process.env.GITHUB_STEP_SUMMARY) {
    return;
  }

  core.summary.addHeading("Notion sync", 2);
  if (pageChanges.length === 0) {
    core.summary.addRaw("No Notion pages changed.", true);
  } else {
    core.summary.addTable([
      [
        { data: "Change", header: true },
        { data: "Page", header: true },
      ],
      ...pageChanges.map(({ action, title, url }) => [
        action,
        `<a href="${escapeHtml(url)}">${escapeHtml(title)}</a>`,
      ]),
    ]);
  }
  await core.summary.write();
}
