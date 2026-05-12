import { describe, expect, test } from "bun:test";
import { buildLangfuseProvisionPlan, explainLlmConnectionFailure, provisionLangfuseForMae } from "./langfuse-admin";

describe("langfuse-admin", () => {
  test("builds MAE score configs and LiteLLM model connection plan", () => {
    const plan = buildLangfuseProvisionPlan();

    expect(plan.scoreConfigs.map((cfg) => cfg.name)).toContain("session_completion");
    expect(plan.scoreConfigs.map((cfg) => cfg.name)).toContain("judge_overall_quality");
    expect(plan.scoreConfigs.map((cfg) => cfg.name)).toContain("ralph_mutation_verdict");
    expect(plan.llmConnection.provider).toBe("openai");
    expect(plan.llmConnection.customModels).toContain("opus");
    expect(plan.llmConnection.customModels).toContain("sonnet");
    expect(plan.llmConnection.customModels).not.toContain("gpt-5.4");
    expect(plan.llmConnection.customModels).not.toContain("gpt-5.5");
    expect(plan.judgeConfigs.map((cfg) => cfg.scoreName)).toContain("judge_overall_quality");
    expect(plan.judgeConfigs.find((cfg) => cfg.name === "MAE Overall Quality Judge")!.model).toBe("sonnet");
    expect(plan.judgeConfigs.find((cfg) => cfg.name === "MAE Golden Overall Quality Judge")!.model).toBe("opus");
  });

  test("dry-run provisioning returns a complete plan without network calls", async () => {
    const result = await provisionLangfuseForMae({ dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.scoreConfigs.length).toBeGreaterThan(0);
    expect(result.llmConnection.status).toBe("planned");
    expect(result.judgeConfigs.length).toBeGreaterThan(0);
  });

  test("explains self-hosted allowlist fix for blocked LiteLLM hosts", () => {
    const message = explainLlmConnectionFailure(
      '400: {"message":"Invalid baseURL: Blocked IP address detected"}',
      "https://litellm.rodaddy.live/v1",
    );

    expect(message).toContain("LANGFUSE_LLM_CONNECTION_WHITELISTED_HOST=litellm.rodaddy.live");
  });
});
