#!/usr/bin/env bun
import { Orchestrator } from "./orchestrator";
import { EchoAdapter } from "./adapters/echo";
import { ClaudeCodeAdapter } from "./adapters/claude-code";
import { PiAdapter } from "./adapters/pi";
import { CodexAdapter } from "./adapters/codex";

const args = process.argv.slice(2);

if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
  console.log(`
Multi-Agent Orchestration Engine

Usage:
  agent run <prompt-name> [args...]     Run a reusable prompt workflow
  agent chain <chain-name> <task>       Run a named chain directly
  agent task <task-description>         Run plan-build-review on a task
  agent new-agent <name> <role> <team>  Scaffold a new agent
  agent adapters                        List available adapters

Options:
  --adapter <name>     Use specific adapter (echo, claude-code, pi, codex)
  --dashboard <url>    Dashboard URL (default: http://localhost:8400)
  --token <token>      API token for dashboard auth (or MAE_API_TOKEN env var)
  --dry-run            Use echo adapter for testing

Examples:
  agent run plan-build-review "Add input validation to auth"
  agent run review "git diff HEAD~1"
  agent run parallel-build "Implement caching layer"
  agent chain build-verify "Fix the login bug"
  agent task "Add rate limiting to API endpoints"
  agent new-agent billing-specialist worker Engineering
  `);
  process.exit(0);
}

const command = args[0];
const dashboardUrl = getFlag(args, "--dashboard") ?? process.env.MAE_DASHBOARD_URL ?? "http://localhost:8400";
const apiToken = getFlag(args, "--token") ?? process.env.MAE_API_TOKEN;
const adapterName = getFlag(args, "--adapter");
const workingDir = getFlag(args, "--cwd") ?? process.cwd();
const dryRun = args.includes("--dry-run");

const orch = new Orchestrator(dashboardUrl, apiToken);

const adapters = [
  new EchoAdapter(),
  new ClaudeCodeAdapter(),
  new PiAdapter(),
  new CodexAdapter(),
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
    if (adapter.name !== "echo" && await adapter.isAvailable()) {
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

  case "new-agent": {
    await scaffoldAgent(args.slice(1));
    break;
  }

  case "adapters": {
    console.log("\nAvailable adapters:");
    for (const adapter of adapters) {
      const available = await adapter.isAvailable();
      console.log(`  ${available ? "✓" : "✗"} ${adapter.name}${available ? "" : " (not installed)"}`);
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
