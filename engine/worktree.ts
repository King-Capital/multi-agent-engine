import { $ } from "bun";
import { dirname, join, relative } from "path";
import { tmpdir } from "os";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync } from "fs";
import { createLogger } from "./logger";

const log = createLogger("worktree");

export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await $`git -C ${dir} rev-parse --git-dir`.quiet();
    return true;
  } catch {
    return false;
  }
}

const DEFAULT_CONTEXT_PATHS = [".goal-runs/context"];
const MAX_CONTEXT_BYTES = Number(process.env.MAE_WORKTREE_CONTEXT_MAX_BYTES ?? 5_000_000);
const MAX_CONTEXT_FILES = Number(process.env.MAE_WORKTREE_CONTEXT_MAX_FILES ?? 200);

function contextPaths(): string[] {
  const configured = process.env.MAE_WORKTREE_CONTEXT_PATHS;
  if (!configured) return DEFAULT_CONTEXT_PATHS;
  return configured
    .split(/[,:]/)
    .map((path) => path.trim())
    .filter(Boolean);
}

function isInsideBase(baseDir: string, path: string): boolean {
  const rel = relative(baseDir, path);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

function measurePathSafe(src: string, realBase: string, budget: { bytes: number; files: number }): void {
  const stat = lstatSync(src);
  if (stat.isSymbolicLink()) return;
  if (!isInsideBase(realBase, realpathSync(src))) return;

  if (stat.isDirectory()) {
    for (const entry of readdirSync(src)) {
      measurePathSafe(join(src, entry), realBase, budget);
      if (budget.bytes > MAX_CONTEXT_BYTES || budget.files > MAX_CONTEXT_FILES) return;
    }
    return;
  }

  if (!stat.isFile()) return;
  budget.bytes += stat.size;
  budget.files += 1;
}

function copyPathSafe(src: string, dest: string, realBase: string): void {
  const stat = lstatSync(src);
  if (stat.isSymbolicLink()) return;
  if (!isInsideBase(realBase, realpathSync(src))) return;

  if (stat.isDirectory()) {
    mkdirSync(dest, { recursive: true });
    for (const entry of readdirSync(src)) {
      copyPathSafe(join(src, entry), join(dest, entry), realBase);
    }
    return;
  }

  if (!stat.isFile()) return;
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
}

function copyContextPaths(baseDir: string, wtPath: string): void {
  const realBase = realpathSync(baseDir);
  for (const relPath of contextPaths()) {
    if (relPath.startsWith("/") || relPath.includes("..")) continue;
    const src = join(baseDir, relPath);
    if (!existsSync(src)) continue;
    const dest = join(wtPath, relPath);
    try {
      const budget = { bytes: 0, files: 0 };
      measurePathSafe(src, realBase, budget);
      if (budget.bytes > MAX_CONTEXT_BYTES || budget.files > MAX_CONTEXT_FILES) {
        log.warn("Skipped oversized worktree context path", {
          path: relPath,
          bytes: budget.bytes,
          files: budget.files,
          max_bytes: MAX_CONTEXT_BYTES,
          max_files: MAX_CONTEXT_FILES,
        });
        continue;
      }
      rmSync(dest, { recursive: true, force: true });
      copyPathSafe(src, dest, realBase);
    } catch (err) {
      log.warn("Skipped worktree context copy", {
        path: relPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export async function createWorktree(baseDir: string, id: string): Promise<string> {
  const safeId = id.replace(/[^a-zA-Z0-9._-]/g, "-");
  const wtPath = join(tmpdir(), `mae-wt-${safeId}`);
  const branch = `mae-wt-${safeId}`;
  // Clean up stale worktree/branch from previous runs
  await $`git -C ${baseDir} worktree remove ${wtPath} --force`.quiet().nothrow();
  await $`git -C ${baseDir} branch -D ${branch}`.quiet().nothrow();
  await $`git -C ${baseDir} worktree add ${wtPath} -b ${branch}`.quiet();
  copyContextPaths(baseDir, wtPath);
  return wtPath;
}

export async function mergeWorktree(baseDir: string, id: string): Promise<{ merged: boolean; hadChanges: boolean }> {
  const branch = `mae-wt-${id.replace(/[^a-zA-Z0-9._-]/g, "-")}`;
  try {
    const diff = await $`git -C ${baseDir} diff HEAD...${branch} --stat`.text();
    if (!diff.trim()) return { merged: true, hadChanges: false };

    await $`git -C ${baseDir} merge ${branch} --no-edit`.quiet();
    return { merged: true, hadChanges: true };
  } catch {
    // Abort failed merge so repo is in clean state
    await $`git -C ${baseDir} merge --abort`.quiet().nothrow();
    return { merged: false, hadChanges: true };
  }
}

export async function cleanupWorktree(baseDir: string, id: string): Promise<void> {
  const safeId = id.replace(/[^a-zA-Z0-9._-]/g, "-");
  const wtPath = join(tmpdir(), `mae-wt-${safeId}`);
  const branch = `mae-wt-${safeId}`;
  await $`git -C ${baseDir} worktree remove ${wtPath} --force`.quiet().nothrow();
  await $`git -C ${baseDir} branch -D ${branch}`.quiet().nothrow();
}
