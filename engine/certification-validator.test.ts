import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	validateCertificationEvidence,
	formatValidationContract,
	type ValidatorContext,
	type ValidationContract,
} from "./certification-validator";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let testDir: string;
let traceDir: string;

function setup(): void {
	testDir = mkdtempSync(join(tmpdir(), "mae-validator-test-"));
	traceDir = join(testDir, "traces");
	mkdirSync(traceDir, { recursive: true });
}

function cleanup(): void {
	rmSync(testDir, { recursive: true, force: true });
}

function makeSessionId(n: number): string {
	return `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
}

function writeTrace(sessionId: string, events: object[]): string {
	const traceFile = join(traceDir, `${sessionId}.jsonl`);
	writeFileSync(traceFile, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
	return traceFile;
}

function writeArtifact(sessionId: string, filename: string, content: string): string {
	const dir = join(traceDir, sessionId, "artifacts");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, filename);
	writeFileSync(path, content);
	return `${sessionId}/artifacts/${filename}`;
}

function allLeadEndEvents(sessionId: string): object[] {
	return [
		{ type: "agent.end", session_id: sessionId, agent_id: "pi-correctness-lead", team: "Correctness Review" },
		{ type: "agent.end", session_id: sessionId, agent_id: "pi-adversarial-lead", team: "Adversarial Review" },
		{ type: "agent.end", session_id: sessionId, agent_id: "pi-quality-lead", team: "Quality Review" },
		{ type: "agent.end", session_id: sessionId, agent_id: "pi-security-lead", team: "Security Review" },
		{ type: "agent.end", session_id: sessionId, agent_id: "pi-domain-lead", team: "Domain Review" },
	];
}

function validCleanContract(): string {
	return [
		"CERTIFICATION_CONTRACT:",
		"schema_version: 1",
		"verdict: pass",
		"p0_count: 0",
		"p1_count: 0",
		"perspectives_covered: correctness, adversarial, quality, security, domain",
		"blockers: none",
		"failed_teams: none",
		"certification_ready: true",
		"END_CERTIFICATION_CONTRACT",
	].join("\n");
}

function validFailContract(): string {
	return [
		"CERTIFICATION_CONTRACT:",
		"schema_version: 1",
		"verdict: fail",
		"p0_count: 1",
		"p1_count: 0",
		"perspectives_covered: correctness, adversarial, quality, security, domain",
		"blockers: missing readiness",
		"failed_teams: none",
		"certification_ready: false",
		"END_CERTIFICATION_CONTRACT",
	].join("\n");
}

function makeCtx(traceFile: string, overrides?: Partial<ValidatorContext>): ValidatorContext {
	return {
		traceFile,
		traceDir,
		workDir: testDir,
		repoRoot: "/fake/repo",
		isLivePi: true,
		...overrides,
	};
}

function findCheck(contract: ValidationContract, name: string) {
	return contract.checks.find((c) => c.name === name);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("certification-validator", () => {
	beforeEach(setup);
	afterEach(cleanup);

	describe("lifecycle checks", () => {
		test("passes with all 5 required leads", () => {
			const sid = makeSessionId(1);
			const synthRef = writeArtifact(sid, "synth-output.txt", validCleanContract());
			const traceFile = writeTrace(sid, [
				{ type: "session.start", session_id: sid },
				...allLeadEndEvents(sid),
				{ type: "agent.end", session_id: sid, agent_id: "pi-orchestrator", output_artifact: synthRef },
				{ type: "session.end", session_id: sid, status: "completed" },
			]);

			const result = validateCertificationEvidence(makeCtx(traceFile, { expectedFixture: "clean" }));
			expect(result.lifecycle_valid).toBe(true);
			expect(findCheck(result, "lifecycle_complete")?.passed).toBe(true);
		});

		test("fails with missing lead", () => {
			const sid = makeSessionId(2);
			const traceFile = writeTrace(sid, [
				{ type: "session.start", session_id: sid },
				{ type: "agent.end", session_id: sid, agent_id: "pi-correctness-lead", team: "Correctness Review" },
				{ type: "agent.end", session_id: sid, agent_id: "pi-adversarial-lead", team: "Adversarial Review" },
				{ type: "agent.end", session_id: sid, agent_id: "pi-quality-lead", team: "Quality Review" },
				// Missing security and domain leads
				{ type: "session.end", session_id: sid, status: "completed" },
			]);

			const result = validateCertificationEvidence(makeCtx(traceFile));
			expect(result.lifecycle_valid).toBe(false);
			expect(findCheck(result, "lifecycle_complete")?.evidence).toContain("Security Review");
			expect(findCheck(result, "lifecycle_complete")?.evidence).toContain("Domain Review");
		});

		test("accepts team-name-based lead matching", () => {
			const sid = makeSessionId(3);
			const synthRef = writeArtifact(sid, "synth-output.txt", validCleanContract());
			const traceFile = writeTrace(sid, [
				{ type: "session.start", session_id: sid },
				{ type: "agent.end", session_id: sid, agent_id: "Correctness Review-lead", team: "Correctness Review" },
				{ type: "agent.end", session_id: sid, agent_id: "Adversarial Review-lead", team: "Adversarial Review" },
				{ type: "agent.end", session_id: sid, agent_id: "Quality Review-lead", team: "Quality Review" },
				{ type: "agent.end", session_id: sid, agent_id: "Security Review-lead", team: "Security Review" },
				{ type: "agent.end", session_id: sid, agent_id: "Domain Review-lead", team: "Domain Review" },
				{ type: "agent.end", session_id: sid, agent_id: "pi-orchestrator", output_artifact: synthRef },
				{ type: "session.end", session_id: sid, status: "completed" },
			]);

			const result = validateCertificationEvidence(makeCtx(traceFile, { expectedFixture: "clean" }));
			expect(result.lifecycle_valid).toBe(true);
		});
	});

	describe("operational failures", () => {
		test("detects agent.error", () => {
			const sid = makeSessionId(4);
			const traceFile = writeTrace(sid, [
				{ type: "session.start", session_id: sid },
				...allLeadEndEvents(sid),
				{ type: "agent.error", session_id: sid, agent_id: "pi-security-lead" },
				{ type: "session.end", session_id: sid, status: "completed" },
			]);

			const result = validateCertificationEvidence(makeCtx(traceFile));
			expect(findCheck(result, "no_operational_failures")?.passed).toBe(false);
		});

		test("detects worker_failed event type", () => {
			const sid = makeSessionId(5);
			const traceFile = writeTrace(sid, [
				{ type: "session.start", session_id: sid },
				...allLeadEndEvents(sid),
				{ event_type: "worker_failed", session_id: sid },
				{ type: "session.end", session_id: sid, status: "completed" },
			]);

			const result = validateCertificationEvidence(makeCtx(traceFile));
			expect(findCheck(result, "no_operational_failures")?.passed).toBe(false);
		});

		test("detects non-completed session end", () => {
			const sid = makeSessionId(6);
			const traceFile = writeTrace(sid, [
				{ type: "session.start", session_id: sid },
				...allLeadEndEvents(sid),
				{ type: "session.end", session_id: sid, status: "error" },
			]);

			const result = validateCertificationEvidence(makeCtx(traceFile));
			expect(findCheck(result, "no_operational_failures")?.passed).toBe(false);
		});
	});

	describe("empty output artifacts", () => {
		test("fails on unsuperseded empty output", () => {
			const sid = makeSessionId(7);
			const emptyRef = writeArtifact(sid, "worker-output.txt", "ERROR: Empty output\n");
			const traceFile = writeTrace(sid, [
				{ type: "session.start", session_id: sid },
				...allLeadEndEvents(sid),
				{ type: "agent.end", session_id: sid, agent_id: "pi-security-reviewer", grade: "FAILED", output_artifact: emptyRef },
				{ type: "session.end", session_id: sid, status: "completed" },
			]);

			const result = validateCertificationEvidence(makeCtx(traceFile));
			expect(findCheck(result, "no_empty_outputs")?.passed).toBe(false);
		});

		test("accepts superseded empty output (retry success)", () => {
			const sid = makeSessionId(8);
			const emptyRef = writeArtifact(sid, "worker-output-empty.txt", "ERROR: Empty output\n");
			const successRef = writeArtifact(sid, "worker-output-success.txt", "REVIEW_REPORT: pass\n");
			const synthRef = writeArtifact(sid, "synth-output.txt", validCleanContract());
			const traceFile = writeTrace(sid, [
				{ type: "session.start", session_id: sid },
				...allLeadEndEvents(sid),
				{ type: "agent.end", session_id: sid, agent_id: "pi-security-reviewer", grade: "FAILED", output_artifact: emptyRef },
				{ type: "agent.end", session_id: sid, agent_id: "pi-security-reviewer", grade: "VERIFIED", output_artifact: successRef },
				{ type: "agent.end", session_id: sid, agent_id: "pi-orchestrator", output_artifact: synthRef },
				{ type: "session.end", session_id: sid, status: "completed" },
			]);

			const result = validateCertificationEvidence(makeCtx(traceFile, { expectedFixture: "clean" }));
			expect(findCheck(result, "no_empty_outputs")?.passed).toBe(true);
		});
	});

	describe("scope drift", () => {
		test("detects tool calls to previous cert dir", () => {
			const sid = makeSessionId(9);
			const traceFile = writeTrace(sid, [
				{ type: "session.start", session_id: sid },
				...allLeadEndEvents(sid),
				{ type: "tool.call", session_id: sid, args_preview: "/tmp/mae-cert.OLD/failing/README.md" },
				{ type: "session.end", session_id: sid, status: "completed" },
			]);

			const result = validateCertificationEvidence(makeCtx(traceFile));
			expect(findCheck(result, "no_scope_drift")?.passed).toBe(false);
		});

		test("accepts tool calls within workdir", () => {
			const sid = makeSessionId(10);
			const synthRef = writeArtifact(sid, "synth-output.txt", validCleanContract());
			const traceFile = writeTrace(sid, [
				{ type: "session.start", session_id: sid },
				...allLeadEndEvents(sid),
				{ type: "tool.call", session_id: sid, args_preview: `${testDir}/failing/README.md` },
				{ type: "agent.end", session_id: sid, agent_id: "pi-orchestrator", output_artifact: synthRef },
				{ type: "session.end", session_id: sid, status: "completed" },
			]);

			const result = validateCertificationEvidence(makeCtx(traceFile, { expectedFixture: "failing" }));
			expect(findCheck(result, "no_scope_drift")?.passed).toBe(true);
		});
	});

	describe("wrong fixture access", () => {
		test("detects sibling fixture access", () => {
			const sid = makeSessionId(11);
			const workDir = "/tmp/mae-cert.CURRENT";
			const traceFile = writeTrace(sid, [
				{ type: "session.start", session_id: sid },
				...allLeadEndEvents(sid),
				{ type: "tool.call", session_id: sid, args_preview: `${workDir}/clean/app.ts` },
				{ type: "session.end", session_id: sid, status: "completed" },
			]);

			const result = validateCertificationEvidence(makeCtx(traceFile, { workDir, expectedFixture: "failing" }));
			expect(findCheck(result, "no_wrong_fixture")?.passed).toBe(false);
		});
	});

	describe("worker spawn enforcement", () => {
		test("rejects worker spawns in live Pi mode", () => {
			const sid = makeSessionId(12);
			const traceFile = writeTrace(sid, [
				{ type: "session.start", session_id: sid },
				...allLeadEndEvents(sid),
				{ type: "agent.start", session_id: sid, agent_id: "Security Review-input-auditor", team: "Security Review" },
				{ type: "session.end", session_id: sid, status: "completed" },
			]);

			const result = validateCertificationEvidence(makeCtx(traceFile, { isLivePi: true }));
			expect(findCheck(result, "no_worker_spawns")?.passed).toBe(false);
		});

		test("skips worker spawn check in echo mode", () => {
			const sid = makeSessionId(13);
			const traceFile = writeTrace(sid, [
				{ type: "session.start", session_id: sid },
				...allLeadEndEvents(sid),
				{ type: "agent.start", session_id: sid, agent_id: "Security Review-input-auditor", team: "Security Review" },
				{ type: "session.end", session_id: sid, status: "completed" },
			]);

			const result = validateCertificationEvidence(makeCtx(traceFile, { isLivePi: false }));
			expect(result.checks.find((c) => c.name === "no_worker_spawns")).toBeUndefined();
		});

		test("accepts lead-only trace", () => {
			const sid = makeSessionId(14);
			const synthRef = writeArtifact(sid, "synth-output.txt", validCleanContract());
			const traceFile = writeTrace(sid, [
				{ type: "session.start", session_id: sid },
				{ type: "agent.start", session_id: sid, agent_id: "pi-correctness-lead", team: "Correctness Review" },
				...allLeadEndEvents(sid),
				{ type: "agent.end", session_id: sid, agent_id: "pi-orchestrator", output_artifact: synthRef },
				{ type: "session.end", session_id: sid, status: "completed" },
			]);

			const result = validateCertificationEvidence(makeCtx(traceFile, { expectedFixture: "clean" }));
			expect(findCheck(result, "no_worker_spawns")?.passed).toBe(true);
		});

		test("strict spawn policy rejects worker spawn without SPAWN_DECISION", () => {
			const sid = makeSessionId(141);
			const synthRef = writeArtifact(sid, "synth-output.txt", validCleanContract());
			const traceFile = writeTrace(sid, [
				{ type: "session.start", session_id: sid },
				...allLeadEndEvents(sid),
				{ event_type: "agent_spawn", session_id: sid, agent_id: "Security Review-security-reviewer", data: { agent_name: "Security Reviewer", agent_role: "worker" } },
				{ type: "agent.end", session_id: sid, agent_id: "pi-orchestrator", output_artifact: synthRef },
				{ type: "session.end", session_id: sid, status: "completed" },
			]);

			const result = validateCertificationEvidence(makeCtx(traceFile, {
				isLivePi: false,
				strictSpawnDecisions: true,
				expectedFixture: "clean",
			}));
			expect(findCheck(result, "spawn_decisions_valid")?.passed).toBe(false);
			expect(result.spawn_policy_valid).toBe(false);
		});

		test("strict spawn policy accepts scoped SPAWN_DECISION", () => {
			const sid = makeSessionId(142);
			const synthRef = writeArtifact(sid, "synth-output.txt", validCleanContract());
			const traceFile = writeTrace(sid, [
				{ type: "session.start", session_id: sid },
				...allLeadEndEvents(sid),
				{
					event_type: "spawn_decision",
					session_id: sid,
					agent_id: "Security Review-security-reviewer",
					data: {
						worker_name: "Security Reviewer",
						spawn_type: "worker",
						reason: "Focused security review needed",
						why_lead_cannot_do_it: "Independent specialist evidence required",
						constraints: {
							allowed_paths: ["engine/security.ts"],
							allowed_tools: ["read", "rg"],
							forbidden_paths: [".env"],
						},
						bus_policy: "isolated",
						expected_output_schema: "REVIEW_REPORT: Security",
						timeout_seconds: 600,
					},
				},
				{ event_type: "agent_spawn", session_id: sid, agent_id: "Security Review-security-reviewer", data: { agent_name: "Security Reviewer", agent_role: "worker" } },
				{ type: "agent.end", session_id: sid, agent_id: "pi-orchestrator", output_artifact: synthRef },
				{ type: "session.end", session_id: sid, status: "completed" },
			]);

			const result = validateCertificationEvidence(makeCtx(traceFile, {
				isLivePi: false,
				strictSpawnDecisions: true,
				expectedFixture: "clean",
			}));
			expect(findCheck(result, "spawn_decisions_valid")?.passed).toBe(true);
			expect(result.spawn_policy_valid).toBe(true);
		});

		test("strict spawn policy binds adapter agent.start by mae_agent_id", () => {
			const sid = makeSessionId(145);
			const synthRef = writeArtifact(sid, "synth-output.txt", validCleanContract());
			const traceFile = writeTrace(sid, [
				{ type: "session.start", session_id: sid },
				...allLeadEndEvents(sid),
				{
					type: "spawn.decision",
					session_id: sid,
					agent_id: "Engineering-backend-engineer",
					parent_id: "Engineering-lead",
					worker_name: "Backend Engineer",
					spawn_type: "worker",
					reason: "Backend review needed",
					why_lead_cannot_do_it: "Independent specialist evidence required",
					constraints: {
						allowed_paths: ["engine/team-execution.ts"],
						allowed_tools: ["read"],
						forbidden_paths: [".env"],
					},
					bus_policy: "isolated",
					expected_output_schema: "REVIEW_REPORT: Backend",
					timeout_seconds: 600,
				},
				{ type: "agent.start", session_id: sid, agent_id: "pi-backend-engineer", mae_agent_id: "Engineering-backend-engineer", parent_id: "Engineering-lead", persona: "Backend Engineer" },
				{ type: "agent.end", session_id: sid, agent_id: "pi-orchestrator", output_artifact: synthRef },
				{ type: "session.end", session_id: sid, status: "completed" },
			]);

			const result = validateCertificationEvidence(makeCtx(traceFile, {
				isLivePi: false,
				strictSpawnDecisions: true,
				expectedFixture: "clean",
			}));
			expect(findCheck(result, "spawn_decisions_valid")?.passed).toBe(true);
			expect(result.spawn_policy_valid).toBe(true);
		});

		test("strict spawn policy rejects SPAWN_DECISION after worker spawn", () => {
			const sid = makeSessionId(143);
			const synthRef = writeArtifact(sid, "synth-output.txt", validCleanContract());
			const traceFile = writeTrace(sid, [
				{ type: "session.start", session_id: sid },
				...allLeadEndEvents(sid),
				{ event_type: "agent_spawn", session_id: sid, agent_id: "Security Review-security-reviewer", data: { agent_name: "Security Reviewer", agent_role: "worker" } },
				{
					event_type: "spawn_decision",
					session_id: sid,
					agent_id: "Security Review-security-reviewer",
					data: {
						worker_name: "Security Reviewer",
						spawn_type: "worker",
						reason: "Focused security review needed",
						why_lead_cannot_do_it: "Independent specialist evidence required",
						constraints: {
							allowed_paths: ["engine/security.ts"],
							allowed_tools: ["read", "rg"],
							forbidden_paths: [".env"],
						},
						bus_policy: "isolated",
						expected_output_schema: "REVIEW_REPORT: Security",
						timeout_seconds: 600,
					},
				},
				{ type: "agent.end", session_id: sid, agent_id: "pi-orchestrator", output_artifact: synthRef },
				{ type: "session.end", session_id: sid, status: "completed" },
			]);

			const result = validateCertificationEvidence(makeCtx(traceFile, {
				isLivePi: false,
				strictSpawnDecisions: true,
				expectedFixture: "clean",
			}));
			const check = findCheck(result, "spawn_decisions_valid");
			expect(check?.passed).toBe(false);
			expect(check?.details).toContain("appears after worker spawn");
			expect(result.spawn_policy_valid).toBe(false);
		});

		test("strict spawn policy rejects unsafe trace decision paths", () => {
			const sid = makeSessionId(146);
			const synthRef = writeArtifact(sid, "synth-output.txt", validCleanContract());
			const traceFile = writeTrace(sid, [
				{ type: "session.start", session_id: sid },
				...allLeadEndEvents(sid),
				{
					event_type: "spawn_decision",
					session_id: sid,
					agent_id: "Security Review-security-reviewer",
					data: {
						worker_name: "Security Reviewer",
						spawn_type: "worker",
						reason: "Focused security review needed",
						why_lead_cannot_do_it: "Independent specialist evidence required",
						constraints: {
							allowed_paths: ["**/*"],
							allowed_tools: ["read"],
							forbidden_paths: [".env"],
						},
						bus_policy: "isolated",
						expected_output_schema: "REVIEW_REPORT: Security",
						timeout_seconds: 600,
					},
				},
				{ event_type: "agent_spawn", session_id: sid, agent_id: "Security Review-security-reviewer", data: { agent_name: "Security Reviewer", agent_role: "worker" } },
				{ type: "agent.end", session_id: sid, agent_id: "pi-orchestrator", output_artifact: synthRef },
				{ type: "session.end", session_id: sid, status: "completed" },
			]);

			const result = validateCertificationEvidence(makeCtx(traceFile, {
				isLivePi: false,
				strictSpawnDecisions: true,
				expectedFixture: "clean",
			}));
			const check = findCheck(result, "spawn_decisions_valid");
			expect(check?.passed).toBe(false);
			expect(check?.details).toContain("unsafe path constraint: **/*");
			expect(result.spawn_policy_valid).toBe(false);
		});

		test("strict spawn policy accepts nested legacy decision shapes before spawn", () => {
			const sid = makeSessionId(144);
			const synthRef = writeArtifact(sid, "synth-output.txt", validCleanContract());
			const traceFile = writeTrace(sid, [
				{ type: "session.start", session_id: sid },
				...allLeadEndEvents(sid),
				{
					event_type: "spawn_decision",
					session_id: sid,
					agent_id: "Security Review-security-reviewer",
					data: {
						decision: {
							worker_name: "Security Reviewer",
							spawn_type: "specialist",
							reason: "Focused security review needed",
							why_lead_cannot_do_it: "Independent specialist evidence required",
							constraints: {
								allowed_read_paths: ["engine/security.ts"],
								allowed_tools: "read, rg",
								forbidden_paths: [".env"],
							},
							bus_policy: "none",
							expected_output: "REVIEW_REPORT: Security",
							timeout_seconds: 600,
						},
					},
				},
				{ event_type: "agent_spawn", session_id: sid, agent_id: "Security Review-security-reviewer", data: { agent_name: "Security Reviewer", agent_role: "worker" } },
				{ type: "agent.end", session_id: sid, agent_id: "pi-orchestrator", output_artifact: synthRef },
				{ type: "session.end", session_id: sid, status: "completed" },
			]);

			const result = validateCertificationEvidence(makeCtx(traceFile, {
				isLivePi: false,
				strictSpawnDecisions: true,
				expectedFixture: "clean",
			}));
			expect(findCheck(result, "spawn_decisions_valid")?.passed).toBe(true);
			expect(result.spawn_policy_valid).toBe(true);
		});
	});

	describe("leaked contracts", () => {
		test("detects non-synthesis CERTIFICATION_CONTRACT", () => {
			const sid = makeSessionId(15);
			const leakedRef = writeArtifact(sid, "lead-output.txt", validCleanContract());
			const traceFile = writeTrace(sid, [
				{ type: "session.start", session_id: sid },
				...allLeadEndEvents(sid),
				{ type: "agent.end", session_id: sid, agent_id: "pi-correctness-lead", output_artifact: leakedRef },
				{ type: "session.end", session_id: sid, status: "completed" },
			]);

			const result = validateCertificationEvidence(makeCtx(traceFile));
			expect(findCheck(result, "no_leaked_contracts")?.passed).toBe(false);
		});

		test("allows synthesis CERTIFICATION_CONTRACT", () => {
			const sid = makeSessionId(16);
			const synthRef = writeArtifact(sid, "synth-output.txt", validCleanContract());
			const traceFile = writeTrace(sid, [
				{ type: "session.start", session_id: sid },
				...allLeadEndEvents(sid),
				{ type: "agent.end", session_id: sid, agent_id: "synth-001", team: "Synthesis", output_artifact: synthRef },
				{ type: "session.end", session_id: sid, status: "completed" },
			]);

			const result = validateCertificationEvidence(makeCtx(traceFile));
			expect(findCheck(result, "no_leaked_contracts")?.passed).toBe(true);
		});
	});

	describe("canonical artifact", () => {
		test("finds synthesis artifact with valid contract block", () => {
			const sid = makeSessionId(17);
			const synthRef = writeArtifact(sid, "synth-output.txt", validCleanContract());
			const traceFile = writeTrace(sid, [
				{ type: "session.start", session_id: sid },
				...allLeadEndEvents(sid),
				{ type: "agent.end", session_id: sid, agent_id: "pi-orchestrator", output_artifact: synthRef },
				{ type: "session.end", session_id: sid, status: "completed" },
			]);

			const result = validateCertificationEvidence(makeCtx(traceFile, { expectedFixture: "clean" }));
			expect(findCheck(result, "canonical_artifact_exists")?.passed).toBe(true);
		});

		test("fails when no synthesis artifact exists", () => {
			const sid = makeSessionId(18);
			const traceFile = writeTrace(sid, [
				{ type: "session.start", session_id: sid },
				...allLeadEndEvents(sid),
				{ type: "session.end", session_id: sid, status: "completed" },
			]);

			const result = validateCertificationEvidence(makeCtx(traceFile));
			expect(findCheck(result, "canonical_artifact_exists")?.passed).toBe(false);
		});

		test("prefers artifact with valid contract block over later prose", () => {
			const sid = makeSessionId(19);
			writeArtifact(sid, "orch-early.txt", "Assignment prompt echo");
			const contractRef = writeArtifact(sid, "orch-synth.txt", validFailContract());
			writeArtifact(sid, "orch-late.txt", "Periodic prose report");
			const traceFile = writeTrace(sid, [
				{ type: "session.start", session_id: sid },
				...allLeadEndEvents(sid),
				{ type: "agent.end", session_id: sid, agent_id: "pi-orchestrator", output_artifact: `${sid}/artifacts/orch-early.txt` },
				{ type: "agent.end", session_id: sid, agent_id: "pi-orchestrator", output_artifact: contractRef },
				{ type: "agent.end", session_id: sid, agent_id: "pi-orchestrator", output_artifact: `${sid}/artifacts/orch-late.txt` },
				{ type: "session.end", session_id: sid, status: "completed" },
			]);

			const result = validateCertificationEvidence(makeCtx(traceFile, { expectedFixture: "failing" }));
			const check = findCheck(result, "canonical_artifact_exists");
			expect(check?.passed).toBe(true);
			expect(check?.evidence).toContain("orch-synth.txt");
		});
	});

	describe("contract matches evidence", () => {
		test("clean contract matches clean evidence", () => {
			const sid = makeSessionId(20);
			const synthRef = writeArtifact(sid, "synth-output.txt", validCleanContract());
			const traceFile = writeTrace(sid, [
				{ type: "session.start", session_id: sid },
				...allLeadEndEvents(sid),
				{ type: "agent.end", session_id: sid, agent_id: "pi-orchestrator", output_artifact: synthRef },
				{ type: "session.end", session_id: sid, status: "completed" },
			]);

			const result = validateCertificationEvidence(makeCtx(traceFile, { expectedFixture: "clean" }));
			expect(result.contract_matches_evidence).toBe(true);
			expect(result.validated).toBe(true);
		});

		test("rejects clean contract when lifecycle incomplete", () => {
			const sid = makeSessionId(21);
			const synthRef = writeArtifact(sid, "synth-output.txt", validCleanContract());
			const traceFile = writeTrace(sid, [
				{ type: "session.start", session_id: sid },
				// Only 3 leads
				{ type: "agent.end", session_id: sid, agent_id: "pi-correctness-lead", team: "Correctness Review" },
				{ type: "agent.end", session_id: sid, agent_id: "pi-adversarial-lead", team: "Adversarial Review" },
				{ type: "agent.end", session_id: sid, agent_id: "pi-quality-lead", team: "Quality Review" },
				{ type: "agent.end", session_id: sid, agent_id: "pi-orchestrator", output_artifact: synthRef },
				{ type: "session.end", session_id: sid, status: "completed" },
			]);

			const result = validateCertificationEvidence(makeCtx(traceFile, { expectedFixture: "clean" }));
			expect(result.contract_matches_evidence).toBe(false);
			expect(result.validated).toBe(false);
		});

		test("rejects placeholder contract", () => {
			const sid = makeSessionId(22);
			const placeholderContract = [
				"CERTIFICATION_CONTRACT:",
				"schema_version: 1",
				"verdict: pass|fail",
				"p0_count: <integer>",
				"p1_count: <integer>",
				"perspectives_covered: correctness, adversarial, quality, security, domain",
				"blockers: none",
				"failed_teams: none",
				"certification_ready: true|false",
				"END_CERTIFICATION_CONTRACT",
			].join("\n");
			const synthRef = writeArtifact(sid, "synth-output.txt", placeholderContract);
			const traceFile = writeTrace(sid, [
				{ type: "session.start", session_id: sid },
				...allLeadEndEvents(sid),
				{ type: "agent.end", session_id: sid, agent_id: "pi-orchestrator", output_artifact: synthRef },
				{ type: "session.end", session_id: sid, status: "completed" },
			]);

			const result = validateCertificationEvidence(makeCtx(traceFile, { expectedFixture: "clean" }));
			expect(result.contract_matches_evidence).toBe(false);
		});

		test("rejects contract with failed teams claiming ready", () => {
			const sid = makeSessionId(23);
			const badContract = [
				"CERTIFICATION_CONTRACT:",
				"schema_version: 1",
				"verdict: pass",
				"p0_count: 0",
				"p1_count: 0",
				"perspectives_covered: correctness, adversarial, quality, security, domain",
				"blockers: none",
				"failed_teams: Security Review",
				"certification_ready: true",
				"END_CERTIFICATION_CONTRACT",
			].join("\n");
			const synthRef = writeArtifact(sid, "synth-output.txt", badContract);
			const traceFile = writeTrace(sid, [
				{ type: "session.start", session_id: sid },
				...allLeadEndEvents(sid),
				{ type: "agent.end", session_id: sid, agent_id: "pi-orchestrator", output_artifact: synthRef },
				{ type: "session.end", session_id: sid, status: "completed" },
			]);

			const result = validateCertificationEvidence(makeCtx(traceFile, { expectedFixture: "clean" }));
			expect(result.contract_matches_evidence).toBe(false);
		});

		test("failing fixture requires fail verdict", () => {
			const sid = makeSessionId(24);
			const synthRef = writeArtifact(sid, "synth-output.txt", validCleanContract());
			const traceFile = writeTrace(sid, [
				{ type: "session.start", session_id: sid },
				...allLeadEndEvents(sid),
				{ type: "agent.end", session_id: sid, agent_id: "pi-orchestrator", output_artifact: synthRef },
				{ type: "session.end", session_id: sid, status: "completed" },
			]);

			const result = validateCertificationEvidence(makeCtx(traceFile, { expectedFixture: "failing" }));
			expect(result.contract_matches_evidence).toBe(false);
			const check = findCheck(result, "contract_matches_evidence");
			expect(check?.details).toContain("Expected failing verdict=fail");
		});

		test("seeded fixture requires certification_ready=false", () => {
			const sid = makeSessionId(25);
			const synthRef = writeArtifact(sid, "synth-output.txt", validCleanContract());
			const traceFile = writeTrace(sid, [
				{ type: "session.start", session_id: sid },
				...allLeadEndEvents(sid),
				{ type: "agent.end", session_id: sid, agent_id: "pi-orchestrator", output_artifact: synthRef },
				{ type: "session.end", session_id: sid, status: "completed" },
			]);

			const result = validateCertificationEvidence(makeCtx(traceFile, { expectedFixture: "seeded" }));
			expect(result.contract_matches_evidence).toBe(false);
		});
	});

	describe("stale participants", () => {
		test("flags unresolved stale participant", () => {
			const sid = makeSessionId(26);
			const traceFile = writeTrace(sid, [
				{ type: "session.start", session_id: sid },
				...allLeadEndEvents(sid),
				{ event_type: "participant_stale", session_id: sid, data: { participant_id: "pi-security-lead", status: "stale" } },
				{ type: "session.end", session_id: sid, status: "completed" },
			]);

			const result = validateCertificationEvidence(makeCtx(traceFile));
			expect(findCheck(result, "no_stale_participants")?.passed).toBe(false);
		});

		test("accepts stale participant that recovered", () => {
			const sid = makeSessionId(27);
			const synthRef = writeArtifact(sid, "synth-output.txt", validCleanContract());
			const traceFile = writeTrace(sid, [
				{ type: "session.start", session_id: sid },
				{ event_type: "participant_stale", session_id: sid, data: { participant_id: "pi-security-lead", status: "stale" } },
				{ event_type: "participant_end", session_id: sid, data: { participant_id: "pi-security-lead", status: "completed" } },
				...allLeadEndEvents(sid),
				{ type: "agent.end", session_id: sid, agent_id: "pi-orchestrator", output_artifact: synthRef },
				{ type: "session.end", session_id: sid, status: "completed" },
			]);

			const result = validateCertificationEvidence(makeCtx(traceFile, { expectedFixture: "clean" }));
			expect(findCheck(result, "no_stale_participants")?.passed).toBe(true);
		});
	});

	describe("team contracts (REVIEW_REPORT vs CERTIFICATION_CONTRACT)", () => {
		test("flags lead emitting CERTIFICATION_CONTRACT", () => {
			const sid = makeSessionId(28);
			const leakedRef = writeArtifact(sid, "lead-output.txt", validCleanContract());
			const traceFile = writeTrace(sid, [
				{ type: "session.start", session_id: sid },
				{ type: "agent.end", session_id: sid, agent_id: "pi-correctness-lead", team: "Correctness Review", output_artifact: leakedRef },
				{ type: "agent.end", session_id: sid, agent_id: "pi-adversarial-lead", team: "Adversarial Review" },
				{ type: "agent.end", session_id: sid, agent_id: "pi-quality-lead", team: "Quality Review" },
				{ type: "agent.end", session_id: sid, agent_id: "pi-security-lead", team: "Security Review" },
				{ type: "agent.end", session_id: sid, agent_id: "pi-domain-lead", team: "Domain Review" },
				{ type: "session.end", session_id: sid, status: "completed" },
			]);

			const result = validateCertificationEvidence(makeCtx(traceFile));
			expect(findCheck(result, "team_contracts_valid")?.passed).toBe(false);
		});
	});

	describe("repo source reads", () => {
		test("rejects tool calls to repo source", () => {
			const sid = makeSessionId(29);
			const repoRoot = "/fake/repo";
			const traceFile = writeTrace(sid, [
				{ type: "session.start", session_id: sid },
				...allLeadEndEvents(sid),
				{ type: "tool.call", session_id: sid, args_preview: `${repoRoot}/scripts/certify-live-swarm` },
				{ type: "session.end", session_id: sid, status: "completed" },
			]);

			const result = validateCertificationEvidence(makeCtx(traceFile, { repoRoot }));
			expect(findCheck(result, "no_repo_source_reads")?.passed).toBe(false);
		});

		test("skips repo source check in echo mode", () => {
			const sid = makeSessionId(30);
			const repoRoot = "/fake/repo";
			const traceFile = writeTrace(sid, [
				{ type: "session.start", session_id: sid },
				...allLeadEndEvents(sid),
				{ type: "tool.call", session_id: sid, args_preview: `${repoRoot}/scripts/certify-live-swarm` },
				{ type: "session.end", session_id: sid, status: "completed" },
			]);

			const result = validateCertificationEvidence(makeCtx(traceFile, { repoRoot, isLivePi: false }));
			expect(result.checks.find((c) => c.name === "no_repo_source_reads")).toBeUndefined();
		});
	});

	describe("full happy path", () => {
		test("validates complete clean certification", () => {
			const sid = makeSessionId(31);
			const synthRef = writeArtifact(sid, "synth-output.txt", validCleanContract());
			const traceFile = writeTrace(sid, [
				{ type: "session.start", session_id: sid },
				...allLeadEndEvents(sid),
				{ type: "agent.end", session_id: sid, agent_id: "pi-orchestrator", output_artifact: synthRef },
				{ type: "session.end", session_id: sid, status: "completed" },
			]);

			const result = validateCertificationEvidence(makeCtx(traceFile, { expectedFixture: "clean" }));
			expect(result.validated).toBe(true);
			expect(result.evidence_complete).toBe(true);
			expect(result.lifecycle_valid).toBe(true);
			expect(result.contract_matches_evidence).toBe(true);
			expect(result.scope_valid).toBe(true);
			expect(result.spawn_policy_valid).toBe(true);
			expect(result.blocking_reasons).toEqual([]);
		});

		test("validates complete failing certification", () => {
			const sid = makeSessionId(32);
			const synthRef = writeArtifact(sid, "synth-output.txt", validFailContract());
			const traceFile = writeTrace(sid, [
				{ type: "session.start", session_id: sid },
				...allLeadEndEvents(sid),
				{ type: "agent.end", session_id: sid, agent_id: "pi-orchestrator", output_artifact: synthRef },
				{ type: "session.end", session_id: sid, status: "completed" },
			]);

			const result = validateCertificationEvidence(makeCtx(traceFile, { expectedFixture: "failing" }));
			expect(result.validated).toBe(true);
			expect(result.evidence_complete).toBe(true);
			expect(result.blocking_reasons).toEqual([]);
		});
	});

	describe("formatValidationContract", () => {
		test("produces parseable output with checks", () => {
			const sid = makeSessionId(33);
			const synthRef = writeArtifact(sid, "synth-output.txt", validCleanContract());
			const traceFile = writeTrace(sid, [
				{ type: "session.start", session_id: sid },
				...allLeadEndEvents(sid),
				{ type: "agent.end", session_id: sid, agent_id: "pi-orchestrator", output_artifact: synthRef },
				{ type: "session.end", session_id: sid, status: "completed" },
			]);

			const result = validateCertificationEvidence(makeCtx(traceFile, { expectedFixture: "clean" }));
			const formatted = formatValidationContract(result);

			expect(formatted).toContain("VALIDATION_CONTRACT:");
			expect(formatted).toContain("END_VALIDATION_CONTRACT");
			expect(formatted).toContain("validated: true");
			expect(formatted).toContain("blocking_reasons: none");
			expect(formatted).toContain("✓ lifecycle_complete");
		});

		test("includes blocking reasons when validation fails", () => {
			const sid = makeSessionId(34);
			const traceFile = writeTrace(sid, [
				{ type: "session.start", session_id: sid },
				// No leads at all
				{ type: "session.end", session_id: sid, status: "error" },
			]);

			const result = validateCertificationEvidence(makeCtx(traceFile));
			const formatted = formatValidationContract(result);

			expect(formatted).toContain("validated: false");
			expect(formatted).toContain("✗ lifecycle_complete");
			expect(formatted).not.toContain("blocking_reasons: none");
		});
	});

	describe("missing trace file", () => {
		test("handles nonexistent trace gracefully", () => {
			const result = validateCertificationEvidence(
				makeCtx("/nonexistent/trace.jsonl"),
			);
			expect(result.validated).toBe(false);
			expect(result.lifecycle_valid).toBe(false);
		});
	});

	// -----------------------------------------------------------------------
	// Phase 5: Steer event validation
	// -----------------------------------------------------------------------

	describe("steer event checks", () => {
		function steerActionEvent(sessionId: string, overrides?: Record<string, unknown>, kind: string = "web-steer"): object {
			return {
				type: "steer.action",
				event_type: "steer_action",
				session_id: sessionId,
				agent_id: `${kind}-1`,
				data: {
					participant_id: `${kind}-1`,
					sender: "user",
					source: kind === "cli-steer" ? "cli" : "web",
					authority: 90,
					intent: "freeform",
					target: "orchestrator",
					content: "focus on auth module",
					certification_impact: "blocks_unattended",
					...overrides,
				},
			};
		}

		function steerParticipantStart(sessionId: string, kind: string = "web-steer"): object {
			return {
				type: "participant.start",
				event_type: "participant_start",
				session_id: sessionId,
				agent_id: `${kind}-1`,
				data: {
					participant_id: `${kind}-1`,
					kind,
					status: "active",
					name: kind === "cli-steer" ? "CLI Operator" : "Dashboard Operator",
					role: "steer",
				},
			};
		}

		function steerParticipantEnd(sessionId: string, kind: string = "web-steer"): object {
			return {
				type: "participant.end",
				event_type: "participant_end",
				session_id: sessionId,
				agent_id: `${kind}-1`,
				data: { participant_id: `${kind}-1`, status: "completed" },
			};
		}

		/** Full steer bracket: start → action → end */
		function steerBracket(sessionId: string, overrides?: Record<string, unknown>, kind: string = "web-steer"): object[] {
			return [
				steerParticipantStart(sessionId, kind),
				steerActionEvent(sessionId, overrides, kind),
				steerParticipantEnd(sessionId, kind),
			];
		}

		// --- Default = fail-closed (unattended) ---

		test("default mode (no interactiveCert) fails on steer events", () => {
			const sid = makeSessionId(100);
			const synthRef = writeArtifact(sid, "synth.txt", validCleanContract());
			const traceFile = writeTrace(sid, [
				{ type: "session.start", session_id: sid },
				steerActionEvent(sid),
				...allLeadEndEvents(sid),
				{ type: "agent.end", session_id: sid, agent_id: "pi-orchestrator", output_artifact: synthRef },
				{ type: "session.end", session_id: sid, status: "completed" },
			]);

			// Default: interactiveCert=undefined → unattended/strict
			const result = validateCertificationEvidence(makeCtx(traceFile, { expectedFixture: "clean" }));
			expect(result.steering_valid).toBe(false);
			expect(result.validated).toBe(false);
			const check = findCheck(result, "steer_events_valid");
			expect(check?.passed).toBe(false);
			expect(check?.details).toContain("unattended certification");
		});

		test("passes when no steer events exist (default unattended)", () => {
			const sid = makeSessionId(101);
			const synthRef = writeArtifact(sid, "synth.txt", validCleanContract());
			const traceFile = writeTrace(sid, [
				{ type: "session.start", session_id: sid },
				...allLeadEndEvents(sid),
				{ type: "agent.end", session_id: sid, agent_id: "pi-orchestrator", output_artifact: synthRef },
				{ type: "session.end", session_id: sid, status: "completed" },
			]);

			const result = validateCertificationEvidence(makeCtx(traceFile, { expectedFixture: "clean" }));
			expect(result.steering_valid).toBe(true);
			expect(findCheck(result, "steer_events_valid")?.passed).toBe(true);
		});

		test("multiple steer events in unattended mode includes count", () => {
			const sid = makeSessionId(102);
			const synthRef = writeArtifact(sid, "synth.txt", validCleanContract());
			const traceFile = writeTrace(sid, [
				{ type: "session.start", session_id: sid },
				steerActionEvent(sid, { intent: "pause" }),
				steerActionEvent(sid, { intent: "resume" }),
				steerActionEvent(sid, { intent: "freeform" }),
				...allLeadEndEvents(sid),
				{ type: "agent.end", session_id: sid, agent_id: "pi-orchestrator", output_artifact: synthRef },
				{ type: "session.end", session_id: sid, status: "completed" },
			]);

			const result = validateCertificationEvidence(makeCtx(traceFile, { expectedFixture: "clean" }));
			expect(result.steering_valid).toBe(false);
			const check = findCheck(result, "steer_events_valid");
			expect(check?.details).toContain("3 steer event(s)");
		});

		// --- Interactive cert (--interactive-cert) ---

		test("passes with steer events in interactive mode (valid impact)", () => {
			const sid = makeSessionId(103);
			const synthRef = writeArtifact(sid, "synth.txt", validCleanContract());
			const traceFile = writeTrace(sid, [
				{ type: "session.start", session_id: sid },
				...steerBracket(sid),
				...allLeadEndEvents(sid),
				{ type: "agent.end", session_id: sid, agent_id: "pi-orchestrator", output_artifact: synthRef },
				{ type: "session.end", session_id: sid, status: "completed" },
			]);

			const result = validateCertificationEvidence(makeCtx(traceFile, { expectedFixture: "clean", interactiveCert: true }));
			expect(result.steering_valid).toBe(true);
			const check = findCheck(result, "steer_events_valid");
			expect(check?.passed).toBe(true);
			expect(check?.evidence).toContain("Interactive certification");
			expect(check?.details).toContain("web:freeform");
		});

		test("records CLI steer intents in interactive mode", () => {
			const sid = makeSessionId(104);
			const synthRef = writeArtifact(sid, "synth.txt", validCleanContract());
			const traceFile = writeTrace(sid, [
				{ type: "session.start", session_id: sid },
				...steerBracket(sid, { source: "cli", intent: "pause" }, "cli-steer"),
				...steerBracket(sid, { source: "cli", intent: "resume" }, "cli-steer"),
				...allLeadEndEvents(sid),
				{ type: "agent.end", session_id: sid, agent_id: "pi-orchestrator", output_artifact: synthRef },
				{ type: "session.end", session_id: sid, status: "completed" },
			]);

			const result = validateCertificationEvidence(makeCtx(traceFile, { expectedFixture: "clean", interactiveCert: true }));
			expect(result.steering_valid).toBe(true);
			const check = findCheck(result, "steer_events_valid");
			expect(check?.passed).toBe(true);
			expect(check?.details).toContain("cli:pause");
			expect(check?.details).toContain("cli:resume");
		});

		// --- Authority validation ---

		test("fails when steer action has non-90 authority", () => {
			const sid = makeSessionId(105);
			const synthRef = writeArtifact(sid, "synth.txt", validCleanContract());
			const traceFile = writeTrace(sid, [
				{ type: "session.start", session_id: sid },
				...steerBracket(sid, { authority: 50 }),
				...allLeadEndEvents(sid),
				{ type: "agent.end", session_id: sid, agent_id: "pi-orchestrator", output_artifact: synthRef },
				{ type: "session.end", session_id: sid, status: "completed" },
			]);

			const result = validateCertificationEvidence(makeCtx(traceFile, { expectedFixture: "clean", interactiveCert: true }));
			expect(result.steering_valid).toBe(false);
			const check = findCheck(result, "steer_events_valid");
			expect(check?.passed).toBe(false);
			expect(check?.details).toContain("non-90 authority");
		});

		// --- Certification impact validation ---

		test("fails with missing certification_impact in interactive mode", () => {
			const sid = makeSessionId(106);
			const synthRef = writeArtifact(sid, "synth.txt", validCleanContract());
			const traceFile = writeTrace(sid, [
				{ type: "session.start", session_id: sid },
				...steerBracket(sid, { certification_impact: undefined }),
				...allLeadEndEvents(sid),
				{ type: "agent.end", session_id: sid, agent_id: "pi-orchestrator", output_artifact: synthRef },
				{ type: "session.end", session_id: sid, status: "completed" },
			]);

			const result = validateCertificationEvidence(makeCtx(traceFile, { expectedFixture: "clean", interactiveCert: true }));
			expect(result.steering_valid).toBe(false);
			const check = findCheck(result, "steer_events_valid");
			expect(check?.passed).toBe(false);
			expect(check?.details).toContain("invalid certification_impact");
		});

		test("fails with unknown certification_impact value", () => {
			const sid = makeSessionId(107);
			const synthRef = writeArtifact(sid, "synth.txt", validCleanContract());
			const traceFile = writeTrace(sid, [
				{ type: "session.start", session_id: sid },
				...steerBracket(sid, { certification_impact: "corrupted" }),
				...allLeadEndEvents(sid),
				{ type: "agent.end", session_id: sid, agent_id: "pi-orchestrator", output_artifact: synthRef },
				{ type: "session.end", session_id: sid, status: "completed" },
			]);

			const result = validateCertificationEvidence(makeCtx(traceFile, { expectedFixture: "clean", interactiveCert: true }));
			expect(result.steering_valid).toBe(false);
			const check = findCheck(result, "steer_events_valid");
			expect(check?.passed).toBe(false);
			expect(check?.details).toContain("invalid certification_impact");
		});

		test("accepts certification_impact 'none' in interactive mode", () => {
			const sid = makeSessionId(114);
			const synthRef = writeArtifact(sid, "synth.txt", validCleanContract());
			const traceFile = writeTrace(sid, [
				{ type: "session.start", session_id: sid },
				...steerBracket(sid, { certification_impact: "none" }),
				...allLeadEndEvents(sid),
				{ type: "agent.end", session_id: sid, agent_id: "pi-orchestrator", output_artifact: synthRef },
				{ type: "session.end", session_id: sid, status: "completed" },
			]);

			const result = validateCertificationEvidence(makeCtx(traceFile, { expectedFixture: "clean", interactiveCert: true }));
			const check = findCheck(result, "steer_events_valid");
			expect(check?.passed).toBe(true);
		});

		// --- Lifecycle bracket validation ---

		test("fails when steer_action has no participant_start bracket", () => {
			const sid = makeSessionId(115);
			const synthRef = writeArtifact(sid, "synth.txt", validCleanContract());
			const traceFile = writeTrace(sid, [
				{ type: "session.start", session_id: sid },
				// steer_action with NO preceding participant_start
				steerActionEvent(sid),
				{ type: "participant.end", event_type: "participant_end", session_id: sid, agent_id: "web-steer-1", data: { participant_id: "web-steer-1", status: "completed" } },
				...allLeadEndEvents(sid),
				{ type: "agent.end", session_id: sid, agent_id: "pi-orchestrator", output_artifact: synthRef },
				{ type: "session.end", session_id: sid, status: "completed" },
			]);

			const result = validateCertificationEvidence(makeCtx(traceFile, { expectedFixture: "clean", interactiveCert: true }));
			const check = findCheck(result, "steer_events_valid");
			expect(check?.passed).toBe(false);
			expect(check?.details).toContain("missing participant_start bracket");
		});

		test("fails when steer_action has no participant_end bracket", () => {
			const sid = makeSessionId(116);
			const synthRef = writeArtifact(sid, "synth.txt", validCleanContract());
			const traceFile = writeTrace(sid, [
				{ type: "session.start", session_id: sid },
				steerParticipantStart(sid),
				steerActionEvent(sid),
				// NO participant_end
				...allLeadEndEvents(sid),
				{ type: "agent.end", session_id: sid, agent_id: "pi-orchestrator", output_artifact: synthRef },
				{ type: "session.end", session_id: sid, status: "completed" },
			]);

			const result = validateCertificationEvidence(makeCtx(traceFile, { expectedFixture: "clean", interactiveCert: true }));
			const check = findCheck(result, "steer_events_valid");
			expect(check?.passed).toBe(false);
			expect(check?.details).toContain("missing participant_end bracket");
		});

		test("passes when steer_action has complete start/end bracket", () => {
			const sid = makeSessionId(117);
			const synthRef = writeArtifact(sid, "synth.txt", validCleanContract());
			const traceFile = writeTrace(sid, [
				{ type: "session.start", session_id: sid },
				steerParticipantStart(sid),
				steerActionEvent(sid),
				{ type: "participant.end", event_type: "participant_end", session_id: sid, agent_id: "web-steer-1", data: { participant_id: "web-steer-1", status: "completed" } },
				...allLeadEndEvents(sid),
				{ type: "agent.end", session_id: sid, agent_id: "pi-orchestrator", output_artifact: synthRef },
				{ type: "session.end", session_id: sid, status: "completed" },
			]);

			const result = validateCertificationEvidence(makeCtx(traceFile, { expectedFixture: "clean", interactiveCert: true }));
			const check = findCheck(result, "steer_events_valid");
			expect(check?.passed).toBe(true);
		});

		// --- Evidence-hiding detection (from claude) ---

		test("interactive mode fails when steer stop hides incomplete lead lifecycle", () => {
			const sid = makeSessionId(108);
			const synthRef = writeArtifact(sid, "synth.txt", validFailContract());
			const traceFile = writeTrace(sid, [
				{ type: "session.start", session_id: sid },
				// Only 2 of 5 leads complete before steer stop
				{ type: "agent.end", session_id: sid, agent_id: "pi-correctness-lead", team: "Correctness Review" },
				{ type: "agent.end", session_id: sid, agent_id: "pi-adversarial-lead", team: "Adversarial Review" },
				...steerBracket(sid, { intent: "stop" }),
				// No more lead ends after the stop
				{ type: "agent.end", session_id: sid, agent_id: "pi-orchestrator", output_artifact: synthRef },
				{ type: "session.end", session_id: sid, status: "error" },
			]);

			const result = validateCertificationEvidence(makeCtx(traceFile, { expectedFixture: "failing", interactiveCert: true }));
			const check = findCheck(result, "steer_events_valid");
			expect(check?.passed).toBe(false);
			expect(check?.details).toContain("Steer stop prevented remaining leads from completing");
		});

		test("evidence-hiding not bypassed by duplicate lead end after stop", () => {
			const sid = makeSessionId(111);
			const synthRef = writeArtifact(sid, "synth.txt", validFailContract());
			const traceFile = writeTrace(sid, [
				{ type: "session.start", session_id: sid },
				// Only 2 unique leads complete before stop
				{ type: "agent.end", session_id: sid, agent_id: "pi-correctness-lead", team: "Correctness Review" },
				{ type: "agent.end", session_id: sid, agent_id: "pi-adversarial-lead", team: "Adversarial Review" },
				...steerBracket(sid, { intent: "stop" }),
				// Duplicate/fake lead end after stop — should NOT bypass the check
				{ type: "agent.end", session_id: sid, agent_id: "pi-correctness-lead", team: "Correctness Review" },
				{ type: "agent.end", session_id: sid, agent_id: "pi-orchestrator", output_artifact: synthRef },
				{ type: "session.end", session_id: sid, status: "error" },
			]);

			const result = validateCertificationEvidence(makeCtx(traceFile, { expectedFixture: "failing", interactiveCert: true }));
			const check = findCheck(result, "steer_events_valid");
			expect(check?.passed).toBe(false);
			expect(check?.details).toContain("Steer stop prevented remaining leads from completing");
			expect(check?.details).toContain("2/5");
		});

		test("interactive mode passes when steer stop does not hide evidence", () => {
			const sid = makeSessionId(109);
			const synthRef = writeArtifact(sid, "synth.txt", validCleanContract());
			const traceFile = writeTrace(sid, [
				{ type: "session.start", session_id: sid },
				...steerBracket(sid, { intent: "pause" }),
				...steerBracket(sid, { intent: "resume" }),
				// All 5 leads complete after the steer events
				...allLeadEndEvents(sid),
				{ type: "agent.end", session_id: sid, agent_id: "pi-orchestrator", output_artifact: synthRef },
				{ type: "session.end", session_id: sid, status: "completed" },
			]);

			const result = validateCertificationEvidence(makeCtx(traceFile, { expectedFixture: "clean", interactiveCert: true }));
			const check = findCheck(result, "steer_events_valid");
			expect(check?.passed).toBe(true);
		});

		// --- event_type-only format ---

		test("steer events with event_type only (no type field) are detected", () => {
			const sid = makeSessionId(110);
			const synthRef = writeArtifact(sid, "synth.txt", validCleanContract());
			const traceFile = writeTrace(sid, [
				{ type: "session.start", session_id: sid },
				steerParticipantStart(sid),
				{
					event_type: "steer_action",
					session_id: sid,
					agent_id: "web-steer-1",
					data: {
						sender: "user", source: "web", authority: 90,
						intent: "pause", target: "orchestrator", content: "!pause",
						certification_impact: "blocks_unattended",
					},
				},
				steerParticipantEnd(sid),
				...allLeadEndEvents(sid),
				{ type: "agent.end", session_id: sid, agent_id: "pi-orchestrator", output_artifact: synthRef },
				{ type: "session.end", session_id: sid, status: "completed" },
			]);

			// Default = unattended, should fail
			const result = validateCertificationEvidence(makeCtx(traceFile, { expectedFixture: "clean" }));
			expect(result.steering_valid).toBe(false);
			const check = findCheck(result, "steer_events_valid");
			expect(check?.passed).toBe(false);
			expect(check?.details).toContain("unattended certification");

			// In interactive mode, the intent should be visible
			const interactive = validateCertificationEvidence(makeCtx(traceFile, { expectedFixture: "clean", interactiveCert: true }));
			const iCheck = findCheck(interactive, "steer_events_valid");
			expect(iCheck?.details).toContain("web:pause");
		});

		test("reads flat fields from trace-recorder format (no data wrapper)", () => {
			const sid = makeSessionId(112);
			const synthRef = writeArtifact(sid, "synth.txt", validCleanContract());
			const traceFile = writeTrace(sid, [
				{ type: "session.start", session_id: sid },
				// Flat bracket: trace-recorder format
				{ type: "participant.start", session_id: sid, agent_id: "cli-steer-1", data: { participant_id: "cli-steer-1", kind: "cli-steer", status: "active" } },
				{
					type: "steer.action",
					session_id: sid,
					agent_id: "cli-steer-1",
					sender: "user",
					source: "cli",
					authority: 90,
					intent: "budget",
					target: "orchestrator",
					certification_impact: "blocks_unattended",
				},
				{ type: "participant.end", session_id: sid, agent_id: "cli-steer-1", data: { participant_id: "cli-steer-1", status: "completed" } },
				...allLeadEndEvents(sid),
				{ type: "agent.end", session_id: sid, agent_id: "pi-orchestrator", output_artifact: synthRef },
				{ type: "session.end", session_id: sid, status: "completed" },
			]);

			// Interactive mode: should read flat fields correctly
			const result = validateCertificationEvidence(makeCtx(traceFile, { expectedFixture: "clean", interactiveCert: true }));
			const check = findCheck(result, "steer_events_valid");
			expect(check?.passed).toBe(true);
			expect(check?.details).toContain("cli:budget");

			// Unattended: should still detect flat steer events
			const unattended = validateCertificationEvidence(makeCtx(traceFile, { expectedFixture: "clean" }));
			expect(unattended.steering_valid).toBe(false);
		});

		test("rejects string authority even if it coerces to 90", () => {
			const sid = makeSessionId(113);
			const synthRef = writeArtifact(sid, "synth.txt", validCleanContract());
			const traceFile = writeTrace(sid, [
				{ type: "session.start", session_id: sid },
				...steerBracket(sid, { authority: "90" }),
				...allLeadEndEvents(sid),
				{ type: "agent.end", session_id: sid, agent_id: "pi-orchestrator", output_artifact: synthRef },
				{ type: "session.end", session_id: sid, status: "completed" },
			]);

			const result = validateCertificationEvidence(makeCtx(traceFile, { expectedFixture: "clean", interactiveCert: true }));
			expect(result.steering_valid).toBe(false);
			const check = findCheck(result, "steer_events_valid");
			expect(check?.details).toContain("non-90 authority");
		});
	});
});
