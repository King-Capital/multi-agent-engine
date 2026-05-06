import { describe, it, expect } from "bun:test";
import { getCrossModelVerifier, isDifferentModelFamily, resolveModel } from "./config";

describe("cross-model pair enforcement", () => {
  describe("getCrossModelVerifier", () => {
    it("returns verifier for opus builder", () => {
      const verifier = getCrossModelVerifier("litellm/opus-nocache");
      expect(verifier).toBe("openai/gpt-5.5");
    });

    it("returns verifier for openai builder", () => {
      const verifier = getCrossModelVerifier("openai/gpt-5.5");
      expect(verifier).toBe("litellm/opus-nocache");
    });

    it("returns null for model not in crossModelPairs", () => {
      // sonnet is not in the current crossModelPairs config
      const verifier = getCrossModelVerifier("litellm/sonnet-nocache");
      expect(verifier).toBeNull();
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

    it("same model = same family", () => {
      expect(isDifferentModelFamily("litellm/opus-nocache", "litellm/opus-nocache")).toBe(false);
    });

    it("resolves aliases before comparing", () => {
      // "quality" = litellm/opus-nocache, "pro" = openai/gpt-5.5 -- different families
      const qualityModel = resolveModel("quality");
      const proModel = resolveModel("pro");
      expect(qualityModel).toBe("litellm/opus-nocache");
      expect(proModel).toBe("openai/gpt-5.5");
      expect(isDifferentModelFamily(qualityModel, proModel)).toBe(true);
    });
  });

  describe("team config cross-model pairs", () => {
    it("quality and pro aliases resolve to different model families", () => {
      // quality = litellm/opus-nocache, pro = openai/gpt-5.5
      const qualityModel = resolveModel("quality");
      const proModel = resolveModel("pro");

      // These are different families now (litellm vs openai)
      expect(isDifferentModelFamily(qualityModel, proModel)).toBe(true);

      // getCrossModelVerifier should find the paired verifier
      const verifier = getCrossModelVerifier(qualityModel);
      expect(verifier).toBe("openai/gpt-5.5");
      expect(isDifferentModelFamily(qualityModel, verifier!)).toBe(true);
    });

    it("crossModelPairs are bidirectional", () => {
      // opus -> gpt-5.5 and gpt-5.5 -> opus
      const opusVerifier = getCrossModelVerifier("litellm/opus-nocache");
      const gptVerifier = getCrossModelVerifier("openai/gpt-5.5");
      expect(opusVerifier).toBe("openai/gpt-5.5");
      expect(gptVerifier).toBe("litellm/opus-nocache");
    });
  });
});
