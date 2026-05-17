import type { ChainStep, DelegateOptions, DomainConfig } from "./types";

const READ_ONLY_TOOLS = ["read", "grep", "glob"];
const REVIEW_ONLY_RE = /REVIEW-ONLY MODE|Do not edit files|review-only/i;

export function isReviewOnlyStep(step: Pick<ChainStep, "read_only" | "system_prompt_append">): boolean {
  return step.read_only === true || REVIEW_ONLY_RE.test(step.system_prompt_append ?? "");
}

export function readOnlyTools(tools: string[]): string[] {
  const allowed = new Set(READ_ONLY_TOOLS);
  const filtered = tools.filter((tool) => allowed.has(tool));
  return filtered.length > 0 ? [...new Set(filtered)] : [...READ_ONLY_TOOLS];
}

export function readOnlyDomain(domain: DomainConfig): DomainConfig {
  return { ...domain, write: [], update: [] };
}

export function applyReviewOnlyOptions(opts: DelegateOptions, enabled: boolean): DelegateOptions {
  if (!enabled) return opts;
  return {
    ...opts,
    tools: readOnlyTools(opts.tools),
    domain: readOnlyDomain(opts.domain),
  };
}

export function buildWorkerSystemPromptAppend(stepAppend?: string): string {
  if (!stepAppend) return "";
  const lines = stepAppend
    .split("\n")
    .map((line) => line.trim())
    .filter((line) =>
      line.includes("REVIEW-ONLY MODE") ||
      line.includes("Do not edit files") ||
      line.includes("Use lightweight evidence commands"),
    );
  if (stepAppend.includes("P0/P1/P2/P3")) {
    lines.push("Use P0/P1/P2/P3 severity markers for material findings.");
  }
  return lines.join("\n");
}
