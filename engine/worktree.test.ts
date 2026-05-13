import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { $ } from "bun";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
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
    await cleanupWorktree(BASE_DIR, "context-copy").catch(() => {});
    rmSync(BASE_DIR, { recursive: true, force: true });
    BASE_DIR = "";
  });

  test("copies gitignored goal-run context into worker worktrees", async () => {
    const wtPath = await createWorktree(BASE_DIR, "context-copy");
    const copied = join(wtPath, ".goal-runs", "audit", "evidence.md");

    expect(existsSync(copied)).toBe(true);
    expect(readFileSync(copied, "utf8")).toBe("audit context\n");
  });
});
