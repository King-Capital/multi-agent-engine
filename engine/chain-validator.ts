import { existsSync } from "fs";
import { join } from "path";
import {
  BASE_DIR,
  loadChains,
  loadTeams,
  loadPersona,
  resolveModel,
  resolveModelForRole,
} from "./config";
import type {
  AgentRole,
  Chain,
  ChainStep,
  ParallelTeamStep,
  TeamConfig,
  TeamMember,
  TillDoneVerifyType,
} from "./types";

type AgentKind = "lead" | "worker" | "scout" | "agent";
type ChainSuggestion = NonNullable<ChainValidationReport["suggestedChain"]>;

export interface ValidationAgent {
  name: string;
  kind: AgentKind;
  modelAlias: string;
  resolvedModel: string;
  thinking: string;
  domain: string;
}

export interface ValidationStep {
  index: number;
  title: string;
  mode: "team" | "agent" | "parallel" | "deterministic";
  team?: string;
  teams?: string[];
  command?: string;
  agents: ValidationAgent[];
  tillDone: string[];
}

export interface ChainValidationReport {
  chainName: string;
  description: string;
  goal?: string;
  suggestedChain?: { chain: string; reason: string; score: number };
  warnings: string[];
  steps: ValidationStep[];
  summary: {
    steps: number;
    teams: number;
    agents: number;
    leads: number;
    workers: number;
    deterministic: number;
    models: Record<string, number>;
    estimatedCostLow: number;
    estimatedCostHigh: number;
    unknownCostModels: string[];
  };
}

const MODEL_PRICING_PER_MILLION: Record<string, { input: number; output: number }> = {
  "opus": { input: 15, output: 75 },
  "opus-nocache": { input: 15, output: 75 },
  "claude-opus-4.6": { input: 15, output: 75 },
  "sonnet": { input: 3, output: 15 },
  "sonnet-nocache": { input: 3, output: 15 },
  "claude-sonnet-4.6": { input: 3, output: 15 },
  "gemini-3.1-pro": { input: 1.25, output: 5 },
  "pro-nocache": { input: 1.25, output: 5 },
  "gpt-5.5": { input: 2, output: 8 },
  "gpt-5.4": { input: 0.8, output: 3.2 },
  "o3-mini": { input: 1.1, output: 4.4 },
};

const TOKEN_ASSUMPTIONS: Record<AgentKind, { input: number; output: number }> = {
  lead: { input: 25_000, output: 8_000 },
  worker: { input: 18_000, output: 6_000 },
  scout: { input: 12_000, output: 3_000 },
  agent: { input: 15_000, output: 5_000 },
};

function normalizeSteps(chain: Chain): ChainStep[] {
  if (chain.steps?.length) return chain.steps;
  return [
    ...(chain.parallel?.length ? [{ parallel: chain.parallel } as ChainStep] : []),
    ...(chain.then ?? []),
  ];
}

function normalizeTillDone(items?: ChainStep["till_done"]): string[] {
  return (items ?? []).map((item) => {
    if (typeof item === "string") return item;
    const type = item.type && item.type !== ("llm_verified" as TillDoneVerifyType) ? ` [${item.type}]` : "";
    const verify = item.verify ? ` (${item.verify})` : "";
    return `${item.text}${type}${verify}`;
  });
}

function domainForMember(member: TeamMember): string {
  try {
    const persona = loadPersona(member.path);
    const write = persona.domain?.write ?? [];
    const read = persona.domain?.read ?? [];
    return write.length > 0 ? write.join(", ") : read.join(", ");
  } catch {
    return member.path;
  }
}

function resolveAgent(member: TeamMember, kind: AgentKind): ValidationAgent {
  const role: AgentRole = kind === "lead" ? "lead" : member.name.toLowerCase().includes("scout") ? "scout" : "worker";
  const resolved = resolveModelForRole(role, member.model);
  return {
    name: member.name,
    kind,
    modelAlias: member.model,
    resolvedModel: resolved.model,
    thinking: resolved.thinking,
    domain: domainForMember(member),
  };
}

function findTeam(name: string): TeamConfig | undefined {
  return loadTeams().teams.find((team) => team["team-name"] === name);
}

function allMembers(): TeamMember[] {
  const teams = loadTeams();
  return [
    teams.orchestrator,
    ...teams.teams.flatMap((team) => [team.lead, ...team.members]),
  ];
}

function resolveDirectAgent(name: string): ValidationAgent {
  const member = allMembers().find((m) => m.name === name);
  if (member) return resolveAgent(member, member.name.toLowerCase().includes("scout") ? "scout" : "agent");
  const path = `agents/personas/${name.toLowerCase().replace(/\s+/g, "-")}.md`;
  const exists = existsSync(join(BASE_DIR, path));
  const modelAlias = "main";
  return {
    name,
    kind: name.toLowerCase().includes("scout") ? "scout" : "agent",
    modelAlias,
    resolvedModel: resolveModel(modelAlias),
    thinking: "medium",
    domain: exists ? path : "(not found in teams.yaml)",
  };
}

function agentsForTeam(teamName: string): ValidationAgent[] {
  const team = findTeam(teamName);
  if (!team) {
    return [{
      name: `(missing team: ${teamName})`,
      kind: "agent",
      modelAlias: "unknown",
      resolvedModel: "unknown",
      thinking: "unknown",
      domain: "(team not found)",
    }];
  }
  return [
    resolveAgent(team.lead, "lead"),
    ...team.members.map((member) => resolveAgent(member, "worker")),
  ];
}

function describeTeamStep(index: number, step: ChainStep, teamName: string): ValidationStep {
  return {
    index,
    title: `Step ${index}: ${teamName}`,
    mode: "team",
    team: teamName,
    teams: [teamName],
    agents: agentsForTeam(teamName),
    tillDone: normalizeTillDone(step.till_done),
  };
}

function describeParallelStep(index: number, step: ChainStep, parallel: ParallelTeamStep[]): ValidationStep {
  return {
    index,
    title: `Step ${index}: Parallel teams`,
    mode: "parallel",
    teams: parallel.map((p) => p.team),
    agents: parallel.flatMap((p) => agentsForTeam(p.team)),
    tillDone: [
      ...normalizeTillDone(step.till_done),
      ...parallel.flatMap((p) => normalizeTillDone(p.till_done).map((t) => `${p.team}: ${t}`)),
    ],
  };
}

function describeStep(index: number, step: ChainStep): ValidationStep {
  if (step.team) return describeTeamStep(index, step, step.team);
  if (step.agent) {
    return {
      index,
      title: `Step ${index}: ${step.agent}`,
      mode: "agent",
      agents: [resolveDirectAgent(step.agent)],
      tillDone: normalizeTillDone(step.till_done),
    };
  }
  if (step.parallel?.length) return describeParallelStep(index, step, step.parallel);
  if (step.deterministic) {
    return {
      index,
      title: `Step ${index}: ${step.deterministic.label ?? "Deterministic check"}`,
      mode: "deterministic",
      command: step.deterministic.command,
      agents: [],
      tillDone: normalizeTillDone(step.till_done),
    };
  }
  return { index, title: `Step ${index}: Unknown`, mode: "deterministic", agents: [], tillDone: [] };
}

function costForAgent(agent: ValidationAgent): { low: number; high: number; unknown?: string } {
  const pricing = MODEL_PRICING_PER_MILLION[agent.resolvedModel] ?? MODEL_PRICING_PER_MILLION[agent.modelAlias];
  if (!pricing) return { low: 0, high: 0, unknown: agent.resolvedModel };
  const tokens = TOKEN_ASSUMPTIONS[agent.kind];
  const mid = (tokens.input * pricing.input + tokens.output * pricing.output) / 1_000_000;
  return { low: mid * 0.5, high: mid * 2 };
}

function buildContractWarnings(steps: ValidationStep[], goal?: string): string[] {
  const warnings: string[] = [];
  const goalWords = goal?.split(/\s+/).filter(Boolean) ?? [];
  const actionMatches = goal?.match(/\b(add|build|fix|implement|refactor|migrate|deploy|review|audit|test|document|create|update|harden|investigate)\b/gi) ?? [];
  const systemsMatches = goal?.match(/\b(api|dashboard|frontend|backend|database|auth|rbac|ci|cd|deploy|server|worker|agent|adapter|trace|logger|langfuse)\b/gi) ?? [];

  if (goalWords.length > 60) warnings.push("Goal is long; split into micro-tasks or a PRD/task ledger before spawning agents.");
  if (actionMatches.length > 4) warnings.push("Goal contains many action verbs; split into <=30s micro-tasks with one owner each.");
  if (new Set(systemsMatches.map((m) => m.toLowerCase())).size > 4) warnings.push("Goal spans many subsystems; use a scout/planning step to produce bounded task shards first.");

  for (const step of steps) {
    if (step.mode === "parallel" && (step.teams?.length ?? 0) > 4) {
      warnings.push(`${step.title} has high fanout (${step.teams?.length ?? 0} teams); require bounded outputs and deterministic gates.`);
    }
    if (step.agents.length > 8) {
      warnings.push(`${step.title} may spawn ${step.agents.length} agents; prefer micro-task sharding to avoid context/time blowups.`);
    }
    if (step.tillDone.some((item) => !item.includes("[output_match]") && !item.includes("[deterministic]")) && step.agents.length > 0) {
      warnings.push(`${step.title} relies on soft till_done checks; add output_match or deterministic evidence where possible.`);
    }
  }

  return [...new Set(warnings)];
}

function summarize(steps: ValidationStep[]): ChainValidationReport["summary"] {
  const agents = steps.flatMap((step) => step.agents);
  const models: Record<string, number> = {};
  let estimatedCostLow = 0;
  let estimatedCostHigh = 0;
  const unknownCostModels = new Set<string>();

  for (const agent of agents) {
    models[agent.resolvedModel] = (models[agent.resolvedModel] ?? 0) + 1;
    const cost = costForAgent(agent);
    estimatedCostLow += cost.low;
    estimatedCostHigh += cost.high;
    if (cost.unknown) unknownCostModels.add(cost.unknown);
  }

  return {
    steps: steps.length,
    teams: new Set(steps.flatMap((step) => step.teams ?? (step.team ? [step.team] : []))).size,
    agents: agents.length,
    leads: agents.filter((a) => a.kind === "lead").length,
    workers: agents.filter((a) => a.kind === "worker").length,
    deterministic: steps.filter((step) => step.mode === "deterministic").length,
    models,
    estimatedCostLow,
    estimatedCostHigh,
    unknownCostModels: [...unknownCostModels],
  };
}

export function suggestChainForGoal(goal: string): ChainSuggestion {
  const chains = loadChains().chains;
  const words = goal.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const scored = Object.entries(chains).map(([name, chain]) => {
    const haystack = `${name} ${chain.description}`.toLowerCase();
    let score = 0;
    for (const word of words) {
      if (haystack.includes(word)) score += word.length > 3 ? 2 : 1;
    }
    if (/\breview|audit|security|holes|bugs?\b/.test(goal.toLowerCase()) && /review|swarm|red|blue/.test(haystack)) score += 6;
    if (/\bbuild|fix|implement|add|change\b/.test(goal.toLowerCase()) && /build|development|sdlc/.test(haystack)) score += 6;
    if (/\bdesign|ui|css|frontend|visual\b/.test(goal.toLowerCase()) && /design/.test(haystack)) score += 8;
    if (/\bexplore|map|scout|understand\b/.test(goal.toLowerCase()) && /scout|explore/.test(haystack)) score += 5;
    return { chain: name, score };
  }).sort((a, b) => b.score - a.score || a.chain.localeCompare(b.chain));

  const best = scored[0];
  if (!best || best.score <= 0) {
    return { chain: "plan-build-review", score: 0, reason: "No strong local keyword match; defaulting to plan-build-review." };
  }
  return { chain: best.chain, score: best.score, reason: "Deterministic local match from goal text and chain descriptions." };
}

export function buildChainValidationReport(chainName: string, goal?: string): ChainValidationReport {
  const chains = loadChains().chains;
  const chain = chains[chainName];
  if (!chain) throw new Error(`Chain not found: ${chainName}`);
  const steps = normalizeSteps(chain).map((step, i) => describeStep(i + 1, step));
  return {
    chainName,
    description: chain.description,
    goal,
    warnings: buildContractWarnings(steps, goal),
    steps,
    summary: summarize(steps),
  };
}

export function resolveValidateChainInput(args: string[]): { chainName: string; goal?: string; suggestedChain?: ChainValidationReport["suggestedChain"] } {
  const chains = loadChains().chains;
  const positional = args.filter((arg) => !arg.startsWith("--"));
  const first = positional[0];
  if (!first) throw new Error("Usage: mae validate-chain <chain-name> [goal] OR mae validate-chain \"goal text\"");
  if (chains[first]) {
    return { chainName: first, goal: positional.slice(1).join(" ") || undefined };
  }
  const goal = positional.join(" ");
  const suggestedChain = suggestChainForGoal(goal);
  return { chainName: suggestedChain.chain, goal, suggestedChain };
}

export function formatChainValidationReport(report: ChainValidationReport): string {
  const lines: string[] = [];
  lines.push(`Chain: ${report.chainName} (${report.summary.steps} steps)`);
  lines.push(`Description: ${report.description}`);
  if (report.goal) lines.push(`Goal: ${report.goal}`);
  if (report.suggestedChain) {
    lines.push(`Suggested chain: ${report.suggestedChain.chain} (score ${report.suggestedChain.score}) — ${report.suggestedChain.reason}`);
  }
  if (report.warnings.length > 0) {
    lines.push("Warnings:");
    for (const warning of report.warnings) lines.push(`  - ${warning}`);
  }
  lines.push("");

  for (const step of report.steps) {
    lines.push(step.title);
    if (step.teams?.length) lines.push(`  Teams: ${step.teams.join(", ")}`);
    if (step.command) lines.push(`  Command: ${step.command}`);
    const leads = step.agents.filter((a) => a.kind === "lead");
    if (leads.length === 1) {
      const lead = leads[0]!;
      lines.push(`  Lead: ${lead.name} (${lead.resolvedModel}, thinking=${lead.thinking}) — domain: ${lead.domain || "(none)"}`);
    } else if (leads.length > 1) {
      lines.push(`  Leads:`);
      for (const lead of leads) {
        lines.push(`    - ${lead.name} (${lead.resolvedModel}, thinking=${lead.thinking}) — domain: ${lead.domain || "(none)"}`);
      }
    }
    const workers = step.agents.filter((a) => a.kind !== "lead");
    if (workers.length > 0) {
      lines.push(`  Workers:`);
      for (const worker of workers) {
        lines.push(`    - ${worker.name} (${worker.resolvedModel}, thinking=${worker.thinking}) — domain: ${worker.domain || "(none)"}`);
      }
    }
    if (step.tillDone.length > 0) {
      lines.push(`  Till Done:`);
      for (const item of step.tillDone) lines.push(`    - ${item}`);
    }
    lines.push("");
  }

  const models = Object.entries(report.summary.models)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([model, count]) => `${count} ${model}`)
    .join(", ");
  lines.push(`Summary: ${report.summary.steps} steps, ${report.summary.deterministic} deterministic checks, ${report.summary.agents} agent spawns (${report.summary.leads} leads + ${report.summary.workers} workers)`);
  lines.push(`Models: ${models || "(none)"}`);
  lines.push(`Estimated cost: $${report.summary.estimatedCostLow.toFixed(2)}-$${report.summary.estimatedCostHigh.toFixed(2)} (config-only estimate)`);
  if (report.summary.unknownCostModels.length > 0) {
    lines.push(`Unknown pricing: ${report.summary.unknownCostModels.join(", ")}`);
  }
  return lines.join("\n");
}
