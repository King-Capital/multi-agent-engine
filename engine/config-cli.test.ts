import { describe, test, expect } from "bun:test";
import { loadModelRouting, writeModelRouting } from "./config";
import type { ModelRoutingConfig } from "./types";

describe("config CLI (#146)", () => {
  describe("config round-trip", () => {
    test("loadModelRouting returns valid config", () => {
      const config = loadModelRouting();
      expect(config.tiers).toBeDefined();
      expect(config.aliases).toBeDefined();
      expect(config.roleDefaults).toBeDefined();
      expect(config.budgets).toBeDefined();
    });

    test("config has all required tier fields", () => {
      const config = loadModelRouting();
      for (const [name, tier] of Object.entries(config.tiers)) {
        expect(tier.default).toBeTruthy();
        expect(tier.default_thinking).toBeTruthy();
      }
    });

    test("config exports as valid JSON", () => {
      const config = loadModelRouting();
      const json = JSON.stringify(config);
      const parsed = JSON.parse(json) as ModelRoutingConfig;
      expect(parsed.tiers).toBeDefined();
      expect(parsed.budgets).toBeDefined();
    });

    test("JSON round-trip preserves all fields", () => {
      const config = loadModelRouting();
      const json = JSON.stringify(config);
      const parsed = JSON.parse(json) as ModelRoutingConfig;

      expect(Object.keys(parsed.tiers)).toEqual(Object.keys(config.tiers));
      expect(parsed.budgets?.max_per_session_usd).toBe(config.budgets?.max_per_session_usd);
      expect(Object.keys(parsed.roleDefaults)).toEqual(Object.keys(config.roleDefaults));
    });
  });

  describe("config merge", () => {
    test("partial budget merge preserves existing fields", () => {
      const current = loadModelRouting();
      const partial: Partial<ModelRoutingConfig> = {
        budgets: { ...current.budgets!, max_per_session_usd: 999 },
      };
      const merged = { ...current, budgets: { ...current.budgets, ...partial.budgets } };
      expect(merged.budgets!.max_per_session_usd).toBe(999);
      expect(merged.budgets!.max_per_agent_usd).toBe(current.budgets!.max_per_agent_usd);
    });

    test("partial alias merge adds new aliases", () => {
      const current = loadModelRouting();
      const newAliases: Record<string, string> = { ...current.aliases, test: "litellm/test-model" };
      const merged = { ...current, aliases: newAliases };
      expect(merged.aliases["test"]).toBe("litellm/test-model");
      expect(merged.aliases["quality"]).toBe(current.aliases!["quality"]);
    });
  });

  describe("writeModelRouting", () => {
    test("write and re-read produces same config", () => {
      const original = loadModelRouting();
      writeModelRouting(original);
      const reread = loadModelRouting();
      expect(JSON.stringify(reread)).toBe(JSON.stringify(original));
    });
  });
});
