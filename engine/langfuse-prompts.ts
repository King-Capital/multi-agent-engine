import { createHash } from "crypto";
import { basename, dirname, join, resolve } from "path";
import { existsSync } from "fs";

const seenPromptHashes = new Map<string, string>();

export interface PromptMetadata {
  prompt_name: string;
  prompt_version: string;
  prompt_hash: string;
  prompt_context_repo?: string;
  prompt_context_root?: string;
  prompt_context_stack?: string;
}

export interface PromptContext {
  workingDir?: string;
  sourceRoot?: string;
  chain?: string;
  team?: string;
}

function cfg(): { host: string; auth: string } | null {
  const host = process.env.LANGFUSE_HOST;
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  if (!host || !publicKey || !secretKey) return null;
  return { host, auth: btoa(`${publicKey}:${secretKey}`) };
}

export function promptHash(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex");
}

function findRepoRoot(workingDir: string): string {
  let dir = resolve(workingDir);
  while (true) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(workingDir);
    dir = parent;
  }
}

function detectStack(root: string): string {
  if (existsSync(join(root, "pyproject.toml")) || existsSync(join(root, "requirements.txt")) || existsSync(join(root, "setup.py"))) return "python";
  if (existsSync(join(root, "bun.lock")) || existsSync(join(root, "bun.lockb"))) return "bun";
  if (existsSync(join(root, "justfile")) && existsSync(join(root, "engine", "cli.ts"))) return "bun";
  if (existsSync(join(root, "package.json"))) return existsSync(join(root, "tsconfig.json")) ? "typescript" : "javascript";
  if (existsSync(join(root, "go.mod"))) return "go";
  if (existsSync(join(root, "Cargo.toml"))) return "rust";
  return "unknown";
}

export function buildPromptContext(context?: PromptContext): Pick<PromptMetadata, "prompt_context_repo" | "prompt_context_root" | "prompt_context_stack"> {
  const rootInput = context?.sourceRoot ?? context?.workingDir;
  if (!rootInput) return {};
  const root = findRepoRoot(rootInput);
  return {
    prompt_context_repo: basename(root),
    prompt_context_root: root,
    prompt_context_stack: detectStack(root),
  };
}

async function registerPrompt(name: string, prompt: string, hash: string, contextMeta: ReturnType<typeof buildPromptContext>): Promise<void> {
  const config = cfg();
  if (!config) return;
  try {
    await fetch(`${config.host}/api/public/v2/prompts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Basic ${config.auth}` },
      body: JSON.stringify({
        name,
        type: "text",
        prompt,
        labels: ["mae-agent"],
        config: { hash, ...contextMeta },
      }),
    });
  } catch {
    // Prompt registration is observability-only. Trace logging must not fail an agent run.
  }
}

export function trackPromptVersion(name: string, prompt: string, context?: PromptContext): PromptMetadata {
  const hash = promptHash(prompt);
  const contextMeta = buildPromptContext(context);
  const promptName = `mae-agent/${name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "unknown"}`;
  if (seenPromptHashes.get(promptName) !== hash) {
    seenPromptHashes.set(promptName, hash);
    void registerPrompt(promptName, prompt, hash, contextMeta);
  }
  return {
    prompt_name: promptName,
    prompt_version: hash.slice(0, 12),
    prompt_hash: hash,
    ...contextMeta,
  };
}

export function resetPromptRegistryForTests(): void {
  seenPromptHashes.clear();
}
