import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type CommandResult = { stdout: string; stderr: string };

async function runCommand(
  command: string,
  arguments_: string[],
  cwd?: string,
): Promise<CommandResult> {
  const commandResult = await execFileAsync(command, arguments_, {
    cwd,
    env: process.env,
  });
  return {
    stdout: commandResult.stdout?.toString() ?? "",
    stderr: commandResult.stderr?.toString() ?? "",
  };
}

export async function getLastCommitTime(
  filePath: string,
  repoRoot?: string,
  githubToken?: string | null,
): Promise<Date | null> {
  const gitPath = resolveGitPath(filePath, repoRoot);
  const githubCommitTime = await getLastCommitTimeFromGitHubApi(gitPath, githubToken);
  if (githubCommitTime) {
    return githubCommitTime;
  }

  try {
    const result = await runCommand("git", ["log", "-1", "--format=%cI", "--", gitPath], repoRoot);
    const trimmed = result.stdout.trim();
    if (!trimmed) {
      return null;
    }
    const parsed = new Date(trimmed);
    if (Number.isNaN(parsed.getTime())) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

type GitHubCommitListItem = {
  commit?: {
    committer?: {
      date?: string;
    };
  };
};

async function getLastCommitTimeFromGitHubApi(
  gitPath: string,
  githubToken?: string | null,
): Promise<Date | null> {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) {
    return null;
  }

  const apiBase = (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "");
  const url = new URL(`${apiBase}/repos/${repo}/commits`);
  url.searchParams.set("path", gitPath);
  url.searchParams.set("per_page", "1");

  const reference = process.env.GITHUB_SHA || process.env.GITHUB_REF_NAME;
  if (reference) {
    url.searchParams.set("sha", reference);
  }

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (githubToken) {
    headers.Authorization = `Bearer ${githubToken}`;
  }

  try {
    const response = await fetch(url, { headers });
    if (!response.ok) {
      return null;
    }

    const commits = (await response.json()) as GitHubCommitListItem[];
    const commitDate = commits[0]?.commit?.committer?.date;
    if (!commitDate) {
      return null;
    }

    const parsed = new Date(commitDate);
    if (Number.isNaN(parsed.getTime())) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function resolveGitPath(filePath: string, repoRoot?: string): string {
  const root = repoRoot ?? process.cwd();
  const relative = path.relative(root, filePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return filePath;
  }
  return relative;
}
