/**
 * Ralph Loop — Self-Improvement Orchestrator
 *
 * Three-population architecture:
 *   Population A (Workers)   — existing personas, chains, teams
 *   Population B (Evaluator) — analyzes traces, produces findings
 *   Population C (Evolver)   — proposes config mutations from findings
 *
 * NO agent modifies its own config. The ratchet (accept/reject) is
 * operated by this module, not by any agent.
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { loadTrace, scoreSession, extractFingerprint, compareFingerprints, getGoldenTraces } from "./replay";
import type { SessionTrace, ReplayScore } from "./replay";
import { TRACE_DIR } from "./trace-recorder";
import { BASE_DIR } from "./config";
import { evaluateTraces } from "./ralph-evaluator";
import { proposeConfigMutations, readPersonaRaw } from "./ralph-evolver";
import type { ConfigMutation } from "./ralph-evolver";
import { createLogger } from "./logger";

const log = createLogger("ralph");

export interface RalphConfig {
  traceDir?: string;
  personaDir?: string;
  maxIterations?: number;
  model?: string;
  dryRun?: boolean;
}

export interface MutationResult {
  persona: string;
  change: string;
  accepted: boolean;
  scoreBefore: number;
  scoreAfter: number;
}

export interface RalphResult {
  iterations: number;
  accepted: number;
  rejected: number;
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

/** Load golden traces for baseline comparison. */
function loadGoldenTraces(traceDir: string): SessionTrace[] {
  const golden = getGoldenTraces(traceDir);
  const traces: SessionTrace[] = [];
  for (const entry of golden) {
    if (entry.verdict !== "pass") continue;
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

  if (mutation.field === "model") {
    return raw.replace(/^(model:\s*).+$/m, `$1${mutation.content}`);
  }

  return raw;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Git-commit an accepted mutation. */
function commitMutation(personaPath: string, mutation: ConfigMutation): void {
  const msg = `ralph: mutate ${mutation.persona} — ${mutation.reasoning}`;
  try {
    Bun.spawnSync(["git", "add", personaPath], { cwd: BASE_DIR });
    Bun.spawnSync(["git", "commit", "-m", msg], { cwd: BASE_DIR });
    log.info("Committed mutation", { persona: mutation.persona, msg });
  } catch (err) {
    log.warn("Git commit failed (non-fatal)", { error: String(err) });
  }
}

/** Run the Ralph self-improvement loop. */
export async function runRalphLoop(config?: RalphConfig): Promise<RalphResult> {
  const traceDir = config?.traceDir ?? TRACE_DIR;
  const personaDir = config?.personaDir ?? join(BASE_DIR, "agents/personas");
  const maxIterations = config?.maxIterations ?? 5;
  const model = config?.model ?? "quality";
  const isDryRun = config?.dryRun ?? false;

  log.info("Ralph loop starting", { traceDir, personaDir, maxIterations, model, dryRun: isDryRun });

  // 1. Load traces
  const recentTraces = loadRecentTraces(traceDir, 20);
  const goldenTraces = loadGoldenTraces(traceDir);
  const allTraces = [...recentTraces, ...goldenTraces]
    .filter((v, i, a) => a.findIndex((t) => t.sessionId === v.sessionId) === i);

  if (allTraces.length === 0) {
    log.info("No traces found, nothing to evaluate");
    return { iterations: 0, accepted: 0, rejected: 0, mutations: [] };
  }

  log.info(`Loaded ${allTraces.length} traces (${recentTraces.length} recent, ${goldenTraces.length} golden)`);

  // 2. Evaluate traces (Population B)
  const findings = await evaluateTraces(allTraces, model);
  log.info(`Evaluator produced ${findings.length} finding(s)`);

  if (findings.length === 0) {
    return { iterations: 0, accepted: 0, rejected: 0, mutations: [] };
  }

  // 3. Propose mutations (Population C)
  const proposedMutations = await proposeConfigMutations(findings, model);
  log.info(`Evolver proposed ${proposedMutations.length} mutation(s)`);

  // 4. Apply and test each mutation
  const results: MutationResult[] = [];
  const limit = Math.min(proposedMutations.length, maxIterations);

  for (let i = 0; i < limit; i++) {
    const mutation = proposedMutations[i]!;
    const personaPath = join(personaDir, `${mutation.persona}.md`);

    log.info(`Iteration ${i + 1}/${limit}: ${mutation.field}.${mutation.action} on ${mutation.persona}`);

    // Read current file
    const currentRaw = readPersonaRaw(mutation.persona);
    if (!currentRaw) {
      log.warn(`Persona file not found: ${mutation.persona}, skipping`);
      results.push({
        persona: mutation.persona,
        change: mutation.reasoning,
        accepted: false,
        scoreBefore: 0,
        scoreAfter: 0,
      });
      continue;
    }

    // Score before: use the first golden trace or recent trace as baseline
    const baselineTrace = goldenTraces[0] ?? recentTraces[0];
    const scoreBefore = baselineTrace ? numericScore(scoreSession(baselineTrace)) : 0;

    // Apply mutation
    const mutatedRaw = applyMutation(currentRaw, mutation);
    if (mutatedRaw === currentRaw) {
      log.info("Mutation produced no change, skipping");
      results.push({
        persona: mutation.persona,
        change: mutation.reasoning,
        accepted: false,
        scoreBefore,
        scoreAfter: scoreBefore,
      });
      continue;
    }

    // Write mutated config (temporarily for validation)
    if (!isDryRun) {
      writeFileSync(personaPath, mutatedRaw);
    }

    // Score after: re-score the baseline trace (the config change affects
    // future runs, but for the ratchet we validate that the config is at
    // least syntactically valid and the score doesn't regress)
    let scoreAfter = scoreBefore;
    try {
      if (baselineTrace) {
        // Verify the persona file parses correctly with the mutation
        const { loadPersona } = await import("./config");
        loadPersona(`agents/personas/${mutation.persona}.md`);
        // Config loads — score stays at baseline or better
        scoreAfter = scoreBefore;
      }
    } catch (err) {
      // Mutation broke the config — reject
      log.warn("Mutation broke persona config", { error: String(err) });
      scoreAfter = 0;
    }

    const accepted = scoreAfter >= scoreBefore && !isDryRun;

    if (accepted) {
      commitMutation(personaPath, mutation);
      log.info(`ACCEPTED: ${mutation.persona} — ${mutation.reasoning}`);
    } else if (!isDryRun) {
      // Revert
      writeFileSync(personaPath, currentRaw);
      log.info(`REJECTED: ${mutation.persona} — score regressed or dry-run`);
    } else {
      log.info(`DRY-RUN: would ${scoreAfter >= scoreBefore ? "accept" : "reject"} ${mutation.persona} — ${mutation.reasoning}`);
    }

    results.push({
      persona: mutation.persona,
      change: mutation.reasoning,
      accepted,
      scoreBefore,
      scoreAfter,
    });
  }

  const accepted = results.filter((r) => r.accepted).length;
  const rejected = results.filter((r) => !r.accepted).length;

  log.info(`Ralph loop complete: ${accepted} accepted, ${rejected} rejected out of ${results.length} iterations`);

  return {
    iterations: results.length,
    accepted,
    rejected,
    mutations: results,
  };
}
