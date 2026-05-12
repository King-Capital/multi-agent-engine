import { loadModelRouting, resolveModel } from "./config";

export type LangfuseScoreType = "NUMERIC" | "CATEGORICAL" | "BOOLEAN" | "TEXT";

export interface LangfuseScoreConfigSpec {
  name: string;
  dataType: LangfuseScoreType;
  description: string;
  minValue?: number;
  maxValue?: number;
  categories?: Array<{ label: string; value: string | number }>;
}

export interface LangfuseLlmConnectionSpec {
  name: string;
  provider: "openai";
  baseUrl: string;
  customModels: string[];
}

export interface LangfuseProvisionPlan {
  host: string;
  scoreConfigs: LangfuseScoreConfigSpec[];
  llmConnection: LangfuseLlmConnectionSpec;
  judgeConfigs: Array<{
    name: string;
    scoreName: string;
    model: string;
    scoreType: LangfuseScoreType;
    prompt: string;
  }>;
}

export interface LangfuseProvisionResult {
  dryRun: boolean;
  plan: LangfuseProvisionPlan;
  scoreConfigs: Array<{ name: string; status: "exists" | "created" | "failed"; message?: string }>;
  llmConnection: { name: string; status: "planned" | "upserted" | "failed"; message?: string };
  judgeConfigs: Array<{ name: string; status: "manual" | "planned"; message: string }>;
}

const MAE_SCORE_CONFIGS: LangfuseScoreConfigSpec[] = [
  {
    name: "session_completion",
    dataType: "BOOLEAN",
    description: "Whether a MAE session completed successfully.",
  },
  {
    name: "agent_grade",
    dataType: "CATEGORICAL",
    description: "Final agent/lead review grade.",
    categories: [
      { label: "PERFECT", value: 1 },
      { label: "VERIFIED", value: 0.9 },
      { label: "PARTIAL", value: 0.5 },
      { label: "FEEDBACK", value: 0.25 },
      { label: "FAILED", value: 0 },
    ],
  },
  {
    name: "cost_efficiency",
    dataType: "NUMERIC",
    description: "Cost quality score from 0.0 poor to 1.0 efficient.",
    minValue: 0,
    maxValue: 1,
  },
  {
    name: "worker_success_rate",
    dataType: "NUMERIC",
    description: "Share of workers that completed without final failure.",
    minValue: 0,
    maxValue: 1,
  },
  {
    name: "chain_step_completion",
    dataType: "NUMERIC",
    description: "Share of configured chain steps that completed.",
    minValue: 0,
    maxValue: 1,
  },
  {
    name: "judge_overall_quality",
    dataType: "NUMERIC",
    description: "LLM-as-judge overall quality score for a MAE trace.",
    minValue: 0,
    maxValue: 1,
  },
  {
    name: "judge_rc1_readiness",
    dataType: "CATEGORICAL",
    description: "LLM-as-judge RC1 readiness verdict.",
    categories: [
      { label: "pass", value: 1 },
      { label: "partial", value: 0.5 },
      { label: "fail", value: 0 },
    ],
  },
  {
    name: "ralph_mutation_verdict",
    dataType: "CATEGORICAL",
    description: "Ralph mutation disposition.",
    categories: [
      { label: "accepted", value: 1 },
      { label: "needs_verification", value: 0.6 },
      { label: "dry_run", value: 0.4 },
      { label: "no_change", value: 0.2 },
      { label: "invalid", value: 0.1 },
      { label: "rejected", value: 0 },
    ],
  },
];

const JUDGE_PROMPT = `You are evaluating a MAE multi-agent orchestration trace.

Score the run against these criteria:
- Did the orchestrator coordinate the correct leads and workers?
- Did the system complete all relevant chain steps?
- Were failures handled with useful retries or escalation?
- Was cost reasonable for the amount of work?
- Was the final output actionable and aligned with the user's goal?

Return a structured score and concise reasoning.`;

function uniq<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function configuredJudgeModels(): string[] {
  const routing = loadModelRouting();
  const aliases = Object.values(routing.aliases ?? {}).map((m) => resolveModel(m));
  const tierDefaults = Object.values(routing.tiers).map((tier) => resolveModel(tier.default));
  const tierOptions = Object.values(routing.tiers)
    .flatMap((tier) => tier.options ?? [])
    .map((option) => resolveModel(option.model));
  return uniq([...aliases, ...tierDefaults, ...tierOptions]).sort();
}

export function buildLangfuseProvisionPlan(): LangfuseProvisionPlan {
  const host = process.env.LANGFUSE_HOST ?? "http://10.71.20.73:3000";
  const baseUrl = process.env.LANGFUSE_LITELLM_BASE_URL
    ?? process.env.MAE_LLM_GATEWAY_URL
    ?? process.env.LITELLM_URL
    ?? process.env.LITELLM_API_BASE
    ?? "";
  const customModels = configuredJudgeModels();
  const defaultJudgeModel = resolveModel(process.env.LANGFUSE_JUDGE_MODEL ?? "quality");

  return {
    host,
    scoreConfigs: MAE_SCORE_CONFIGS,
    llmConnection: {
      name: process.env.LANGFUSE_LITELLM_CONNECTION_NAME ?? "MAE LiteLLM",
      provider: "openai",
      baseUrl: baseUrl ? (baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl.replace(/\/$/, "")}/v1`) : "",
      customModels,
    },
    judgeConfigs: [
      {
        name: "MAE Overall Quality Judge",
        scoreName: "judge_overall_quality",
        model: defaultJudgeModel,
        scoreType: "NUMERIC",
        prompt: JUDGE_PROMPT,
      },
      {
        name: "MAE RC1 Readiness Judge",
        scoreName: "judge_rc1_readiness",
        model: defaultJudgeModel,
        scoreType: "CATEGORICAL",
        prompt: `${JUDGE_PROMPT}\n\nVerdict categories: pass, partial, fail.`,
      },
    ],
  };
}

function authHeader(): string {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  if (!publicKey || !secretKey) throw new Error("Langfuse credentials missing. Set LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY.");
  return `Basic ${btoa(`${publicKey}:${secretKey}`)}`;
}

export function explainLlmConnectionFailure(message: string, baseUrl: string): string {
  if (!message.includes("Blocked IP address detected")) return message;

  let host = "the LiteLLM host";
  try {
    host = new URL(baseUrl).hostname || host;
  } catch {
    // Keep the generic fallback when the configured URL is malformed.
  }

  return `${message} Set LANGFUSE_LLM_CONNECTION_WHITELISTED_HOST=${host} on the self-hosted Langfuse web/worker containers if this gateway is trusted.`;
}

async function langfuseRequest(host: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${host}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: authHeader(),
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(15_000),
  });
}

export async function provisionLangfuseForMae(opts: { dryRun?: boolean } = {}): Promise<LangfuseProvisionResult> {
  const dryRun = opts.dryRun ?? false;
  const plan = buildLangfuseProvisionPlan();
  const result: LangfuseProvisionResult = {
    dryRun,
    plan,
    scoreConfigs: [],
    llmConnection: { name: plan.llmConnection.name, status: dryRun ? "planned" : "failed" },
    judgeConfigs: plan.judgeConfigs.map((cfg) => ({
      name: cfg.name,
      status: dryRun ? "planned" : "manual",
      message: "Create this hosted evaluator in Langfuse UI using the MAE LiteLLM connection, or run MAE-side judges to ingest scores via API.",
    })),
  };

  if (dryRun) {
    result.scoreConfigs = plan.scoreConfigs.map((cfg) => ({ name: cfg.name, status: "exists", message: "dry run" }));
    result.llmConnection = { name: plan.llmConnection.name, status: "planned", message: "dry run" };
    return result;
  }

  let existingScoreConfigs: Array<{ name?: string }> = [];
  const scoreList = await langfuseRequest(plan.host, "/api/public/score-configs");
  if (scoreList.ok) {
    const json = await scoreList.json() as { data?: Array<{ name?: string }> } | Array<{ name?: string }>;
    existingScoreConfigs = Array.isArray(json) ? json : (json.data ?? []);
  }

  for (const cfg of plan.scoreConfigs) {
    if (existingScoreConfigs.some((existing) => existing.name === cfg.name)) {
      result.scoreConfigs.push({ name: cfg.name, status: "exists" });
      continue;
    }

    const res = await langfuseRequest(plan.host, "/api/public/score-configs", {
      method: "POST",
      body: JSON.stringify(cfg),
    });
    result.scoreConfigs.push({
      name: cfg.name,
      status: res.ok ? "created" : "failed",
      message: res.ok ? undefined : `${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`,
    });
  }

  const llmKey = process.env.LANGFUSE_LITELLM_API_KEY ?? process.env.MAE_LLM_GATEWAY_KEY ?? process.env.LITELLM_API_KEY;
  if (!plan.llmConnection.baseUrl || !llmKey) {
    result.llmConnection = {
      name: plan.llmConnection.name,
      status: "failed",
      message: "Missing LiteLLM base URL or API key. Set LANGFUSE_LITELLM_BASE_URL and LANGFUSE_LITELLM_API_KEY, or MAE/LITELLM equivalents.",
    };
    return result;
  }

  // Langfuse documents LLM connection management through GET/PUT. The provider is OpenAI
  // because LiteLLM exposes the OpenAI-compatible chat/completions schema.
  const llmPayload = {
    provider: "openai",
    adapter: "openai",
    name: plan.llmConnection.name,
    displaySecretKey: "MAE LiteLLM API key",
    secretKey: llmKey,
    baseURL: plan.llmConnection.baseUrl,
    customModels: plan.llmConnection.customModels,
    withDefaultModels: false,
  };
  const llmRes = await langfuseRequest(plan.host, "/api/public/llm-connections", {
    method: "PUT",
    body: JSON.stringify(llmPayload),
  });
  const failureMessage = llmRes.ok ? undefined : `${llmRes.status}: ${(await llmRes.text().catch(() => "")).slice(0, 200)}`;
  result.llmConnection = {
    name: plan.llmConnection.name,
    status: llmRes.ok ? "upserted" : "failed",
    message: failureMessage ? explainLlmConnectionFailure(failureMessage, plan.llmConnection.baseUrl) : undefined,
  };

  return result;
}
