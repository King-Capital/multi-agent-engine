import { describe, it, expect } from "bun:test";
import { getCrossModelVerifier, isDifferentModelFamily, resolveModel } from "./config";

describe("cross-model pair enforcement", () => {
  describe("getCrossModelVerifier", () => {
    it("returns verifier for opus builder", () => {
      const verifier = getCrossModelVerifier("litellm/opus-nocache");
      // GPT-5.5 is configured as cross-model pair but goes through Codex sub, not LiteLLM
      // crossModelPairs in model-routing.yaml defines the pairing
      expect(verifier).toBe("openai/gpt-5.5");
    });

    it("returns verifier for openai builder", () => {
      const verifier = getCrossModelVerifier("openai/gpt-5.5");
      expect(verifier).toBe("litellm/opus-nocache");
    });

    it("returns null for model not in crossModelPairs", () => {
      const verifier = getCrossModelVerifier("litellm/sonnet-nocache");
      expect(verifier).toBeNull();
    });

    it("returns null for unknown model", () => {
      const verifier = getCrossModelVerifier("some/random-model");
      expect(verifier).toBeNull();
    });

    it("resolves aliases before matching", () => {
      const resolved = resolveModel("quality");
      expect(resolved).toBe("litellm/opus-nocache");

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
      // quality = litellm/opus-nocache, pro = gpt-5.5 -- different families
      const qualityModel = resolveModel("quality");
      const proModel = resolveModel("pro");
      expect(qualityModel).toBe("litellm/opus-nocache");
      expect(proModel).toBe("openai/gpt-5.5");
      expect(isDifferentModelFamily(qualityModel, proModel)).toBe(true);
    });
  });

  describe("crossModelPairs config", () => {
    it("crossModelPairs are bidirectional", () => {
      const opusVerifier = getCrossModelVerifier("litellm/opus-nocache");
      const gptVerifier = getCrossModelVerifier("openai/gpt-5.5");
      expect(opusVerifier).toBe("openai/gpt-5.5");
      expect(gptVerifier).toBe("litellm/opus-nocache");
    });

    it("cross-model pair models are different families", () => {
      // The pairing itself defines different families (litellm vs openai)
      // Even though GPT-5.5 routing needs Codex adapter, the config is correct
      expect(isDifferentModelFamily("litellm/opus-nocache", "openai/gpt-5.5")).toBe(true);
    });
  });
});
