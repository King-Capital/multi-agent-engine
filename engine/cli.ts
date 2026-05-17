#!/usr/bin/env bun
import { Orchestrator } from "./orchestrator";
import { EchoAdapter } from "./adapters/echo";
import { PiAdapter } from "./adapters/pi";
import { A2AAdapter } from "./adapters/a2a";
import { loadChains, loadModelRouting, BASE_DIR } from "./config";
import { configShow, configExport, configImport, configDiscover, configInteractive } from "./config-cli";
import { teamWizard } from "./team-wizard";
import { expertiseLearn } from "./expertise-builder";
import { expertiseValidate } from "./expertise-validator";
import { expertSession } from "./expert-session";
import { readFileSync as readFile, writeFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";
import { getFlag, stripFlags, slugify } from "./cli-utils";
import { classifyGoal } from "./goal-classifier";
import { startDesignGallery } from "./design-gallery";
import { loadFileReferences, loadUrlReferences, scanProjectDesign } from "./reference-loader";
import { TRACE_DIR } from "./trace-recorder";
import { loadTrace, scoreSession, extractFingerprint, compareFingerprints, getGoldenTraces } from "./replay";
import { runRalphLoop } from "./ralph-loop";
import { handleGoldenCommand } from "./cli-commands-golden";
import { handleLangfuseCommand, handleRalphCommand } from "./cli-commands-ralph";
import { runHealthCheck, formatHealthReport } from "./health";
import { buildChainValidationReport, formatChainValidationReport, resolveValidateChainInput } from "./chain-validator";
import * as p from "@clack/prompts";

const args = process.argv.slice(2);
const wantsRootHelp = args.length === 0 || args[0] === "--help" || args[0] === "-h";

function configuredChains(): string[] {
  try {
    return Object.keys(loadChains().chains);
  } catch {
    return [];
  }
}

function configuredPrompts(): string[] {
  try {
    return readdirSync(join(import.meta.dir, "..", "prompts"))
      .filter((f: string) => f.endsWith(".md") && f !== "BASE.md")
      .map((f: string) => f.replace(".md", ""))
      .sort();
  } catch {
    return [];
  }
}

function pickConfigured(preferred: string[], actual: string[], fallback: string): string {
  return preferred.find(name => actual.includes(name)) ?? actual[0] ?? fallback;
}

function chainExample(preferred: string[], task: string, fallback: string): string {
  return `mae chain ${pickConfigured(preferred, configuredChains(), fallback)} "${task}"`;
}

function promptExample(preferred: string[], task: string, fallback: string): string {
  return `mae run ${pickConfigured(preferred, configuredPrompts(), fallback)} "${task}"`;
}

function buildMainHelpExamples() {
  const chains = configuredChains();
  const prompts = configuredPrompts();
  const reviewChain = pickConfigured(["review-only", "standard-swarm", "swarm-review"], chains, "review-only");
  const hasDesignReview = chains.includes("design-review");
  const hasDesignBuild = chains.includes("design-build");
  return {
    taskWithChain: `mae task "Review engine/orchestrator.ts" --chain ${reviewChain}`,
    chainPrimary: `mae chain ${pickConfigured(["standard-swarm", "swarm-review", "red-blue"], chains, "standard-swarm")} "Find release blockers in the dashboard"`,
    chainSecondary: `mae chain ${pickConfigured(["plan-build-review", "build-verify", "full-sdlc"], chains, "plan-build-review")} "Add cost summary to session detail"`,
    promptPrimary: `mae run ${pickConfigured(["review", "swarm-review", "plan-build-review"], prompts, "review")} "git diff HEAD~1"`,
    promptSecondary: `mae run ${pickConfigured(["swarm-review", "review", "scout"], prompts, "swarm-review")} "Review engine/ for bugs"`,
    designReview: hasDesignReview ? "mae design review ./dashboard-next --ref screenshot.png" : "mae design ./dashboard-next --ref screenshot.png",
    designBuild: hasDesignBuild ? "mae design build ./dashboard-next --port 8401" : "mae design ./dashboard-next --port 8401",
    validateStandard: `mae validate-chain ${pickConfigured(["standard-swarm", "swarm-review", "review-only"], chains, "standard-swarm")}`,
    validateGoal: `mae validate-chain "Design dashboard UI review"`,
  };
}

const subHelp = args[1] === "--help" || args[1] === "-h";

function showSubHelp(text: string): never {
  console.log(text);
  process.exit(0);
}

function maeVersion(): string {
  try {
    return readFile(join(BASE_DIR, "VERSION"), "utf-8").trim();
  } catch {
    return "?";
  }
}

type HelpSection = "work" | "operate" | "inspect" | "build" | "configure";

function sectionForCommand(command: string | undefined): HelpSection | null {
  switch (command) {
    case "work":
      return "work";
    case "operate":
      return "operate";
    case "inspect":
    case "verify":
      return "inspect";
    case "build":
      return "build";
    case "configure":
    case "diagnose":
      return "configure";
    default:
      return null;
  }
}

function showMainHelp(): never {
  console.log(`
Multi-Agent Orchestration Engine v${maeVersion()}

Sections:
  work       Run tasks, named chains, and prompt workflows
  operate    Manage dashboard sessions and design runs
  inspect    Read traces, score/replay runs, and validate chains
  build      Create teams, agents, expertise, and improvement loops
  configure  Configure models, check health, and inspect adapters

Start here:
  mae work
  mae build
  mae inspect
  mae tui

Run 'mae <section>' or 'mae <command> --help' for examples.
`);
  process.exit(0);
}

function showSectionHelp(section: HelpSection): never {
  const examples = buildMainHelpExamples();
  const sections: Record<HelpSection, string> = {
    work: `
mae work — Run agent work

Commands:
  task    Auto-pick a chain and run a task
  chain   Run a named chain directly
  run     Run a prompt workflow

Examples:
  mae task "Fix the login redirect bug"
  ${examples.taskWithChain}
  ${examples.chainPrimary}
  ${examples.chainSecondary}
  ${examples.promptPrimary}
  ${examples.promptSecondary}

More:
  mae task --help
  mae chain --help
  mae run --help
`,
    operate: `
mae operate — Manage active work

Commands:
  session  List or close dashboard sessions
  design   Run a design review/build flow with a gallery

Examples:
  mae session list
  mae session close 2dbc90f5 --status error
  ${examples.designReview}
  ${examples.designBuild}

More:
  mae session --help
  mae design --help
`,
    inspect: `
mae inspect — Inspect and verify runs

Commands:
  traces          List or inspect local JSONL traces
  score           Score a session trace
  compare         Compare two session fingerprints
  replay          Re-run a past session goal and compare behavior
  validate-chain  Preview configured chain agents, teams, checks, and cost
  golden          Manage golden reference traces

Examples:
  mae traces
  mae traces 2dbc90f5
  mae score 2dbc90f5
  mae compare 2dbc90f5 8fa2c1b3
  mae replay 2dbc90f5 --dry-run
  ${examples.validateStandard}
  ${examples.validateGoal}
  mae golden add 2dbc90f5 --verdict pass --notes "good swarm"
  mae golden list

More:
  mae validate-chain --help
  mae golden --help
`,
    build: `
mae build — Build the agent system

Commands:
  new-team        Create a new agent team
  new-agent       Scaffold one persona
  learn           Build expertise from sources
  expert          Interactive expert session
  validate-agent  Test expertise quality
  ralph           Self-improvement loop

Examples:
  mae new-team
  mae new-team --template frontend
  mae new-agent "API Reviewer" lead Engineering quality
  mae learn --from ./engine --agent api-reviewer
  mae expert ./engine --agent api-reviewer
  mae validate-agent api-reviewer
  mae ralph --dry-run --iterations 3

More:
  mae new-team --help
  mae learn --help
  mae ralph --help
`,
    configure: `
mae configure — Configure and diagnose

Commands:
  config    Configure models, aliases, roles, and budgets
  tui       Full interactive launcher
  health    Probe adapters, traces, dashboard, and Langfuse
  langfuse  Configure Langfuse scores and LiteLLM judge models
  info      Full system overview
  adapters  List adapter availability
  discover  Discover an A2A agent card
  version   Show local binary and config counts
  update    Pull, build, and install the local mae binary

Examples:
  mae config
  mae config show
  mae tui
  mae health
  mae health --json
  mae langfuse setup --dry-run
  mae info
  mae adapters
  mae discover http://localhost:9000
  mae version
  mae update

More:
  mae config --help
  mae health --help
  mae langfuse --help
`,
  };

  console.log(sections[section]);
  process.exit(0);
}

const command = args[0];
if (wantsRootHelp) showMainHelp();

const helpSection = sectionForCommand(command);
if (helpSection) showSectionHelp(helpSection);

if (command === "tui" && subHelp) showSubHelp(`
mae tui — Full interactive launcher

Usage:
  mae tui

Use arrow-key menus to run work, operate sessions, inspect traces,
build agent assets, and configure or diagnose the engine.
`);

const isLocal = args.includes("--local") || process.env.MAE_LOCAL === "1";
const dashboardUrl = isLocal ? "http://localhost:8400" : (getFlag(args, "--dashboard") ?? process.env.MAE_DASHBOARD_URL ?? "http://localhost:8400");
const adapterName = getFlag(args, "--adapter");
const workingDir = resolve(getFlag(args, "--cwd") ?? process.cwd());
const dryRun = args.includes("--dry-run");

// A2A configuration
const a2aUrl = getFlag(args, "--a2a-url") ?? process.env.MAE_A2A_URL;
const a2aToken = getFlag(args, "--a2a-token") ?? process.env.MAE_A2A_TOKEN;

const apiToken = getFlag(args, "--api-token") ?? process.env.MAE_API_TOKEN;

type CliRuntime = {
  orch: Orchestrator;
  adapters: Array<EchoAdapter | PiAdapter | A2AAdapter>;
  a2aAdapter: A2AAdapter;
};

let runtime: CliRuntime | null = null;

function createA2AAdapter(): A2AAdapter {
  const a2aAdapter = new A2AAdapter();
  if (a2aUrl) {
    a2aAdapter.setDefaultEndpoint({
      url: a2aUrl,
      token: a2aToken,
    });
  }
  return a2aAdapter;
}

function createAdapters(): { adapters: Array<EchoAdapter | PiAdapter | A2AAdapter>; a2aAdapter: A2AAdapter } {
  const a2aAdapter = createA2AAdapter();
  const adapters: Array<EchoAdapter | PiAdapter | A2AAdapter> = [
    new EchoAdapter(),
    new PiAdapter(),
  ];
  if (a2aUrl) {
    adapters.push(a2aAdapter);
  }
  return {
    a2aAdapter,
    adapters,
  };
}

async function ensureRuntime(opts: { announceAdapter?: boolean } = {}): Promise<CliRuntime> {
  if (runtime) return runtime;

  const orch = new Orchestrator(dashboardUrl, apiToken);
  const { adapters, a2aAdapter } = createAdapters();

  for (const adapter of adapters) {
    orch.registerAdapter(adapter);
  }

  if (dryRun) {
    orch.setDefaultAdapter("echo");
  } else if (adapterName) {
    const requested = adapters.find((adapter) => adapter.name === adapterName);
    if (!requested) {
      throw new Error(`Adapter not registered: ${adapterName}. Available: ${adapters.map((adapter) => adapter.name).join(", ")}`);
    }
    if (adapterName !== "echo" && !await requested.isAvailable()) {
      throw new Error(`Adapter '${adapterName}' is not available. Install/configure it first, or use --dry-run for echo mode.`);
    }
    orch.setDefaultAdapter(adapterName);
  } else {
    let selected = false;
    for (const adapter of adapters) {
      if (adapter.name !== "echo" && await adapter.isAvailable()) {
        orch.setDefaultAdapter(adapter.name);
        if (opts.announceAdapter) console.log(`[cli] Using adapter: ${adapter.name}`);
        selected = true;
        break;
      }
    }
    if (!selected) {
      throw new Error("No real adapter available. Install Pi, configure MAE_A2A_URL, choose --adapter a2a with an endpoint, or use --dry-run for echo mode.");
    }
  }

  runtime = { orch, adapters, a2aAdapter };
  return runtime;
}

// Graceful shutdown handler
let shuttingDown = false;
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[cli] Received ${sig}, shutting down gracefully...`);
    (runtime?.orch.shutdown() ?? Promise.resolve()).then(() => process.exit(0)).catch(() => process.exit(1));
    setTimeout(() => { console.error("[cli] Shutdown timed out, forcing exit"); process.exit(1); }, 10_000);
  });
}

switch (command) {
	  case "run": {
	    if (subHelp) {
	      const promptList = configuredPrompts();
	      showSubHelp(`
	mae run — Run a prompt workflow

	Usage: mae run <prompt-name> [args...]

	Prompts:  ${promptList.length > 0 ? promptList.join(", ") : "plan-build-review, review, scout, swarm-review, ..."}

	Options:
	  --adapter <name>     Use specific adapter (pi, a2a, echo)
  --dry-run            Use echo adapter for testing
  --cwd <path>         Working directory for agents

	Examples:
	  ${promptExample(["plan-build-review", "build", "review"], "Add input validation to auth", "plan-build-review")}
	  ${promptExample(["review", "swarm-review", "plan-build-review"], "git diff HEAD~1", "review")}
	  ${promptExample(["swarm-review", "review", "standard-swarm"], "Review engine/ for bugs", "swarm-review")}
	  ${promptExample(["scout", "plan-build-review", "review"], "engine/", "scout")}
	`);
	    }
    const promptName = args[1];
	    if (!promptName) {
	      console.error("Usage: mae run <prompt-name> [args...]\nRun 'mae run --help' for available prompts.");
	      process.exit(1);
	    }
    if (!configuredPrompts().includes(promptName) && configuredChains().includes(promptName)) {
      console.error(`"${promptName}" is a chain, not a prompt workflow.`);
      console.error(`Use: mae chain ${promptName} <task>`);
      console.error("Run 'mae chain --help' for available chains or 'mae run --help' for prompt workflows.");
      process.exit(1);
    }
	    const promptArgs = stripFlags(args.slice(2));
	    const { orch } = await ensureRuntime({ announceAdapter: true });
	    const session = await orch.run({
	      prompt: promptName,
	      task: promptArgs.join(" "),
      args: promptArgs,
      adapter: dryRun ? "echo" : adapterName,
      workingDir,
    });
    console.log(`\nSession ${session.id} ${session.status}. Cost: $${session.totalCost.toFixed(3)}`);
    process.exit(session.status === "completed" ? 0 : 1);
  }

  case "chain": {
    if (subHelp) {
      const chainsFile = loadChains();
      const chainList = Object.entries(chainsFile.chains).map(([name, c]) =>
        `  ${name.padEnd(22)} ${(c.steps?.length ?? 0)} steps  ${c.description}`).join("\n");
      showSubHelp(`
mae chain — Run a named chain

Usage: mae chain <chain-name> <task>

Chains:
${chainList}

Options:
  --adapter <name>     Use specific adapter
  --dry-run            Use echo adapter for testing
  --cwd <path>         Working directory for agents

	Examples:
	  ${chainExample(["build-verify", "plan-build-review", "full-sdlc"], "Fix the login bug", "build-verify")}
	  ${chainExample(["review-only", "standard-swarm", "swarm-review"], "Review auth module", "review-only")}
	  ${chainExample(["plan-build-review", "build-verify", "full-sdlc"], "Add caching layer", "plan-build-review")}
	`);
    }
    const chainName = args[1];
    const task = stripFlags(args.slice(2)).join(" ");
	    if (!chainName || !task) {
	      console.error("Usage: mae chain <chain-name> <task>\nRun 'mae chain --help' for available chains.");
	      process.exit(1);
	    }
	    const { orch } = await ensureRuntime({ announceAdapter: true });
	    const session = await orch.run({
	      chain: chainName,
	      task,
      adapter: dryRun ? "echo" : adapterName,
      workingDir,
    });
    console.log(`\nSession ${session.id} ${session.status}. Cost: $${session.totalCost.toFixed(3)}`);
    process.exit(session.status === "completed" ? 0 : 1);
  }

  case "task": {
    if (subHelp) showSubHelp(`
mae task — Quick task with auto-classified or explicit chain

Usage: mae task <task-description>

Auto-selects the best chain for the task, or use --chain to override.

Options:
  --chain <name>       Use a specific chain (skip auto-classification)
  --adapter <name>     Use specific adapter
  --dry-run            Use echo adapter for testing
  --cwd <path>         Working directory for agents

Examples:
	  mae task "Add rate limiting to API endpoints"
	  mae task "Fix the auth bug in login.ts"
	  mae task "Review auth module for security" --chain ${pickConfigured(["review-only", "standard-swarm", "swarm-review"], configuredChains(), "review-only")}
	  mae task "Add unit tests for budget module" --dry-run
	`);
    const explicitChain = getFlag(args, "--chain");
    const task = stripFlags(args.slice(1)).join(" ");
    if (!task) {
      console.error("Usage: mae task <task-description>\nRun 'mae task --help' for details.");
      process.exit(1);
    }

    let chainName: string | undefined = explicitChain;
    if (!chainName) {
      const result = await classifyGoal(task);
      if (result.confidence >= 0.8) {
        console.log(`[cli] Auto-selected chain: ${result.chain} (confidence: ${result.confidence.toFixed(2)}) — ${result.reasoning}`);
        chainName = result.chain;
      } else {
        console.log(`[cli] Suggested chain: ${result.chain} (confidence: ${result.confidence.toFixed(2)}) — ${result.reasoning}`);
        console.log(`[cli] Low confidence — using default: plan-build-review. Override with --chain <name>`);
        chainName = "plan-build-review";
	      }
	    }

	    const { orch } = await ensureRuntime({ announceAdapter: true });
	    const session = await orch.run({
	      chain: chainName,
	      task,
      adapter: dryRun ? "echo" : adapterName,
      workingDir,
    });
    console.log(`\nSession ${session.id} ${session.status}. Cost: $${session.totalCost.toFixed(3)}`);
    process.exit(session.status === "completed" ? 0 : 1);
  }

  case "discover": {
    const url = args[1];
	    if (!url) {
	      console.error("Usage: mae discover <url>");
	      process.exit(1);
	    }
	    const a2aAdapter = createA2AAdapter();
	    const card = await a2aAdapter.discover(url, a2aToken);
    if (card) {
      console.log(`\nDiscovered A2A agent:`);
      console.log(`  Name: ${card.name}`);
      console.log(`  URL: ${card.url}`);
      console.log(`  Version: ${card.version ?? "unknown"}`);
      console.log(`  Protocol: ${card.protocolVersion ?? "unknown"}`);
      if (card.skills?.length) {
        console.log(`  Skills:`);
        for (const skill of card.skills) {
          console.log(`    - ${skill.name}: ${skill.description ?? ""}`);
        }
      }
      console.log(`  Streaming: ${card.capabilities?.streaming !== false ? "yes" : "no"}`);
    } else {
      console.error(`Could not discover agent at ${url}`);
      process.exit(1);
    }
    break;
  }

  case "session": {
    if (subHelp) showSubHelp(`
mae session — Manage sessions

Usage:
  mae session list                          List all sessions
  mae session show [latest|<id>]            Summarize one dashboard run
  mae session close <id> [--status done]    Close/complete a session

Status options: done, completed, error

Examples:
  mae session list
  mae session show latest
  mae session show 2dbc90f5 --messages 20
  mae session close 2dbc90f5
  mae session close 2dbc90f5 --status error
`);
    const subCmd = args[1];
    const dashUrl = dashboardUrl;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiToken) headers["Authorization"] = `Bearer ${apiToken}`;

    if (subCmd === "list") {
      const resp = await fetch(`${dashUrl}/api/sessions`, { headers });
      if (!resp.ok) { console.error(`Dashboard error: ${resp.status}`); process.exit(1); }
      const sessions = await resp.json() as Array<{ id: string; name: string; status: string; started_at: string; total_cost: number; agents: Record<string, unknown> }>;
      sessions.sort((a, b) => b.started_at.localeCompare(a.started_at));
      console.log(`\n${"ID".padEnd(14)} ${"Status".padEnd(12)} ${"Agents".padEnd(8)} ${"Cost".padEnd(10)} Name`);
      console.log("─".repeat(80));
      for (const s of sessions) {
        const agentCount = Object.keys(s.agents ?? {}).length;
        console.log(`${s.id.slice(0, 12)}  ${s.status.padEnd(12)} ${String(agentCount).padEnd(8)} $${s.total_cost.toFixed(3).padEnd(9)} ${(s.name ?? "").slice(0, 50)}`);
      }
      console.log(`\n${sessions.length} sessions total`);
    } else if (subCmd === "show" || subCmd === "latest") {
      const target = subCmd === "latest" ? "latest" : (args[2] ?? "latest");
      const messageLimit = Number(getFlag(args, "--messages") ?? "12");
      const eventLimit = Number(getFlag(args, "--events") ?? "20");
      const resolveResp = target === "latest"
        ? await fetch(`${dashUrl}/api/pg/sessions?limit=1`, { headers })
        : await fetch(`${dashUrl}/api/pg/sessions/${encodeURIComponent(target)}`, { headers });
      if (!resolveResp.ok) { console.error(`Dashboard error: ${resolveResp.status} ${await resolveResp.text()}`); process.exit(1); }
      const resolved = await resolveResp.json() as unknown;
      const session = Array.isArray(resolved) ? resolved[0] : resolved;
      if (!session || typeof session !== "object") { console.error("No session found"); process.exit(1); }
      const s = session as { id: string; name?: string; status?: string; chain?: string | null; created_at?: string; updated_at?: string; completed_at?: string | null };
      const eventsResp = await fetch(`${dashUrl}/api/pg/sessions/${encodeURIComponent(s.id)}/events`, { headers });
      if (!eventsResp.ok) { console.error(`Events error: ${eventsResp.status} ${await eventsResp.text()}`); process.exit(1); }
      const events = await eventsResp.json() as Array<{ id?: number; created_at?: string; event_type: string; agent_id?: string | null; payload?: Record<string, unknown> | null }>;
      const byType = new Map<string, number>();
      for (const ev of events) byType.set(ev.event_type, (byType.get(ev.event_type) ?? 0) + 1);
      const messages = events.filter(ev => ev.event_type === "message");
      const steerMessages = messages.filter(ev => {
        const payload = ev.payload as { data?: { from?: string; ack_for?: string } } | null | undefined;
        const from = String(payload?.data?.from ?? ev.agent_id ?? "").toLowerCase();
        return ev.agent_id === "user" || from === "user" || Boolean(payload?.data?.ack_for);
      });
      const synthesis = messages.filter(ev => String(ev.agent_id ?? "").toLowerCase().includes("synth"));
      const interestingTail = events.filter(ev => ["message", "error", "stall_detected", "nudge_sent", "agent_done"].includes(ev.event_type)).slice(-eventLimit);
      const preview = (ev: { payload?: Record<string, unknown> | null }) => {
        const data = (ev.payload?.data ?? {}) as Record<string, unknown>;
        const text = String(data.content ?? data.error_msg ?? data.status ?? data.grade ?? data.ack_for ?? "");
        return text.replace(/\s+/g, " ").slice(0, 220);
      };

      console.log(`\nSession ${s.id}`);
      console.log(`  Name: ${s.name ?? ""}`);
      console.log(`  Status: ${s.status ?? "unknown"}${s.chain ? ` · Chain: ${s.chain}` : ""}`);
      console.log(`  Created: ${s.created_at ?? "?"}`);
      console.log(`  Updated: ${s.updated_at ?? "?"}${s.completed_at ? ` · Completed: ${s.completed_at}` : ""}`);
      console.log(`\nEvents: ${events.length}`);
      console.log([...byType.entries()].sort((a, b) => b[1] - a[1]).map(([type, count]) => `  ${type}: ${count}`).join("\n"));
      console.log(`\nSteer messages (${steerMessages.length}, showing ${Math.min(messageLimit, steerMessages.length)}):`);
      for (const ev of steerMessages.slice(-messageLimit)) {
        const data = (ev.payload?.data ?? {}) as Record<string, unknown>;
        console.log(`  ${ev.created_at ?? ""} ${data.from ?? ev.agent_id ?? "?"} → ${data.to ?? "?"}: ${preview(ev)}`);
      }
      console.log(`\nSynthesis messages (${synthesis.length}, showing ${Math.min(3, synthesis.length)}):`);
      for (const ev of synthesis.slice(-3)) console.log(`  ${ev.created_at ?? ""} ${preview(ev)}`);
      console.log(`\nRecent interesting events:`);
      for (const ev of interestingTail) console.log(`  ${ev.created_at ?? ""} ${ev.event_type.padEnd(14)} ${(ev.agent_id ?? "").slice(0, 32).padEnd(32)} ${preview(ev)}`);
    } else if (subCmd === "close") {
      const sessionId = args[2];
      if (!sessionId) { console.error("Usage: mae session close <id> [--status done|error]"); process.exit(1); }
      const rawStatus = getFlag(args, "--status") ?? "completed";
      const status = rawStatus === "done" ? "completed" : rawStatus;
      if (status !== "completed" && status !== "error") {
        console.error("--status must be completed, done, or error"); process.exit(1);
      }
      const resp = await fetch(`${dashUrl}/api/sessions/${sessionId}/status`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ status }),
      });
      if (!resp.ok) { console.error(`Failed: ${resp.status} ${await resp.text()}`); process.exit(1); }
      console.log(`Session ${sessionId} → ${status}`);
    } else {
      console.error("Usage: mae session <list|show|latest|close>");
      process.exit(1);
    }
    break;
  }

  case "new-agent": {
    await scaffoldAgent(args.slice(1));
    break;
  }

  case "new-team": {
    if (subHelp) showSubHelp(`
mae new-team — Create a new agent team

Usage:
  mae new-team                    Interactive wizard
  mae new-team --template <name>  Create from template

Templates: trading, devops, frontend, research

The wizard walks through team name, color, members, roles, and
optionally generates a starter chain. All persona and expertise
files are scaffolded automatically.
`);
    await teamWizard(args.slice(1));
    break;
  }

  case "learn": {
    if (subHelp) showSubHelp(`
mae learn — Build agent expertise from reference sources

Usage:
  mae learn --from <path>       --agent <name>   Learn from codebase
  mae learn --from <url>        --agent <name>   Learn from URL/document
  mae learn --from-agent <src>  --agent <name>   Copy structure from existing agent

Scans the source, extracts patterns and conventions, and generates
structured expertise in agents/expertise/<name>.md.
`);
    await expertiseLearn(args.slice(1));
    break;
  }

  case "validate-agent": {
    if (subHelp) showSubHelp(`
mae validate-agent — Test agent expertise quality

Usage: mae validate-agent <name>

Runs the agent on a test prompt, grades specificity/depth/actionability,
and suggests improvements to the expertise file.
`);
    await expertiseValidate(args.slice(1));
    break;
  }

  case "expert": {
    if (subHelp) showSubHelp(`
mae expert — Interactive expert session on a codebase

Usage:
  mae expert <path>                Drop into expert session
  mae expert <path> --agent <name> Use existing agent's expertise

Auto-learns the codebase if no expertise exists, then starts an
interactive REPL where you can ask questions and get implementations
from an agent that deeply understands the code.
`);
    await expertSession(args.slice(1));
    break;
  }

	  case "design": {
	    if (subHelp) {
	      const chains = configuredChains();
	      const reviewExample = chains.includes("design-review")
	        ? "mae design review ./my-app --ref screenshot.png --url https://example.com"
	        : "mae design ./my-app --ref screenshot.png --url https://example.com";
	      const buildExample = chains.includes("design-build")
	        ? "mae design build ./dashboard-next --ref brand-guide.pdf"
	        : "mae design ./dashboard-next --ref brand-guide.pdf";
	      showSubHelp(`
	mae design — Design session or design review

	Usage:
	  mae design <project-path>                  Start interactive design session
  mae design review <project-path>           Run design-review chain
  mae design build <project-path>            Run design-build chain (design → implement → validate)

Options:
  --ref <path>         Add file reference (screenshot, mockup, CSS)
  --url <url>          Add URL reference (fetch and extract design patterns)
  --no-scan            Skip automatic project design system scan
  --port <port>        Design gallery port (default: 8401)
  --adapter <name>     Use specific adapter
  --dry-run            Use echo adapter for testing
  --cwd <path>         Working directory for agents

	Examples:
	  mae design ./my-app
	  ${reviewExample}
	  ${buildExample}
	`);
	    }
    const sub = args[1]?.startsWith("--") ? undefined : args[1];
    const isReview = sub === "review";
    const isBuild = sub === "build";
    const projectPath = resolve(isReview || isBuild ? (args[2] ?? ".") : (sub ?? "."));
    const galleryPort = parseInt(getFlag(args, "--port") ?? "8401", 10);
    const skipScan = args.includes("--no-scan");

    const refPaths: string[] = [];
    const refUrls: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--ref" && args[i + 1]) refPaths.push(resolve(args[i + 1]!));
      if (args[i] === "--url" && args[i + 1]) refUrls.push(args[i + 1]!);
    }

    console.log(`[design] Loading references...`);
    const refs = [
      ...(refPaths.length > 0 ? loadFileReferences(refPaths) : []),
      ...(refUrls.length > 0 ? await loadUrlReferences(refUrls) : []),
      ...(!skipScan ? await scanProjectDesign(projectPath) : []),
    ];

    if (refs.length > 0) {
      console.log(`[design] Loaded ${refs.length} reference(s): ${refs.map(r => r.name).join(", ")}`);
    }

    const outputDir = join(projectPath, "design-output");
    const gallery = startDesignGallery(outputDir, galleryPort);

    const referenceContext = refs.length > 0
      ? `\n\nDesign References:\n${refs.map(r => `--- ${r.source}: ${r.name} ---\n${r.content}`).join("\n\n")}`
      : "";

	    try {
	      if (isReview || isBuild) {
	        const chainName = isBuild ? "design-build" : "design-review";
	        const task = `Review and improve the UI design of the project at ${projectPath}. Output design variants as self-contained HTML files to ${outputDir}/${referenceContext}`;
	        const { orch } = await ensureRuntime({ announceAdapter: true });
	        const session = await orch.run({
	          chain: chainName,
	          task,
          adapter: dryRun ? "echo" : adapterName,
          workingDir: projectPath,
        });
        console.log(`\nSession ${session.id} ${session.status}. Cost: $${session.totalCost.toFixed(3)}`);
	        console.log(`Gallery: ${gallery.url}`);
	      } else {
	        const task = `Design session for the project at ${projectPath}. Analyze the existing UI, create design variants as self-contained HTML files in ${outputDir}. Focus on visual quality, consistency, and accessibility.${referenceContext}`;
	        const { orch } = await ensureRuntime({ announceAdapter: true });
	        const session = await orch.run({
	          prompt: "plan-build-review",
	          task,
          adapter: dryRun ? "echo" : adapterName,
          workingDir: projectPath,
        });
        console.log(`\nSession ${session.id} ${session.status}. Cost: $${session.totalCost.toFixed(3)}`);
        console.log(`Gallery: ${gallery.url}`);
      }
    } finally {
      gallery.stop();
    }
    break;
  }

  case "version": {
    const versionFile = join(BASE_DIR, "VERSION");
    let maeVersion = "unknown";
    try { maeVersion = readFile(versionFile, "utf-8").trim(); } catch {}

	    const bunVersion = typeof Bun !== "undefined" ? Bun.version : "unknown";
	    const chainsFile = loadChains();
	    const chainCount = Object.keys(chainsFile.chains).length;
	    const { adapters } = createAdapters();

    console.log(`
MAE v${maeVersion}
Bun v${bunVersion}
Dashboard: ${dashboardUrl}
Adapters:  ${adapters.length} registered
Chains:    ${chainCount} configured
`);
    break;
  }

  case "info": {
    const versionFileInfo = join(BASE_DIR, "VERSION");
    let maeVer = "unknown";
    try { maeVer = readFile(versionFileInfo, "utf-8").trim(); } catch {}

    const bunVer = typeof Bun !== "undefined" ? Bun.version : "unknown";

    console.log(`\n${"═".repeat(50)}`);
    console.log(`  Multi-Agent Engine v${maeVer}`);
    console.log(`${"═".repeat(50)}`);
    console.log(`  Bun: v${bunVer}  |  Dashboard: ${dashboardUrl}`);

    // --- Chains ---
    console.log(`\n${"─".repeat(50)}`);
    console.log("  CHAINS");
    console.log(`${"─".repeat(50)}`);
    const chainsData = loadChains();
    for (const [name, chain] of Object.entries(chainsData.chains)) {
      const stepCount = (chain as any).steps?.length ?? (chain as any).parallel?.length ?? 0;
      const desc = (chain as any).description ?? "";
      console.log(`  ${name.padEnd(24)} ${String(stepCount).padStart(2)} steps  ${desc}`);
    }
    console.log(`  Total: ${Object.keys(chainsData.chains).length} chains`);

	    // --- Adapters ---
	    console.log(`\n${"─".repeat(50)}`);
	    console.log("  ADAPTERS");
	    console.log(`${"─".repeat(50)}`);
	    const { adapters } = createAdapters();
	    for (const adapter of adapters) {
	      const available = await adapter.isAvailable();
	      console.log(`  ${available ? "✓" : "✗"} ${adapter.name.padEnd(20)} ${available ? "available" : "not available"}`);
    }

    // --- Model Routing ---
    console.log(`\n${"─".repeat(50)}`);
    console.log("  MODEL ROUTING");
    console.log(`${"─".repeat(50)}`);
    const routing = loadModelRouting() as any;
    if (routing.tiers) {
      for (const [tierName, tier] of Object.entries(routing.tiers as Record<string, any>)) {
        const defaultModel = tier.default ?? "none";
        const optionCount = tier.options?.length ?? 0;
        console.log(`  ${tierName.padEnd(10)} default: ${defaultModel.padEnd(28)} (${optionCount} options)`);
        if (tier.description) console.log(`             ${tier.description}`);
      }
    }
    if (routing.aliases) {
      console.log(`\n  Aliases:`);
      for (const [alias, model] of Object.entries(routing.aliases as Record<string, string>)) {
        console.log(`    ${alias.padEnd(12)} -> ${model}`);
      }
    }
    if (routing.budgets) {
      console.log(`\n  Budgets:`);
      console.log(`    Max/session: ${routing.budgets.max_per_session_usd}  |  Warn at: ${routing.budgets.warn_at_usd}  |  Max/agent: ${routing.budgets.max_per_agent_usd}`);
    }

    // --- Dashboard Health ---
    console.log(`\n${"─".repeat(50)}`);
    console.log("  DASHBOARD");
    console.log(`${"─".repeat(50)}`);
    try {
      const healthResp = await fetch(`${dashboardUrl}/api/health`, { signal: AbortSignal.timeout(3000) });
      if (healthResp.ok) {
        const healthData = await healthResp.json().catch(() => null);
        console.log(`  ✓ Connected (${dashboardUrl})`);
        if (healthData && typeof healthData === "object") {
          const h = healthData as Record<string, unknown>;
          if (h.version) console.log(`    Dashboard version: ${h.version}`);
          if (h.uptime) console.log(`    Uptime: ${h.uptime}s`);
        }
      } else {
        console.log(`  ✗ Responded with ${healthResp.status} (${dashboardUrl})`);
      }
    } catch (e: any) {
      console.log(`  ✗ Unreachable (${dashboardUrl})`);
    }

    console.log(`\n${"═".repeat(50)}\n`);
    break;
  }

	  case "adapters": {
	    console.log("\nAvailable adapters:");
	    const { adapters } = createAdapters();
	    for (const adapter of adapters) {
	      const available = await adapter.isAvailable();
	      console.log(`  ${available ? "✓" : "✗"} ${adapter.name}${available ? "" : " (not installed/configured)"}`);
    }
    break;
  }

  case "config": {
    if (subHelp) showSubHelp(`
mae config — Configure models, budgets, and aliases

Usage:
  mae config                 Interactive config TUI
  mae config show            Show current config summary
  mae config export          Export full config as JSON
  mae config import <file>   Import/merge JSON config
  mae config discover        Probe all configured models via LiteLLM

Interactive TUI menus:
  1. Show config    2. Budgets    3. Model tiers
  4. Aliases        5. Role defaults    6. Discover models
`);
    const sub = args[1];
    if (args.includes("--export")) {
      configExport();
    } else if (args.includes("--json")) {
      const file = getFlag(args, "--json") ?? sub;
      await configImport(file);
    } else if (sub === "show") {
      await configShow();
    } else if (sub === "discover") {
      await configDiscover();
    } else {
      await configInteractive();
    }
    break;
  }

  case "tui":
    if (subHelp) showSubHelp(`
mae tui — Full interactive launcher

Usage:
  mae tui

Use arrow-key menus to run work, operate sessions, inspect traces,
build agent assets, and configure or diagnose the engine.
`);
    await runFullTui();
    break;

  case "validate-chain": {
    if (subHelp) {
      const chainsFile = loadChains();
      const chainList = Object.entries(chainsFile.chains).map(([name, c]) =>
        `  ${name.padEnd(22)} ${(c.steps?.length ?? (c.parallel?.length ? 1 : 0) + (c.then?.length ?? 0))} steps  ${c.description}`).join("\n");
      showSubHelp(`
mae validate-chain — Preview configured chain execution without spawning agents

Usage:
  mae validate-chain <chain-name> [goal]
  mae validate-chain "goal text"
  mae validate-chain <chain-name> --json

Chains:
${chainList}

Examples:
  ${chainExample(["standard-swarm", "swarm-review", "review-only"], "Find release blockers in the dashboard", "standard-swarm").replace("mae chain", "mae validate-chain").replace(/ ".*"$/, "")}
  mae validate-chain "Design dashboard UI review"
  ${chainExample(["plan-build-review", "build-verify", "full-sdlc"], "Add cost summary to session detail", "plan-build-review").replace("mae chain", "mae validate-chain")}

This reads YAML/persona config only. It does not start adapters, burn model tokens, or write traces.
`);
    }
    try {
      const positional = args.slice(1).filter((arg) => arg !== "--json");
      const input = resolveValidateChainInput(positional);
      const report = buildChainValidationReport(input.chainName, input.goal);
      report.suggestedChain = input.suggestedChain;
      if (args.includes("--json")) console.log(JSON.stringify(report, null, 2));
      else console.log(formatChainValidationReport(report));
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    break;
  }

  case "traces": {
    if (subHelp) showSubHelp(`
mae traces — List and inspect JSONL trace files

Usage:
  mae traces              List recent traces (last 10)
  mae traces <id>         Show summary of a specific trace

Traces are stored in: ${TRACE_DIR}

Each session produces a .jsonl file with structured events
following the trace schema (specs/trace-schema.md).
`);
    const traceId = args[1];
    if (!existsSync(TRACE_DIR)) {
      console.log(`No trace directory found at ${TRACE_DIR}`);
      break;
    }

    if (traceId) {
      // Show summary of a specific trace
      let traceFile = join(TRACE_DIR, traceId.endsWith(".jsonl") ? traceId : `${traceId}.jsonl`);
      if (!existsSync(traceFile)) {
        // Try partial match
        const files = readdirSync(TRACE_DIR).filter((f: string) => f.startsWith(traceId) && f.endsWith(".jsonl"));
        if (files.length === 1) {
          traceFile = join(TRACE_DIR, files[0]!);
        } else if (files.length > 1) {
          console.error(`Ambiguous ID '${traceId}', matches: ${files.map((f: string) => f.replace(".jsonl", "")).join(", ")}`);
          process.exit(1);
        } else {
          console.error(`Trace not found: ${traceId}`);
          process.exit(1);
        }
      }

      const content = readFile(traceFile, "utf-8").trim();
      if (!content) { console.log("Empty trace file."); break; }
      const lines = content.split("\n");
      const events = lines.map((l: string) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

      // Count events by type
      const typeCounts: Record<string, number> = {};
      let totalCost = 0;
      let firstTs: string | null = null;
      let lastTs: string | null = null;
      let goal = "";

      for (const evt of events) {
        typeCounts[evt.type] = (typeCounts[evt.type] ?? 0) + 1;
        if (!firstTs) firstTs = evt.ts;
        lastTs = evt.ts;
        if (evt.type === "session.start" && (evt.goal || evt.task_preview)) {
          goal = evt.goal ?? evt.task_preview?.slice(0, 80) ?? "";
        }
        if (evt.total_cost !== undefined) totalCost = evt.total_cost;
        if (evt.cost !== undefined) totalCost += evt.cost;
      }

      const durationMs = firstTs && lastTs ? new Date(lastTs).getTime() - new Date(firstTs).getTime() : 0;
      const durationStr = durationMs > 60000 ? `${(durationMs / 60000).toFixed(1)}m` : `${(durationMs / 1000).toFixed(1)}s`;

      console.log(`\nTrace: ${traceFile.split("/").pop()?.replace(".jsonl", "")}`);
      if (goal) console.log(`Goal: ${goal}`);
      console.log(`Events: ${events.length}  |  Duration: ${durationStr}  |  Cost: $${totalCost.toFixed(3)}`);
      console.log(`\nEvent breakdown:`);
      for (const [type, count] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${type.padEnd(22)} ${count}`);
      }
    } else {
      // List recent traces
      const { statSync } = await import("fs");
      const files = readdirSync(TRACE_DIR)
        .filter((f: string) => f.endsWith(".jsonl"))
        .map((f: string) => {
          const stat = statSync(join(TRACE_DIR, f));
          return { name: f, mtime: stat.mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, 10);

      if (files.length === 0) {
        console.log(`No traces found in ${TRACE_DIR}`);
        break;
      }

      console.log(`\nRecent traces (${TRACE_DIR}):\n`);
      console.log(`${"Session ID".padEnd(40)} ${"Goal".padEnd(40)} Status`);
      console.log("-".repeat(90));

      for (const file of files) {
        const content = readFile(join(TRACE_DIR, file.name), "utf-8").trim();
        if (!content) continue;
        const firstLine = content.split("\n")[0];
        const lastLine = content.split("\n").pop();
        let goal = "";
        let status = "";
        try {
          const first = JSON.parse(firstLine!);
          goal = (first.goal ?? first.task_preview ?? first.msg ?? "").slice(0, 38);
          const last = JSON.parse(lastLine!);
          status = last.status ?? last.type ?? "";
        } catch { /* ignore parse errors */ }

        const sessionId = file.name.replace(".jsonl", "");
        console.log(`${sessionId.slice(0, 38).padEnd(40)} ${goal.padEnd(40)} ${status}`);
      }
    }
    break;
  }

  case "score": {
    if (subHelp) showSubHelp(`
mae score — Score a session trace with deterministic checks

Usage: mae score <session_id>

Runs deterministic checks against a trace:
  - Did the session complete?
  - Were all chain steps executed?
  - Did any agents fail?
  - Were there ERROR/CRITICAL log events?
  - Was cost reasonable?

Prints a results table and behavioral fingerprint summary.
`);
    const scoreId = args[1];
    if (!scoreId) {
      console.error("Usage: mae score <session_id>");
      process.exit(1);
    }
    try {
      const trace = loadTrace(scoreId);
      const result = scoreSession(trace);

      console.log(`\nSession: ${result.sessionId}`);
      if (trace.goal) console.log(`Goal: ${trace.goal}`);
      console.log(`Overall: ${result.overall.toUpperCase()}\n`);

      console.log(`${"Check".padEnd(24)} ${"Result".padEnd(8)} Details`);
      console.log("─".repeat(70));
      for (const check of result.checks) {
        const icon = check.pass ? "PASS" : "FAIL";
        console.log(`${check.name.padEnd(24)} ${icon.padEnd(8)} ${check.details ?? ""}`);
      }

      const fp = result.fingerprint;
      console.log(`\nFingerprint:`);
      console.log(`  Tools:   ${fp.toolSequence.length > 0 ? fp.toolSequence.join(" → ") : "(none)"}`);
      console.log(`  Agents:  ${fp.agentCount}`);
      console.log(`  Teams:   ${fp.teamSequence.join(" → ") || "(none)"}`);
      console.log(`  Steps:   ${fp.stepCount}`);
      console.log(`  Errors:  ${fp.errorCount}`);
    } catch (err: unknown) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    break;
  }

  case "compare": {
    if (subHelp) showSubHelp(`
mae compare — Compare two session fingerprints

Usage: mae compare <session_id_1> <session_id_2>

Loads both traces, extracts behavioral fingerprints, and shows
similarity score (0-1) plus a list of differences.
`);
    const id1 = args[1];
    const id2 = args[2];
    if (!id1 || !id2) {
      console.error("Usage: mae compare <session_id_1> <session_id_2>");
      process.exit(1);
    }
    try {
      const trace1 = loadTrace(id1);
      const trace2 = loadTrace(id2);
      const fp1 = extractFingerprint(trace1);
      const fp2 = extractFingerprint(trace2);
      const result = compareFingerprints(fp1, fp2);

      console.log(`\nComparing:`);
      console.log(`  A: ${id1} — ${trace1.goal || "(no goal)"}`);
      console.log(`  B: ${id2} — ${trace2.goal || "(no goal)"}`);
      console.log(`\nSimilarity: ${(result.similarity * 100).toFixed(1)}%`);

      if (result.diffs.length > 0) {
        console.log(`\nDifferences:`);
        for (const diff of result.diffs) {
          console.log(`  - ${diff}`);
        }
      } else {
        console.log(`\nNo differences found — fingerprints are identical.`);
      }
    } catch (err: unknown) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    break;
  }

  case "replay": {
    if (subHelp) showSubHelp(`
mae replay — Re-run a past session's goal and compare traces

Usage: mae replay <session_id>

Loads the old trace, extracts the goal and chain, re-runs
through the engine, then compares the new trace's fingerprint
to the old one. Prints similarity score and diffs.

Options:
  --adapter <name>     Use specific adapter (default: current)
  --dry-run            Use echo adapter for replay
`);
    const replayId = args[1];
    if (!replayId) {
      console.error("Usage: mae replay <session_id>");
      process.exit(1);
    }
    try {
      const oldTrace = loadTrace(replayId);
      if (!oldTrace.goal) {
        console.error("Cannot replay: trace has no goal recorded.");
        process.exit(1);
      }

      console.log(`\nReplaying session ${replayId}`);
	      console.log(`Goal: ${oldTrace.goal}`);
	      console.log(`Chain: ${oldTrace.chain || "plan-build-review"}`);
	      console.log(`Running...\n`);

	      const { orch } = await ensureRuntime({ announceAdapter: true });
	      const newSession = await orch.run({
	        chain: oldTrace.chain || undefined,
	        task: oldTrace.goal,
        adapter: dryRun ? "echo" : adapterName,
        workingDir,
        sessionName: `replay:${replayId.slice(0, 8)}`,
      });

      console.log(`\nNew session: ${newSession.id} (${newSession.status})`);
      console.log(`Cost: $${newSession.totalCost.toFixed(3)}`);

      // Compare fingerprints
      try {
        const newTrace = loadTrace(newSession.id);
        const oldFp = extractFingerprint(oldTrace);
        const newFp = extractFingerprint(newTrace);
        const comparison = compareFingerprints(oldFp, newFp);

        console.log(`\nFingerprint similarity: ${(comparison.similarity * 100).toFixed(1)}%`);
        if (comparison.diffs.length > 0) {
          console.log(`Differences:`);
          for (const diff of comparison.diffs) {
            console.log(`  - ${diff}`);
          }
        } else {
          console.log(`No behavioral differences detected.`);
        }
      } catch {
        console.log(`\n(Could not load new trace for comparison — trace may not have been written yet)`);
      }
    } catch (err: unknown) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    break;
  }

  case "golden": {
    await handleGoldenCommand(args, subHelp);
    break;
  }

  case "ralph": {
    await handleRalphCommand(args, subHelp, dryRun);
    break;
  }

  case "langfuse": {
    await handleLangfuseCommand(args, subHelp, dryRun);
    break;
  }

  case "update": {
    const installPath = join(process.env.HOME ?? "/tmp", ".local", "bin", "mae");
    const { copyFileSync, chmodSync, mkdirSync } = await import("fs");

    console.log("[mae] Pulling latest from GitHub...");
    const pullProc = Bun.spawn(["git", "pull", "origin", "main"], { cwd: BASE_DIR, stdout: "inherit", stderr: "inherit" });
    await pullProc.exited;
    if (pullProc.exitCode !== 0) { console.error("[mae] Git pull failed"); process.exit(1); }

    console.log("[mae] Installing dependencies...");
    const installProc = Bun.spawn(["bun", "install"], { cwd: BASE_DIR, stdout: "inherit", stderr: "inherit" });
    await installProc.exited;

    console.log("[mae] Building...");
    const buildProc = Bun.spawn(["bun", "build", "engine/cli.ts", "--target=bun", "--outfile=./agent"], { cwd: BASE_DIR, stdout: "inherit", stderr: "inherit" });
    await buildProc.exited;
    if (buildProc.exitCode !== 0) { console.error("[mae] Build failed"); process.exit(1); }

    mkdirSync(join(process.env.HOME ?? "/tmp", ".local", "bin"), { recursive: true });
    copyFileSync(join(BASE_DIR, "agent"), installPath);
    chmodSync(installPath, 0o755);

    const ver = (() => { try { return readFile(join(BASE_DIR, "VERSION"), "utf-8").trim(); } catch { return "?"; } })();
    console.log(`[mae] Updated to v${ver} — installed at ${installPath}`);
    break;
  }

  case "health": {
    if (subHelp) showSubHelp(`
mae health — Engine health check

Usage:
  mae health           Human-readable health report
  mae health --json    Machine-readable JSON output

Probes: adapters, traces, dashboard, langfuse
`);
	    const versionFile = join(BASE_DIR, "VERSION");
	    let ver = "unknown";
	    try { ver = readFile(versionFile, "utf-8").trim(); } catch {}
	    const { adapters } = createAdapters();
	    const report = await runHealthCheck(adapters, dashboardUrl, ver);
    if (args.includes("--json")) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      process.stdout.write(formatHealthReport(report));
    }
    process.exit(report.status === "unhealthy" ? 1 : 0);
  }

  default:
    console.error(`Unknown command: ${command}`);
    console.error("Sections: work, operate, inspect, build, configure");
    console.error("Run 'mae <section>' for grouped help or 'mae <command> --help'.");
    process.exit(1);
}

type TuiSession = {
  id: string;
  name?: string;
  status: string;
  started_at?: string;
  created_at?: string;
  total_cost?: number;
  agents?: Record<string, unknown>;
};

async function runFullTui(): Promise<void> {
  p.intro("MAE TUI");
  try {
    while (true) {
      const section = await p.select({
        message: "What do you want to do?",
        options: [
          { value: "run", label: "Run work", hint: "task, chain, prompt workflow" },
          { value: "operate", label: "Operate runs", hint: "list, steer, pause, resume, stop, close" },
          { value: "inspect", label: "Inspect and verify", hint: "traces, score, compare, validate chain" },
          { value: "build", label: "Build the agent system", hint: "teams, personas, expertise, Ralph" },
          { value: "config", label: "Configure and diagnose", hint: "config, health, adapters" },
          { value: "quit", label: "Quit" },
        ],
      });
      if (p.isCancel(section) || section === "quit") break;

      switch (section) {
        case "run": await tuiRunWork(); break;
        case "operate": await tuiOperateRuns(); break;
        case "inspect": await tuiInspect(); break;
        case "build": await tuiBuildSystem(); break;
        case "config": await tuiConfigure(); break;
      }
    }
  } finally {
    p.outro("Done.");
  }
}

function tuiHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiToken) headers["Authorization"] = `Bearer ${apiToken}`;
  return headers;
}

function asString(value: string | symbol, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

async function tuiText(message: string, opts?: { placeholder?: string; defaultValue?: string; required?: boolean }): Promise<string | null> {
  const value = await p.text({
    message,
    placeholder: opts?.placeholder,
    defaultValue: opts?.defaultValue,
    validate: opts?.required ? v => {
      if (!String(v ?? "").trim()) return "Required";
    } : undefined,
  });
  if (p.isCancel(value)) return null;
  return String(value).trim();
}

async function tuiConfirm(message: string, initialValue = true): Promise<boolean> {
  const ok = await p.confirm({ message, initialValue });
  return !p.isCancel(ok) && Boolean(ok);
}

async function tuiPickAdapter(): Promise<string | undefined | null> {
  const adapter = await p.select({
    message: "Adapter",
    options: [
      { value: "", label: "Default", hint: dryRun ? "current CLI dry-run echo" : "current CLI/default adapter" },
      { value: "echo", label: "echo", hint: "local dry run" },
      { value: "pi", label: "pi", hint: "Pi/Codex adapter" },
      { value: "a2a", label: "a2a", hint: "remote A2A adapter" },
    ],
  });
  if (p.isCancel(adapter)) return null;
  return asString(adapter) || undefined;
}

async function tuiPickWorkingDir(): Promise<string | null> {
  const cwd = await tuiText("Working directory", { defaultValue: workingDir, required: true });
  return cwd ? resolve(cwd) : null;
}

async function tuiRunWork(): Promise<void> {
  const mode = await p.select({
    message: "Run work",
    options: [
      { value: "task", label: "Auto-classified task", hint: "mae task \"...\"" },
      { value: "chain", label: "Named chain", hint: "mae chain standard-swarm \"...\"" },
      { value: "prompt", label: "Prompt workflow", hint: "mae run review \"...\"" },
    ],
  });
  if (p.isCancel(mode)) return;

  const adapter = await tuiPickAdapter();
  if (adapter === null) return;
  const cwd = await tuiPickWorkingDir();
  if (!cwd) return;

  if (mode === "task") {
    const task = await tuiText("Task", { placeholder: "Fix the login redirect bug", required: true });
    if (!task) return;
    const result = await classifyGoal(task);
    const chainName = result.confidence >= 0.8 ? result.chain : "plan-build-review";
    const prefix = result.confidence >= 0.8 ? "Auto-selected" : "Low confidence, using";
    p.log.info(`${prefix} ${chainName} (${result.confidence.toFixed(2)}): ${result.reasoning}`);
    await tuiRunSession({ chain: chainName, task, adapter, workingDir: cwd });
    return;
  }

  if (mode === "chain") {
    const chainsFile = loadChains();
    const chain = await p.select({
      message: "Chain",
      options: Object.entries(chainsFile.chains).map(([name, c]) => ({
        value: name,
        label: name,
        hint: `${c.steps?.length ?? 0} steps - ${c.description ?? ""}`,
      })),
    });
    if (p.isCancel(chain)) return;
    const task = await tuiText("Task", { placeholder: "Find release blockers in the dashboard", required: true });
    if (!task) return;
    await tuiRunSession({ chain: asString(chain), task, adapter, workingDir: cwd });
    return;
  }

  const promptNames = (() => {
    try {
      return readdirSync(join(import.meta.dir, "..", "prompts"))
        .filter((f: string) => f.endsWith(".md") && f !== "BASE.md")
        .map((f: string) => f.replace(".md", ""))
        .sort();
    } catch {
      return ["plan-build-review", "review", "scout", "swarm-review"];
    }
  })();
  const prompt = await p.select({
    message: "Prompt workflow",
    options: promptNames.map(name => ({ value: name, label: name })),
  });
  if (p.isCancel(prompt)) return;
  const task = await tuiText("Prompt args/task", { placeholder: "Review engine/ for bugs", required: true });
  if (!task) return;
  await tuiRunSession({ prompt: asString(prompt), task, args: task.split(/\s+/), adapter, workingDir: cwd });
}

async function tuiRunSession(opts: { chain?: string; prompt?: string; task: string; args?: string[]; adapter?: string; workingDir: string }): Promise<void> {
	  const s = p.spinner();
	  s.start("Running session");
	  try {
	    const { orch } = await ensureRuntime();
	    const session = await orch.run({
	      chain: opts.chain,
	      prompt: opts.prompt,
      task: opts.task,
      args: opts.args,
      adapter: opts.adapter ?? (dryRun ? "echo" : adapterName),
      workingDir: opts.workingDir,
    });
    s.stop("Session finished");
    p.note(`ID: ${session.id}\nStatus: ${session.status}\nCost: $${session.totalCost.toFixed(3)}`, "Session result");
  } catch (err) {
    s.stop("Session failed");
    p.log.error(err instanceof Error ? err.message : String(err));
  }
}

async function fetchDashboardSessions(): Promise<TuiSession[]> {
  const resp = await fetch(`${dashboardUrl}/api/sessions`, { headers: tuiHeaders() });
  if (!resp.ok) throw new Error(`Dashboard error: ${resp.status} ${await resp.text().catch(() => "")}`);
  const sessions = await resp.json() as TuiSession[];
  return sessions.sort((a, b) => (b.started_at ?? b.created_at ?? "").localeCompare(a.started_at ?? a.created_at ?? ""));
}

function formatTuiSession(s: TuiSession): string {
  const cost = typeof s.total_cost === "number" ? `$${s.total_cost.toFixed(3)}` : "$0.000";
  const agents = Object.keys(s.agents ?? {}).length;
  return `${s.id.slice(0, 12).padEnd(12)}  ${s.status.padEnd(10)}  ${String(agents).padStart(2)} agents  ${cost.padStart(8)}  ${(s.name ?? "").slice(0, 70)}`;
}

async function pickDashboardSession(message = "Session"): Promise<TuiSession | null> {
  let sessions: TuiSession[];
  try {
    sessions = await fetchDashboardSessions();
  } catch (err) {
    p.log.error(err instanceof Error ? err.message : String(err));
    return null;
  }
  if (sessions.length === 0) {
    p.log.warn("No dashboard sessions found.");
    return null;
  }
  const selected = await p.select({
    message,
    options: sessions.slice(0, 50).map(s => ({
      value: s.id,
      label: `${s.id.slice(0, 12)} ${s.status} ${(s.name ?? "").slice(0, 48)}`,
      hint: typeof s.total_cost === "number" ? `$${s.total_cost.toFixed(3)}` : undefined,
    })),
  });
  if (p.isCancel(selected)) return null;
  return sessions.find(s => s.id === selected) ?? null;
}

async function tuiOperateRuns(): Promise<void> {
  const action = await p.select({
    message: "Operate runs",
    options: [
      { value: "list", label: "List sessions" },
      { value: "steer", label: "Send steer message" },
      { value: "pause", label: "Pause session" },
      { value: "resume", label: "Resume session" },
      { value: "stop", label: "Stop session" },
      { value: "close", label: "Close session status" },
    ],
  });
  if (p.isCancel(action)) return;

  if (action === "list") {
    try {
      const sessions = await fetchDashboardSessions();
      p.note(sessions.slice(0, 20).map(formatTuiSession).join("\n") || "No sessions.", `Sessions (${sessions.length})`);
    } catch (err) {
      p.log.error(err instanceof Error ? err.message : String(err));
    }
    return;
  }

  const session = await pickDashboardSession();
  if (!session) return;

  if (action === "close") {
    const status = await p.select({
      message: "Close as",
      options: [
        { value: "completed", label: "completed" },
        { value: "error", label: "error" },
      ],
    });
    if (p.isCancel(status)) return;
    const ok = await tuiConfirm(`Set ${session.id.slice(0, 12)} to ${status}?`);
    if (!ok) return;
    const resp = await fetch(`${dashboardUrl}/api/sessions/${session.id}/status`, {
      method: "PATCH",
      headers: tuiHeaders(),
      body: JSON.stringify({ status }),
    });
    if (!resp.ok) p.log.error(`Failed: ${resp.status} ${await resp.text().catch(() => "")}`);
    else p.log.success(`Session ${session.id.slice(0, 12)} -> ${status}`);
    return;
  }

  const content = action === "steer"
    ? await tuiText("Steer message", { placeholder: "Focus on the orchestrator ACK path first", required: true })
    : `!${action}`;
  if (!content) return;
  const body = new URLSearchParams({
    content,
    message_id: `tui-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  });
  const resp = await fetch(`${dashboardUrl}/api/sessions/${session.id}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...(apiToken ? { Authorization: `Bearer ${apiToken}` } : {}) },
    body,
  });
  if (!resp.ok) p.log.error(`Failed: ${resp.status} ${await resp.text().catch(() => "")}`);
  else {
    const data = await resp.json().catch(() => ({})) as { message_id?: string };
    p.log.success(`Sent to ${session.id.slice(0, 12)}${data.message_id ? ` (${data.message_id})` : ""}`);
  }
}

function recentTraceFiles(limit = 20): string[] {
  if (!existsSync(TRACE_DIR)) return [];
  return readdirSync(TRACE_DIR)
    .filter((f: string) => f.endsWith(".jsonl"))
    .map((f: string) => ({ name: f.replace(".jsonl", ""), mtime: statSync(join(TRACE_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map(f => f.name);
}

async function pickTraceId(message = "Trace"): Promise<string | null> {
  const files = recentTraceFiles();
  if (files.length === 0) return await tuiText(`${message} ID`, { required: true });
  const trace = await p.select({
    message,
    options: [
      ...files.map(id => ({ value: id, label: id })),
      { value: "__manual", label: "Enter another ID" },
    ],
  });
  if (p.isCancel(trace)) return null;
  if (trace === "__manual") return await tuiText(`${message} ID`, { required: true });
  return asString(trace);
}

function summarizeTrace(traceId: string): string {
  const trace = loadTrace(traceId);
  const typeCounts: Record<string, number> = {};
  let totalCost = 0;
  for (const evt of trace.events) {
    typeCounts[evt.type] = (typeCounts[evt.type] ?? 0) + 1;
    if ((evt as any).total_cost !== undefined) totalCost = (evt as any).total_cost;
    if ((evt as any).cost !== undefined) totalCost += (evt as any).cost;
  }
  const breakdown = Object.entries(typeCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([type, count]) => `  ${type.padEnd(24)} ${count}`)
    .join("\n");
  return `Goal: ${trace.goal ?? "(no goal)"}\nEvents: ${trace.events.length}\nCost: $${totalCost.toFixed(3)}\n\n${breakdown}`;
}

async function tuiInspect(): Promise<void> {
  const action = await p.select({
    message: "Inspect and verify",
    options: [
      { value: "list", label: "List recent traces" },
      { value: "trace", label: "Inspect a trace" },
      { value: "score", label: "Score a trace" },
      { value: "compare", label: "Compare two traces" },
      { value: "validate-chain", label: "Validate a configured chain" },
      { value: "golden", label: "List golden traces" },
    ],
  });
  if (p.isCancel(action)) return;

  try {
    if (action === "list") {
      const files = recentTraceFiles(15);
      p.note(files.join("\n") || `No traces found in ${TRACE_DIR}`, `Recent traces (${TRACE_DIR})`);
    } else if (action === "trace") {
      const id = await pickTraceId();
      if (id) p.note(summarizeTrace(id), `Trace ${id}`);
    } else if (action === "score") {
      const id = await pickTraceId();
      if (!id) return;
      const result = scoreSession(loadTrace(id));
      const checks = result.checks.map(c => `${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.details ? ` - ${c.details}` : ""}`).join("\n");
      p.note(`Overall: ${result.overall.toUpperCase()}\n\n${checks}`, `Score ${id}`);
    } else if (action === "compare") {
      const id1 = await pickTraceId("First trace");
      const id2 = await pickTraceId("Second trace");
      if (!id1 || !id2) return;
      const result = compareFingerprints(extractFingerprint(loadTrace(id1)), extractFingerprint(loadTrace(id2)));
      p.note(`Similarity: ${(result.similarity * 100).toFixed(1)}%\n\n${result.diffs.join("\n") || "No differences found."}`, "Trace comparison");
    } else if (action === "validate-chain") {
      await tuiValidateChain();
    } else {
      const entries = getGoldenTraces();
      p.note(entries.map(e => `${e.sessionId.slice(0, 12)}  ${e.verdict}  ${e.goal ?? ""}`).join("\n") || "No golden traces registered.", "Golden traces");
    }
  } catch (err) {
    p.log.error(err instanceof Error ? err.message : String(err));
  }
}

async function tuiValidateChain(): Promise<void> {
  const mode = await p.select({
    message: "Validate chain",
    options: [
      { value: "chain", label: "Pick configured chain" },
      { value: "goal", label: "Suggest from goal text" },
    ],
  });
  if (p.isCancel(mode)) return;

  try {
    if (mode === "chain") {
      const chainsFile = loadChains();
      const selected = await p.select({
        message: "Chain",
        options: Object.entries(chainsFile.chains).map(([name, c]) => ({
          value: name,
          label: name,
          hint: c.description,
        })),
      });
      if (p.isCancel(selected)) return;
      const goal = await tuiText("Optional goal/context", { placeholder: "Find release blockers in the dashboard" });
      const report = buildChainValidationReport(asString(selected), goal || undefined);
      p.note(formatChainValidationReport(report), `Chain ${asString(selected)}`);
      return;
    }

    const goal = await tuiText("Goal text", { placeholder: "Design dashboard UI review", required: true });
    if (!goal) return;
    const input = resolveValidateChainInput([goal]);
    const report = buildChainValidationReport(input.chainName, input.goal);
    report.suggestedChain = input.suggestedChain;
    p.note(formatChainValidationReport(report), `Suggested ${input.chainName}`);
  } catch (err) {
    p.log.error(err instanceof Error ? err.message : String(err));
  }
}

async function tuiBuildSystem(): Promise<void> {
  const action = await p.select({
    message: "Build the agent system",
    options: [
      { value: "new-team", label: "Create a new team" },
      { value: "new-agent", label: "Scaffold a new agent" },
      { value: "learn", label: "Build expertise from sources" },
      { value: "expert", label: "Open expert session" },
      { value: "validate", label: "Validate an agent" },
      { value: "ralph", label: "Run Ralph dry-run" },
    ],
  });
  if (p.isCancel(action)) return;

  switch (action) {
    case "new-team":
      await teamWizard([]);
      return;
    case "new-agent": {
      const name = await tuiText("Agent name", { placeholder: "API Reviewer", required: true });
      if (!name) return;
      const role = await p.select({
        message: "Role",
        options: [
          { value: "worker", label: "worker" },
          { value: "lead", label: "lead" },
          { value: "orchestrator", label: "orchestrator" },
        ],
      });
      if (p.isCancel(role)) return;
      const team = await tuiText("Team", { defaultValue: "Engineering", required: true });
      if (!team) return;
      const model = await tuiText("Model alias/tier", { defaultValue: role === "worker" ? "main" : "quality", required: true });
      if (!model) return;
      await scaffoldAgent([name, asString(role), team, model]);
      return;
    }
    case "learn": {
      const source = await tuiText("Source path or URL", { defaultValue: "./engine", required: true });
      const agent = await tuiText("Agent slug", { placeholder: "api-reviewer", required: true });
      if (source && agent) await expertiseLearn(["--from", source, "--agent", agent]);
      return;
    }
    case "expert": {
      const target = await tuiText("Project path", { defaultValue: "./engine", required: true });
      if (!target) return;
      const agent = await tuiText("Agent slug (optional)", { placeholder: "api-reviewer" });
      await expertSession(agent ? [target, "--agent", agent] : [target]);
      return;
    }
    case "validate": {
      const agent = await tuiText("Agent slug", { placeholder: "api-reviewer", required: true });
      if (agent) await expertiseValidate([agent]);
      return;
    }
    case "ralph": {
      const iterations = await tuiText("Iterations", { defaultValue: "3", required: true });
      if (!iterations) return;
      const result = await runRalphLoop({ maxIterations: parseInt(iterations, 10), model: "quality", dryRun: true });
      p.note(`Iterations: ${result.iterations}\nAccepted: ${result.accepted}\nRejected: ${result.rejected}\nMutations: ${result.mutations.length}`, "Ralph dry-run");
      return;
    }
  }
}

async function tuiConfigure(): Promise<void> {
  const action = await p.select({
    message: "Configure and diagnose",
    options: [
      { value: "config", label: "Open config TUI" },
      { value: "show", label: "Show config summary" },
      { value: "discover", label: "Discover/probe models" },
      { value: "health", label: "Run health check" },
      { value: "adapters", label: "List adapters" },
      { value: "version", label: "Show version" },
    ],
  });
  if (p.isCancel(action)) return;

  if (action === "config") {
    await configInteractive();
  } else if (action === "show") {
    await configShow();
  } else if (action === "discover") {
    await configDiscover();
	  } else if (action === "health") {
	    const versionFile = join(BASE_DIR, "VERSION");
	    let ver = "unknown";
	    try { ver = readFile(versionFile, "utf-8").trim(); } catch {}
	    const { adapters } = createAdapters();
	    const report = await runHealthCheck(adapters, dashboardUrl, ver);
	    p.note(formatHealthReport(report), "Health");
	  } else if (action === "adapters") {
	    const rows: string[] = [];
	    const { adapters } = createAdapters();
	    for (const adapter of adapters) {
      const available = await adapter.isAvailable();
      rows.push(`${available ? "OK " : "NO "} ${adapter.name}`);
    }
    p.note(rows.join("\n"), "Adapters");
  } else if (action === "version") {
    const versionFile = join(BASE_DIR, "VERSION");
    let ver = "unknown";
    try { ver = readFile(versionFile, "utf-8").trim(); } catch {}
    p.note(`MAE v${ver}\nBun v${typeof Bun !== "undefined" ? Bun.version : "unknown"}\nDashboard: ${dashboardUrl}`, "Version");
  }
}

async function scaffoldAgent(args: string[]) {
  const name = args[0];
  const role = (args[1] ?? "worker") as "orchestrator" | "lead" | "worker";
  const team = args[2] ?? "Engineering";
  const model = args[3] ?? (role === "worker" ? "main" : "quality");

  if (!name) {
    console.error("Usage: mae new-agent <name> [role] [team] [model]");
    process.exit(1);
  }

  let slug: string;
  try {
    slug = slugify(name);
  } catch {
    console.error("Invalid agent name");
    process.exit(1);
  }

  const skillsForRole = {
    orchestrator: [
      "agents/skills/zero-micromanagement.md",
      "agents/skills/active-listener.md",
      "agents/skills/conversational-response.md",
      "agents/skills/till-done.md",
      "agents/skills/prompt-engineering.md",
      "agents/skills/mental-model.md",
    ],
    lead: [
      "agents/skills/zero-micromanagement.md",
      "agents/skills/active-listener.md",
      "agents/skills/conversational-response.md",
      "agents/skills/till-done.md",
      "agents/skills/mental-model.md",
    ],
    worker: ["agents/skills/active-listener.md", "agents/skills/mental-model.md"],
  };

  const toolsForRole = {
    orchestrator: ["delegate"],
    lead: ["delegate", "read", "grep", "find", "glob"],
    worker: ["read", "write", "edit", "bash", "grep", "find", "glob"],
  };

  const persona = `---
name: ${name}
model: ${model}
expertise: agents/expertise/${slug}.md
max_expertise_lines: 7000
skills:
${skillsForRole[role].map((s) => `  - ${s}`).join("\n")}
tools:
${toolsForRole[role].map((t) => `  - ${t}`).join("\n")}
domain:
  read: ["**/*"]
  write: ["agents/expertise/${slug}.md"]
  update: ["agents/expertise/${slug}.md"]
---

# Purpose

You are ${name} — a ${role} agent.

## Role

[Describe this agent's specific purpose and responsibilities]

## Rules

1. ${role === "worker" ? "Execute tasks as briefed. Be verbose." : "Delegate work to your team. Think, plan, coordinate."}
2. Load your expertise file at session start.
3. Update your mental model after every session.
`;

  const baseDir = join(import.meta.dir, "..");

  const personaPath = join(baseDir, `agents/personas/${slug}.md`);
  const expertisePath = join(baseDir, `agents/expertise/${slug}.md`);

  if (existsSync(personaPath)) {
    console.error(`Agent already exists: ${personaPath}`);
    process.exit(1);
  }

  writeFileSync(personaPath, persona);
  writeFileSync(expertisePath, `# ${name} Expertise\n\n<!-- Auto-maintained by the agent. Do not edit manually. -->\n`);

  console.log(`Created: agents/personas/${slug}.md`);
  console.log(`Created: agents/expertise/${slug}.md`);
  console.log(`\nNext: Add this agent to agents/teams/teams.yaml under the ${team} team.`);
  console.log(`Tip: Edit the persona file to customize the Purpose and Rules sections.`);
}
