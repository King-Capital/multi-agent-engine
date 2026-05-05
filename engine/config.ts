import { readFileSync, existsSync, statSync } from "fs";
import { join } from "path";
import { parse as parseYaml } from "yaml";
import type {
  TeamsFile,
  ChainsFile,
  PersonaConfig,
  PromptConfig,
  Chain,
  TeamConfig,
} from "./types";

const BASE_DIR = join(import.meta.dir, "..");

const cache = new Map<string, { data: unknown; mtime: number }>();

function cachedRead<T>(path: string): T {
  const fullPath = join(BASE_DIR, path);
  const stat = statSync(fullPath);
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
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) throw new Error(`No frontmatter in ${path}`);
  return parseYaml(fmMatch[1]) as PersonaConfig;
}

export function loadPrompt(name: string): { config: PromptConfig; body: string } {
  const fullPath = join(BASE_DIR, "prompts", `${name}.md`);
  const raw = readFileSync(fullPath, "utf-8");
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) throw new Error(`No frontmatter in prompt ${name}`);
  return {
    config: parseYaml(fmMatch[1]) as PromptConfig,
    body: fmMatch[2].trim(),
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

export function buildSystemPrompt(persona: PersonaConfig): string {
  const skills = persona.skills.map((s) => loadSkill(resolveSkillPath(s))).join("\n\n---\n\n");
  const expertise = loadExpertise(persona.expertise);

  return [
    `# ${persona.name}`,
    "",
    `Model: ${persona.model}`,
    `Tools: ${persona.tools.join(", ")}`,
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

export function loadModelRouting(): {
  budgets?: { max_per_session_usd: number; warn_at_usd: number; max_per_agent_usd: number; max_total_tokens: number };
  aliases?: Record<string, string>;
  models?: Record<string, { primary: string }>;
} {
  return cachedRead("configs/model-routing.yaml");
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
