import { describe, test, expect } from "bun:test";
import { resolveModelForRole, resolveModel, loadModelRouting } from "./config";

describe("model tier enforcement (#148)", () => {
  describe("resolveModelForRole", () => {
    test("lead resolves to high tier default model with high thinking", () => {
      const result = resolveModelForRole("lead");
      const routing = loadModelRouting();
      expect(result.model).toBe(routing.tiers["high"]!.default);
      expect(result.thinking).toBe("high");
    });

    test("orchestrator resolves to high tier", () => {
      const result = resolveModelForRole("orchestrator");
      const routing = loadModelRouting();
      expect(result.model).toBe(routing.tiers["high"]!.default);
      expect(result.thinking).toBe("high");
    });

    test("sr resolves to high tier", () => {
      const result = resolveModelForRole("sr");
      const routing = loadModelRouting();
      expect(result.model).toBe(routing.tiers["high"]!.default);
      expect(result.thinking).toBe("high");
    });

    test("worker resolves to medium tier default model with medium thinking", () => {
      const result = resolveModelForRole("worker");
      const routing = loadModelRouting();
      expect(result.model).toBe(routing.tiers["medium"]!.default);
      expect(result.thinking).toBe("medium");
    });

    test("scout resolves to fast tier default model with fast-tier thinking", () => {
      const result = resolveModelForRole("scout");
      const routing = loadModelRouting();
      expect(result.model).toBe(routing.tiers["fast"]!.default);
      expect(result.thinking).toBe(routing.roleDefaults["scout"]!.thinking);
    });
  });

  describe("preferred alias override", () => {
    test("lead with preferred quality alias uses alias model and high thinking", () => {
      const result = resolveModelForRole("lead", "quality");
      expect(result.model).toBe(resolveModel("quality"));
      expect(result.thinking).toBe("high");
    });

    test("gpt-5.5 aliases use low thinking regardless of role default", () => {
      const leadResult = resolveModelForRole("lead", "pro");
      const workerResult = resolveModelForRole("worker", "pro");

      expect(leadResult.model).toBe("gpt-5.5");
      expect(leadResult.thinking).toBe("low");
      expect(workerResult.model).toBe("gpt-5.5");
      expect(workerResult.thinking).toBe("low");
    });

    test("worker with quality alias gets opus model but medium thinking", () => {
      const result = resolveModelForRole("worker", "quality");
      expect(result.model).toBe(resolveModel("quality"));
      expect(result.thinking).toBe("medium");
    });

    test("worker with fast alias gets fast model but medium thinking", () => {
      const result = resolveModelForRole("worker", "fast");
      expect(result.model).toBe(resolveModel("fast"));
      expect(result.thinking).toBe("medium");
    });

    test("scout with preferred alias uses alias model but scout-tier thinking", () => {
      const result = resolveModelForRole("scout", "quality");
      const routing = loadModelRouting();
      expect(result.model).toBe(resolveModel("quality"));
      expect(result.thinking).toBe(routing.roleDefaults["scout"]!.thinking);
    });
  });

  describe("fallback for unknown role", () => {
    test("unknown role falls back to main alias with medium thinking", () => {
      const result = resolveModelForRole("unknown_role" as any);
      expect(result.model).toBe(resolveModel("main"));
      expect(result.thinking).toBe("medium");
    });
  });

  describe("roleDefaults config completeness", () => {
    test("all AgentRole values have roleDefaults entries", () => {
      const routing = loadModelRouting();
      const roles = ["orchestrator", "lead", "sr", "worker", "scout"];
      for (const role of roles) {
        const defaults = routing.roleDefaults[role];
        expect(defaults).toBeDefined();
        expect(defaults!.tier).toBeTruthy();
        expect(defaults!.thinking).toBeTruthy();
      }
    });

    test("all referenced tiers exist in tiers config", () => {
      const routing = loadModelRouting();
      for (const [, defaults] of Object.entries(routing.roleDefaults)) {
        const tier = routing.tiers[defaults.tier];
        expect(tier).toBeDefined();
        expect(tier!.default).toBeTruthy();
      }
    });
  });

  describe("tier defaults are correct", () => {
    test("high tier default is opus", () => {
      const routing = loadModelRouting();
      expect(routing.tiers["high"]!.default).toContain("opus");
    });

    test("medium tier has a default model", () => {
      const routing = loadModelRouting();
      expect(routing.tiers["medium"]!.default).toBeTruthy();
    });

    test("fast tier has a default model", () => {
      const routing = loadModelRouting();
      expect(routing.tiers["fast"]!.default).toBeTruthy();
    });
  });
});
