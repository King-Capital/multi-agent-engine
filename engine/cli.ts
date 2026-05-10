#!/usr/bin/env bun
import { Orchestrator } from "./orchestrator";
import { EchoAdapter } from "./adapters/echo";
import { ClaudeCodeAdapter } from "./adapters/claude-code";
import { PiAdapter } from "./adapters/pi";
import { CodexAdapter } from "./adapters/codex";
import { A2AAdapter } from "./adapters/a2a";
import { loadChains, loadModelRouting } from "./config";
import { configShow, configExport, configImport, configDiscover, configInteractive } from "./config-cli";
import { readFileSync as readFile } from "fs";
import { join } from "path";

const args = process.argv.slice(2);

if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
  console.log(`
Multi-Agent Orchestration Engine

Usage:
  agent run <prompt-name> [args...]     Run a reusable prompt workflow
  agent chain <chain-name> <task>       Run a named chain directly
  agent task <task-description>         Run plan-build-review on a task
  agent session list                    List all sessions
  agent session close <id> [--status done|error]  Close a session
  agent new-agent <name> <role> <team>  Scaffold a new agent
  agent version                         Show MAE version and system info
  agent info                            Show detailed system overview
  agent adapters                        List available adapters
  agent discover <url>                  Discover a remote A2A agent

Options:
  --adapter <name>     Use specific adapter (echo, claude-code, pi, codex, a2a)
  --dashboard <url>    Dashboard URL (default: http://localhost:8400)
  --a2a-url <url>      Remote A2A agent URL (sets default A2A endpoint)
  --a2a-token <token>  Bearer token for A2A agent auth
  --dry-run            Use echo adapter for testing

Examples:
  agent run plan-build-review "Add input validation to auth"
  agent run review "git diff HEAD~1"
  agent run parallel-build "Implement caching layer"
  agent chain build-verify "Fix the login bug"
  agent task "Add rate limiting to API endpoints"
  agent task "review auth" --adapter a2a --a2a-url http://localhost:41271
  agent discover http://localhost:41271
  agent session list
  agent session close 2dbc90f5 --status error
  agent new-agent billing-specialist worker Engineering
  `);
  process.exit(0);
}

const command = args[0];
const isLocal = args.includes("--local") || process.env.MAE_LOCAL === "1";
const dashboardUrl = isLocal ? "http://localhost:8400" : (getFlag(args, "--dashboard") ?? process.env.MAE_DASHBOARD_URL ?? "http://localhost:8400");
const adapterName = getFlag(args, "--adapter");
const workingDir = getFlag(args, "--cwd") ?? process.cwd();
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
  new ClaudeCodeAdapter(),
  new CodexAdapter(),
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

switch (command) {
  case "run": {
    const promptName = args[1];
    if (!promptName) {
      console.error("Usage: agent run <prompt-name> [args...]");
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
    const chainName = args[1];
    const task = stripFlags(args.slice(2)).join(" ");
    if (!chainName || !task) {
      console.error("Usage: agent chain <chain-name> <task>");
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
    const task = stripFlags(args.slice(1)).join(" ");
    if (!task) {
      console.error("Usage: agent task <task-description>");
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
      console.error("Usage: agent discover <url>");
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
      if (!sessionId) { console.error("Usage: agent session close <id> [--status done|error]"); process.exit(1); }
      const status = getFlag(args, "--status") ?? "completed";
      if (status !== "completed" && status !== "error") {
        console.error("--status must be completed or error"); process.exit(1);
      }
      const resp = await fetch(`${dashUrl}/api/sessions/${sessionId}/status`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ status }),
      });
      if (!resp.ok) { console.error(`Failed: ${resp.status} ${await resp.text()}`); process.exit(1); }
      console.log(`Session ${sessionId} → ${status}`);
    } else {
      console.error("Usage: agent session <list|close>");
      process.exit(1);
    }
    break;
  }

  case "new-agent": {
    await scaffoldAgent(args.slice(1));
    break;
  }

  case "version": {
    const BASE_DIR = process.env.MAE_ROOT ?? join(import.meta.dir, "..");
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
    const BASE_DIR_INFO = process.env.MAE_ROOT ?? join(import.meta.dir, "..");
    const versionFileInfo = join(BASE_DIR_INFO, "VERSION");
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

  default:
    console.error(`Unknown command: ${command}`);
    process.exit(1);
}

async function scaffoldAgent(args: string[]) {
  const name = args[0];
  const role = (args[1] ?? "worker") as "orchestrator" | "lead" | "worker";
  const team = args[2] ?? "Engineering";
  const model = args[3] ?? (role === "worker" ? "main" : "quality");

  if (!name) {
    console.error("Usage: agent new-agent <name> [role] [team] [model]");
    process.exit(1);
  }

  const slug = name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
  if (!slug) {
    console.error("Invalid agent name");
    process.exit(1);
  }

  const skillsForRole = {
    orchestrator: [
      "skills/zero-micromanagement.md",
      "skills/active-listener.md",
      "skills/conversational-response.md",
      "skills/till-done.md",
      "skills/prompt-engineering.md",
      "skills/mental-model.md",
    ],
    lead: [
      "skills/zero-micromanagement.md",
      "skills/active-listener.md",
      "skills/conversational-response.md",
      "skills/till-done.md",
      "skills/mental-model.md",
    ],
    worker: ["skills/active-listener.md", "skills/mental-model.md"],
  };

  const toolsForRole = {
    orchestrator: ["delegate"],
    lead: ["delegate", "read", "grep", "find", "glob"],
    worker: ["read", "write", "edit", "bash", "grep", "find", "glob"],
  };

  const persona = `---
name: ${name}
model: ${model}
expertise: expertise/${slug}.md
max_expertise_lines: 7000
skills:
${skillsForRole[role].map((s) => `  - ${s}`).join("\n")}
tools:
${toolsForRole[role].map((t) => `  - ${t}`).join("\n")}
domain:
  read: ["**/*"]
  write: ["expertise/${slug}.md"]
  update: ["expertise/${slug}.md"]
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

  const { join } = await import("path");
  const { writeFileSync, existsSync } = await import("fs");
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

function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return undefined;
}

function stripFlags(args: string[]): string[] {
  const result: string[] = [];
  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    if (arg.startsWith("--")) {
      if (arg.includes("=")) {
        i++;
      } else {
        i += 2;
      }
    } else {
      result.push(arg);
      i++;
    }
  }
  return result;
}
