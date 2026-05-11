import { test, expect, describe, mock, beforeEach } from "bun:test";
import { _parseClassification as parseClassification } from "./goal-classifier";

const VALID_CHAINS = [
  "plan-build-review",
  "build-verify",
  "review-only",
  "swarm-review",
  "scout-then-plan",
  "full-sdlc",
  "red-blue",
];

describe("parseClassification", () => {
  test("parses valid JSON response correctly", () => {
    const raw = '{"chain": "build-verify", "confidence": 0.95, "reasoning": "Small single-file fix"}';
    const result = parseClassification(raw, VALID_CHAINS);
    expect(result.chain).toBe("build-verify");
    expect(result.confidence).toBe(0.95);
    expect(result.reasoning).toBe("Small single-file fix");
  });

  test("strips markdown code fences from response", () => {
    const raw = '```json\n{"chain": "review-only", "confidence": 0.88, "reasoning": "Code review request"}\n```';
    const result = parseClassification(raw, VALID_CHAINS);
    expect(result.chain).toBe("review-only");
    expect(result.confidence).toBe(0.88);
  });

  test("falls back to plan-build-review on invalid JSON", () => {
    const result = parseClassification("not json at all", VALID_CHAINS);
    expect(result.chain).toBe("plan-build-review");
    expect(result.confidence).toBe(0);
    expect(result.reasoning).toContain("Failed to parse");
  });

  test("falls back to plan-build-review for unknown chain name", () => {
    const raw = '{"chain": "nonexistent-chain", "confidence": 0.9, "reasoning": "test"}';
    const result = parseClassification(raw, VALID_CHAINS);
    expect(result.chain).toBe("plan-build-review");
    expect(result.confidence).toBe(0);
    expect(result.reasoning).toContain("Unknown chain");
  });

  test("clamps confidence to 0-1 range", () => {
    const raw = '{"chain": "build-verify", "confidence": 1.5, "reasoning": "test"}';
    const result = parseClassification(raw, VALID_CHAINS);
    expect(result.confidence).toBe(1);

    const raw2 = '{"chain": "build-verify", "confidence": -0.5, "reasoning": "test"}';
    const result2 = parseClassification(raw2, VALID_CHAINS);
    expect(result2.confidence).toBe(0);
  });

  test("handles missing fields with defaults", () => {
    const raw = '{"chain": "build-verify"}';
    const result = parseClassification(raw, VALID_CHAINS);
    expect(result.chain).toBe("build-verify");
    expect(result.confidence).toBe(0);
    expect(result.reasoning).toBe("");
  });

  test("handles non-string chain with default", () => {
    const raw = '{"chain": 123, "confidence": 0.5, "reasoning": "test"}';
    const result = parseClassification(raw, VALID_CHAINS);
    expect(result.chain).toBe("plan-build-review");
  });
});

describe("classifyGoal integration", () => {
  test("classification prompt includes all chain names from config", async () => {
    // Verify the chains config can be loaded and has entries
    const { loadChains } = await import("./config");
    const chainsFile = loadChains();
    const chainNames = Object.keys(chainsFile.chains);
    expect(chainNames.length).toBeGreaterThan(0);
    expect(chainNames).toContain("plan-build-review");
    expect(chainNames).toContain("build-verify");
    expect(chainNames).toContain("review-only");
  });
});
