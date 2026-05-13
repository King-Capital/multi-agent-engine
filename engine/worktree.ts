import { $ } from "bun";
import { join } from "path";
import { tmpdir } from "os";
import { cpSync, existsSync, rmSync } from "fs";

export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await $`git -C ${dir} rev-parse --git-dir`.quiet();
    return true;
  } catch {
    return false;
  }
}

const DEFAULT_CONTEXT_PATHS = [".goal-runs"];

function contextPaths(): string[] {
  const configured = process.env.MAE_WORKTREE_CONTEXT_PATHS;
  if (!configured) return DEFAULT_CONTEXT_PATHS;
  return configured
    .split(/[,:]/)
    .map((path) => path.trim())
    .filter(Boolean);
}

function copyContextPaths(baseDir: string, wtPath: string): void {
  for (const relPath of contextPaths()) {
    if (relPath.startsWith("/") || relPath.includes("..")) continue;
    const src = join(baseDir, relPath);
    if (!existsSync(src)) continue;
    const dest = join(wtPath, relPath);
    rmSync(dest, { recursive: true, force: true });
    cpSync(src, dest, { recursive: true, force: true });
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
