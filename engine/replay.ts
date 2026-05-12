/**
 * Replay & Evaluation Module — session scoring, behavioral fingerprinting,
 * fingerprint comparison, and golden trace registry.
 * Trace files: ~/.mae/traces/{session_id}.jsonl (specs/trace-schema.md)
 */
import { join } from "path";
import { TRACE_DIR } from "./trace-recorder";

export interface TraceEvent {
  ts: string;
  type: string;
  id: string;
  parent_id?: string;
  session_id: string;
  [key: string]: unknown;
}

export interface SessionTrace {
  sessionId: string;
  goal: string;
  chain: string;
  status: string;
  events: TraceEvent[];
  duration_ms?: number;
  totalCost?: number;
}

export interface ReplayScore {
  sessionId: string;
  overall: "pass" | "partial" | "fail";
  checks: Array<{ name: string; pass: boolean; details?: string }>;
  fingerprint: BehavioralFingerprint;
}

export interface BehavioralFingerprint {
  toolSequence: string[];
  agentCount: number;
  teamSequence: string[];
  stepCount: number;
  errorCount: number;
  statusTransitions: string[];
}

export interface GoldenEntry {
  sessionId: string;
  goal: string;
  verdict: "pass" | "fail";
  addedAt: string;
  notes?: string;
}

export interface GoldenCandidate {
  sessionId: string;
  goal: string;
  chain: string;
  status: string;
  overall: ReplayScore["overall"];
  signalScore: number;
  replayScore: number;
  totalCost?: number;
  duration_ms?: number;
  agentCount: number;
  stepCount: number;
  errorCount: number;
  eventCount: number;
  goldenVerdict?: GoldenEntry["verdict"];
  suggestedVerdict: "pass" | "fail" | "review";
}

export interface GoldenValidationSummary {
  sessionId: string;
  goal: string;
  chain: string;
  verdict: "pass" | "fail";
  eventCount: number;
  duration_ms?: number;
  totalCost?: number;
  scoreOverall: ReplayScore["overall"];
  passedChecks: number;
  failedChecks: number;
  hasLlmCall: boolean;
  hasChainStepStart: boolean;
}

export interface FingerprintComparison {
  similarity: number;
  diffs: string[];
}

/** Load a JSONL trace file and parse it into a SessionTrace. */
export function loadTrace(sessionId: string, traceDirOverride?: string): SessionTrace {
  const traceDir = traceDirOverride ?? TRACE_DIR;
  const filePath = join(traceDir, `${sessionId}.jsonl`);
  const { readFileSync, existsSync } = require("fs") as typeof import("fs");

  if (!existsSync(filePath)) throw new Error(`Trace not found: ${filePath}`);

  let content: string;
  try { content = readFileSync(filePath, "utf-8").trim(); }
  catch { throw new Error(`Trace not found: ${filePath}`); }

  if (!content) throw new Error(`Empty trace file: ${filePath}`);

  const events: TraceEvent[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line) as TraceEvent); } catch { /* skip malformed */ }
  }
  if (events.length === 0) throw new Error(`No valid events in trace: ${filePath}`);

  const startEvent = events.find((e) => e.type === "session.start");
  const endEvent = events.find((e) => e.type === "session.end");
  const goal = (startEvent?.goal as string) ?? (startEvent?.task_preview as string) ?? "";
  const chain = (startEvent?.chain as string) ?? "";
  const status = (endEvent?.status as string) ?? "unknown";

  let duration_ms: number | undefined;
  if (endEvent?.duration_ms !== undefined) {
    duration_ms = endEvent.duration_ms as number;
  } else if (events.length >= 2) {
    duration_ms = new Date(events[events.length - 1]!.ts).getTime() - new Date(events[0]!.ts).getTime();
  }

  return { sessionId, goal, chain, status, events, duration_ms, totalCost: (endEvent?.total_cost as number) ?? undefined };
}

/** Extract a behavioral fingerprint from a session trace. */
export function extractFingerprint(trace: SessionTrace): BehavioralFingerprint {
  const toolSequence: string[] = [];
  const teamSet = new Set<string>();
  const teamSequence: string[] = [];
  const statusTransitions: string[] = [];
  let agentCount = 0, stepCount = 0, errorCount = 0;

  for (const event of trace.events) {
    switch (event.type) {
      case "tool.call":
        if (event.tool) toolSequence.push(event.tool as string);
        break;
      case "agent.start":
        agentCount++;
        if (event.team && !teamSet.has(event.team as string)) {
          teamSet.add(event.team as string);
          teamSequence.push(event.team as string);
        }
        break;
      case "chain.step.start": stepCount++; break;
      case "agent.error": errorCount++; break;
      case "session.end":
        if (event.status) statusTransitions.push(event.status as string);
        break;
      case "chain.step.end":
        if (event.status) statusTransitions.push(`step:${event.status as string}`);
        break;
    }
  }

  // Count ERROR/CRITICAL log events as errors too
  for (const event of trace.events) {
    if (event.type === "log" && (event.level === "ERROR" || event.level === "CRITICAL")) errorCount++;
  }

  return { toolSequence, agentCount, teamSequence, stepCount, errorCount, statusTransitions };
}

/** Compare two behavioral fingerprints. Returns 0-1 similarity and a list of diffs. */
export function compareFingerprints(a: BehavioralFingerprint, b: BehavioralFingerprint): FingerprintComparison {
  const diffs: string[] = [];
  let matchScore = 0, totalChecks = 0;

  const checkScalar = (name: string, va: number, vb: number) => {
    totalChecks++;
    if (va === vb) { matchScore++; } else { diffs.push(`${name}: ${va} vs ${vb}`); }
  };

  const checkSeq = (name: string, sa: string[], sb: string[]) => {
    totalChecks++;
    const sim = sequenceSimilarity(sa, sb);
    matchScore += sim;
    if (sim < 1.0) {
      if (name === "toolSequence") {
        diffs.push(`${name}: ${sa.length} tools vs ${sb.length} tools (${(sim * 100).toFixed(0)}% similar)`);
      } else {
        diffs.push(`${name}: [${sa.join(",")}] vs [${sb.join(",")}]`);
      }
    }
  };

  checkScalar("agentCount", a.agentCount, b.agentCount);
  checkScalar("stepCount", a.stepCount, b.stepCount);
  checkScalar("errorCount", a.errorCount, b.errorCount);
  checkSeq("toolSequence", a.toolSequence, b.toolSequence);
  checkSeq("teamSequence", a.teamSequence, b.teamSequence);
  checkSeq("statusTransitions", a.statusTransitions, b.statusTransitions);

  return { similarity: totalChecks > 0 ? matchScore / totalChecks : 1.0, diffs };
}

/** Jaccard similarity on bigrams for order-sensitive sequence comparison. */
function sequenceSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1.0;
  if (a.length === 0 || b.length === 0) return 0.0;
  if (a.length === 1 && b.length === 1) return a[0] === b[0] ? 1.0 : 0.0;

  const bigramsA = new Set<string>();
  const bigramsB = new Set<string>();
  for (let i = 0; i < a.length - 1; i++) bigramsA.add(`${a[i]}|${a[i + 1]}`);
  for (let i = 0; i < b.length - 1; i++) bigramsB.add(`${b[i]}|${b[i + 1]}`);

  if (bigramsA.size === 0 && bigramsB.size === 0) return a[0] === b[0] ? 1.0 : 0.0;

  let intersection = 0;
  for (const bg of bigramsA) { if (bigramsB.has(bg)) intersection++; }
  const union = bigramsA.size + bigramsB.size - intersection;
  return union > 0 ? intersection / union : 1.0;
}

/** Run deterministic checks against a session trace. */
export function scoreSession(trace: SessionTrace): ReplayScore {
  const fingerprint = extractFingerprint(trace);
  const checks: Array<{ name: string; pass: boolean; details?: string }> = [];

  const completed = trace.status === "completed";
  checks.push({ name: "session_completed", pass: completed, details: completed ? undefined : `status: ${trace.status}` });

  const stepStarts = trace.events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.type === "chain.step.start");
  const stepEnds = trace.events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.type === "chain.step.end");
  const endedByStep = new Map<string, Array<{ event: TraceEvent; index: number }>>();
  for (const event of stepEnds) {
    const traceEvent = event.event;
    const key = String(traceEvent.step ?? traceEvent.id);
    endedByStep.set(key, [...(endedByStep.get(key) ?? []), event]);
  }
  const unmatchedStarts = stepStarts.filter(({ event, index }) => {
    const ends = endedByStep.get(String(event.step ?? event.id)) ?? [];
    return !ends.some((end) => end.index > index);
  }).length;
  const unfinishedEnds = stepEnds.filter(({ event }) => event.status !== "completed").length;
  const duplicateEnds = [...endedByStep.values()].filter((events) => events.length !== 1).length;
  const allStepsRan = stepStarts.length > 0 && stepStarts.length === stepEnds.length && unmatchedStarts === 0 && unfinishedEnds === 0 && duplicateEnds === 0;
  checks.push({ name: "all_steps_executed", pass: allStepsRan, details: allStepsRan ? undefined : `started: ${stepStarts.length}, ended: ${stepEnds.length}, unmatched: ${unmatchedStarts}, unfinished: ${unfinishedEnds}, duplicate_ends: ${duplicateEnds}` });

  const failedAgents = trace.events.filter((e) => e.type === "agent.error").length;
  checks.push({ name: "no_agent_failures", pass: failedAgents === 0, details: failedAgents > 0 ? `${failedAgents} agent error(s)` : undefined });

  const errorLogs = trace.events.filter((e) => e.level === "ERROR" || e.level === "CRITICAL").length;
  checks.push({ name: "no_error_logs", pass: errorLogs === 0, details: errorLogs > 0 ? `${errorLogs} error/critical log(s)` : undefined });

  const maxCost = 5.0;
  const costOk = trace.totalCost === undefined || trace.totalCost <= maxCost;
  checks.push({ name: "cost_reasonable", pass: costOk, details: costOk ? undefined : `$${trace.totalCost?.toFixed(3)} exceeds $${maxCost.toFixed(2)} limit` });

  const failCount = checks.filter((c) => !c.pass).length;
  const overall: "pass" | "partial" | "fail" = failCount === 0 ? "pass" : !completed ? "fail" : "partial";

  return { sessionId: trace.sessionId, overall, checks, fingerprint };
}

// --- Golden Trace Registry ---

function goldenPath(traceDirOverride?: string): string {
  return join(traceDirOverride ?? TRACE_DIR, "golden.json");
}

/** Mark a trace as a golden reference in the registry. */
export function addGoldenTrace(sessionId: string, verdict: "pass" | "fail", notes?: string, traceDirOverride?: string): void {
  const { readFileSync, writeFileSync, existsSync } = require("fs") as typeof import("fs");
  const filePath = goldenPath(traceDirOverride);

  let entries: GoldenEntry[] = [];
  if (existsSync(filePath)) {
    try { entries = JSON.parse(readFileSync(filePath, "utf-8")) as GoldenEntry[]; } catch { entries = []; }
  }

  let goal = "";
  try { goal = loadTrace(sessionId, traceDirOverride ?? TRACE_DIR).goal; } catch { /* proceed without goal */ }

  const entry: GoldenEntry = { sessionId, goal, verdict, addedAt: new Date().toISOString().slice(0, 10), notes };
  const idx = entries.findIndex((e) => e.sessionId === sessionId);
  if (idx >= 0) { entries[idx] = entry; } else { entries.push(entry); }

  writeFileSync(filePath, JSON.stringify(entries, null, 2) + "\n");
}

/** Validate a trace before it is promoted to the golden registry. */
export function validateGoldenTrace(
  sessionId: string,
  verdict: "pass" | "fail",
  opts?: { force?: boolean; traceDirOverride?: string },
): GoldenValidationSummary {
  const trace = loadTrace(sessionId, opts?.traceDirOverride);
  const score = scoreSession(trace);
  const hasLlmCall = trace.events.some((event) => event.type === "llm.call");
  const hasChainStepStart = trace.events.some((event) => event.type === "chain.step.start");
  const failedChecks = score.checks.filter((check) => !check.pass).length;
  const passedChecks = score.checks.length - failedChecks;

  if (verdict === "fail" && !opts?.force) {
    throw new Error(`Refusing to add failed golden trace ${sessionId} without --force`);
  }
  if (!hasLlmCall) {
    throw new Error(`Refusing to add ${sessionId}: golden traces must include at least one llm.call event`);
  }
  if (!hasChainStepStart) {
    throw new Error(`Refusing to add ${sessionId}: golden traces must include at least one chain.step.start event`);
  }

  return {
    sessionId,
    goal: trace.goal,
    chain: trace.chain,
    verdict,
    eventCount: trace.events.length,
    duration_ms: trace.duration_ms,
    totalCost: trace.totalCost,
    scoreOverall: score.overall,
    passedChecks,
    failedChecks,
    hasLlmCall,
    hasChainStepStart,
  };
}

/** Validate and mark a trace as a golden reference in one operation. */
export function addValidatedGoldenTrace(
  sessionId: string,
  verdict: "pass" | "fail",
  notes?: string,
  opts?: { force?: boolean; traceDirOverride?: string },
): GoldenValidationSummary {
  const summary = validateGoldenTrace(sessionId, verdict, opts);
  addGoldenTrace(sessionId, verdict, notes, opts?.traceDirOverride);
  return summary;
}

/** List all golden traces from the registry. */
export function getGoldenTraces(traceDirOverride?: string): GoldenEntry[] {
  const { readFileSync, existsSync } = require("fs") as typeof import("fs");
  const filePath = goldenPath(traceDirOverride);
  if (!existsSync(filePath)) return [];
  try { return JSON.parse(readFileSync(filePath, "utf-8")) as GoldenEntry[]; } catch { return []; }
}

function numericReplayScore(score: ReplayScore): number {
  if (score.checks.length === 0) return 0;
  return score.checks.filter((check) => check.pass).length / score.checks.length;
}

function goldenSignalScore(trace: SessionTrace, score: ReplayScore): number {
  const fp = score.fingerprint;
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

/** Rank traces that are good candidates for golden promotion. */
export function listGoldenCandidates(traceDirOverride?: string, limit = 20): GoldenCandidate[] {
  const { readdirSync, existsSync } = require("fs") as typeof import("fs");
  const traceDir = traceDirOverride ?? TRACE_DIR;
  if (!existsSync(traceDir)) return [];

  const goldenVerdicts = new Map(getGoldenTraces(traceDir).map((entry) => [entry.sessionId, entry.verdict]));
  const candidates: GoldenCandidate[] = [];

  for (const file of readdirSync(traceDir).filter((f: string) => f.endsWith(".jsonl"))) {
    const sessionId = file.replace(".jsonl", "");
    try {
      const trace = loadTrace(sessionId, traceDir);
      const score = scoreSession(trace);
      candidates.push({
        sessionId,
        goal: trace.goal,
        chain: trace.chain,
        status: trace.status,
        overall: score.overall,
        signalScore: goldenSignalScore(trace, score),
        replayScore: numericReplayScore(score),
        totalCost: trace.totalCost,
        duration_ms: trace.duration_ms,
        agentCount: score.fingerprint.agentCount,
        stepCount: score.fingerprint.stepCount,
        errorCount: score.fingerprint.errorCount,
        eventCount: trace.events.length,
        goldenVerdict: goldenVerdicts.get(sessionId),
        suggestedVerdict: score.overall === "pass" ? "pass" : score.overall === "fail" ? "fail" : "review",
      });
    } catch {
      // Skip malformed traces; candidate listing should be best-effort.
    }
  }

  return candidates
    .sort((a, b) =>
      b.signalScore - a.signalScore ||
      b.replayScore - a.replayScore ||
      a.sessionId.localeCompare(b.sessionId),
    )
    .slice(0, limit);
}
