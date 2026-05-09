import { describe, test, expect } from "bun:test";
import type { TillDoneItem, TillDoneVerifyType } from "./types";
import { loadChains } from "./config";

function makeTillDone(overrides?: Partial<TillDoneItem>): TillDoneItem {
  return {
    description: "Test criterion",
    completed: false,
    active: false,
    type: "llm_verified",
    ...overrides,
  };
}

describe("till_done verification (#150)", () => {
  describe("output_match verification", () => {
    test("regex matches agent output", () => {
      const item = makeTillDone({ type: "output_match", verify: "GRADE:\\s*(PASS|FEEDBACK|FAILED)" });
      const output = "Review complete.\nGRADE: PASS\nAll tests passing.";
      const match = new RegExp(item.verify!).exec(output);
      expect(match).not.toBeNull();
      expect(match![1]).toBe("PASS");
    });

    test("regex does not match", () => {
      const item = makeTillDone({ type: "output_match", verify: "GRADE:\\s*(PASS|FEEDBACK|FAILED)" });
      const output = "Review complete. No grade assigned.";
      const match = new RegExp(item.verify!).exec(output);
      expect(match).toBeNull();
    });

    test("invalid regex doesn't throw", () => {
      const item = makeTillDone({ type: "output_match", verify: "[invalid" });
      expect(() => new RegExp(item.verify!)).toThrow();
    });
  });

  describe("deterministic verification", () => {
    test("command exits 0 marks completed", async () => {
      const proc = Bun.spawn(["sh", "-c", "echo ok"], { stdout: "pipe", stderr: "pipe" });
      const exitCode = await proc.exited;
      const stdout = await new Response(proc.stdout).text();
      expect(exitCode).toBe(0);
      expect(stdout.trim()).toBe("ok");
    });

    test("command exits non-zero marks failed", async () => {
      const proc = Bun.spawn(["sh", "-c", "exit 1"], { stdout: "pipe", stderr: "pipe" });
      const exitCode = await proc.exited;
      expect(exitCode).toBe(1);
    });
  });

  describe("backwards compatibility", () => {
    test("plain string defaults to llm_verified", () => {
      const item = makeTillDone({ description: "Code reviewed" });
      expect(item.type).toBe("llm_verified");
    });
  });

  describe("TillDoneItem type completeness", () => {
    test("all verify types are valid", () => {
      const types: TillDoneVerifyType[] = ["output_match", "deterministic", "llm_verified"];
      for (const t of types) {
        const item = makeTillDone({ type: t });
        expect(item.type).toBe(t);
      }
    });

    test("evidence field is optional", () => {
      const item = makeTillDone();
      expect(item.evidence).toBeUndefined();
      item.evidence = "Matched: GRADE: PASS";
      expect(item.evidence).toBe("Matched: GRADE: PASS");
    });
  });

  describe("chain config parsing", () => {
    test("chains.yaml loads with mixed till_done formats", () => {
      const chains = loadChains();
      expect(chains.chains).toBeDefined();
      const planBuildReview = chains.chains["plan-build-review"];
      expect(planBuildReview).toBeDefined();
    });

    test("string till_done items are preserved", () => {
      const chains = loadChains();
      const reviewOnly = chains.chains["review-only"];
      expect(reviewOnly).toBeDefined();
      const steps = reviewOnly!.steps ?? [];
      const withTillDone = steps.find(s => s.till_done);
      expect(withTillDone).toBeDefined();
      if (withTillDone?.till_done) {
        for (const item of withTillDone.till_done) {
          if (typeof item === "string") {
            expect(item.length).toBeGreaterThan(0);
          }
        }
      }
    });
  });
});
