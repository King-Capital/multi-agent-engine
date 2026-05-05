import { writeFileSync } from "fs";
import { join } from "path";
import { resolveModel } from "./config";
import { sanitizeAgentInput } from "./security";
import type { DelegateResult, DelegateOptions, PlatformAdapter, ThinkingLevel } from "./types";

const MODEL_ESCALATION: Record<string, string> = {
  "litellm/sonnet-nocache": "litellm/opus-nocache",
  "litellm/haiku-nocache": "litellm/sonnet-nocache",
  "litellm/flash": "litellm/sonnet-nocache",
  "litellm/pro-nocache": "litellm/opus-nocache",
  "openai/gpt-5.4-mini": "openai/gpt-5.5",
  "fast": "main",
  "main": "quality",
  "free": "main",
};

const THINKING_ESCALATION: Record<ThinkingLevel, ThinkingLevel> = {
  off: "low",
  minimal: "low",
  low: "medium",
  medium: "high",
  high: "xhigh",
  xhigh: "xhigh",
};

const TIMEOUT_FOR_ROLE: Record<string, number> = {
  scout: 60_000,
  worker: 300_000,
  lead: 600_000,
  orchestrator: 600_000,
};

function isFailed(result: DelegateResult): boolean {
  if (result.grade === "FAILED") return true;
  if (!result.output.trim()) return true;
  if (result.output.startsWith("ERROR:")) return true;
  if (result.findings?.includes("timeout")) return true;
  if (result.findings?.includes("empty_output")) return true;
  return false;
}

export interface SelfHealContext {
  adapter: PlatformAdapter;
  opts: DelegateOptions;
  sessionId: string;
  agentRole: string;
  onEvent: (type: string, data: Record<string, unknown>) => Promise<void>;
}

export async function delegateWithHealing(ctx: SelfHealContext): Promise<DelegateResult> {
  const { adapter, opts, sessionId, agentRole, onEvent } = ctx;
  const maxAttempts = 4;

  opts.timeoutMs = opts.timeoutMs ?? TIMEOUT_FOR_ROLE[agentRole] ?? 300_000;

  // Attempt 1: Normal run
  console.log(`[self-heal] Attempt 1: ${opts.persona.name} (${opts.model})`);
  let result = await adapter.delegate(opts);
  logOutput(opts.sessionDir, opts.persona.name, 1, result);

  if (!isFailed(result)) return result;

  // Attempt 2: Same model, more context
  console.log(`[self-heal] Attempt 2: retry with error context`);
  await onEvent("self_heal", {
    failed_worker: opts.persona.name,
    heal_action: `Attempt 1 failed (${result.grade ?? "empty"}). Retrying with error context.`,
  });

  const retryPrompt = [
    opts.userPrompt,
    "",
    "## Previous Attempt Failed",
    `Your first attempt failed with: ${result.grade ?? "empty output"}`,
    result.output ? `Previous output:\n${sanitizeAgentInput(result.output.slice(0, 1000))}` : "No output was produced.",
    "Try again with a different approach.",
  ].join("\n");

  result = await adapter.delegate({ ...opts, userPrompt: retryPrompt });
  logOutput(opts.sessionDir, opts.persona.name, 2, result);

  if (!isFailed(result)) return result;

  // Attempt 3: Upgrade model
  const upgradedModel = MODEL_ESCALATION[opts.model] ?? opts.model;
  const upgradedThinking = THINKING_ESCALATION[opts.thinking] ?? opts.thinking;
  const modelChanged = upgradedModel !== opts.model;

  if (modelChanged) {
    console.log(`[self-heal] Attempt 3: upgrading ${opts.model} → ${upgradedModel}, thinking ${opts.thinking} → ${upgradedThinking}`);
    await onEvent("self_heal", {
      failed_worker: opts.persona.name,
      heal_action: `Escalating from ${opts.model} to ${upgradedModel} after 2 failed attempts.`,
    });

    result = await adapter.delegate({
      ...opts,
      model: resolveModel(upgradedModel),
      thinking: upgradedThinking,
      userPrompt: retryPrompt,
    });
    logOutput(opts.sessionDir, opts.persona.name, 3, result);

    if (!isFailed(result)) return result;
  }

  // Attempt 4: This is handled by the orchestrator (lead takes over)
  // Return the failed result so the orchestrator knows to self-heal
  console.log(`[self-heal] All ${modelChanged ? 3 : 2} attempts failed for ${opts.persona.name}. Escalating.`);
  await onEvent("self_heal", {
    failed_worker: opts.persona.name,
    heal_action: `All attempts exhausted. Escalating to lead or user.`,
  });

  result.grade = "FAILED";
  return result;
}

function logOutput(sessionDir: string, agentName: string, attempt: number, result: DelegateResult): void {
  try {
    const slug = agentName.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
    const path = join(sessionDir, `${slug}_attempt${attempt}.md`);
    const content = [
      `# ${agentName} - Attempt ${attempt}`,
      `Grade: ${result.grade ?? "unknown"}`,
      `Cost: $${result.costUsd.toFixed(4)}`,
      `Tokens: ${result.tokensUsed}`,
      "",
      "## Output",
      "",
      result.output,
      "",
      result.findings?.length ? `## Findings\n${result.findings.map((f) => `- ${f}`).join("\n")}` : "",
    ].join("\n");
    writeFileSync(path, content);
  } catch {
    // session dir might not exist for echo adapter
  }
}
