import { writeFileSync } from "fs";
import { join } from "path";
import { resolveModel, getModelFallbacks } from "./config";
import { sanitizeAgentInput } from "./security";
import { createLogger } from "./logger";
import type { DelegateResult, DelegateOptions, PlatformAdapter, ThinkingLevel } from "./types";

const log = createLogger("self-heal");

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

function getEscalationModel(currentModel: string): string {
  // First try dynamic fallbacks from model-routing.yaml
  const fallbacks = getModelFallbacks(currentModel);
  if (fallbacks.length > 0) return fallbacks[0]!;
  // Then try static escalation map
  return MODEL_ESCALATION[currentModel] ?? currentModel;
}

function getUnavailableModelFallback(currentModel: string): string {
  const configured = process.env.MAE_MODEL_UNAVAILABLE_FALLBACK;
  if (configured && configured !== currentModel) return configured;
  const fallback = getEscalationModel(currentModel);
  if (fallback !== currentModel) return fallback;
  return currentModel === "main" ? "quality" : "main";
}

const THINKING_ESCALATION: Record<ThinkingLevel, ThinkingLevel> = {
  off: "low",
  minimal: "low",
  low: "medium",
  medium: "high",
  high: "xhigh",
  xhigh: "xhigh",
};

const TIMEOUT_FOR_ROLE: Record<string, number> = {
  scout: 300_000,
  worker: 1_800_000,
  lead: 1_800_000,
  orchestrator: 0,
};

const READ_ONLY_TOOLS = new Set(["read", "grep", "glob"]);

export function isReadOnlyDelegateOptions(opts: DelegateOptions): boolean {
  const writes = opts.domain.write ?? [];
  const updates = opts.domain.update ?? [];
  return writes.length === 0 && updates.length === 0 && opts.tools.every((tool) => READ_ONLY_TOOLS.has(tool));
}

function isFailed(result: DelegateResult): boolean {
  if (result.grade === "FAILED") return true;
  if (!result.output.trim()) return true;
  if (result.output.startsWith("ERROR:")) return true;
  if (result.findings?.includes("timeout")) return true;
  if (result.findings?.includes("empty_output")) return true;
  return false;
}

function isModelUnavailable(result: DelegateResult): boolean {
  const haystack = [
    result.output,
    ...(result.findings ?? []),
  ].join("\n").toLowerCase();

  return [
    "model_not_found",
    "model not found",
    "unknown model",
    "model_not_available",
    "model unavailable",
    "not available for model",
    "no such model",
    "could not find model",
  ].some((needle) => haystack.includes(needle));
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

  const timeoutMs = opts.timeoutMs ?? TIMEOUT_FOR_ROLE[agentRole] ?? 300_000;
  const healOpts = { ...opts, timeoutMs };

  // Attempt 1: Normal run
  log.info("Attempt 1: normal run", { agent: healOpts.persona.name, model: healOpts.model });
  let result = await adapter.delegate(healOpts);
  logOutput(opts.sessionDir, opts.persona.name, 1, result);

  if (!isFailed(result)) return result;
  if (opts.abortSignal?.aborted) return result;

  if (isModelUnavailable(result)) {
    const fallbackModel = getUnavailableModelFallback(opts.model);
    const fallbackResolved = resolveModel(fallbackModel);

    if (fallbackResolved !== opts.model) {
      log.warn("Attempt 2: model unavailable, respawning with fallback model", {
        agent: opts.persona.name,
        failed_model: opts.model,
        fallback_model: fallbackResolved,
      });
      await onEvent("self_heal", {
        failed_worker: opts.persona.name,
        heal_action: `Model ${opts.model} was unavailable. Respawning with ${fallbackResolved}.`,
      });

      result = await adapter.delegate({
        ...opts,
        model: fallbackResolved,
        userPrompt: [
          opts.userPrompt,
          "",
          "## Runtime Note",
          `The originally configured model (${opts.model}) was unavailable. Continue this assignment using ${fallbackResolved}.`,
        ].join("\n"),
      });
      logOutput(opts.sessionDir, opts.persona.name, 2, result);

      if (!isFailed(result)) return result;
      if (opts.abortSignal?.aborted) return result;
    }
  }

  // Attempt 1.5: Try deterministic autofix before burning tokens on retry.
  // Review-only/read-only runs must never mutate the worktree as part of self-healing.
  if (opts.workingDir && !isReadOnlyDelegateOptions(opts)) {
    log.info("Attempting deterministic autofix", { workingDir: opts.workingDir });
    try {
      // Run common autofixers -- they either fix the issue or no-op harmlessly
      const commands = [
        ["bash", "-c", "[ -f tsconfig.json ] && bunx tsc --noEmit 2>&1 | head -20"],
        ["bash", "-c", "[ -f go.mod ] && go vet ./... 2>&1 | head -20"],
        ["bash", "-c", "[ -f .eslintrc ] || [ -f .eslintrc.json ] || [ -f eslint.config.js ] || exit 0; bunx eslint --fix . 2>/dev/null || true"],
      ];
      for (const command of commands) {
        const fixProc = Bun.spawn(command, {
          cwd: opts.workingDir,
          stdout: "pipe",
          stderr: "pipe",
        });
        const fixOutput = await new Response(fixProc.stdout).text();
        const fixExit = await fixProc.exited;
        if (fixExit === 0 && fixOutput.trim()) {
          log.debug("Autofix output", { output: fixOutput.slice(0, 200) });
        }
      }
    } catch { /* autofix is best-effort */ }
  }

  // Attempt 2: Same model, more context
  log.info("Attempt 2: retry with error context", { agent: opts.persona.name });
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
  if (opts.abortSignal?.aborted) return result;

  // Attempt 3: Upgrade model
  const upgradedModel = getEscalationModel(opts.model);
  const upgradedThinking = THINKING_ESCALATION[opts.thinking] ?? opts.thinking;
  const modelChanged = upgradedModel !== opts.model;

  if (modelChanged) {
    log.info("Attempt 3: model upgrade", { from_model: opts.model, to_model: upgradedModel, from_thinking: opts.thinking, to_thinking: upgradedThinking });
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
    if (opts.abortSignal?.aborted) return result;
  }

  // Attempt 4: This is handled by the orchestrator (lead takes over)
  // Return the failed result so the orchestrator knows to self-heal
  log.warn("All attempts failed, escalating", { agent: opts.persona.name, attempts: modelChanged ? 3 : 2 });
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
