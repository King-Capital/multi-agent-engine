import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { $ } from "bun";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { cleanupWorktree, createWorktree } from "./worktree";

let BASE_DIR = "";

describe("worktree context copy", () => {
  beforeEach(async () => {
    BASE_DIR = mkdtempSync(join(tmpdir(), "mae-worktree-test-"));
    mkdirSync(join(BASE_DIR, ".goal-runs", "audit"), { recursive: true });
    writeFileSync(join(BASE_DIR, "README.md"), "# fixture\n");
    writeFileSync(join(BASE_DIR, ".goal-runs", "audit", "evidence.md"), "audit context\n");
    await $`git -C ${BASE_DIR} init`.quiet();
    await $`git -C ${BASE_DIR} config user.email mae@example.invalid`.quiet();
    await $`git -C ${BASE_DIR} config user.name "MAE Test"`.quiet();
    await $`git -C ${BASE_DIR} add README.md`.quiet();
    await $`git -C ${BASE_DIR} commit -m init`.quiet();
  });

  afterEach(async () => {
    delete process.env.MAE_WORKTREE_CONTEXT_PATHS;
    await cleanupWorktree(BASE_DIR, "context-copy").catch(() => {});
    rmSync(BASE_DIR, { recursive: true, force: true });
    BASE_DIR = "";
  });

  test("copies gitignored goal-run context into worker worktrees", async () => {
    process.env.MAE_WORKTREE_CONTEXT_PATHS = ".goal-runs/audit";
    const wtPath = await createWorktree(BASE_DIR, "context-copy");
    const copied = join(wtPath, ".goal-runs", "audit", "evidence.md");

    expect(existsSync(copied)).toBe(true);
    expect(readFileSync(copied, "utf8")).toBe("audit context\n");
  });

  test("does not copy the entire goal-runs directory by default", async () => {
    const wtPath = await createWorktree(BASE_DIR, "context-copy");
    const copied = join(wtPath, ".goal-runs", "audit", "evidence.md");

    expect(existsSync(copied)).toBe(false);
  });

  test("skips symlinks in copied context paths", async () => {
    process.env.MAE_WORKTREE_CONTEXT_PATHS = ".goal-runs/audit";
    symlinkSync("/etc/passwd", join(BASE_DIR, ".goal-runs", "audit", "passwd-link"));

    const wtPath = await createWorktree(BASE_DIR, "context-copy");
    const copiedLink = join(wtPath, ".goal-runs", "audit", "passwd-link");

    expect(existsSync(copiedLink)).toBe(false);
  });
});
