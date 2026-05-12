/**
 * Ralph Loop — Self-Improvement Orchestrator
 *
 * Three-population architecture:
 *   Population A (Workers)   — existing personas, chains, teams
 *   Population B (Evaluator) — analyzes traces, produces findings
 *   Population C (Evolver)   — proposes improvement suggestions from findings
 *
 * NO agent modifies its own config. The verified apply ratchet will be
 * operated by this module, not by any agent. Current Ralph output is advisory.
 */

import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { loadTrace, scoreSession, getGoldenTraces } from "./replay";
import type { SessionTrace, ReplayScore } from "./replay";
import { TRACE_DIR } from "./trace-recorder";
import { BASE_DIR } from "./config";
import { evaluateTraces } from "./ralph-evaluator";
import type { EvaluatorFinding } from "./ralph-evaluator";
import { proposeConfigMutations, readPersonaRaw } from "./ralph-evolver";
import type { ConfigMutation } from "./ralph-evolver";
import { createLogger } from "./logger";

const log = createLogger("ralph");

export interface RalphConfig {
  traceDir?: string;
  personaDir?: string;
  maxIterations?: number;
  traceLimit?: number;
  selectionMode?: "high_signal" | "recent";
  traceIds?: string[];
  goldenOnly?: boolean;
  includeGolden?: boolean;
  model?: string;
  dryRun?: boolean;
  acceptUnproven?: boolean;
  evaluator?: typeof evaluateTraces;
  evolver?: typeof proposeConfigMutations;
}

export interface RalphTraceSummary {
  sessionId: string;
  goal: string;
  chain: string;
  status: string;
  score: number;
  totalCost?: number;
  errorCount: number;
}

export interface MutationResult {
  persona: string;
  change: string;
  accepted: boolean;
  scoreBefore: number;
  scoreAfter: number;
  status: "suggested" | "accepted" | "rejected" | "dry_run" | "needs_verification" | "invalid" | "no_change";
  reason: string;
  targetType: NonNullable<ConfigMutation["targetType"]>;
  target: string;
  file?: string;
  field: ConfigMutation["field"];
  action: ConfigMutation["action"];
  content: string;
  verification?: string;
  diffPreview: string;
}

export interface RalphResult {
  iterations: number;
  accepted: number;
  rejected: number;
  traces: RalphTraceSummary[];
  findings: EvaluatorFinding[];
  proposedMutations: ConfigMutation[];
  suggestions: MutationResult[];
  mutations: MutationResult[];
}

/** Load recent traces for evaluation. */
function loadRecentTraces(traceDir: string, limit: number): SessionTrace[] {
  if (!existsSync(traceDir)) return [];

  const files = readdirSync(traceDir)
    .filter((f: string) => f.endsWith(".jsonl"))
    .sort()
    .reverse()
    .slice(0, limit);

  const traces: SessionTrace[] = [];
  for (const file of files) {
    const sessionId = file.replace(".jsonl", "");
    try {
      traces.push(loadTrace(sessionId, traceDir));
    } catch {
      // Skip unreadable traces
    }
  }
  return traces;
}

function personaSlug(personaName: string): string {
  return personaName.toLowerCase().replace(/\s+/g, "-");
}

function readPersonaRawFromDir(personaDir: string, personaName: string): string | null {
  const slug = personaSlug(personaName);
  const path = join(personaDir, `${slug}.md`);
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return readPersonaRaw(personaName);
  }
}

function suggestionTarget(mutation: ConfigMutation): { targetType: NonNullable<ConfigMutation["targetType"]>; target: string } {
  return {
    targetType: mutation.targetType ?? "persona",
    target: mutation.target ?? mutation.persona,
  };
}

function defaultFileForTarget(targetType: NonNullable<ConfigMutation["targetType"]>): string | undefined {
  if (targetType === "chain") return "agents/teams/chains.yaml";
  if (targetType === "team") return "agents/teams/teams.yaml";
  if (targetType === "routing") return "configs/model-routing.yaml";
  if (targetType === "engine") return "engine/";
  if (targetType === "dashboard") return "dashboard-next/src/";
  return undefined;
}

function fieldForTarget(targetType: NonNullable<ConfigMutation["targetType"]>): ConfigMutation["field"] {
  if (targetType === "chain") return "chain";
  if (targetType === "team") return "team";
  if (targetType === "routing") return "routing";
  if (targetType === "engine") return "code";
  if (targetType === "dashboard") return "dashboard";
  return "system_prompt";
}

function fallbackSuggestionFromFinding(finding: EvaluatorFinding): ConfigMutation {
  const targetType = finding.targetType ?? "persona";
  const target = finding.target ?? finding.persona;
  return {
    persona: finding.persona || "orchestrator",
    targetType,
    target,
    file: defaultFileForTarget(targetType),
    field: fieldForTarget(targetType),
    action: "investigate",
    content: finding.suggestion,
    reasoning: `${finding.type}: ${finding.evidence}`,
    verification: `Re-run Ralph or replay a relevant golden trace after addressing ${targetType}:${target}.`,
  };
}

function highSignalScore(trace: SessionTrace): number {
  const fp = scoreSession(trace).fingerprint;
  const eventCount = trace.events.length;
  const cost = trace.totalCost ?? 0;
  const durationMinutes = (trace.duration_ms ?? 0) / 60_000;
  const failedOrPartial = trace.status === "completed" ? 0 : 8;

  return (
    failedOrPartial +
    fp.agentCount * 3 +
    fp.stepCount * 4 +
    fp.errorCount * 5 +
    Math.min(cost, 10) * 2 +
    Math.min(durationMinutes, 60) * 0.4 +
    Math.min(eventCount, 500) * 0.02
  );
}

/** Load larger/richer sessions that carry more training signal than smoke runs. */
function loadHighSignalTraces(traceDir: string, limit: number): SessionTrace[] {
  if (!existsSync(traceDir)) return [];

  const traces: SessionTrace[] = [];
  const files = readdirSync(traceDir).filter((f: string) => f.endsWith(".jsonl"));

  for (const file of files) {
    try {
      traces.push(loadTrace(file.replace(".jsonl", ""), traceDir));
    } catch {
      // Skip unreadable traces
    }
  }

  return traces
    .sort((a, b) => highSignalScore(b) - highSignalScore(a))
    .slice(0, limit);
}

/** Load explicitly selected traces by full or unique partial session id. */
function loadSelectedTraces(traceDir: string, sessionIds: string[]): SessionTrace[] {
  if (!existsSync(traceDir)) return [];

  const files = readdirSync(traceDir).filter((f: string) => f.endsWith(".jsonl"));
  const traces: SessionTrace[] = [];

  for (const rawId of sessionIds) {
    const id = rawId.endsWith(".jsonl") ? rawId.replace(".jsonl", "") : rawId;
    const exact = files.find((f: string) => f === `${id}.jsonl`);
    const partials = exact ? [exact] : files.filter((f: string) => f.startsWith(id));
    if (partials.length !== 1) {
      log.warn("Could not resolve selected trace", { session_id: rawId, matches: partials.length });
      continue;
    }

    try {
      traces.push(loadTrace(partials[0]!.replace(".jsonl", ""), traceDir));
    } catch {
      // Skip unreadable selected traces, but log because user explicitly asked for it.
      log.warn("Selected trace could not be loaded", { session_id: rawId });
    }
  }

  return traces;
}

/** Load golden traces for baseline comparison. */
function loadGoldenTraces(traceDir: string): SessionTrace[] {
  const golden = getGoldenTraces(traceDir);
  const traces: SessionTrace[] = [];
  for (const entry of golden) {
    try {
      traces.push(loadTrace(entry.sessionId, traceDir));
    } catch {
      // Skip missing golden traces
    }
  }
  return traces;
}

/** Compute a numeric score from a ReplayScore (0-1 scale). */
export function numericScore(score: ReplayScore): number {
  if (score.checks.length === 0) return 0;
  const passed = score.checks.filter((c) => c.pass).length;
  return passed / score.checks.length;
}

function summarizeForReport(trace: SessionTrace): RalphTraceSummary {
  const score = scoreSession(trace);
  return {
    sessionId: trace.sessionId,
    goal: trace.goal,
    chain: trace.chain,
    status: trace.status,
    score: numericScore(score),
    totalCost: trace.totalCost,
    errorCount: score.fingerprint.errorCount,
  };
}

function mutateFrontmatter(raw: string, update: (frontmatter: Record<string, unknown>) => boolean): string {
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fmMatch) return raw;

  const frontmatter = parseYaml(fmMatch[1]!) as Record<string, unknown>;
  const changed = update(frontmatter);
  if (!changed) return raw;

  const body = fmMatch[2] ?? "";
  return `---\n${stringifyYaml(frontmatter).trimEnd()}\n---\n${body.startsWith("\n") ? body : `\n${body}`}`;
}

function skillPath(skill: unknown): string | null {
  if (typeof skill === "string") return skill;
  if (skill && typeof skill === "object" && typeof (skill as { path?: unknown }).path === "string") {
    return (skill as { path: string }).path;
  }
  return null;
}

function buildDiffPreview(before: string, after: string, maxLines = 24): string {
  if (before === after) return "";

  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const out: string[] = [];
  const limit = Math.max(beforeLines.length, afterLines.length);

  for (let i = 0; i < limit && out.length < maxLines; i++) {
    const a = beforeLines[i];
    const b = afterLines[i];
    if (a === b) continue;
    if (a !== undefined) out.push(`- ${a}`);
    if (b !== undefined) out.push(`+ ${b}`);
  }

  if (out.length >= maxLines) out.push("... diff truncated ...");
  return out.join("\n");
}

function validatePersonaRaw(raw: string): void {
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fmMatch) throw new Error("No frontmatter in persona");
  parseYaml(fmMatch[1]!);
}

/** Apply a mutation to a persona file's raw content. Returns the mutated content. */
export function applyMutation(raw: string, mutation: ConfigMutation): string {
  if (mutation.field === "system_prompt") {
    // system_prompt mutations target the body (after the frontmatter)
    const fmMatch = raw.match(/^(---\n[\s\S]*?\n---\n)([\s\S]*)$/);
    if (!fmMatch) return raw;
    const frontmatter = fmMatch[1]!;
    const body = fmMatch[2] ?? "";

    if (mutation.action === "append") {
      return `${frontmatter}${body}\n\n${mutation.content}\n`;
    }
    if (mutation.action === "replace") {
      return `${frontmatter}\n${mutation.content}\n`;
    }
    if (mutation.action === "remove") {
      return `${frontmatter}${body.replace(mutation.content, "")}\n`;
    }
  }

  if (mutation.field === "tools") {
    // tools mutations modify the YAML frontmatter tools list
    if (mutation.action === "append") {
      return raw.replace(
        /(tools:\n(?:\s+-\s+\S+\n)*)/,
        `$1  - ${mutation.content}\n`,
      );
    }
    if (mutation.action === "remove") {
      return raw.replace(new RegExp(`\\s*-\\s+${escapeRegex(mutation.content)}\\n`), "\n");
    }
  }

  if (mutation.field === "skills") {
    return mutateFrontmatter(raw, (frontmatter) => {
      const skills = Array.isArray(frontmatter.skills) ? [...frontmatter.skills] : [];
      const content = mutation.content.trim();
      if (!content) return false;

      if (mutation.action === "append") {
        if (skills.some((s) => skillPath(s) === content)) return false;
        frontmatter.skills = [...skills, content];
        return true;
      }

      if (mutation.action === "remove") {
        const filtered = skills.filter((s) => skillPath(s) !== content);
        if (filtered.length === skills.length) return false;
        frontmatter.skills = filtered;
        return true;
      }

      if (mutation.action === "replace") {
        frontmatter.skills = [content];
        return skills.length !== 1 || skillPath(skills[0]) !== content;
      }

      return false;
    });
  }

  if (mutation.field === "model") {
    return raw.replace(/^(model:\s*).+$/m, `$1${mutation.content}`);
  }

  return raw;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Run the Ralph self-improvement loop. */
export async function runRalphLoop(config?: RalphConfig): Promise<RalphResult> {
  const traceDir = config?.traceDir ?? TRACE_DIR;
  const personaDir = config?.personaDir ?? join(BASE_DIR, "agents/personas");
  const maxIterations = config?.maxIterations ?? 5;
  const traceLimit = config?.traceLimit ?? 20;
  const selectionMode = config?.selectionMode ?? "high_signal";
  const traceIds = config?.traceIds ?? [];
  const explicitTraceMode = traceIds.length > 0;
  const goldenOnly = config?.goldenOnly ?? false;
  const includeGolden = config?.includeGolden ?? !explicitTraceMode;
  const model = config?.model ?? "quality";
  const isDryRun = config?.dryRun ?? false;
  const acceptUnproven = config?.acceptUnproven ?? false;
  const evaluator = config?.evaluator ?? evaluateTraces;
  const evolver = config?.evolver ?? proposeConfigMutations;

  log.info("Ralph loop starting", {
    traceDir,
    personaDir,
    maxIterations,
    traceLimit,
    selectionMode,
    traceIds,
    goldenOnly,
    includeGolden,
    model,
    dryRun: isDryRun,
    acceptUnproven,
  });

  // 1. Load traces
  const selectedTraces = explicitTraceMode ? loadSelectedTraces(traceDir, traceIds) : [];
  const trainingTraces = explicitTraceMode || goldenOnly
    ? []
    : selectionMode === "recent"
      ? loadRecentTraces(traceDir, traceLimit)
      : loadHighSignalTraces(traceDir, traceLimit);
  const goldenTraces = includeGolden || goldenOnly ? loadGoldenTraces(traceDir) : [];
  const allTraces = [...selectedTraces, ...trainingTraces, ...goldenTraces]
    .filter((v, i, a) => a.findIndex((t) => t.sessionId === v.sessionId) === i);

  if (allTraces.length === 0) {
    log.info("No traces found, nothing to evaluate");
    return { iterations: 0, accepted: 0, rejected: 0, traces: [], findings: [], proposedMutations: [], suggestions: [], mutations: [] };
  }

  const traceSummaries = allTraces.map(summarizeForReport);
  log.info(`Loaded ${allTraces.length} traces (${trainingTraces.length} ${selectionMode}, ${selectedTraces.length} selected, ${goldenTraces.length} golden)`);

  // 2. Evaluate traces (Population B)
  const findings = await evaluator(allTraces, model);
  log.info(`Evaluator produced ${findings.length} finding(s)`);

  if (findings.length === 0) {
    return { iterations: 0, accepted: 0, rejected: 0, traces: traceSummaries, findings, proposedMutations: [], suggestions: [], mutations: [] };
  }

  // 3. Propose mutations (Population C)
  const evolvedMutations = await evolver(findings, model);
  const proposedMutations = evolvedMutations.length > 0
    ? evolvedMutations
    : findings.map(fallbackSuggestionFromFinding);
  log.info(`Evolver proposed ${evolvedMutations.length} mutation(s)${evolvedMutations.length === 0 && findings.length > 0 ? "; using finding fallback suggestions" : ""}`);

  // 4. Return advisory suggestions. No files are written here until the
  // replay/golden verification ratchet can prove a change is safe.
  const results: MutationResult[] = [];
  const limit = Math.min(proposedMutations.length, maxIterations);

  for (let i = 0; i < limit; i++) {
    const mutation = proposedMutations[i]!;
    const baselineTrace = goldenTraces[0] ?? trainingTraces[0] ?? selectedTraces[0];
    const scoreBefore = baselineTrace ? numericScore(scoreSession(baselineTrace)) : 0;
    const { targetType, target } = suggestionTarget(mutation);
    const diffPreview = targetType === "persona"
      ? (() => {
        const currentRaw = readPersonaRawFromDir(personaDir, mutation.persona);
        if (!currentRaw) return "";
        try {
          return buildDiffPreview(currentRaw, applyMutation(currentRaw, mutation));
        } catch {
          return "";
        }
      })()
      : "";

    log.info(`SUGGESTED: ${targetType}:${target} — ${mutation.reasoning}`);

    results.push({
      persona: mutation.persona,
      change: mutation.reasoning,
      accepted: false,
      scoreBefore,
      scoreAfter: scoreBefore,
      status: "suggested",
      reason: "Suggestion only; no files were changed. Requires replay/golden verification before apply.",
      targetType,
      target,
      file: mutation.file,
      field: mutation.field,
      action: mutation.action,
      content: mutation.content,
      verification: mutation.verification,
      diffPreview,
    });
  }

  const accepted = 0;
  const rejected = 0;

  log.info(`Ralph loop complete: ${results.length} suggestion(s), no files changed`);

  return {
    iterations: results.length,
    accepted,
    rejected,
    traces: traceSummaries,
    findings,
    proposedMutations,
    suggestions: results,
    mutations: results,
  };
}
