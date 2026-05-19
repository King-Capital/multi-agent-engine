export interface SpawnDecisionConstraints {
  allowed_paths: string[];
  allowed_tools: string[];
  forbidden_paths: string[];
}

export interface SpawnDecision {
  need_worker: boolean;
  worker_name?: string;
  spawn_type: "worker" | "sr";
  reason: string;
  why_lead_cannot_do_it: string;
  constraints: SpawnDecisionConstraints;
  bus_policy: "isolated" | "main_bus";
  expected_output_schema: string;
  timeout_seconds: number;
}

export interface SpawnDecisionValidation {
  valid: boolean;
  errors: string[];
}

const START = "SPAWN_DECISION:";
const END = "END_SPAWN_DECISION";

function normalizeList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  if (/^true$/i.test(value.trim())) return true;
  if (/^false$/i.test(value.trim())) return false;
  return undefined;
}

function coerceDecision(raw: Record<string, unknown>): SpawnDecision | null {
  const constraints = raw.constraints && typeof raw.constraints === "object"
    ? raw.constraints as Record<string, unknown>
    : raw;
  const needWorker = parseBoolean(raw.need_worker);
  const timeout = Number(raw.timeout_seconds ?? raw.timeout);
  const spawnType = String(raw.spawn_type ?? "worker").trim();
  const busPolicy = String(raw.bus_policy ?? "").trim();

  if (needWorker === undefined) return null;

  return {
    need_worker: needWorker,
    worker_name: typeof raw.worker_name === "string" ? raw.worker_name.trim() : undefined,
    spawn_type: spawnType === "sr" ? "sr" : "worker",
    reason: String(raw.reason ?? "").trim(),
    why_lead_cannot_do_it: String(raw.why_lead_cannot_do_it ?? "").trim(),
    constraints: {
      allowed_paths: normalizeList(constraints.allowed_paths),
      allowed_tools: normalizeList(constraints.allowed_tools),
      forbidden_paths: normalizeList(constraints.forbidden_paths),
    },
    bus_policy: busPolicy === "main_bus" ? "main_bus" : "isolated",
    expected_output_schema: String(raw.expected_output_schema ?? "").trim(),
    timeout_seconds: Number.isFinite(timeout) ? timeout : 0,
  };
}

function parseYamlish(block: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const constraints: Record<string, unknown> = {};
  let inConstraints = false;

  for (const line of block.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed === "constraints:") {
      inConstraints = true;
      continue;
    }
    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;
    const key = trimmed.slice(0, colon).trim();
    const value = trimmed.slice(colon + 1).trim();
    if (inConstraints && ["allowed_paths", "allowed_tools", "forbidden_paths"].includes(key)) {
      constraints[key] = value;
      continue;
    }
    inConstraints = false;
    result[key] = value;
  }

  if (Object.keys(constraints).length > 0) result.constraints = constraints;
  return result;
}

export function parseSpawnDecisions(output: string): SpawnDecision[] {
  const decisions: SpawnDecision[] = [];
  let searchFrom = 0;

  while (searchFrom < output.length) {
    const start = output.indexOf(START, searchFrom);
    if (start === -1) break;
    const end = output.indexOf(END, start);
    if (end === -1) break;
    const block = output.slice(start + START.length, end).trim();
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(block) as Record<string, unknown>;
    } catch {
      raw = parseYamlish(block);
    }
    const decision = coerceDecision(raw);
    if (decision) decisions.push(decision);
    searchFrom = end + END.length;
  }

  return decisions;
}

export function validateSpawnDecision(decision: SpawnDecision): SpawnDecisionValidation {
  const errors: string[] = [];
  if (decision.need_worker) {
    if (!decision.worker_name) errors.push("worker_name is required when need_worker is true");
    if (!decision.reason) errors.push("reason is required");
    if (!decision.why_lead_cannot_do_it) errors.push("why_lead_cannot_do_it is required");
    if (decision.constraints.allowed_paths.length === 0) errors.push("constraints.allowed_paths is required");
    if (decision.constraints.allowed_tools.length === 0) errors.push("constraints.allowed_tools is required");
    if (decision.constraints.forbidden_paths.length === 0) errors.push("constraints.forbidden_paths is required");
    if (!decision.expected_output_schema) errors.push("expected_output_schema is required");
    if (!Number.isFinite(decision.timeout_seconds) || decision.timeout_seconds <= 0) errors.push("timeout_seconds must be positive");
    if (decision.bus_policy === "main_bus") errors.push("bus_policy main_bus is reserved for v2.1 sub-bus work");
  }
  return { valid: errors.length === 0, errors };
}

export function findSpawnDecisionForWorker(decisions: SpawnDecision[], workerName: string): SpawnDecision | undefined {
  const wanted = workerName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return decisions.find((decision) => {
    const name = decision.worker_name?.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    return decision.need_worker && name === wanted;
  });
}

export function isSpawnDecisionStrictMode(): boolean {
  return process.env.MAE_SPAWN_DECISION_STRICT === "1" || process.env.MAE_STANDARD_SWARM_V2_STRICT === "1";
}

export function buildSpawnDecisionInstructions(members: { name: string; consultWhen?: string }[]): string {
  const roster = members.map((member) => `- ${member.name}: ${member.consultWhen ?? "general tasks"}`).join("\n");
  return [
    "Before any worker can run, emit one SPAWN_DECISION block per worker you need.",
    "If no worker is needed, emit one block with need_worker: false.",
    "Each worker decision must be scoped and machine-readable:",
    "SPAWN_DECISION:",
    "need_worker: true",
    "worker_name: <exact worker name>",
    "spawn_type: worker",
    "reason: <specific reason this specialist is needed>",
    "why_lead_cannot_do_it: <specific limitation>",
    "constraints:",
    "  allowed_paths: <comma-separated paths/globs>",
    "  allowed_tools: <comma-separated tools>",
    "  forbidden_paths: <comma-separated paths/globs>",
    "bus_policy: isolated",
    "expected_output_schema: <required final schema>",
    "timeout_seconds: <positive integer>",
    "END_SPAWN_DECISION",
    "",
    "Available workers:",
    roster,
  ].join("\n");
}

export function buildWorkerPromptFromDecision(decision: SpawnDecision, task: string): string {
  return [
    `Your assignment from SPAWN_DECISION for ${decision.worker_name}:`,
    `Reason: ${decision.reason}`,
    `Why the lead cannot do it: ${decision.why_lead_cannot_do_it}`,
    `Scope: ${decision.constraints.allowed_paths.join(", ")}`,
    `Allowed tools: ${decision.constraints.allowed_tools.join(", ")}`,
    `Forbidden paths: ${decision.constraints.forbidden_paths.join(", ")}`,
    `Communication bus policy: ${decision.bus_policy}`,
    `Timeout seconds: ${decision.timeout_seconds}`,
    "",
    "Expected output schema:",
    decision.expected_output_schema,
    "",
    `Original task: ${task}`,
  ].join("\n");
}
