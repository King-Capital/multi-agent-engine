import { $ } from "bun";
import { join } from "path";
import { tmpdir } from "os";

export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await $`git -C ${dir} rev-parse --git-dir`.quiet();
    return true;
  } catch {
    return false;
  }
}

export async function createWorktree(baseDir: string, id: string): Promise<string> {
  const wtPath = join(tmpdir(), `mae-wt-${id}`);
  const branch = `mae-wt-${id}`;
  await $`git -C ${baseDir} worktree add ${wtPath} -b ${branch}`.quiet();
  return wtPath;
}

export async function mergeWorktree(baseDir: string, id: string): Promise<{ merged: boolean; hadChanges: boolean }> {
  const branch = `mae-wt-${id}`;
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
  const wtPath = join(tmpdir(), `mae-wt-${id}`);
  const branch = `mae-wt-${id}`;
  await $`git -C ${baseDir} worktree remove ${wtPath} --force`.quiet().nothrow();
  await $`git -C ${baseDir} branch -D ${branch}`.quiet().nothrow();
}
