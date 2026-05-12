import { callLLM } from "./llm-gateway";
import { loadTrace, type SessionTrace, type TraceEvent } from "./replay";
import { sanitizeAgentInput } from "./security";

export interface JudgeScores {
  judge_overall_quality: number;
  judge_release_readiness: number;
}

export interface JudgeResult {
  traceId: string;
  scores: JudgeScores;
  rationale: string;
  model: string;
  cached: boolean;
  posted: boolean;
}

export interface JudgeOptions {
  model?: string;
  explicit?: boolean;
  traceDirOverride?: string;
  maxEvents?: number;
  cacheDays?: number;
  fetchImpl?: typeof fetch;
  llm?: typeof callLLM;
}

interface LangfuseScore {
  name?: string;
  value?: number;
  timestamp?: string;
  createdAt?: string;
  updatedAt?: string;
}

function clamp01(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function langfuseConfig(): { host: string; publicKey: string; secretKey: string; auth: string } | null {
  const host = process.env.LANGFUSE_HOST;
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  if (!host || !publicKey || !secretKey) return null;
  return { host, publicKey, secretKey, auth: btoa(`${publicKey}:${secretKey}`) };
}

function eventPriority(event: TraceEvent): number {
  if (event.level === "ERROR" || event.level === "CRITICAL" || event.type === "agent.error") return 0;
  if (event.type === "agent.end") return 1;
  if (event.type === "llm.call") return 2;
  if (event.type.startsWith("chain.step.")) return 3;
  if (event.type === "tool.call") return 4;
  if (event.type === "session.start" || event.type === "session.end") return 5;
  return 6;
}

function safeJudgeText(value: string, maxLength: number): string {
  return sanitizeAgentInput(value).replace(/<[^>]*>/g, "").slice(0, maxLength);
}

export function selectJudgeEvents(trace: SessionTrace, maxEvents = 50): TraceEvent[] {
  if (trace.events.length <= maxEvents) return trace.events;
  return trace.events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => eventPriority(a.event) - eventPriority(b.event) || a.index - b.index)
    .slice(0, maxEvents)
    .sort((a, b) => a.index - b.index)
    .map(({ event }) => event);
}

function eventSummary(event: TraceEvent): Record<string, unknown> {
  const allowed: Record<string, unknown> = {
    ts: event.ts,
    type: event.type,
    level: event.level,
    status: event.status,
    step: event.step ?? event.name,
    agent_id: event.agent_id,
    persona: event.persona,
    team: event.team,
    model: event.model,
    cost: event.cost ?? event.cost_usd ?? event.total_cost,
    tokens: event.tokens ?? event.total_tokens,
    grade: event.grade,
  };
  const preview = event.output_preview ?? event.error ?? event.msg;
  if (preview) allowed.preview = safeJudgeText(String(preview), 500);
  return Object.fromEntries(Object.entries(allowed).filter(([, value]) => value !== undefined));
}

export function buildJudgePrompt(trace: SessionTrace, maxEvents = 50): string {
  const events = selectJudgeEvents(trace, maxEvents).map(eventSummary);
  const errors = trace.events.filter((event) => event.level === "ERROR" || event.level === "CRITICAL" || event.type === "agent.error").map(eventSummary);
  return [
    "Judge this multi-agent engine trace for operational quality.",
    "Return only JSON with numeric 0..1 fields: judge_overall_quality, judge_release_readiness, and a short rationale string.",
    "",
    JSON.stringify({
      sessionId: trace.sessionId,
      goal: safeJudgeText(trace.goal, 1000),
      chain: trace.chain,
      status: trace.status,
      duration_ms: trace.duration_ms,
      totalCost: trace.totalCost,
      eventCount: trace.events.length,
      sampledEvents: events,
      errors,
    }, null, 2),
  ].join("\n");
}

export function parseJudgeResponse(text: string): { scores: JudgeScores; rationale: string } {
  const trimmed = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Judge response did not contain JSON");
    parsed = JSON.parse(match[0]) as Record<string, unknown>;
  }
  return {
    scores: {
      judge_overall_quality: clamp01(parsed.judge_overall_quality),
      judge_release_readiness: clamp01(parsed.judge_release_readiness),
    },
    rationale: String(parsed.rationale ?? "").slice(0, 1000),
  };
}

function scoreTimestamp(score: LangfuseScore): number | undefined {
  const raw = score.createdAt ?? score.timestamp ?? score.updatedAt;
  if (!raw) return undefined;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function recentEnough(score: LangfuseScore, cacheDays: number): boolean {
  const ts = scoreTimestamp(score);
  if (ts === undefined) return true;
  return Date.now() - ts <= cacheDays * 24 * 60 * 60 * 1000;
}

export async function getExistingJudgeScores(traceId: string, opts?: JudgeOptions): Promise<JudgeScores | null> {
  const cfg = langfuseConfig();
  if (!cfg) return null;
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const cacheDays = opts?.cacheDays ?? 7;
  const url = `${cfg.host}/api/public/scores?traceId=${encodeURIComponent(traceId)}&limit=100`;
  const resp = await fetchImpl(url, { headers: { Authorization: `Basic ${cfg.auth}` } });
  if (!resp.ok) return null;
  const json = await resp.json() as { data?: LangfuseScore[] } | LangfuseScore[];
  const scores = Array.isArray(json) ? json : json.data ?? [];
  const overall = scores.find((score) => score.name === "judge_overall_quality" && recentEnough(score, cacheDays));
  const readiness = scores.find((score) => score.name === "judge_release_readiness" && recentEnough(score, cacheDays));
  if (!overall || !readiness) return null;
  return {
    judge_overall_quality: clamp01(overall.value),
    judge_release_readiness: clamp01(readiness.value),
  };
}

async function postJudgeScores(traceId: string, scores: JudgeScores, rationale: string, opts?: JudgeOptions): Promise<boolean> {
  const cfg = langfuseConfig();
  if (!cfg) return false;
  const fetchImpl = opts?.fetchImpl ?? fetch;
  for (const [name, value] of Object.entries(scores)) {
    const resp = await fetchImpl(`${cfg.host}/api/public/scores`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Basic ${cfg.auth}` },
      body: JSON.stringify({ traceId, name, value, comment: rationale }),
    });
    if (!resp.ok) return false;
  }
  return true;
}

export function isTraceEvaluable(trace: SessionTrace): boolean {
  return trace.status === "completed" && trace.events.some((event) => event.type === "llm.call" || event.type === "agent.end");
}

export async function judgeTrace(traceOrId: SessionTrace | string, opts?: JudgeOptions): Promise<JudgeResult> {
  const trace = typeof traceOrId === "string" ? loadTrace(traceOrId, opts?.traceDirOverride) : traceOrId;
  if (!opts?.explicit && !isTraceEvaluable(trace)) {
    throw new Error(`Trace ${trace.sessionId} is not evaluable; pass explicit=true to judge anyway`);
  }
  const cached = await getExistingJudgeScores(trace.sessionId, opts);
  const model = opts?.model ?? "main";
  if (cached) {
    return { traceId: trace.sessionId, scores: cached, rationale: "cached Langfuse judge scores", model, cached: true, posted: false };
  }

  const prompt = buildJudgePrompt(trace, opts?.maxEvents ?? 50);
  const raw = await (opts?.llm ?? callLLM)({
    model,
    temperature: 0,
    maxTokens: 700,
    system: "You are a strict release-readiness judge. Respond with JSON only.",
    user: prompt,
  });
  const parsed = parseJudgeResponse(raw);
  const posted = await postJudgeScores(trace.sessionId, parsed.scores, parsed.rationale, opts);
  return { traceId: trace.sessionId, scores: parsed.scores, rationale: parsed.rationale, model, cached: false, posted };
}

export async function judgeTraces(traces: Array<SessionTrace | string>, opts?: JudgeOptions & { maxTraces?: number }): Promise<JudgeResult[]> {
  const maxTraces = opts?.maxTraces ?? 10;
  const selected = traces.slice(0, maxTraces);
  const results: JudgeResult[] = [];
  for (const trace of selected) {
    results.push(await judgeTrace(trace, opts));
  }
  return results;
}
