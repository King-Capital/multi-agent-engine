import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { buildPromptContext, promptHash, resetPromptRegistryForTests, trackPromptVersion } from "./langfuse-prompts";

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
const TEST_DIR = join(import.meta.dir, "..", ".test-langfuse-prompts-" + process.pid);

describe("langfuse prompt registry", () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.LANGFUSE_HOST = "http://langfuse.test";
    process.env.LANGFUSE_PUBLIC_KEY = "pk-test";
    process.env.LANGFUSE_SECRET_KEY = "sk-test";
    resetPromptRegistryForTests();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    globalThis.fetch = originalFetch;
    resetPromptRegistryForTests();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test("promptHash is stable", () => {
    expect(promptHash("abc")).toBe(promptHash("abc"));
    expect(promptHash("abc")).not.toBe(promptHash("abcd"));
  });

  test("buildPromptContext detects repo and stack from working directory", () => {
    const repo = join(TEST_DIR, "python-app");
    const nested = join(repo, "src", "pkg");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(repo, "pyproject.toml"), "[project]\nname='python-app'\n");

    expect(buildPromptContext({ workingDir: nested })).toEqual({
      prompt_context_repo: "python-app",
      prompt_context_root: repo,
      prompt_context_stack: "python",
    });
  });

  test("buildPromptContext detects MAE-style bun repo without package.json", () => {
    const repo = join(TEST_DIR, "mae-app");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(repo, "engine"), { recursive: true });
    writeFileSync(join(repo, "justfile"), "test:\n  bun test\n");
    writeFileSync(join(repo, "engine", "cli.ts"), "");

    expect(buildPromptContext({ sourceRoot: repo })).toEqual({
      prompt_context_repo: "mae-app",
      prompt_context_root: repo,
      prompt_context_stack: "bun",
    });
  });

  test("trackPromptVersion returns Langfuse metadata and registers only changed hashes", async () => {
    const calls: any[] = [];
    const repo = join(TEST_DIR, "bun-app");
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(repo, "bun.lock"), "");
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      calls.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const first = trackPromptVersion("Test Agent", "System prompt v1", { workingDir: repo });
    const second = trackPromptVersion("Test Agent", "System prompt v1", { workingDir: repo });
    const third = trackPromptVersion("Test Agent", "System prompt v2", { workingDir: repo });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(first.prompt_name).toBe("mae-agent/test-agent");
    expect(first.prompt_version).toHaveLength(12);
    expect(first.prompt_context_repo).toBe("bun-app");
    expect(first.prompt_context_stack).toBe("bun");
    expect(second.prompt_version).toBe(first.prompt_version);
    expect(third.prompt_version).not.toBe(first.prompt_version);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.name).toBe("mae-agent/test-agent");
    expect(calls[0]!.config.prompt_context_stack).toBe("bun");
  });
});
