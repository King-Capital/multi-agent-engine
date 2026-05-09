import { describe, it, expect } from "bun:test";
import { getCrossModelVerifier, isDifferentModelFamily, resolveModel, loadModelRouting } from "./config";

describe("cross-model pair enforcement", () => {
  describe("getCrossModelVerifier", () => {
    it("returns verifier for first builder in crossModelPairs", () => {
      const routing = loadModelRouting();
      const pair = routing.crossModelPairs?.[0];
      if (!pair) return;
      const verifier = getCrossModelVerifier(pair.builder);
      expect(verifier).toBe(pair.verifier);
    });

    it("returns verifier for second builder (reverse pair)", () => {
      const routing = loadModelRouting();
      const pair = routing.crossModelPairs?.[1];
      if (!pair) return;
      const verifier = getCrossModelVerifier(pair.builder);
      expect(verifier).toBe(pair.verifier);
    });

    it("returns null for model not in crossModelPairs", () => {
      const verifier = getCrossModelVerifier("some/random-model-not-paired");
      expect(verifier).toBeNull();
    });

    it("returns null for unknown model", () => {
      const verifier = getCrossModelVerifier("nonexistent/model");
      expect(verifier).toBeNull();
    });

    it("resolves aliases before matching", () => {
      const routing = loadModelRouting();
      const qualityModel = resolveModel("quality");
      expect(qualityModel).toBeTruthy();
      const verifier = getCrossModelVerifier(qualityModel);
      if (routing.crossModelPairs?.some(p => p.builder === qualityModel)) {
        expect(verifier).toBeTruthy();
      }
    });
  });

  describe("isDifferentModelFamily", () => {
    it("same provider prefix = same family", () => {
      const routing = loadModelRouting();
      const highDefault = routing.tiers["high"]!.default;
      expect(isDifferentModelFamily(highDefault, highDefault)).toBe(false);
    });

    it("different provider prefix = different family", () => {
      const routing = loadModelRouting();
      const pairs = routing.crossModelPairs ?? [];
      if (pairs.length > 0) {
        expect(isDifferentModelFamily(pairs[0]!.builder, pairs[0]!.verifier)).toBe(true);
      }
    });

    it("same model = same family", () => {
      expect(isDifferentModelFamily("opus", "opus")).toBe(false);
    });

    it("resolves aliases before comparing", () => {
      const qualityModel = resolveModel("quality");
      const proModel = resolveModel("pro");
      if (qualityModel !== proModel) {
        const different = isDifferentModelFamily(qualityModel, proModel);
        expect(typeof different).toBe("boolean");
      }
    });
  });

  describe("crossModelPairs config", () => {
    it("crossModelPairs exist and have at least one pair", () => {
      const routing = loadModelRouting();
      expect(routing.crossModelPairs).toBeDefined();
      expect(routing.crossModelPairs!.length).toBeGreaterThan(0);
    });

    it("cross-model pair models are different families", () => {
      const routing = loadModelRouting();
      for (const pair of routing.crossModelPairs ?? []) {
        expect(isDifferentModelFamily(pair.builder, pair.verifier)).toBe(true);
      }
    });
  });
});
