/**
 * Ralph Evaluator — Population B
 *
 * Analyzes batches of session traces and produces structured findings
 * about weak outputs, high costs, stall patterns, and failure modes.
 * Does NOT modify any config — only produces findings for the Evolver.
 */

import type { SessionTrace } from "./replay";
import { extractFingerprint, scoreSession } from "./replay";
import { callLLM } from "./llm-gateway";

export interface EvaluatorFinding {
  type: "weak_output" | "high_cost" | "stall_pattern" | "skip_pattern" | "failure_pattern";
  persona: string;
  targetType?: "persona" | "chain" | "team" | "routing" | "engine" | "dashboard";
  target?: string;
  evidence: string;
  severity: "low" | "medium" | "high";
  suggestion: string;
}

/** Summarize a trace into a compact string for the LLM prompt. */
function summarizeTrace(trace: SessionTrace): string {
  const score = scoreSession(trace);
  const fp = extractFingerprint(trace);

  const agentPersonas = trace.events
    .filter((e) => e.type === "agent.start" && e.persona)
    .map((e) => e.persona as string);

  const errors = trace.events
    .filter((e) => e.type === "agent.error")
    .map((e) => `${e.agent_id}: ${e.error ?? "unknown"}`);

  return [
    `Session: ${trace.sessionId}`,
    `Goal: ${trace.goal}`,
    `Chain: ${trace.chain}`,
    `Status: ${trace.status} | Score: ${score.overall}`,
    `Cost: $${(trace.totalCost ?? 0).toFixed(3)} | Duration: ${trace.duration_ms ?? 0}ms`,
    `Agents: ${fp.agentCount} | Steps: ${fp.stepCount} | Errors: ${fp.errorCount}`,
    `Teams: ${fp.teamSequence.join(" → ") || "none"}`,
    `Tools: ${fp.toolSequence.slice(0, 20).join(", ") || "none"}`,
    `Personas: ${[...new Set(agentPersonas)].join(", ") || "none"}`,
    errors.length > 0 ? `Errors:\n  ${errors.join("\n  ")}` : "",
    `Checks: ${score.checks.map((c) => `${c.name}:${c.pass ? "PASS" : "FAIL"}`).join(", ")}`,
  ]
    .filter(Boolean)
    .join("\n");
}

const EVALUATOR_SYSTEM = `You are an AI agent evaluator. You analyze session traces from a multi-agent orchestration engine and identify patterns that indicate problems.

You receive summaries of multiple session traces. Your job is to find:
- weak_output: agents producing low-quality or incomplete results
- high_cost: sessions or agents consuming excessive tokens/money
- stall_pattern: agents getting stuck in loops or making no progress
- skip_pattern: chain steps being skipped or agents not being utilized
- failure_pattern: recurring errors or failures tied to specific personas

Return ONLY valid JSON — an array of finding objects with these fields:
- type: one of "weak_output", "high_cost", "stall_pattern", "skip_pattern", "failure_pattern"
- persona: the persona name most affected, or "orchestrator" when the issue is systemic
- targetType: one of "persona", "chain", "team", "routing", "engine", "dashboard"
- target: the specific persona/chain/team/file/area affected
- evidence: what you observed in the traces (be specific, cite session IDs)
- severity: "low", "medium", or "high"
- suggestion: a specific, actionable change to improve the target

If no problems are found, return an empty array: []`;

/** Analyze a batch of traces and produce structured findings. */
export async function evaluateTraces(
  traces: SessionTrace[],
  model?: string,
): Promise<EvaluatorFinding[]> {
  if (traces.length === 0) return [];

  const summaries = traces.map(summarizeTrace).join("\n\n---\n\n");

  const response = await callLLM({
    system: EVALUATOR_SYSTEM,
    user: `Analyze these ${traces.length} session traces and identify patterns:\n\n${summaries}`,
    model: model ?? "quality",
    temperature: 0.2,
  });

  return parseFindings(response);
}

/** Parse LLM response into typed findings, handling markdown fences. */
export function parseFindings(raw: string): EvaluatorFinding[] {
  const cleaned = raw.replace(/```(?:json)?\s*/g, "").replace(/```\s*/g, "").trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Try to find JSON array in the response
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (!match) return [];
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return [];
    }
  }

  if (!Array.isArray(parsed)) return [];

  const validTypes = new Set(["weak_output", "high_cost", "stall_pattern", "skip_pattern", "failure_pattern"]);
  const validSeverities = new Set(["low", "medium", "high"]);

  return parsed
    .filter(
      (f: Record<string, unknown>) =>
        typeof f === "object" &&
        f !== null &&
        validTypes.has(f.type as string) &&
        typeof f.persona === "string" &&
        typeof f.evidence === "string" &&
        typeof f.suggestion === "string",
    )
    .map((f: Record<string, unknown>) => ({
      type: f.type as EvaluatorFinding["type"],
      persona: f.persona as string,
      targetType: ["persona", "chain", "team", "routing", "engine", "dashboard"].includes(f.targetType as string)
        ? (f.targetType as EvaluatorFinding["targetType"])
        : "persona",
      target: typeof f.target === "string" ? f.target : (f.persona as string),
      evidence: f.evidence as string,
      severity: validSeverities.has(f.severity as string)
        ? (f.severity as EvaluatorFinding["severity"])
        : "medium",
      suggestion: f.suggestion as string,
    }));
}
