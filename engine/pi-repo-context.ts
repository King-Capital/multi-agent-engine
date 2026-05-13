import { existsSync, readdirSync, statSync } from "fs";
import { basename, resolve } from "path";

const MAX_TOP_LEVEL_ENTRIES = 40;
const MAX_TRACKED_FILES = 80;

const HIDDEN_ALLOWLIST = new Set([
  ".github",
  ".goal-runs",
  ".gitignore",
  ".planning",
  ".reports",
]);

const SKIP_ENTRIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
]);

function isSafeEntry(name: string): boolean {
  if (SKIP_ENTRIES.has(name)) return false;
  if (/^\.env(?:\.|$)/.test(name)) return false;
  if (name.startsWith(".") && !HIDDEN_ALLOWLIST.has(name)) return false;
  return true;
}

async function readGitOutput(workingDir: string, args: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "-C", workingDir, ...args], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    return exitCode === 0 ? stdout.trim() : null;
  } catch {
    return null;
  }
}

function listTopLevelEntries(workingDir: string): string[] {
  try {
    if (!existsSync(workingDir)) return [];
    return readdirSync(workingDir)
      .filter(isSafeEntry)
      .sort((a, b) => a.localeCompare(b))
      .slice(0, MAX_TOP_LEVEL_ENTRIES)
      .map((entry) => {
        try {
          return statSync(resolve(workingDir, entry)).isDirectory() ? `${entry}/` : entry;
        } catch {
          return entry;
        }
      });
  } catch {
    return [];
  }
}

function selectTrackedFiles(files: string[]): string[] {
  const safeFiles = files
    .map((file) => file.trim())
    .filter(Boolean)
    .filter((file) => !file.split("/").some((part) => !isSafeEntry(part)));

  const priority = [
    "AGENTS.md",
    "README.md",
    "package.json",
    "justfile",
    "engine/cli.ts",
    "engine/orchestrator.ts",
    "engine/chain-runner.ts",
    "engine/team-execution.ts",
    "engine/adapters/pi.ts",
    "agents/teams/chains.yaml",
    "agents/teams/teams.yaml",
  ];

  const selected = new Set<string>();
  for (const file of priority) {
    if (safeFiles.includes(file)) selected.add(file);
  }
  for (const file of safeFiles) {
    if (selected.size >= MAX_TRACKED_FILES) break;
    selected.add(file);
  }
  return [...selected];
}

export async function buildPiRepoContext(workingDir: string): Promise<string> {
  const resolvedWorkingDir = resolve(workingDir);
  const gitRoot = await readGitOutput(resolvedWorkingDir, ["rev-parse", "--show-toplevel"]);
  const branch = await readGitOutput(resolvedWorkingDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const trackedOutput = await readGitOutput(resolvedWorkingDir, ["ls-files"]);
  const trackedFiles = trackedOutput ? selectTrackedFiles(trackedOutput.split("\n")) : [];
  const topLevel = listTopLevelEntries(resolvedWorkingDir);

  const lines = [
    "<mae_repo_context>",
    `Working directory: ${resolvedWorkingDir}`,
    `Repository name: ${basename(gitRoot ?? resolvedWorkingDir)}`,
    gitRoot ? `Git root: ${gitRoot}` : "Git root: unavailable",
    branch ? `Git branch: ${branch}` : "",
    topLevel.length ? "Top-level entries:" : "",
    ...topLevel.map((entry) => `- ${entry}`),
    trackedFiles.length ? "Tracked file sample:" : "",
    ...trackedFiles.map((file) => `- ${file}`),
    "File discovery guidance:",
    "- If `qmd` is installed and this repo has a qmd collection, search it first with `qmd search <terms> -c <collection> --files` or retrieve known files with `qmd get <collection>/<path>`.",
    "- Use glob patterns such as **/*.ts or exact read paths for repo discovery.",
    "- Gitignored MAE scratch context may live under `.goal-runs/`; use exact paths or shell `find .goal-runs -type f` if tool discovery misses dot-prefixed directories.",
    "- Do not treat `find <directory>` returning only a few entries as evidence that a repo is empty.",
    "- This manifest was computed by MAE from the host filesystem before the Pi agent started.",
    "</mae_repo_context>",
  ].filter(Boolean);

  return lines.join("\n");
}

export async function withPiRepoContext(userPrompt: string, workingDir: string): Promise<string> {
  const repoContext = await buildPiRepoContext(workingDir);
  return `${repoContext}\n\n${userPrompt}`;
}
