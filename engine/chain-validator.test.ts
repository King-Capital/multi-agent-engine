import { describe, expect, test } from "bun:test";
import {
  buildChainValidationReport,
  formatChainValidationReport,
  resolveValidateChainInput,
  suggestChainForGoal,
} from "./chain-validator";
import { loadChains } from "./config";

describe("chain-validator", () => {
  test("standard-swarm exposes Arch coordinator plus all SME squads", () => {
    const report = buildChainValidationReport("standard-swarm", "Find release blockers");
    const output = formatChainValidationReport(report);

    expect(report.summary.steps).toBe(2);
    expect(report.summary.teams).toBe(6);
    expect(report.summary.leads).toBe(6);
    expect(report.summary.workers).toBeGreaterThanOrEqual(25);
    expect(report.steps[0]?.agents.map((a) => a.name)).toContain("Arch Coordinator");
    expect(report.steps[1]?.teams).toEqual([
      "Correctness Squad",
      "Adversarial Squad",
      "Quality Squad",
      "Security Squad",
      "Domain Squad",
    ]);
    expect(output).toContain("SWARM_COORDINATION_READY|SME Squad Coverage Plan|Squad Assignments");
    expect(output).toContain("Correctness Lead");
    expect(output).toContain("Security-Aware Domain Reviewer");
  });

  test("standard-swarm review squads are read-only and schema-gated", () => {
    const chain = loadChains().chains["standard-swarm"];
    const parallel = chain?.steps?.[1]?.parallel;
    const tillDone = chain?.steps?.[1]?.till_done;

    expect(parallel?.length).toBe(5);
    for (const step of parallel ?? []) {
      expect(step.system_prompt_append).toContain("REVIEW-ONLY MODE");
      expect(step.system_prompt_append).toContain("Do not edit files");
      expect(step.system_prompt_append).toContain("SQUAD_REPORT:");
      expect(step.system_prompt_append).toContain("BLOCKERS");
    }

    expect(JSON.stringify(tillDone)).toContain("SQUAD_REPORT: Correctness");
    expect(JSON.stringify(tillDone)).toContain("COMMANDS_RUN");
    expect(JSON.stringify(tillDone)).toContain("VERDICT");
  });

  test("plan-build-review includes deterministic verification without agent spawn", () => {
    const report = buildChainValidationReport("plan-build-review");
    const deterministic = report.steps.find((step) => step.mode === "deterministic");

    expect(deterministic?.command).toContain("bun tsc --noEmit");
    expect(deterministic?.agents).toEqual([]);
    expect(report.summary.deterministic).toBe(1);
    expect(report.summary.agents).toBeGreaterThan(0);
  });

  test("goal input is resolved through deterministic local chain suggestion", () => {
    const input = resolveValidateChainInput(["Design dashboard UI review"]);

    expect(input.chainName).toBe("design-review");
    expect(input.goal).toBe("Design dashboard UI review");
    expect(input.suggestedChain?.reason).toContain("Deterministic local match");
  });

  test("explicit chain input keeps the configured chain", () => {
    const input = resolveValidateChainInput(["review-only", "Review auth module"]);

    expect(input.chainName).toBe("review-only");
    expect(input.goal).toBe("Review auth module");
    expect(input.suggestedChain).toBeUndefined();
  });

  test("suggestion falls back to plan-build-review when there is no match", () => {
    const suggestion = suggestChainForGoal("zqyx frobnicate unrelated");

    expect(suggestion?.chain).toBe("plan-build-review");
    expect(suggestion?.score).toBe(0);
  });
});
