/**
 * Ralph Evolver — Population C
 *
 * Takes evaluator findings and proposes specific, minimal config mutations
 * to persona files. Does NOT apply mutations — that's the loop's job.
 */

import type { EvaluatorFinding } from "./ralph-evaluator";
import { callLLM } from "./llm-gateway";
import { loadPersona, BASE_DIR } from "./config";
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";

export interface ConfigMutation {
  persona: string;
  targetType?: "persona" | "chain" | "team" | "routing" | "engine" | "dashboard";
  target?: string;
  file?: string;
  field: "system_prompt" | "tools" | "skills" | "model" | "chain" | "team" | "routing" | "code" | "dashboard";
  action: "append" | "replace" | "remove" | "add" | "investigate";
  content: string;
  reasoning: string;
  verification?: string;
}

/** Read raw persona markdown content by persona name. */
export function readPersonaRaw(personaName: string): string | null {
  const slug = personaName.toLowerCase().replace(/\s+/g, "-");
  const path = join(BASE_DIR, "agents/personas", `${slug}.md`);
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

/** List all persona file slugs. */
export function listPersonaSlugs(): string[] {
  const dir = join(BASE_DIR, "agents/personas");
  try {
    return readdirSync(dir)
      .filter((f: string) => f.endsWith(".md"))
      .map((f: string) => f.replace(".md", ""));
  } catch {
    return [];
  }
}

const EVOLVER_SYSTEM = `You are an AI agent system improvement planner. You receive findings about problems in a multi-agent orchestration engine, along with relevant config and persona context. Your job is to propose specific, minimal improvement suggestions.

Rules:
1. ONE suggestion per finding. Small changes only — never rewrite whole files.
2. Suggestions are advisory. Do not claim a change is applied.
3. Prefer the narrowest target that explains the evidence: persona, chain, team, routing, engine, or dashboard.
4. For persona system_prompt suggestions, provide the exact text to append/replace/remove.
5. For chain/team/routing/code/dashboard suggestions, provide the precise intended change and file/area.
6. Include a verification command or replay/golden check that would prove the suggestion works.
7. Be conservative — if a finding is vague, propose an investigation step rather than a risky edit.

Return ONLY valid JSON — an array of suggestion objects:
- persona: the persona slug (lowercase-hyphenated filename without .md)
- targetType: one of "persona", "chain", "team", "routing", "engine", "dashboard"
- target: the persona slug, chain name, team name, config name, source file, or dashboard area
- file: the likely file path to change, if known
- field: one of "system_prompt", "tools", "skills", "model", "chain", "team", "routing", "code", "dashboard"
- action: one of "append", "replace", "remove", "add", "investigate"
- content: what to add/change/investigate
- reasoning: one sentence explaining why
- verification: command or trace/golden check to prove the improvement

If no suggestions are warranted, return an empty array: []`;

/** Build context about available personas for the evolver. */
function buildPersonaContext(finding: EvaluatorFinding): string {
  const slug = (finding.targetType === "persona" ? (finding.target ?? finding.persona) : finding.persona).toLowerCase().replace(/\s+/g, "-");
  const raw = readPersonaRaw(slug);
  if (raw) return `--- Persona: ${slug} ---\n${raw}`;

  // Try to find a matching persona by name field
  const slugs = listPersonaSlugs();
  for (const s of slugs) {
    try {
      const persona = loadPersona(`agents/personas/${s}.md`);
      if (persona.name.toLowerCase() === finding.persona.toLowerCase()) {
        const content = readPersonaRaw(s);
        if (content) return `--- Persona: ${s} ---\n${content}`;
      }
    } catch { /* skip unreadable personas */ }
  }

  return `--- Persona: ${slug} --- (file not found)`;
}

function readContextFile(path: string, maxChars = 12_000): string {
  const fullPath = join(BASE_DIR, path);
  if (!existsSync(fullPath)) return `--- ${path} ---\n(file not found)`;
  return `--- ${path} ---\n${readFileSync(fullPath, "utf-8").slice(0, maxChars)}`;
}

function buildSystemContext(findings: EvaluatorFinding[]): string {
  const includeChains = findings.some((f) => ["chain", "team", "engine"].includes(f.targetType ?? ""));
  const includeTeams = findings.some((f) => ["team", "chain", "engine"].includes(f.targetType ?? ""));
  const includeRouting = findings.some((f) => ["routing", "persona", "engine"].includes(f.targetType ?? ""));
  const includeEngine = findings.some((f) => f.targetType === "engine");
  const includeDashboard = findings.some((f) => f.targetType === "dashboard");

  const parts: string[] = [];
  if (includeChains) parts.push(readContextFile("agents/teams/chains.yaml"));
  if (includeTeams) parts.push(readContextFile("agents/teams/teams.yaml"));
  if (includeRouting) parts.push(readContextFile("configs/model-routing.yaml"));
  if (includeEngine) {
    parts.push("--- Engine source map ---\nengine/orchestrator.ts, engine/chain-runner.ts, engine/team-execution.ts, engine/worker-lifecycle.ts, engine/session-state.ts");
  }
  if (includeDashboard) {
    parts.push("--- Dashboard source map ---\ndashboard/main.go, dashboard-next/src/");
  }
  return parts.join("\n\n");
}

/** Propose config mutations based on evaluator findings. */
export async function proposeConfigMutations(
  findings: EvaluatorFinding[],
  model?: string,
): Promise<ConfigMutation[]> {
  if (findings.length === 0) return [];

  const personaContexts = findings
    .map(buildPersonaContext)
    .filter((v, i, a) => a.indexOf(v) === i) // deduplicate
    .join("\n\n");
  const systemContext = buildSystemContext(findings);

  const findingsText = findings
    .map(
      (f, i) =>
        `${i + 1}. [${f.type}] Target: ${f.targetType ?? "persona"}:${f.target ?? f.persona} | Persona: ${f.persona} | Severity: ${f.severity}\n   Evidence: ${f.evidence}\n   Suggestion: ${f.suggestion}`,
    )
    .join("\n\n");

  const response = await callLLM({
    system: EVOLVER_SYSTEM,
    user: `Given these findings and current configs, propose minimal suggestions. Do not apply changes.\n\nFindings:\n${findingsText}\n\nCurrent Personas:\n${personaContexts}\n\nSystem Context:\n${systemContext || "(no additional system context requested)"}`,
    model: model ?? "quality",
    temperature: 0.2,
  });

  return parseMutations(response);
}

/** Parse LLM response into typed mutations, handling markdown fences. */
export function parseMutations(raw: string): ConfigMutation[] {
  const cleaned = raw.replace(/```(?:json)?\s*/g, "").replace(/```\s*/g, "").trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (!match) return [];
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return [];
    }
  }

  if (!Array.isArray(parsed)) return [];

  const validTargetTypes = new Set(["persona", "chain", "team", "routing", "engine", "dashboard"]);
  const validFields = new Set(["system_prompt", "tools", "skills", "model", "chain", "team", "routing", "code", "dashboard"]);
  const validActions = new Set(["append", "replace", "remove", "add", "investigate"]);

  return parsed
    .filter(
      (m: Record<string, unknown>) => {
        const targetType = validTargetTypes.has(m.targetType as string) ? m.targetType as string : "persona";
        return (
          typeof m === "object" &&
          m !== null &&
          (typeof m.persona === "string" || targetType !== "persona") &&
          validFields.has(m.field as string) &&
          validActions.has(m.action as string) &&
          typeof m.content === "string" &&
          typeof m.reasoning === "string"
        );
      },
    )
    .map((m: Record<string, unknown>) => ({
      persona: typeof m.persona === "string" ? m.persona as string : "orchestrator",
      targetType: validTargetTypes.has(m.targetType as string)
        ? m.targetType as ConfigMutation["targetType"]
        : "persona",
      target: typeof m.target === "string" ? m.target as string : (typeof m.persona === "string" ? m.persona as string : "orchestrator"),
      file: typeof m.file === "string" ? m.file as string : undefined,
      field: m.field as ConfigMutation["field"],
      action: m.action as ConfigMutation["action"],
      content: m.content as string,
      reasoning: m.reasoning as string,
      verification: typeof m.verification === "string" ? m.verification as string : undefined,
    }));
}
