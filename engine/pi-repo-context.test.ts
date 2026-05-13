import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { $ } from "bun";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { buildPiRepoContext, withPiRepoContext } from "./pi-repo-context";

const FIXTURE_DIR = join(import.meta.dir, "..", ".test-pi-repo-context-" + process.pid);

describe("pi repo context", () => {
  beforeAll(async () => {
    rmSync(FIXTURE_DIR, { recursive: true, force: true });
    mkdirSync(join(FIXTURE_DIR, "engine"), { recursive: true });
    mkdirSync(join(FIXTURE_DIR, "agents", "teams"), { recursive: true });
    mkdirSync(join(FIXTURE_DIR, ".goal-runs", "audit"), { recursive: true });
    writeFileSync(join(FIXTURE_DIR, "AGENTS.md"), "# Fixture\n");
    writeFileSync(join(FIXTURE_DIR, "README.md"), "# Fixture\n");
    writeFileSync(join(FIXTURE_DIR, "engine", "cli.ts"), "export {};\n");
    writeFileSync(join(FIXTURE_DIR, "engine", "orchestrator.ts"), "export {};\n");
    writeFileSync(join(FIXTURE_DIR, "agents", "teams", "chains.yaml"), "chains: {}\n");
    writeFileSync(join(FIXTURE_DIR, ".goal-runs", "audit", "evidence.md"), "audit context\n");
    writeFileSync(join(FIXTURE_DIR, ".env"), "SECRET=do-not-list\n");
    await $`git -C ${FIXTURE_DIR} init`.quiet();
    await $`git -C ${FIXTURE_DIR} add AGENTS.md README.md engine/cli.ts engine/orchestrator.ts agents/teams/chains.yaml`.quiet();
  });

  afterAll(() => {
    rmSync(FIXTURE_DIR, { recursive: true, force: true });
  });

  test("builds a host-computed manifest with repo discovery guidance", async () => {
    const context = await buildPiRepoContext(FIXTURE_DIR);

    expect(context).toContain("<mae_repo_context>");
    expect(context).toContain(`Working directory: ${FIXTURE_DIR}`);
    expect(context).toContain("Top-level entries:");
    expect(context).toContain("- .goal-runs/");
    expect(context).toContain("- engine/");
    expect(context).toContain("Tracked file sample:");
    expect(context).toContain("- engine/cli.ts");
    expect(context).toContain("search it first with `qmd search <terms>");
    expect(context).toContain("Use glob patterns such as **/*.ts");
    expect(context).toContain("Gitignored MAE scratch context may live under `.goal-runs/`");
    expect(context).toContain("Do not treat `find <directory>` returning only a few entries");
    expect(context).not.toContain(".env");
    expect(context).not.toContain("SECRET=");
  });

  test("prepends repo context to the Pi user prompt", async () => {
    const prompt = await withPiRepoContext("Do the work.", FIXTURE_DIR);

    expect(prompt).toStartWith("<mae_repo_context>");
    expect(prompt).toContain("</mae_repo_context>\n\nDo the work.");
  });
});
