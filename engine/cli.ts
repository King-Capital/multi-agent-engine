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
import { readFileSync as readFile, writeFileSync, existsSync, readdirSync } from "fs";
import { join, resolve } from "path";
import { getFlag, stripFlags, slugify } from "./cli-utils";
import { startDesignGallery } from "./design-gallery";
import { loadFileReferences, loadUrlReferences, scanProjectDesign } from "./reference-loader";

const args = process.argv.slice(2);

if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
  console.log(`
Multi-Agent Orchestration Engine v${(() => { try { return readFile(join(import.meta.dir, "..", "VERSION"), "utf-8").trim(); } catch { return "?"; } })()}

Commands:
  run           Run a prompt workflow          mae run --help
  chain         Run a named chain              mae chain --help
  task          Quick task (plan-build-review)  mae task --help
  session       List/manage sessions           mae session --help
  config    ◆   Configure models & budgets     mae config --help
  new-team  ◆   Create a new agent team        mae new-team --help
  new-agent     Scaffold a single agent        mae new-agent <name> [role] [team] [model]
  learn         Build expertise from sources   mae learn --help
  expert    ◆   Interactive expert session      mae expert --help
  validate-agent  Test expertise quality        mae validate-agent --help
  design    ◆   Design session or review        mae design --help
  discover      Discover A2A agents            mae discover <url>
  info          System overview                mae info
  version       Version info                   mae version
  adapters      List adapters                  mae adapters

  ◆ = interactive TUI available (arrow-key navigation)

Run 'mae <command> --help' for details on any command.
  `);
  process.exit(0);
}

const subHelp = args[1] === "--help" || args[1] === "-h";

function showSubHelp(text: string): never {
  console.log(text);
  process.exit(0);
}

const command = args[0];
const isLocal = args.includes("--local") || process.env.MAE_LOCAL === "1";
const dashboardUrl = isLocal ? "http://localhost:8400" : (getFlag(args, "--dashboard") ?? process.env.MAE_DASHBOARD_URL ?? "http://localhost:8400");
const adapterName = getFlag(args, "--adapter");
const workingDir = resolve(getFlag(args, "--cwd") ?? process.cwd());
const dryRun = args.includes("--dry-run");

// A2A configuration
const a2aUrl = getFlag(args, "--a2a-url") ?? process.env.MAE_A2A_URL;
const a2aToken = getFlag(args, "--a2a-token") ?? process.env.MAE_A2A_TOKEN;

const apiToken = getFlag(args, "--api-token") ?? process.env.MAE_API_TOKEN;
const orch = new Orchestrator(dashboardUrl, apiToken);

// Set up A2A adapter with endpoint if configured
const a2aAdapter = new A2AAdapter();
if (a2aUrl) {
  a2aAdapter.setDefaultEndpoint({
    url: a2aUrl,
    token: a2aToken,
  });
}

const adapters = [
  new EchoAdapter(),
  new PiAdapter(),
  a2aAdapter,
];

for (const adapter of adapters) {
  orch.registerAdapter(adapter);
}

if (dryRun) {
  orch.setDefaultAdapter("echo");
} else if (adapterName) {
  orch.setDefaultAdapter(adapterName);
} else {
  for (const adapter of adapters) {
    if (adapter.name !== "echo" && adapter.name !== "a2a" && await adapter.isAvailable()) {
      orch.setDefaultAdapter(adapter.name);
      console.log(`[cli] Using adapter: ${adapter.name}`);
      break;
    }
  }
}

// Graceful shutdown handler
let shuttingDown = false;
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[cli] Received ${sig}, shutting down gracefully...`);
    orch.shutdown().then(() => process.exit(0)).catch(() => process.exit(1));
    setTimeout(() => { console.error("[cli] Shutdown timed out, forcing exit"); process.exit(1); }, 10_000);
  });
}

switch (command) {
  case "run": {
    if (subHelp) showSubHelp(`
mae run — Run a prompt workflow

Usage: mae run <prompt-name> [args...]

Prompts:  ${(() => { try { return readdirSync(join(import.meta.dir, "..", "prompts")).filter((f: string) => f.endsWith(".md") && f !== "BASE.md").map((f: string) => f.replace(".md", "")).join(", "); } catch { return "plan-build-review, review, scout, swarm-review, ..."; }})()}

Options:
  --adapter <name>     Use specific adapter (pi, a2a, echo)
  --dry-run            Use echo adapter for testing
  --cwd <path>         Working directory for agents

Examples:
  mae run plan-build-review "Add input validation to auth"
  mae run review "git diff HEAD~1"
  mae run swarm-review "Review engine/ for bugs"
  mae run scout "engine/"
`);
    const promptName = args[1];
    if (!promptName) {
      console.error("Usage: mae run <prompt-name> [args...]\nRun 'mae run --help' for available prompts.");
      process.exit(1);
    }
    const promptArgs = stripFlags(args.slice(2));
    const session = await orch.run({
      prompt: promptName,
      task: promptArgs.join(" "),
      args: promptArgs,
      adapter: dryRun ? "echo" : adapterName,
      workingDir,
    });
    console.log(`\nSession ${session.id} ${session.status}. Cost: $${session.totalCost.toFixed(3)}`);
    break;
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
  mae chain build-verify "Fix the login bug"
  mae chain review-only "Review auth module"
  mae chain plan-build-review "Add caching layer"
`);
    }
    const chainName = args[1];
    const task = stripFlags(args.slice(2)).join(" ");
    if (!chainName || !task) {
      console.error("Usage: mae chain <chain-name> <task>\nRun 'mae chain --help' for available chains.");
      process.exit(1);
    }
    const session = await orch.run({
      chain: chainName,
      task,
      adapter: dryRun ? "echo" : adapterName,
      workingDir,
    });
    console.log(`\nSession ${session.id} ${session.status}. Cost: $${session.totalCost.toFixed(3)}`);
    break;
  }

  case "task": {
    if (subHelp) showSubHelp(`
mae task — Quick task using plan-build-review chain

Usage: mae task <task-description>

Runs the default plan-build-review chain: plan → build → typecheck → validate.

Options:
  --adapter <name>     Use specific adapter
  --dry-run            Use echo adapter for testing
  --cwd <path>         Working directory for agents

Examples:
  mae task "Add rate limiting to API endpoints"
  mae task "Fix the auth bug in login.ts"
  mae task "Add unit tests for budget module" --dry-run
`);
    const task = stripFlags(args.slice(1)).join(" ");
    if (!task) {
      console.error("Usage: mae task <task-description>\nRun 'mae task --help' for details.");
      process.exit(1);
    }
    const session = await orch.run({
      task,
      adapter: dryRun ? "echo" : adapterName,
      workingDir,
    });
    console.log(`\nSession ${session.id} ${session.status}. Cost: $${session.totalCost.toFixed(3)}`);
    break;
  }

  case "discover": {
    const url = args[1];
    if (!url) {
      console.error("Usage: mae discover <url>");
      process.exit(1);
    }
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
  mae session close <id> [--status done]    Close/complete a session

Status options: done, completed, error

Examples:
  mae session list
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
      console.error("Usage: mae session <list|close>");
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
    if (subHelp) showSubHelp(`
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
  mae design review ./my-app --ref screenshot.png --url https://example.com
  mae design build ./dashboard-next --ref brand-guide.pdf
`);
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
    await configInteractive();
    break;

  default:
    console.error(`Unknown command: ${command}`);
    console.error(`Valid commands: run, chain, task, design, session, config, new-team, new-agent, learn, expert, validate-agent, discover, info, version, adapters, tui`);
    process.exit(1);
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
