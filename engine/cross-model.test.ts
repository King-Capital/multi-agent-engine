import { describe, it, expect } from "bun:test";
import { getCrossModelVerifier, isDifferentModelFamily, resolveModel } from "./config";

describe("cross-model pair enforcement", () => {
  describe("getCrossModelVerifier", () => {
    it("returns verifier for opus builder", () => {
      const verifier = getCrossModelVerifier("litellm/opus-nocache");
      expect(verifier).toBe("openai/gpt-5.5");
    });

    it("returns verifier for sonnet builder", () => {
      const verifier = getCrossModelVerifier("litellm/sonnet-nocache");
      // First matching pair: sonnet -> pro
      expect(verifier).toBe("litellm/pro-nocache");
    });

    it("returns verifier for pro builder", () => {
      const verifier = getCrossModelVerifier("litellm/pro-nocache");
      expect(verifier).toBe("litellm/opus-nocache");
    });

    it("returns verifier for openai builder", () => {
      const verifier = getCrossModelVerifier("openai/gpt-5.5");
      expect(verifier).toBe("litellm/opus-nocache");
    });

    it("returns null for unknown model", () => {
      const verifier = getCrossModelVerifier("some/random-model");
      expect(verifier).toBeNull();
    });

    it("resolves aliases before matching", () => {
      // "quality" alias resolves to "litellm/opus-nocache"
      const resolved = resolveModel("quality");
      expect(resolved).toBe("litellm/opus-nocache");

      // The verifier lookup should work with the resolved model
      const verifier = getCrossModelVerifier(resolved);
      expect(verifier).toBe("openai/gpt-5.5");
    });
  });

  describe("isDifferentModelFamily", () => {
    it("litellm/opus vs litellm/sonnet = same family", () => {
      expect(isDifferentModelFamily("litellm/opus-nocache", "litellm/sonnet-nocache")).toBe(false);
    });

    it("litellm/opus vs openai/gpt = different family", () => {
      expect(isDifferentModelFamily("litellm/opus-nocache", "openai/gpt-5.5")).toBe(true);
    });

    it("litellm/opus vs litellm/pro = same family", () => {
      expect(isDifferentModelFamily("litellm/opus-nocache", "litellm/pro-nocache")).toBe(false);
    });

    it("same model = same family", () => {
      expect(isDifferentModelFamily("litellm/opus-nocache", "litellm/opus-nocache")).toBe(false);
    });

    it("resolves aliases before comparing", () => {
      // "quality" = litellm/opus-nocache, "pro" = litellm/pro-nocache -- same family
      expect(isDifferentModelFamily(resolveModel("quality"), resolveModel("pro"))).toBe(false);
    });
  });

  describe("team config cross-model pairs", () => {
    it("Engineering and Engineering B have different model families configured", () => {
      // Engineering uses quality (litellm/opus), Engineering B uses pro (litellm/pro)
      // These are same family (litellm) -- cross-model enforcement should catch this
      // and override Engineering B's model to the paired verifier
      const engModel = resolveModel("quality");
      const engBModel = resolveModel("pro");

      expect(isDifferentModelFamily(engModel, engBModel)).toBe(false);

      // getCrossModelVerifier should find a cross-family pair
      const verifier = getCrossModelVerifier(engModel);
      expect(verifier).toBe("openai/gpt-5.5");
      expect(isDifferentModelFamily(engModel, verifier!)).toBe(true);
    });

    it("Validation and Validation B lead models", () => {
      // Validation uses quality, Validation B uses pro -- same family
      const valModel = resolveModel("quality");
      const valBModel = resolveModel("pro");

      expect(isDifferentModelFamily(valModel, valBModel)).toBe(false);

      const verifier = getCrossModelVerifier(valModel);
      expect(verifier).not.toBeNull();
      expect(isDifferentModelFamily(valModel, verifier!)).toBe(true);
    });
  });
});
