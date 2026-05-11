/**
 * Ralph Evolver — Population C
 *
 * Takes evaluator findings and proposes specific, minimal config mutations
 * to persona files. Does NOT apply mutations — that's the loop's job.
 */

import type { EvaluatorFinding } from "./ralph-evaluator";
import { callLLM } from "./llm-gateway";
import { loadPersona, BASE_DIR } from "./config";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

export interface ConfigMutation {
  persona: string;
  field: "system_prompt" | "tools" | "skills" | "model";
  action: "append" | "replace" | "remove";
  content: string;
  reasoning: string;
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

const EVOLVER_SYSTEM = `You are an AI agent evolver. You receive findings about problems in agent personas, along with the current persona content. Your job is to propose specific, minimal mutations to fix the problems.

Rules:
1. ONE mutation per finding. Small changes only — never rewrite an entire persona.
2. For system_prompt changes, provide the exact text to append/replace/remove.
3. For tools changes, provide the tool name to add or remove.
4. For model changes, provide the new model alias.
5. Be conservative — if a finding is vague, propose a small clarifying addition rather than a big change.

Return ONLY valid JSON — an array of mutation objects:
- persona: the persona slug (lowercase-hyphenated filename without .md)
- field: one of "system_prompt", "tools", "skills", "model"
- action: one of "append", "replace", "remove"
- content: what to add/replace/remove (exact text)
- reasoning: one sentence explaining why

If no mutations are warranted, return an empty array: []`;

/** Build context about available personas for the evolver. */
function buildPersonaContext(finding: EvaluatorFinding): string {
  const slug = finding.persona.toLowerCase().replace(/\s+/g, "-");
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

  const findingsText = findings
    .map(
      (f, i) =>
        `${i + 1}. [${f.type}] Persona: ${f.persona} | Severity: ${f.severity}\n   Evidence: ${f.evidence}\n   Suggestion: ${f.suggestion}`,
    )
    .join("\n\n");

  const response = await callLLM({
    system: EVOLVER_SYSTEM,
    user: `Given these findings and current persona configs, propose minimal mutations:\n\nFindings:\n${findingsText}\n\nCurrent Personas:\n${personaContexts}`,
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

  const validFields = new Set(["system_prompt", "tools", "skills", "model"]);
  const validActions = new Set(["append", "replace", "remove"]);

  return parsed
    .filter(
      (m: Record<string, unknown>) =>
        typeof m === "object" &&
        m !== null &&
        typeof m.persona === "string" &&
        validFields.has(m.field as string) &&
        validActions.has(m.action as string) &&
        typeof m.content === "string" &&
        typeof m.reasoning === "string",
    )
    .map((m: Record<string, unknown>) => ({
      persona: m.persona as string,
      field: m.field as ConfigMutation["field"],
      action: m.action as ConfigMutation["action"],
      content: m.content as string,
      reasoning: m.reasoning as string,
    }));
}
