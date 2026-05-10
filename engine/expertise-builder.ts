import * as p from "@clack/prompts";
import { readFileSync, existsSync, readdirSync, statSync, writeFileSync } from "fs";
import { join, extname, basename, resolve } from "path";
import { callLLM } from "./llm-gateway";
import { getFlag, slugify } from "./cli-utils";
import { BASE_DIR } from "./config";
import { isInternalUrl } from "./security";

// --- File discovery ---

const KEY_FILES = new Set([
  "package.json", "go.mod", "cargo.toml", "pyproject.toml", "deno.json",
  "readme.md", "readme.txt", "index.ts", "index.js", "main.go", "main.ts",
  "main.py", "app.ts", "app.py", "server.ts", "server.go",
  "tsconfig.json", "justfile", "makefile", "dockerfile",
  ".env.example", "config.ts", "config.go", "config.yaml", "config.yml",
]);

function isKeyFile(name: string): boolean {
  return KEY_FILES.has(name.toLowerCase());
}

const SOURCE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".go", ".rs", ".py", ".yaml", ".yml", ".toml"]);

function priorityScore(name: string): number {
  const lower = name.toLowerCase();
  if (lower.startsWith("readme")) return 0;
  if (lower === "package.json" || lower === "go.mod" || lower === "cargo.toml") return 1;
  if (lower.includes("config") || lower.endsWith(".toml") || lower.endsWith(".yaml")) return 2;
  if (lower.startsWith("main") || lower.startsWith("index") || lower.startsWith("app") || lower.startsWith("server")) return 3;
  return 4;
}

function walkDir(dir: string, maxDepth: number, depth = 0): string[] {
  if (depth > maxDepth) return [];
  const results: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (entry.startsWith(".") || entry === "node_modules" || entry === "vendor" || entry === "dist" || entry === "__pycache__") continue;
    const full = join(dir, entry);
    let stat;
    try { stat = statSync(full); } catch { continue; }
    if (stat.isDirectory()) {
      results.push(...walkDir(full, maxDepth, depth + 1));
    } else if (isKeyFile(entry) || SOURCE_EXTS.has(extname(entry).toLowerCase())) {
      results.push(full);
    }
  }
  return results;
}

function selectFiles(dir: string, max = 20): { path: string; content: string }[] {
  const allFiles = walkDir(dir, 3);
  allFiles.sort((a, b) => priorityScore(basename(a)) - priorityScore(basename(b)));
  const selected = allFiles.slice(0, max);
  const results: { path: string; content: string }[] = [];
  for (const filePath of selected) {
    try {
      const raw = readFileSync(filePath, "utf-8");
      const lines = raw.split("\n").slice(0, 500);
      const relative = filePath.replace(dir, "").replace(/^\//, "");
      results.push({ path: relative, content: lines.join("\n") });
    } catch { /* skip unreadable */ }
  }
  return results;
}

// --- Prompts ---

const ANALYSIS_SYSTEM = `You are an expert at analyzing codebases and generating structured domain knowledge for AI coding agents. Be specific, not generic. Reference actual file names and patterns.`;

function buildAnalysisUserPrompt(agentName: string, files: { path: string; content: string }[]): string {
  const fileBlock = files.map((f) => `--- ${f.path} ---\n${f.content}`).join("\n\n");
  return `Analyze the following codebase and generate structured expertise for an AI coding agent named "${agentName}".

Output format (markdown):

# ${agentName} Expertise

## Domain Rules (always apply)
- Concrete, specific rules derived from the code patterns

## Terminology
- **Term**: Definition with context from this codebase

## Patterns (reference implementations)
- **Pattern Name**: How this codebase implements it, with key file references

## Anti-patterns (things to avoid)
- Specific mistakes to avoid based on this codebase's conventions

## Verification Checklist
- [ ] Specific checks an agent should run after making changes

Be specific to THIS codebase. Reference actual file names, conventions, and patterns you see.
Do not be generic -- an agent reading this should understand the specific project.

--- CODEBASE FILES ---

${fileBlock}`;
}

function buildExtractionPrompt(agentName: string, content: string): string {
  const truncated = content.length > 30_000;
  const contentSlice = content.slice(0, 30_000) + (truncated ? "\n\n[CONTENT TRUNCATED]" : "");
  if (truncated) {
    p.log.warn("Content truncated to 30,000 characters");
  }
  return `Extract structured expertise from the following content for an AI coding agent named "${agentName}".

Output the same markdown format:

# ${agentName} Expertise

## Domain Rules (always apply)
## Terminology
## Patterns (reference implementations)
## Anti-patterns (things to avoid)
## Verification Checklist

Be specific to the content provided. Extract actionable knowledge, not summaries.

--- CONTENT ---

${contentSlice}`;
}

// --- Modes ---

async function learnFromCodebase(dir: string, agentName: string): Promise<void> {
  const resolved = resolve(dir);
  if (!existsSync(resolved)) {
    p.log.error(`Directory not found: ${resolved}`);
    process.exit(1);
  }

  const spin = p.spinner();
  spin.start(`Scanning ${resolved}...`);
  const files = selectFiles(resolved);
  spin.stop(`Found ${files.length} files to analyze`);

  if (files.length === 0) {
    p.log.error("No source files found in directory");
    process.exit(1);
  }

  p.log.info(`Files: ${files.map((f) => f.path).join(", ")}`);

  spin.start("Generating expertise via LLM (quality tier)...");
  let expertise: string;
  try {
    expertise = await callLLM({ system: ANALYSIS_SYSTEM, user: buildAnalysisUserPrompt(agentName, files), temperature: 0.3 });
  } catch (err: unknown) {
    spin.stop("LLM call failed");
    p.log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  spin.stop("Expertise generated");

  await previewAndWrite(agentName, expertise);
}

async function learnFromAgent(existingAgent: string, newAgent: string): Promise<void> {
  const srcPath = join(BASE_DIR, "agents/expertise", `${existingAgent}.md`);
  if (!existsSync(srcPath)) {
    p.log.error(`Source expertise not found: ${srcPath}`);
    process.exit(1);
  }

  const raw = readFileSync(srcPath, "utf-8");
  if (raw.trim().length < 50) {
    p.log.error(`Source expertise for "${existingAgent}" is empty or minimal. Nothing to copy.`);
    process.exit(1);
  }

  // Replace agent-specific references with the new agent name
  const escaped = existingAgent.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/-/g, "[- ]");
  const nameRegex = new RegExp(escaped, "gi");
  const adapted = raw
    .replace(nameRegex, newAgent)
    .replace(/# .+ Expertise/, `# ${newAgent} Expertise`)
    .replace(/<!-- .* -->/, "<!-- Adapted from " + existingAgent + ". Customize for this agent's domain. -->");

  await previewAndWrite(newAgent, adapted);
}

async function learnFromSource(source: string, agentName: string): Promise<void> {
  const spin = p.spinner();
  let content: string;

  if (source.startsWith("http://") || source.startsWith("https://")) {
    if (isInternalUrl(source)) {
      p.log.error("Cannot fetch internal/private URLs");
      return;
    }
    spin.start(`Fetching ${source}...`);
    try {
      const resp = await fetch(source, { signal: AbortSignal.timeout(30_000), redirect: "error" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const contentLength = parseInt(resp.headers.get("content-length") ?? "0", 10);
      if (contentLength > 5_000_000) {
        spin.stop("Content too large");
        p.log.error("URL content too large (>5MB)");
        return;
      }
      const rawText = await resp.text();
      if (rawText.length > 5_000_000) {
        spin.stop("Content too large");
        p.log.error("URL content too large (>5MB after download)");
        return;
      }
      content = rawText;
    } catch (err: unknown) {
      spin.stop("Fetch failed");
      p.log.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    spin.stop("Content fetched");
  } else {
    const resolved = resolve(source);
    if (!existsSync(resolved)) {
      p.log.error(`File not found: ${resolved}`);
      process.exit(1);
    }
    content = readFileSync(resolved, "utf-8");
  }

  if (content.trim().length < 20) {
    p.log.error("Source content is too short to extract expertise from");
    process.exit(1);
  }

  spin.start("Generating expertise via LLM (quality tier)...");
  let expertise: string;
  try {
    expertise = await callLLM({ system: ANALYSIS_SYSTEM, user: buildExtractionPrompt(agentName, content), temperature: 0.3 });
  } catch (err: unknown) {
    spin.stop("LLM call failed");
    p.log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  spin.stop("Expertise generated");

  await previewAndWrite(agentName, expertise);
}

// --- Shared output ---

async function previewAndWrite(agentName: string, expertise: string): Promise<void> {
  const slug = slugify(agentName);
  const outPath = join(BASE_DIR, "agents/expertise", `${slug}.md`);
  const exists = existsSync(outPath);

  // Split once, reuse for preview and count
  const lines = expertise.split("\n");
  const preview = lines.slice(0, 30).join("\n");
  p.note(preview + (lines.length > 30 ? "\n... (truncated)" : ""), "Generated Expertise");

  p.log.info(`${lines.length} lines total${exists ? " (will overwrite existing file)" : ""}`);

  if (exists) {
    const existing = readFileSync(outPath, "utf-8");
    if (existing.trim().length > 200) {
      const overwrite = await p.confirm({
        message: `Existing expertise has ${existing.split("\n").length} lines. Overwrite?`,
      });
      if (p.isCancel(overwrite) || !overwrite) {
        p.log.warn("Aborted — existing expertise preserved");
        return;
      }
    }
  }

  const confirmed = await p.confirm({ message: `Write to agents/expertise/${slug}.md?` });
  if (p.isCancel(confirmed) || !confirmed) {
    p.log.warn("Aborted");
    return;
  }

  writeFileSync(outPath, expertise);
  p.log.success(`Written to agents/expertise/${slug}.md`);
}

// --- Main entry ---

export async function expertiseLearn(args: string[]): Promise<void> {
  const agentName = getFlag(args, "--agent");
  const fromPath = getFlag(args, "--from");
  const fromAgent = getFlag(args, "--from-agent");

  if (!agentName) {
    p.log.error("--agent <name> is required");
    p.log.info("Usage:");
    p.log.info("  mae learn --from /path/to/code --agent backend-engineer");
    p.log.info("  mae learn --from-agent backend-engineer --agent new-agent");
    p.log.info("  mae learn --from https://example.com/docs --agent my-agent");
    process.exit(1);
  }

  if (fromAgent) {
    await learnFromAgent(fromAgent, agentName);
  } else if (fromPath) {
    // Determine if it's a directory (codebase) or a file/URL
    const isUrl = fromPath.startsWith("http://") || fromPath.startsWith("https://");
    const resolved = isUrl ? fromPath : resolve(fromPath);

    if (isUrl) {
      await learnFromSource(fromPath, agentName);
    } else if (existsSync(resolved) && statSync(resolved).isDirectory()) {
      await learnFromCodebase(fromPath, agentName);
    } else {
      await learnFromSource(fromPath, agentName);
    }
  } else {
    p.log.error("Provide --from <path|url> or --from-agent <name>");
    process.exit(1);
  }
}
