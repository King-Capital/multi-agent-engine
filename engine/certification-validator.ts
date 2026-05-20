/**
 * Deterministic certification evidence validator (Phase 3).
 *
 * Validates final certification claims against trace/artifact evidence.
 * All checks are deterministic — no LLM calls. LLM commentary, if any,
 * is non-authoritative.
 *
 * @module certification-validator
 */

import { readFileSync, existsSync } from "node:fs";
import { coerceSpawnDecisionPayload, validateSpawnDecision, type SpawnDecision } from "./spawn-decision";

// ---------------------------------------------------------------------------
// VALIDATION_CONTRACT schema
// ---------------------------------------------------------------------------

export interface ValidationContract {
	schema_version: 1;
	validated: boolean;
	evidence_complete: boolean;
	lifecycle_valid: boolean;
	contract_matches_evidence: boolean;
	scope_valid: boolean;
	steering_valid: boolean;
	spawn_policy_valid: boolean;
	blocking_reasons: string[];
	checks: ValidationCheck[];
}

export interface ValidationCheck {
	name: string;
	passed: boolean;
	evidence: string;
	details?: string;
}

// ---------------------------------------------------------------------------
// Trace event shapes (minimal for jq-free TS validation)
// ---------------------------------------------------------------------------

interface TraceEvent {
	type?: string;
	event_type?: string;
	session_id?: string;
	agent_id?: string;
	mae_agent_id?: string;
	mae_agent_name?: string;
	parent_id?: string;
	team?: string;
	grade?: string;
	status?: string;
	output_artifact?: string;
	args_preview?: string;
	data?: {
		agent_id?: string;
		agent_name?: string;
		agent_role?: string;
		team_name?: string;
		grade?: string;
		output_artifact?: string;
		participant_id?: string;
		kind?: string;
		status?: string;
		worker_name?: string;
		spawn_type?: string;
		reason?: string;
		why_lead_cannot_do_it?: string;
		constraints?: Record<string, unknown>;
		decision?: Record<string, unknown>;
		bus_policy?: string;
		expected_output_schema?: string;
		expected_output?: string;
		timeout_seconds?: number;
		[key: string]: unknown;
	};
	worker_name?: string;
	spawn_type?: string;
	reason?: string;
	why_lead_cannot_do_it?: string;
	constraints?: Record<string, unknown>;
	bus_policy?: string;
	expected_output_schema?: string;
	expected_output?: string;
	timeout_seconds?: number;
	// Steer event flat fields (trace-recorder format)
	sender?: string;
	source?: string;
	authority?: number;
	intent?: string;
	action?: string;
	target?: string;
	certification_impact?: string;
}

// ---------------------------------------------------------------------------
// Certification contract parsed from artifact
// ---------------------------------------------------------------------------

export interface ParsedCertContract {
	schema_version?: number;
	verdict?: string;
	p0_count?: number;
	p1_count?: number;
	perspectives_covered?: string[];
	blockers?: string;
	failed_teams?: string;
	certification_ready?: boolean;
}

// ---------------------------------------------------------------------------
// Validation context
// ---------------------------------------------------------------------------

export interface ValidatorContext {
	traceFile: string;
	traceDir: string;
	workDir: string;
	repoRoot: string;
	expectedFixture?: "clean" | "seeded" | "failing";
	isLivePi: boolean;
	strictSpawnDecisions?: boolean;
	/** When true, steer events are allowed but audited (interactive certification).
	 *  Default is false (unattended/strict — any steer event fails validation). */
	interactiveCert?: boolean;
}

// ---------------------------------------------------------------------------
// Required review leads
// ---------------------------------------------------------------------------

const REQUIRED_LEADS: { team: string; leadPattern: RegExp }[] = [
	{ team: "Correctness Review", leadPattern: /pi-correctness-lead$|^Correctness Review-lead$/ },
	{ team: "Adversarial Review", leadPattern: /pi-adversarial-lead$|^Adversarial Review-lead$/ },
	{ team: "Quality Review", leadPattern: /pi-quality-lead$|^Quality Review-lead$/ },
	{ team: "Security Review", leadPattern: /pi-security-lead$|^Security Review-lead$/ },
	{ team: "Domain Review", leadPattern: /pi-domain-lead$|^Domain Review-lead$/ },
];

const REQUIRED_PERSPECTIVES = ["correctness", "adversarial", "quality", "security", "domain"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readTraceEvents(traceFile: string): TraceEvent[] {
	if (!existsSync(traceFile)) return [];
	const raw = readFileSync(traceFile, "utf8");
	const events: TraceEvent[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			events.push(JSON.parse(trimmed) as TraceEvent);
		} catch {
			// Skip malformed lines
		}
	}
	return events;
}

function agentId(evt: TraceEvent): string {
	return evt.agent_id ?? evt.data?.agent_id ?? evt.data?.participant_id ?? "";
}

function maeAgentId(evt: TraceEvent): string {
	return evt.mae_agent_id ?? "";
}

function teamName(evt: TraceEvent): string {
	return evt.team ?? evt.data?.team_name ?? "";
}

function grade(evt: TraceEvent): string {
	return evt.grade ?? evt.data?.grade ?? "";
}

function artifactRef(evt: TraceEvent): string {
	return evt.output_artifact ?? evt.data?.output_artifact ?? "";
}

function isAgentEnd(evt: TraceEvent): boolean {
	return evt.type === "agent.end" || evt.event_type === "agent_done";
}

function isAgentStart(evt: TraceEvent): boolean {
	return evt.type === "agent.start" || evt.event_type === "agent_spawn" || evt.event_type === "participant_start" || evt.type === "participant.start";
}

function isToolCall(evt: TraceEvent): boolean {
	return evt.type === "tool.call";
}

function isOperationalFailure(evt: TraceEvent): boolean {
	return (
		evt.type === "agent.error" ||
		evt.event_type === "worker_failed" ||
		evt.event_type === "error" ||
		(evt.type === "session.end" && !/^(completed|success)$/i.test(evt.status ?? ""))
	);
}

function isSynthesisAgent(id: string): boolean {
	return (
		id.startsWith("synth-") ||
		id === "pi-orchestrator" ||
		id === "echo-orchestrator"
	);
}

function isWorkerSpawn(evt: TraceEvent): boolean {
	if (!isAgentStart(evt)) return false;
	const id = agentId(evt);
	if (!id) return false;
	if (id.endsWith("-lead")) return false;
	if (id.startsWith("synth-")) return false;
	if (id === "pi-orchestrator" || id === "echo-orchestrator") return false;
	if (evt.event_type === "participant_start" || evt.type === "participant.start") {
		return evt.data?.kind === "worker" || evt.data?.role === "worker";
	}
	if (evt.data?.agent_role === "worker") return true;
	// Heuristic: non-lead, non-synth, non-orchestrator agent.start is a worker
	return true;
}

function parseCertContract(content: string): ParsedCertContract | null {
	const startIdx = content.indexOf("CERTIFICATION_CONTRACT:");
	const endIdx = content.indexOf("END_CERTIFICATION_CONTRACT");
	if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return null;

	const block = content.slice(startIdx + "CERTIFICATION_CONTRACT:".length, endIdx);
	const result: ParsedCertContract = {};

	for (const line of block.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const colonIdx = trimmed.indexOf(":");
		if (colonIdx === -1) continue;
		const key = trimmed.slice(0, colonIdx).trim().toLowerCase();
		const val = trimmed.slice(colonIdx + 1).trim().toLowerCase();

		switch (key) {
			case "schema_version":
				result.schema_version = parseInt(val, 10);
				break;
			case "verdict":
				result.verdict = val;
				break;
			case "p0_count":
				result.p0_count = parseInt(val, 10);
				break;
			case "p1_count":
				result.p1_count = parseInt(val, 10);
				break;
			case "perspectives_covered":
				result.perspectives_covered = val.split(",").map((s) => s.trim());
				break;
			case "blockers":
				result.blockers = val;
				break;
			case "failed_teams":
				result.failed_teams = val;
				break;
			case "certification_ready":
				result.certification_ready = val === "true";
				break;
		}
	}

	return result;
}

function readArtifact(traceDir: string, ref: string): string | null {
	const fullPath = `${traceDir}/${ref}`;
	if (!existsSync(fullPath)) return null;
	try {
		return readFileSync(fullPath, "utf8");
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Individual validation checks
// ---------------------------------------------------------------------------

function checkLifecycleComplete(events: TraceEvent[]): ValidationCheck {
	const endEvents = events.filter(isAgentEnd);
	const missing: string[] = [];

	for (const req of REQUIRED_LEADS) {
		const found = endEvents.some(
			(evt) => req.leadPattern.test(agentId(evt)) || teamName(evt) === req.team,
		);
		if (!found) missing.push(req.team);
	}

	return {
		name: "lifecycle_complete",
		passed: missing.length === 0,
		evidence: missing.length === 0
			? `All ${REQUIRED_LEADS.length} required leads completed`
			: `Missing lead completions: ${missing.join(", ")}`,
	};
}

function checkNoOperationalFailures(events: TraceEvent[]): ValidationCheck {
	const failures = events.filter(isOperationalFailure);
	return {
		name: "no_operational_failures",
		passed: failures.length === 0,
		evidence: failures.length === 0
			? "No operational failures (agent.error, worker_failed, session error)"
			: `${failures.length} operational failure(s) detected`,
		details: failures.length > 0
			? failures.map((e) => `${e.type ?? e.event_type}: ${agentId(e)}`).join("; ")
			: undefined,
	};
}

function checkNoEmptyOutputs(events: TraceEvent[], traceDir: string): ValidationCheck {
	const endEvents = events.filter(isAgentEnd);
	const emptyRefs: string[] = [];

	// Build supersession map: later agent.end for same agent_id supersedes earlier
	const latestGradeByAgent = new Map<string, string>();
	for (const evt of endEvents) {
		const id = agentId(evt);
		if (id) latestGradeByAgent.set(id, grade(evt));
	}

	for (const evt of endEvents) {
		const id = agentId(evt);
		const ref = artifactRef(evt);
		if (!ref) continue;

		// Skip if superseded by a later non-failed event
		const latestGrade = latestGradeByAgent.get(id) ?? "";
		if (/^(FAILED|ERROR)$/i.test(grade(evt)) && !/^(FAILED|ERROR)$/i.test(latestGrade)) {
			continue;
		}

		const content = readArtifact(traceDir, ref);
		if (content !== null && content.includes("ERROR: Empty output")) {
			emptyRefs.push(ref);
		}
	}

	return {
		name: "no_empty_outputs",
		passed: emptyRefs.length === 0,
		evidence: emptyRefs.length === 0
			? "No unsuperseded empty output artifacts"
			: `${emptyRefs.length} empty output artifact(s): ${emptyRefs.join(", ")}`,
	};
}

function checkNoScopeDrift(events: TraceEvent[], workDir: string): ValidationCheck {
	const toolCalls = events.filter(isToolCall);
	const drifted: string[] = [];

	for (const evt of toolCalls) {
		const preview = evt.args_preview ?? "";
		if (/\/mae-cert\.[^/]+\//.test(preview) && !preview.startsWith(workDir)) {
			drifted.push(preview);
		}
	}

	return {
		name: "no_scope_drift",
		passed: drifted.length === 0,
		evidence: drifted.length === 0
			? "No tool calls escaped current certification workdir"
			: `${drifted.length} tool call(s) outside scope: ${drifted.slice(0, 3).join("; ")}`,
	};
}

function checkNoWrongFixture(
	events: TraceEvent[],
	workDir: string,
	fixtureName: string | undefined,
): ValidationCheck {
	if (!fixtureName) {
		return { name: "no_wrong_fixture", passed: true, evidence: "No fixture filter applied" };
	}

	const toolCalls = events.filter(isToolCall);
	const wrong: string[] = [];
	const fixturePrefix = `${workDir}/${fixtureName}`;

	for (const evt of toolCalls) {
		const preview = evt.args_preview ?? "";
		if (
			preview.startsWith(workDir) &&
			/\/mae-cert\.[^/]+\/(clean|seeded|failing)(\/|$)/.test(preview) &&
			!preview.startsWith(fixturePrefix)
		) {
			wrong.push(preview);
		}
	}

	return {
		name: "no_wrong_fixture",
		passed: wrong.length === 0,
		evidence: wrong.length === 0
			? `All tool calls target correct fixture: ${fixtureName}`
			: `${wrong.length} tool call(s) inspected wrong fixture`,
	};
}

function checkNoRepoSourceReads(events: TraceEvent[], repoRoot: string, workDir: string): ValidationCheck {
	const toolCalls = events.filter(isToolCall);
	const offending: string[] = [];

	for (const evt of toolCalls) {
		const preview = evt.args_preview ?? "";
		if (preview.includes(repoRoot) && !preview.includes(workDir)) {
			offending.push(preview);
		}
	}

	return {
		name: "no_repo_source_reads",
		passed: offending.length === 0,
		evidence: offending.length === 0
			? "No tool calls to repository source during fixture certification"
			: `${offending.length} repo source read(s)`,
	};
}

function checkNoWorkerSpawns(events: TraceEvent[]): ValidationCheck {
	const spawns = events.filter(isWorkerSpawn);
	return {
		name: "no_worker_spawns",
		passed: spawns.length === 0,
		evidence: spawns.length === 0
			? "Lead-only mode: no worker spawn events"
			: `${spawns.length} worker spawn(s) detected`,
		details: spawns.length > 0
			? spawns.map((e) => agentId(e)).join(", ")
			: undefined,
	};
}

function normalizeWorkerName(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function listValue(value: unknown): string[] {
	if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
	if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
	return [];
}

function recordValue(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function firstValue(record: Record<string, unknown>, keys: string[]): unknown {
	for (const key of keys) {
		if (record[key] !== undefined) return record[key];
	}
	return undefined;
}

function eventSpawnDecision(evt: TraceEvent): SpawnDecision | null {
	if (evt.event_type !== "spawn_decision" && evt.type !== "spawn.decision") return null;
	const eventData = recordValue(evt.data);
	const data = Object.keys(recordValue(eventData.decision)).length > 0
		? recordValue(eventData.decision)
		: Object.keys(eventData).length > 0
		? eventData
		: evt as unknown as Record<string, unknown>;
	return coerceSpawnDecisionPayload(data, { defaultNeedWorker: true });
}

function hasUnsafeTracePath(value: string): boolean {
	const path = value.trim();
	if (!path) return true;
	if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) return true;
	if (path.split(/[\\/]+/).includes("..")) return true;
	return [".", "./", "*", "**", "**/*", "/*"].includes(path);
}

function tracePathCovers(allowedPath: string, forbiddenPath: string): boolean {
	const allowed = allowedPath.replace(/\/+$/g, "");
	const forbidden = forbiddenPath.replace(/\/+$/g, "");
	if (allowed === forbidden) return true;
	if (allowed.endsWith("/**")) {
		const prefix = allowed.slice(0, -3).replace(/\/+$/g, "");
		return forbidden === prefix || forbidden.startsWith(`${prefix}/`);
	}
	if (allowed.endsWith("/*")) {
		const prefix = allowed.slice(0, -2).replace(/\/+$/g, "");
		return forbidden.startsWith(`${prefix}/`) && !forbidden.slice(prefix.length + 1).includes("/");
	}
	return forbidden.startsWith(`${allowed}/`);
}

function validateTraceSpawnDecision(decision: SpawnDecision): ValidationCheck | null {
	const validation = validateSpawnDecision(decision);
	const errors = [...validation.errors];
	if (decision.need_worker) {
		for (const path of [...decision.constraints.allowed_paths, ...decision.constraints.forbidden_paths]) {
			if (hasUnsafeTracePath(path)) errors.push(`unsafe path constraint: ${path}`);
		}
		for (const tool of decision.constraints.allowed_tools) {
			if (tool === "*") errors.push(`unsafe allowed tool: ${tool}`);
		}
		for (const forbidden of decision.constraints.forbidden_paths) {
			for (const allowed of decision.constraints.allowed_paths) {
				if (tracePathCovers(allowed, forbidden)) {
					errors.push(`forbidden path is covered by allowed path: ${forbidden}`);
				}
			}
		}
	}
	if (errors.length === 0) return null;
	return {
		name: "spawn_decisions_valid",
		passed: false,
		evidence: "Invalid SPAWN_DECISION evidence",
		details: `${decision.worker_name ?? "(unknown)"} invalid: ${errors.join(", ")}`,
	};
}

function checkSpawnDecisions(events: TraceEvent[], strict: boolean): ValidationCheck {
	const spawns = events.map((event, index) => ({ event, index })).filter(({ event }) => isWorkerSpawn(event));
	const decisionEvents = events
		.map((event, index) => ({ event, decision: eventSpawnDecision(event), index }))
		.filter((entry): entry is { event: TraceEvent; decision: SpawnDecision; index: number } => entry.decision !== null);
	const failures: string[] = [];
	const seenDecisionKeys = new Set<string>();

	for (const { event, decision } of decisionEvents) {
		const validation = validateTraceSpawnDecision(decision);
		if (validation) {
			failures.push(validation.details ?? validation.evidence);
		}
		const key = `${event.session_id ?? ""}:${agentId(event)}:${normalizeWorkerName(decision.worker_name ?? "")}`;
		if (seenDecisionKeys.has(key)) {
			failures.push(`${decision.worker_name ?? (agentId(event) || "(unknown)")} has duplicate SPAWN_DECISION evidence`);
		}
		seenDecisionKeys.add(key);
	}

	if (strict) {
		for (const { event: spawn, index: spawnIndex } of spawns) {
			const id = agentId(spawn);
			const canonicalId = maeAgentId(spawn) || id;
			const name = String(spawn.data?.agent_name ?? id);
			const key = normalizeWorkerName(name);
			const idKey = normalizeWorkerName(canonicalId);
			const matchingDecision = decisionEvents.find(({ event, decision }) => {
				if ((event.session_id ?? "") !== (spawn.session_id ?? "")) return false;
				const decisionEventId = maeAgentId(event) || agentId(event);
				if (decisionEventId && decisionEventId !== canonicalId) return false;
				if (event.parent_id && spawn.parent_id && event.parent_id !== spawn.parent_id) return false;
				const decisionName = normalizeWorkerName(decision.worker_name ?? "");
				return decisionName === key || decisionName === idKey || normalizeWorkerName(decisionEventId) === idKey;
			});
			if (!matchingDecision) {
				failures.push(`${id} missing SPAWN_DECISION`);
			} else if (matchingDecision.index > spawnIndex) {
				failures.push(`${id} SPAWN_DECISION appears after worker spawn`);
			}
		}
	}

	return {
		name: "spawn_decisions_valid",
		passed: failures.length === 0,
		evidence: failures.length === 0
			? strict
				? `${spawns.length} worker spawn(s) have valid prior SPAWN_DECISION evidence`
				: `${decisionEvents.length} SPAWN_DECISION event(s) valid`
			: `${failures.length} spawn decision failure(s)`,
		details: failures.length > 0 ? failures.join("; ") : undefined,
	};
}

function checkNoLeakedContracts(events: TraceEvent[], traceDir: string): ValidationCheck {
	const endEvents = events.filter(isAgentEnd);
	const leaked: string[] = [];

	for (const evt of endEvents) {
		const id = agentId(evt);
		if (isSynthesisAgent(id)) continue;

		const ref = artifactRef(evt);
		if (!ref) continue;

		const content = readArtifact(traceDir, ref);
		if (content !== null && content.includes("CERTIFICATION_CONTRACT:")) {
			leaked.push(`${id}: ${ref}`);
		}
	}

	return {
		name: "no_leaked_contracts",
		passed: leaked.length === 0,
		evidence: leaked.length === 0
			? "No non-synthesis agents emitted CERTIFICATION_CONTRACT"
			: `${leaked.length} leaked contract(s): ${leaked.join("; ")}`,
	};
}

function checkCanonicalArtifactExists(
	events: TraceEvent[],
	traceDir: string,
): ValidationCheck & { artifactPath?: string; contract?: ParsedCertContract } {
	const endEvents = events.filter(isAgentEnd);
	const synthesisCandidates: string[] = [];

	for (const evt of endEvents) {
		const id = agentId(evt);
		if (!isSynthesisAgent(id) && teamName(evt) !== "Synthesis") continue;
		const ref = artifactRef(evt);
		if (ref) synthesisCandidates.push(ref);
	}

	// Prefer artifact with valid CERTIFICATION_CONTRACT block
	for (const ref of synthesisCandidates) {
		const content = readArtifact(traceDir, ref);
		if (
			content !== null &&
			content.includes("CERTIFICATION_CONTRACT:") &&
			content.includes("END_CERTIFICATION_CONTRACT")
		) {
			const contract = parseCertContract(content);
			return {
				name: "canonical_artifact_exists",
				passed: true,
				evidence: `Canonical artifact found: ${ref}`,
				artifactPath: `${traceDir}/${ref}`,
				contract: contract ?? undefined,
			};
		}
	}

	// Fall back to last synthesis artifact
	if (synthesisCandidates.length > 0) {
		const lastRef = synthesisCandidates[synthesisCandidates.length - 1]!;
		return {
			name: "canonical_artifact_exists",
			passed: false,
			evidence: `Synthesis artifact ${lastRef} found but lacks valid CERTIFICATION_CONTRACT block`,
		};
	}

	return {
		name: "canonical_artifact_exists",
		passed: false,
		evidence: "No synthesis/orchestrator artifact found in trace",
	};
}

function checkContractMatchesEvidence(
	contract: ParsedCertContract | undefined,
	lifecycleValid: boolean,
	hasEmptyOutputs: boolean,
	hasScopeDrift: boolean,
	hasOperationalFailures: boolean,
	expected?: "clean" | "seeded" | "failing",
): ValidationCheck {
	if (!contract) {
		return {
			name: "contract_matches_evidence",
			passed: false,
			evidence: "No certification contract to validate",
		};
	}

	const reasons: string[] = [];

	// Schema version
	if (contract.schema_version !== 1) {
		reasons.push(`Invalid schema_version: ${contract.schema_version}`);
	}

	// Required fields
	if (contract.verdict === undefined) reasons.push("Missing verdict");
	if (contract.p0_count === undefined) reasons.push("Missing p0_count");
	if (contract.p1_count === undefined) reasons.push("Missing p1_count");
	if (contract.certification_ready === undefined) reasons.push("Missing certification_ready");
	if (!contract.perspectives_covered) reasons.push("Missing perspectives_covered");
	if (contract.blockers === undefined) reasons.push("Missing blockers");
	if (contract.failed_teams === undefined) reasons.push("Missing failed_teams");

	// All 5 perspectives
	if (contract.perspectives_covered) {
		for (const p of REQUIRED_PERSPECTIVES) {
			if (!contract.perspectives_covered.some((covered) => covered.includes(p))) {
				reasons.push(`Missing perspective: ${p}`);
			}
		}
	}

	// Evidence contradictions
	if (!lifecycleValid && contract.certification_ready === true) {
		reasons.push("Contract claims ready but lifecycle is incomplete");
	}
	if (hasEmptyOutputs && contract.certification_ready === true) {
		reasons.push("Contract claims ready but empty outputs exist");
	}
	if (hasScopeDrift && contract.certification_ready === true) {
		reasons.push("Contract claims ready but scope drift detected");
	}
	if (hasOperationalFailures && contract.verdict === "pass") {
		reasons.push("Contract claims pass but operational failures exist");
	}

	// Failed teams contradiction
	if (contract.failed_teams && contract.failed_teams !== "none" && contract.certification_ready === true) {
		reasons.push("Contract claims ready but has failed teams");
	}

	// Placeholder detection
	if (contract.verdict === "pass|fail") {
		reasons.push("Contract contains placeholder verdict");
	}

	// Expected fixture checks
	if (expected === "clean") {
		if (contract.verdict !== "pass") reasons.push(`Expected clean verdict=pass, got ${contract.verdict}`);
		if (contract.p0_count !== 0) reasons.push(`Expected clean p0_count=0, got ${contract.p0_count}`);
		if (contract.p1_count !== 0) reasons.push(`Expected clean p1_count=0, got ${contract.p1_count}`);
		if (contract.certification_ready !== true) reasons.push("Expected clean certification_ready=true");
		if (contract.failed_teams && contract.failed_teams !== "none") {
			reasons.push(`Expected clean failed_teams=none, got ${contract.failed_teams}`);
		}
	}

	if (expected === "seeded") {
		if (contract.certification_ready !== false) {
			reasons.push("Expected seeded certification_ready=false");
		}
		if (contract.verdict === "pass" && contract.p0_count === 0 && contract.p1_count === 0) {
			reasons.push("Seeded fixture should have findings or fail verdict");
		}
	}

	if (expected === "failing") {
		if (contract.verdict !== "fail") reasons.push(`Expected failing verdict=fail, got ${contract.verdict}`);
		if (contract.certification_ready !== false) reasons.push("Expected failing certification_ready=false");
	}

	return {
		name: "contract_matches_evidence",
		passed: reasons.length === 0,
		evidence: reasons.length === 0
			? "Contract fields match trace evidence"
			: `${reasons.length} contract/evidence mismatch(es)`,
		details: reasons.length > 0 ? reasons.join("; ") : undefined,
	};
}

function checkTeamContracts(events: TraceEvent[], traceDir: string): ValidationCheck {
	const endEvents = events.filter(isAgentEnd);
	const issues: string[] = [];

	// Check that lead artifacts contain REVIEW_REPORT, not CERTIFICATION_CONTRACT
	for (const evt of endEvents) {
		const id = agentId(evt);
		if (!id.endsWith("-lead")) continue;
		const ref = artifactRef(evt);
		if (!ref) continue;

		const content = readArtifact(traceDir, ref);
		if (content === null) continue;

		if (content.includes("CERTIFICATION_CONTRACT:")) {
			issues.push(`Lead ${id} emitted CERTIFICATION_CONTRACT instead of REVIEW_REPORT`);
		}
	}

	return {
		name: "team_contracts_valid",
		passed: issues.length === 0,
		evidence: issues.length === 0
			? "All team leads use REVIEW_REPORT (no CERTIFICATION_CONTRACT leaks)"
			: `${issues.length} team contract issue(s)`,
		details: issues.length > 0 ? issues.join("; ") : undefined,
	};
}

// ---------------------------------------------------------------------------
// Phase 5: Steer event checks
// ---------------------------------------------------------------------------

function isSteerEvent(evt: TraceEvent): boolean {
	return evt.type === "steer.action" || evt.event_type === "steer_action";
}

function checkSteerEvents(events: TraceEvent[], interactiveCert: boolean): ValidationCheck {
	const steerEvents = events.filter(isSteerEvent);
	const steerCount = steerEvents.length;

	// Helper: read steer field from evt.data (dashboard format) or flat evt (trace-recorder format)
	const steerField = (evt: TraceEvent, field: string): unknown =>
		(evt.data as Record<string, unknown> | undefined)?.[field] ?? (evt as Record<string, unknown>)[field];

	// Collect steer intents for evidence detail
	const intents: string[] = steerEvents
		.map((evt) => {
			const intent = String(steerField(evt, "intent") ?? "unknown");
			const source = String(steerField(evt, "source") ?? "unknown");
			return `${source}:${intent}`;
		});

	const issues: string[] = [];

	if (!interactiveCert && steerCount > 0) {
		// Unattended/strict certification (default): any steer event is a failure
		issues.push(`${steerCount} steer event(s) found in unattended certification`);
	}

	// Authority validation: all steer actions must use authority 90
	const invalidAuthority = steerEvents.filter((evt) => {
		const auth = steerField(evt, "authority");
		return typeof auth !== "number" || auth !== 90;
	});
	if (invalidAuthority.length > 0) {
		issues.push(`${invalidAuthority.length} steer action(s) had non-90 authority`);
	}

	// Certification impact validation: all steer actions must declare impact
	const missingImpact = steerEvents.filter((evt) => {
		const impact = steerField(evt, "certification_impact") as string | undefined;
		return !impact || (impact !== "blocks_unattended" && impact !== "none");
	});
	if (missingImpact.length > 0) {
		issues.push(`${missingImpact.length} steer action(s) with missing or invalid certification_impact`);
	}

	// Lifecycle bracket validation: each steer_action must have a matching
	// participant_start (steer kind, before action) and participant_end (after action)
	for (const steerEvt of steerEvents) {
		const pid = String(steerField(steerEvt, "participant_id") ?? agentId(steerEvt) ?? "");
		if (!pid) {
			issues.push("steer_action missing participant_id");
			continue;
		}
		const steerIdx = events.indexOf(steerEvt);

		// Find matching participant_start with steer kind before this action
		const matchingStart = events.find((evt, idx) => {
			if (idx >= steerIdx) return false;
			if (evt.type !== "participant.start" && evt.event_type !== "participant_start") return false;
			const evtPid = String((evt.data as Record<string, unknown> | undefined)?.participant_id ?? agentId(evt));
			if (evtPid !== pid) return false;
			const kind = ((evt.data as Record<string, unknown> | undefined)?.kind ?? (evt as Record<string, unknown>).kind) as string | undefined;
			return kind === "web-steer" || kind === "cli-steer";
		});
		if (!matchingStart) {
			issues.push(`steer_action ${pid} missing participant_start bracket`);
		}

		// Find matching participant_end after this action
		const matchingEnd = events.find((evt, idx) => {
			if (idx <= steerIdx) return false;
			if (evt.type !== "participant.end" && evt.event_type !== "participant_end") return false;
			const evtPid = String((evt.data as Record<string, unknown> | undefined)?.participant_id ?? agentId(evt));
			return evtPid === pid;
		});
		if (!matchingEnd) {
			issues.push(`steer_action ${pid} missing participant_end bracket`);
		}
	}

	// Evidence-hiding detection (interactive mode): steer stop must not mask
	// incomplete lifecycle evidence
	if (interactiveCert && steerCount > 0) {
		const steerStops = steerEvents.filter((evt) => {
			const intent = String(steerField(evt, "intent") ?? "");
			const action = String(steerField(evt, "action") ?? "");
			return intent === "stop" || action === "stop";
		});
		if (steerStops.length > 0) {
			const lastSteerStopIdx = Math.max(...steerStops.map((s) => events.indexOf(s)));
			// Count unique required leads completed before the stop
			const leadsCompletedBeforeStop = new Set<string>();
			for (const evt of events) {
				if (events.indexOf(evt) >= lastSteerStopIdx) break;
				if (!isAgentEnd(evt)) continue;
				const id = agentId(evt);
				for (const req of REQUIRED_LEADS) {
					if (req.leadPattern.test(id) || teamName(evt) === req.team) {
						leadsCompletedBeforeStop.add(req.team);
					}
				}
			}
			if (leadsCompletedBeforeStop.size < REQUIRED_LEADS.length) {
				issues.push(`Steer stop prevented remaining leads from completing (${leadsCompletedBeforeStop.size}/${REQUIRED_LEADS.length} completed before stop)`);
			}
		}
	}

	const checkName = "steer_events_valid";

	return {
		name: checkName,
		passed: issues.length === 0,
		evidence: issues.length === 0
			? interactiveCert
				? `Interactive certification: ${steerCount} steer event(s) recorded, all valid`
				: "Unattended certification: no steer events"
			: `${issues.length} steering policy issue(s)`,
		details: issues.length > 0
			? issues.join("; ")
			: steerCount > 0 ? `intents: ${intents.join(", ")}` : undefined,
	};
}

function checkNoStaleParticipants(events: TraceEvent[]): ValidationCheck {
	const staleEvents = events.filter(
		(evt) => evt.type === "participant.stale" || evt.event_type === "participant_stale",
	);

	// Stale events that were later resolved (participant went active/completed)
	const resolvedParticipants = new Set<string>();
	for (const evt of events) {
		if (
			(evt.type === "participant.end" || evt.event_type === "participant_end") ||
			(evt.data?.status === "active" || evt.data?.status === "completed")
		) {
			const pid = evt.data?.participant_id ?? agentId(evt);
			if (pid) resolvedParticipants.add(pid);
		}
	}

	const unresolvedStale = staleEvents.filter((evt) => {
		const pid = evt.data?.participant_id ?? agentId(evt);
		return pid && !resolvedParticipants.has(pid);
	});

	return {
		name: "no_stale_participants",
		passed: unresolvedStale.length === 0,
		evidence: unresolvedStale.length === 0
			? "No unresolved stale participants"
			: `${unresolvedStale.length} stale participant(s) never recovered`,
		details: unresolvedStale.length > 0
			? unresolvedStale.map((e) => e.data?.participant_id ?? agentId(e)).join(", ")
			: undefined,
	};
}

// ---------------------------------------------------------------------------
// Main validator
// ---------------------------------------------------------------------------

export function validateCertificationEvidence(ctx: ValidatorContext): ValidationContract {
	const events = readTraceEvents(ctx.traceFile);
	const checks: ValidationCheck[] = [];
	const blockingReasons: string[] = [];

	// 1. Lifecycle completeness
	const lifecycle = checkLifecycleComplete(events);
	checks.push(lifecycle);
	if (!lifecycle.passed) blockingReasons.push(lifecycle.evidence);

	// 2. No operational failures
	const opFailures = checkNoOperationalFailures(events);
	checks.push(opFailures);
	if (!opFailures.passed) blockingReasons.push(opFailures.evidence);

	// 3. No empty outputs
	const emptyOutputs = checkNoEmptyOutputs(events, ctx.traceDir);
	checks.push(emptyOutputs);
	if (!emptyOutputs.passed) blockingReasons.push(emptyOutputs.evidence);

	// 4. No scope drift
	const scopeDrift = checkNoScopeDrift(events, ctx.workDir);
	checks.push(scopeDrift);
	if (!scopeDrift.passed) blockingReasons.push(scopeDrift.evidence);

	// 5. No wrong fixture access
	const wrongFixture = checkNoWrongFixture(events, ctx.workDir, ctx.expectedFixture);
	checks.push(wrongFixture);
	if (!wrongFixture.passed) blockingReasons.push(wrongFixture.evidence);

	// 6. No repo source reads (live Pi only)
	if (ctx.isLivePi) {
		const repoReads = checkNoRepoSourceReads(events, ctx.repoRoot, ctx.workDir);
		checks.push(repoReads);
		if (!repoReads.passed) blockingReasons.push(repoReads.evidence);
	}

	// 7. No worker spawns (lead-only mode, live Pi only)
	if (ctx.isLivePi) {
		const workerSpawns = checkNoWorkerSpawns(events);
		checks.push(workerSpawns);
		if (!workerSpawns.passed) blockingReasons.push(workerSpawns.evidence);
	}

	// 8. No leaked contracts
	const leakedContracts = checkNoLeakedContracts(events, ctx.traceDir);
	checks.push(leakedContracts);
	if (!leakedContracts.passed) blockingReasons.push(leakedContracts.evidence);

	// 9. Canonical artifact exists
	const canonical = checkCanonicalArtifactExists(events, ctx.traceDir);
	checks.push(canonical);
	if (!canonical.passed) blockingReasons.push(canonical.evidence);

	// 10. Team contracts valid (REVIEW_REPORT vs CERTIFICATION_CONTRACT)
	const teamContracts = checkTeamContracts(events, ctx.traceDir);
	checks.push(teamContracts);
	if (!teamContracts.passed) blockingReasons.push(teamContracts.evidence);

	// 11. No stale participants
	const stale = checkNoStaleParticipants(events);
	checks.push(stale);
	if (!stale.passed) blockingReasons.push(stale.evidence);

	// 12. Contract matches evidence
	const contractCheck = checkContractMatchesEvidence(
		canonical.contract,
		lifecycle.passed,
		!emptyOutputs.passed,
		!scopeDrift.passed,
		!opFailures.passed,
		ctx.expectedFixture,
	);
	checks.push(contractCheck);
	if (!contractCheck.passed) blockingReasons.push(contractCheck.evidence);

	// 13. Structured spawn decisions (Phase 4)
	const spawnDecisions = checkSpawnDecisions(events, ctx.strictSpawnDecisions === true);
	checks.push(spawnDecisions);
	if (!spawnDecisions.passed) blockingReasons.push(spawnDecisions.evidence);

	// 14. Steer events (Phase 5)
	const steerCheck = checkSteerEvents(events, ctx.interactiveCert === true);
	checks.push(steerCheck);
	if (!steerCheck.passed) blockingReasons.push(steerCheck.evidence);

	const allPassed = checks.every((c) => c.passed);

	return {
		schema_version: 1,
		validated: allPassed,
		evidence_complete: lifecycle.passed && canonical.passed,
		lifecycle_valid: lifecycle.passed,
		contract_matches_evidence: contractCheck.passed,
		scope_valid: scopeDrift.passed && wrongFixture.passed,
		steering_valid: steerCheck.passed,
		spawn_policy_valid: (ctx.isLivePi ? checks.find((c) => c.name === "no_worker_spawns")?.passed ?? true : true) && spawnDecisions.passed,
		blocking_reasons: blockingReasons,
		checks,
	};
}

// ---------------------------------------------------------------------------
// Format for human-readable output
// ---------------------------------------------------------------------------

export function formatValidationContract(contract: ValidationContract): string {
	const lines: string[] = [
		"VALIDATION_CONTRACT:",
		`schema_version: ${contract.schema_version}`,
		`validated: ${contract.validated}`,
		`evidence_complete: ${contract.evidence_complete}`,
		`lifecycle_valid: ${contract.lifecycle_valid}`,
		`contract_matches_evidence: ${contract.contract_matches_evidence}`,
		`scope_valid: ${contract.scope_valid}`,
		`steering_valid: ${contract.steering_valid}`,
		`spawn_policy_valid: ${contract.spawn_policy_valid}`,
		`blocking_reasons: ${contract.blocking_reasons.length === 0 ? "none" : contract.blocking_reasons.join("; ")}`,
		"",
		"checks:",
	];

	for (const check of contract.checks) {
		const icon = check.passed ? "✓" : "✗";
		lines.push(`  ${icon} ${check.name}: ${check.evidence}`);
		if (check.details) {
			lines.push(`    details: ${check.details}`);
		}
	}

	lines.push("END_VALIDATION_CONTRACT");
	return lines.join("\n");
}
