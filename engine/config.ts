import { readFileSync, existsSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type {
  TeamsFile,
  ChainsFile,
  PersonaConfig,
  PromptConfig,
  Chain,
  TeamConfig,
  AgentRole,
  ThinkingLevel,
  ModelRoutingConfig,
} from "./types";

const BASE_DIR = process.env.MAE_ROOT ?? join(import.meta.dir, "..");

const cache = new Map<string, { data: unknown; mtime: number }>();

function cachedRead<T>(path: string): T {
  const fullPath = join(BASE_DIR, path);
  let stat;
  try {
    stat = statSync(fullPath);
  } catch {
    throw new Error(`Config file not found: ${fullPath}`);
  }
  const cached = cache.get(fullPath);
  if (cached && cached.mtime === stat.mtimeMs) return cached.data as T;
  const raw = readFileSync(fullPath, "utf-8");
  const data = parseYaml(raw);
  cache.set(fullPath, { data, mtime: stat.mtimeMs });
  return data as T;
}

export function loadTeams(): TeamsFile {
  return cachedRead<TeamsFile>("agents/teams/teams.yaml");
}

export function loadChains(): ChainsFile {
  return cachedRead<ChainsFile>("agents/teams/chains.yaml");
}

export function loadPersona(path: string): PersonaConfig {
  const fullPath = join(BASE_DIR, path);
  const raw = readFileSync(fullPath, "utf-8");
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fmMatch) throw new Error(`No frontmatter in ${path}`);
  const config = parseYaml(fmMatch[1]!) as PersonaConfig;
  const body = fmMatch[2]?.trim();
  if (body) config.body = body;
  return config;
}

export function loadPrompt(name: string): { config: PromptConfig; body: string } {
  const fullPath = join(BASE_DIR, "prompts", `${name}.md`);
  const raw = readFileSync(fullPath, "utf-8");
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) throw new Error(`No frontmatter in prompt ${name}`);
  return {
    config: parseYaml(fmMatch[1]!) as PromptConfig,
    body: fmMatch[2]!.trim(),
  };
}

export function loadSkill(path: string): string {
  const fullPath = join(BASE_DIR, path);
  return readFileSync(fullPath, "utf-8");
}

export function loadExpertise(path: string): string {
  const fullPath = join(BASE_DIR, path);
  if (!existsSync(fullPath)) return "";
  return readFileSync(fullPath, "utf-8");
}

export function getChain(name: string): Chain {
  const chains = loadChains();
  const chain = chains.chains[name];
  if (!chain) throw new Error(`Chain not found: ${name}`);
  return chain;
}

export function getTeam(name: string): TeamConfig {
  const teams = loadTeams();
  const team = teams.teams.find((t) => t["team-name"] === name);
  if (!team) throw new Error(`Team not found: ${name}`);
  return team;
}

function resolveSkillPath(s: string | { path: string; "use-when"?: string }): string {
  return typeof s === "string" ? s : s.path;
}

export function loadPreamble(role: AgentRole, personaName?: string): string {
  if (role === "scout") {
    const p = join(BASE_DIR, "agents/preambles/scout.md");
    return existsSync(p) ? readFileSync(p, "utf-8").trim() : "";
  }
  if (role === "orchestrator" || role === "lead" || role === "sr") {
    const p = join(BASE_DIR, "agents/preambles/lead.md");
    return existsSync(p) ? readFileSync(p, "utf-8").trim() : "";
  }
  const lower = (personaName ?? "").toLowerCase();
  if (lower.includes("review") || lower.includes("validat") || lower.includes("adversarial") || lower.includes("red-team")) {
    const p = join(BASE_DIR, "agents/preambles/reviewer.md");
    return existsSync(p) ? readFileSync(p, "utf-8").trim() : "";
  }
  const p = join(BASE_DIR, "agents/preambles/worker.md");
  return existsSync(p) ? readFileSync(p, "utf-8").trim() : "";
}

export function buildSystemPrompt(persona: PersonaConfig, role?: AgentRole): string {
  const preamble = role ? loadPreamble(role, persona.name) : "";
  const skills = persona.skills.map((s) => loadSkill(resolveSkillPath(s))).join("\n\n---\n\n");
  const expertise = loadExpertise(persona.expertise);

  return [
    preamble,
    "",
    `# ${persona.name}`,
    "",
    `Model: ${persona.model}`,
    `Tools: ${persona.tools.join(", ")}`,
    "",
    persona.body ? `## Instructions\n\n${persona.body}` : "",
    "",
    "## Domain",
    `Read: ${persona.domain.read.join(", ")}`,
    `Write: ${persona.domain.write.join(", ")}`,
    "",
    "## Skills",
    "",
    skills,
    "",
    expertise ? `## Expertise\n\n${expertise}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}


// --- Tool Registry ---

interface ToolRegistry {
  groups: Record<string, { description: string; tools: string[] }>;
  tools: Record<string, { description: string; risk: string }>;
}

let cachedToolRegistry: ToolRegistry | null = null;

export function loadToolRegistry(): ToolRegistry {
  if (cachedToolRegistry) return cachedToolRegistry;
  try {
    cachedToolRegistry = cachedRead<ToolRegistry>("configs/tools.yaml");
  } catch {
    cachedToolRegistry = { groups: {}, tools: {} };
  }
  return cachedToolRegistry;
}

export function resolveToolGroup(groupOrTools: string | string[]): string[] {
  if (Array.isArray(groupOrTools)) return groupOrTools;
  const registry = loadToolRegistry();
  const group = registry.groups[groupOrTools];
  return group?.tools ?? [groupOrTools];
}

export function loadModelRouting(): ModelRoutingConfig {
  return cachedRead<ModelRoutingConfig>("configs/model-routing.yaml");
}

export function writeModelRouting(config: ModelRoutingConfig): void {
  const path = join(BASE_DIR, "configs/model-routing.yaml");
  writeFileSync(path, stringifyYaml(config));
  cache.delete(join(BASE_DIR, "configs/model-routing.yaml"));
}

export function resolveModel(alias: string): string {
  const config = cachedRead<{
    aliases?: Record<string, string>;
    models?: Record<string, { primary: string }>;
  }>("configs/model-routing.yaml");
  if (config.aliases?.[alias]) return config.aliases[alias];
  if (config.models?.[alias]) return config.models[alias].primary;
  return alias;
}

export function resolveModelForRole(
  role: AgentRole,
  preferredAlias?: string,
): { model: string; thinking: ThinkingLevel } {
  const config = cachedRead<ModelRoutingConfig>("configs/model-routing.yaml");
  const roleDefault = config.roleDefaults?.[role];

  if (!roleDefault) {
    return { model: resolveModel(preferredAlias ?? "main"), thinking: "medium" };
  }

  const tier = config.tiers?.[roleDefault.tier];
  if (!tier) {
    return { model: resolveModel(preferredAlias ?? "main"), thinking: roleDefault.thinking };
  }

  if (preferredAlias) {
    const resolved = resolveModel(preferredAlias);
    return { model: resolved, thinking: roleDefault.thinking };
  }

  return { model: tier.default, thinking: roleDefault.thinking };
}

// --- Cross-Model Pair Enforcement ---

interface CrossModelPair {
  builder: string;
  verifier: string;
}

/**
 * Given a builder model, find the paired verifier model from crossModelPairs config.
 * Returns the verifier model if a pair exists, otherwise null.
 * Resolves aliases before matching (e.g., "quality" -> "litellm/opus-nocache").
 */
export function getCrossModelVerifier(builderModel: string): string | null {
  const config = cachedRead<{
    crossModelPairs?: CrossModelPair[];
    aliases?: Record<string, string>;
  }>("configs/model-routing.yaml");

  if (!config.crossModelPairs?.length) return null;

  // Resolve the builder model alias
  const resolvedBuilder = resolveModel(builderModel);

  // Find a matching pair
  const pair = config.crossModelPairs.find(
    (p) => p.builder === resolvedBuilder || p.builder === builderModel
  );

  if (pair) return pair.verifier;

  return null;
}

/**
 * Check if two models are from different families (for cross-model verification).
 * Models are "same family" if they share the same provider prefix.
 */
export function isDifferentModelFamily(modelA: string, modelB: string): boolean {
  const resolvedA = resolveModel(modelA);
  const resolvedB = resolveModel(modelB);

  // Same exact model = same family
  if (resolvedA === resolvedB) return false;

  // Extract provider prefix (e.g., "litellm" from "litellm/opus-nocache")
  const familyA = resolvedA.split("/")[0] ?? resolvedA;
  const familyB = resolvedB.split("/")[0] ?? resolvedB;

  return familyA !== familyB;
}

export function getModelFallbacks(model: string): string[] {
  const routing = loadModelRouting();
  const fallbacks: string[] = [];

  for (const [, tier] of Object.entries(routing.tiers ?? {})) {
    const options = tier.options ?? [];
    const hasModel = options.some((o) => o.model === model);
    if (hasModel) {
      for (const opt of options) {
        if (opt.model !== model) {
          fallbacks.push(opt.model);
        }
      }
      break;
    }
  }

  return fallbacks;
}
