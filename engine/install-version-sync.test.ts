import { afterEach, describe, expect, test } from "bun:test";
import { $ } from "bun";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempHome = "";

afterEach(() => {
  if (tempHome) rmSync(tempHome, { recursive: true, force: true });
  tempHome = "";
});

describe("sync-install-version", () => {
  test("writes MAE_HOME/VERSION from repo VERSION", async () => {
    tempHome = mkdtempSync(join(tmpdir(), "mae-version-sync-"));
    const installHome = join(tempHome, ".mae-test");

    await $`bun ${join(import.meta.dir, "..", "scripts", "sync-install-version.ts")}`.env({
      ...process.env,
      MAE_HOME: installHome,
    }).quiet();

    const expected = readFileSync(join(import.meta.dir, "..", "VERSION"), "utf8").trim();
    expect(readFileSync(join(installHome, "VERSION"), "utf8").trim()).toBe(expected);
  });
});
