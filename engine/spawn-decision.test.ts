import { describe, expect, test } from "bun:test";
import {
  buildWorkerPromptFromDecision,
  findSpawnDecisionForWorker,
  isSpawnDecisionStrictMode,
  parseSpawnDecisions,
  validateSpawnDecision,
  validateSpawnDecisionForExecution,
} from "./spawn-decision";

describe("spawn decisions", () => {
  test("parses and validates a scoped worker decision", () => {
    const [decision] = parseSpawnDecisions(`
SPAWN_DECISION:
need_worker: true
worker_name: Security Auditor
spawn_type: worker
reason: Verify auth boundary.
why_lead_cannot_do_it: Security-specific review is needed.
constraints:
  allowed_paths: engine/security.ts, engine/auth.ts
  allowed_tools: read, rg
  forbidden_paths: .env, secrets/
bus_policy: isolated
expected_output_schema: REVIEW_REPORT with findings
timeout_seconds: 600
END_SPAWN_DECISION
`);

    expect(decision).toBeDefined();
    expect(validateSpawnDecision(decision!).valid).toBe(true);
    expect(findSpawnDecisionForWorker([decision!], "Security Auditor")).toBe(decision);
  });

  test("rejects missing constraints and main bus access", () => {
    const [decision] = parseSpawnDecisions(`
SPAWN_DECISION:
need_worker: true
worker_name: Backend
spawn_type: worker
reason: Check backend.
why_lead_cannot_do_it: Needs focused pass.
bus_policy: main_bus
expected_output_schema: REVIEW_REPORT
timeout_seconds: 300
END_SPAWN_DECISION
`);

    const result = validateSpawnDecision(decision!);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("constraints.allowed_paths is required");
    expect(result.errors).toContain("constraints.allowed_tools is required");
    expect(result.errors).toContain("constraints.forbidden_paths is required");
    expect(result.errors).toContain("bus_policy main_bus is reserved for v2.1 sub-bus work");
  });

  test("builds deterministic worker prompts from the decision", () => {
    const [decision] = parseSpawnDecisions(`
SPAWN_DECISION:
need_worker: true
worker_name: Quality
spawn_type: worker
reason: Check regression coverage.
why_lead_cannot_do_it: Needs independent test review.
constraints:
  allowed_paths: engine/*.test.ts
  allowed_tools: read, rg
  forbidden_paths: node_modules
bus_policy: isolated
expected_output_schema: REVIEW_REPORT: Quality
timeout_seconds: 500
END_SPAWN_DECISION
`);

    const prompt = buildWorkerPromptFromDecision(decision!, "Review the patch");
    expect(prompt).toContain("Scope: engine/*.test.ts");
    expect(prompt).toContain("Allowed tools: read, rg");
    expect(prompt).toContain("Forbidden paths: node_modules");
    expect(prompt).toContain("Expected output schema:\nREVIEW_REPORT: Quality");
    expect(prompt).toContain("Original task: Review the patch");
  });

  test("supports step and certification strict mode", () => {
    const previous = process.env.MAE_CERTIFICATION_MODE;
    try {
      delete process.env.MAE_CERTIFICATION_MODE;
      expect(isSpawnDecisionStrictMode()).toBe(false);
      expect(isSpawnDecisionStrictMode({ strict_spawn: true })).toBe(true);
      process.env.MAE_CERTIFICATION_MODE = "1";
      expect(isSpawnDecisionStrictMode()).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.MAE_CERTIFICATION_MODE;
      else process.env.MAE_CERTIFICATION_MODE = previous;
    }
  });

  test("parses JSON decision blocks and canonicalizes legacy aliases", () => {
    const [decision] = parseSpawnDecisions(`SPAWN_DECISION:
{
  "need_worker": "true",
  "worker_name": "Security Auditor",
  "spawn_type": "specialist",
  "reason": "Deep auth analysis",
  "why_lead_cannot_do_it": "Needs independent security tools",
  "constraints": {
    "allowed_read_paths": ["src/auth/**"],
    "allowed_write_paths": "reports/security.md",
    "allowed_tools": "read, rg",
    "forbidden_paths": ".env, node_modules"
  },
  "bus_policy": "none",
  "expected_output": "REVIEW_REPORT: Security",
  "timeout_seconds": 120
}
END_SPAWN_DECISION`);

    expect(decision).toBeDefined();
    expect(decision!.spawn_type).toBe("worker");
    expect(decision!.bus_policy).toBe("isolated");
    expect(decision!.constraints.allowed_paths).toEqual(["src/auth/**", "reports/security.md"]);
    expect(decision!.constraints.allowed_tools).toEqual(["read", "rg"]);
    expect(decision!.constraints.forbidden_paths).toEqual([".env", "node_modules"]);
    expect(decision!.expected_output_schema).toBe("REVIEW_REPORT: Security");
    expect(validateSpawnDecision(decision!).valid).toBe(true);
  });

  test("parses top-level legacy constraint aliases in yamlish blocks", () => {
    const [decision] = parseSpawnDecisions(`
SPAWN_DECISION:
need_worker: true
worker_name: Backend Engineer
spawn_type: specialist
reason: Review API boundary.
why_lead_cannot_do_it: Needs independent backend evidence.
allowed_read_paths: engine/api.ts, engine/auth.ts
allowed_write_paths: reports/backend.md
allowed_tools: read, rg
forbidden_paths: .env
expected_output: REVIEW_REPORT: Backend
timeout_seconds: 300
END_SPAWN_DECISION
`);

    expect(decision).toBeDefined();
    expect(decision!.worker_name).toBe("Backend Engineer");
    expect(decision!.spawn_type).toBe("worker");
    expect(decision!.constraints.allowed_paths).toEqual(["engine/api.ts", "engine/auth.ts", "reports/backend.md"]);
    expect(decision!.expected_output_schema).toBe("REVIEW_REPORT: Backend");
    expect(validateSpawnDecision(decision!).valid).toBe(true);
  });

  test("execution validation rejects unsafe paths, unavailable tools, and forbidden overlaps", () => {
    const [decision] = parseSpawnDecisions(`
SPAWN_DECISION:
need_worker: true
worker_name: Security Auditor
spawn_type: worker
reason: Verify broad scope.
why_lead_cannot_do_it: Security-specific review is needed.
constraints:
  allowed_paths: engine/**
  allowed_tools: read, sudo
  forbidden_paths: engine/secrets.ts
bus_policy: isolated
expected_output_schema: REVIEW_REPORT with findings
timeout_seconds: 600
END_SPAWN_DECISION
`);

    const result = validateSpawnDecisionForExecution(decision!, ["read"]);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("tool not available to worker: sudo");
    expect(result.errors).toContain("forbidden path is covered by allowed path: engine/secrets.ts");
  });
});
