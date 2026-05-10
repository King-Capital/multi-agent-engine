import { createInterface } from "readline";
import { readFileSync } from "fs";
import { loadModelRouting, writeModelRouting } from "./config";
import { loadPerformance, buildScorecard } from "./perf-log";
import type { ModelRoutingConfig, ThinkingLevel } from "./types";

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function printDivider(char = "─", len = 50) {
  console.log(char.repeat(len));
}

function getAvailableModels(config: ModelRoutingConfig): string[] {
  const models = new Set<string>();
  for (const tier of Object.values(config.tiers ?? {})) {
    if (tier.default) models.add(tier.default);
    for (const opt of tier.options ?? []) models.add(opt.model);
  }
  return [...models];
}

// --- Show ---

export async function configShow(): Promise<void> {
  const config = loadModelRouting();

  console.log("\nMAE Configuration");
  printDivider();

  if (config.budgets) {
    const b = config.budgets;
    console.log(`  Budget:   $${b.max_per_session_usd}/session  $${b.max_per_agent_usd}/agent  warn at $${b.warn_at_usd}`);
    console.log(`            ${(b.max_total_tokens / 1_000_000).toFixed(0)}M token limit`);
  }

  console.log("\n  Tiers:");
  for (const [name, tier] of Object.entries(config.tiers ?? {})) {
    const opts = tier.options?.length ?? 0;
    console.log(`    ${name.padEnd(10)} default: ${tier.default.padEnd(28)} thinking: ${tier.default_thinking}  (${opts} options)`);
  }

  if (config.aliases) {
    const aliasStr = Object.entries(config.aliases).map(([k, v]) => {
      const short = v.split("/").pop() ?? v;
      return `${k}→${short}`;
    }).join("  ");
    console.log(`\n  Aliases:  ${aliasStr}`);
  }

  if (config.roleDefaults) {
    const roleStr = Object.entries(config.roleDefaults).map(([k, v]) => `${k}→${v.tier}`).join("  ");
    console.log(`  Roles:    ${roleStr}`);
  }

  if (config.crossModelPairs?.length) {
    console.log(`\n  Cross-model pairs: ${config.crossModelPairs.length}`);
    for (const pair of config.crossModelPairs) {
      const b = pair.builder.split("/").pop() ?? pair.builder;
      const v = pair.verifier.split("/").pop() ?? pair.verifier;
      console.log(`    ${b} ↔ ${v}`);
    }
  }

  // Model Performance Scorecard
  const records = await loadPerformance();
  if (records.length > 0) {
    const scores = buildScorecard(records);
    if (scores.length > 0) {
      console.log(`\n  Model Performance (${records.length} runs):`);
      for (const s of scores) {
        const modelShort = s.model.split("/").pop() ?? s.model;
        const label = `${modelShort}/${s.role}:`.padEnd(30);
        const latencySec = (s.avg_latency_ms / 1000).toFixed(0);
        console.log(`    ${label} ${s.pass_rate.toFixed(0)}% pass, $${s.avg_cost_usd.toFixed(2)} avg, ${s.avg_findings.toFixed(1)} findings, ${latencySec}s avg`);
      }
    }
  }

  console.log();
}

// --- Export ---

export function configExport(): void {
  const config = loadModelRouting();
  console.log(JSON.stringify(config, null, 2));
}

// --- Import ---

export async function configImport(fileOrStdin?: string): Promise<void> {
  let json: string;
  if (!fileOrStdin || fileOrStdin === "-") {
    json = readFileSync("/dev/stdin", "utf-8");
  } else {
    json = readFileSync(fileOrStdin, "utf-8");
  }

  let partial: Partial<ModelRoutingConfig>;
  try {
    partial = JSON.parse(json);
  } catch {
    console.error("Error: Invalid JSON");
    process.exit(1);
  }

  const current = loadModelRouting();
  const merged: ModelRoutingConfig = {
    ...current,
    ...partial,
    tiers: { ...current.tiers, ...partial.tiers },
    aliases: { ...current.aliases, ...partial.aliases },
    roleDefaults: { ...current.roleDefaults, ...partial.roleDefaults },
  };

  if (partial.budgets) {
    merged.budgets = { ...current.budgets, ...partial.budgets };
  }
  if (partial.crossModelPairs) {
    merged.crossModelPairs = partial.crossModelPairs;
  }

  writeModelRouting(merged);
  console.log("Config updated successfully.");
  await configShow();
}

// --- Discover ---

export async function configDiscover(): Promise<void> {
  const config = loadModelRouting();
  const gatewayUrl = process.env.MAE_LLM_GATEWAY_URL ?? process.env.LITELLM_URL;
  if (!gatewayUrl) {
    console.error("Error: MAE_LLM_GATEWAY_URL not set. Configure in ~/.mae/config");
    return;
  }
  const apiKey = process.env.MAE_LLM_GATEWAY_KEY ?? process.env.LITELLM_API_KEY ?? "";

  const models = new Set<string>();
  for (const tier of Object.values(config.tiers ?? {})) {
    if (tier.default) models.add(tier.default);
    for (const opt of tier.options ?? []) {
      models.add(opt.model);
    }
  }

  console.log(`\nProbing ${models.size} models via ${gatewayUrl}...\n`);

  for (const model of models) {
    const start = Date.now();
    try {
      const resp = await fetch(`${gatewayUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "Reply with just the word ok." }],
          max_tokens: 5,
        }),
        signal: AbortSignal.timeout(15000),
      });
      const latencyMs = Date.now() - start;
      if (resp.ok) {
        console.log(`  ${model.padEnd(30)} ✓  ${String(latencyMs).padStart(5)}ms`);
      } else {
        const body = await resp.text().catch(() => "");
        console.log(`  ${model.padEnd(30)} ✗  ${String(latencyMs).padStart(5)}ms  HTTP ${resp.status} ${body.slice(0, 60)}`);
      }
    } catch (e: any) {
      const latencyMs = Date.now() - start;
      console.log(`  ${model.padEnd(30)} ✗  ${String(latencyMs).padStart(5)}ms  ${e.message?.slice(0, 40) ?? "error"}`);
    }
  }
  console.log();
}

// --- Interactive TUI ---

export async function configInteractive(): Promise<void> {
  let running = true;
  while (running) {
    console.log("\nMAE Configuration");
    printDivider();
    console.log("  1. Show current config");
    console.log("  2. Budget settings");
    console.log("  3. Model tiers");
    console.log("  4. Aliases");
    console.log("  5. Role defaults");
    console.log("  6. Discover models");
    console.log("  7. Export as JSON");
    console.log("  q. Quit");

    const choice = await prompt("\n> ");
    switch (choice) {
      case "1": await configShow(); break;
      case "2": await budgetMenu(); break;
      case "3": await tiersMenu(); break;
      case "4": await aliasesMenu(); break;
      case "5": await roleDefaultsMenu(); break;
      case "6": await configDiscover(); break;
      case "7": configExport(); break;
      case "q": case "Q": case "": running = false; break;
      default: console.log("Invalid choice.");
    }
  }
}

async function budgetMenu(): Promise<void> {
  const config = loadModelRouting();
  const b = config.budgets ?? { max_per_session_usd: 50, warn_at_usd: 25, max_per_agent_usd: 15, max_total_tokens: 10_000_000 };

  console.log("\n  Budget Settings");
  printDivider("─", 40);
  console.log(`  Session limit:  $${b.max_per_session_usd}`);
  console.log(`  Agent limit:    $${b.max_per_agent_usd}`);
  console.log(`  Warn at:        $${b.warn_at_usd}`);
  console.log(`  Token limit:    ${(b.max_total_tokens / 1_000_000).toFixed(0)}M`);

  console.log("\n  1. Edit values");
  console.log("  2. Reset to defaults");
  console.log("  b. Back");

  const choice = await prompt("\n> ");
  if (choice === "1") {
    console.log("  Enter new values (empty to keep current):");
    const session = await prompt(`  Session limit [$${b.max_per_session_usd}]: `);
    const agent = await prompt(`  Agent limit [$${b.max_per_agent_usd}]: `);
    const warn = await prompt(`  Warn at [$${b.warn_at_usd}]: `);

    if (session) {
      const parsed = parseFloat(session);
      if (isNaN(parsed)) { console.error("Invalid number: " + session); return; }
      b.max_per_session_usd = parsed;
    }
    if (agent) {
      const parsed = parseFloat(agent);
      if (isNaN(parsed)) { console.error("Invalid number: " + agent); return; }
      b.max_per_agent_usd = parsed;
    }
    if (warn) {
      const parsed = parseFloat(warn);
      if (isNaN(parsed)) { console.error("Invalid number: " + warn); return; }
      b.warn_at_usd = parsed;
    }

    config.budgets = b;
    writeModelRouting(config);
    console.log("  Budget updated.");
  } else if (choice === "2") {
    config.budgets = { max_per_session_usd: 50, warn_at_usd: 25, max_per_agent_usd: 15, max_total_tokens: 10_000_000 };
    writeModelRouting(config);
    console.log("  Budget reset to defaults.");
  }
}

async function tiersMenu(): Promise<void> {
  const config = loadModelRouting();

  console.log("\n  Model Tiers");
  printDivider("─", 40);
  const tierNames = Object.keys(config.tiers ?? {});
  for (let i = 0; i < tierNames.length; i++) {
    const name = tierNames[i]!;
    const tier = config.tiers[name]!;
    console.log(`  ${i + 1}. ${name.padEnd(10)} default: ${tier.default}`);
    console.log(`                  thinking: ${tier.default_thinking}`);
    for (const opt of tier.options ?? []) {
      console.log(`                  - ${opt.model} (${opt.thinking})`);
    }
  }
  console.log("  b. Back");

  const choice = await prompt("\n  Edit tier (1-" + tierNames.length + "): ");
  const idx = parseInt(choice) - 1;
  if (idx >= 0 && idx < tierNames.length) {
    const name = tierNames[idx]!;
    const tier = config.tiers[name]!;
    const models = tier.options?.map(o => o.model) ?? [tier.default];

    console.log(`\n  Current default: ${tier.default}`);
    for (let i = 0; i < models.length; i++) {
      console.log(`    ${i + 1}. ${models[i]}`);
    }
    const modelChoice = await prompt("  New default (number, model name, or empty to keep): ");
    if (modelChoice) {
      const modelIdx = parseInt(modelChoice) - 1;
      if (modelIdx >= 0 && modelIdx < models.length) {
        tier.default = models[modelIdx]!;
      } else {
        tier.default = modelChoice;
      }
    }

    const thinkingLevels: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
    const thinking = await prompt(`  Thinking [${tier.default_thinking}] (${thinkingLevels.join("/")} or empty to keep): `);
    if (thinking && thinkingLevels.includes(thinking as ThinkingLevel)) {
      tier.default_thinking = thinking;
    }

    if (modelChoice || thinking) {
      writeModelRouting(config);
      console.log(`  Tier "${name}" updated.`);
    }
  }
}

async function aliasesMenu(): Promise<void> {
  const config = loadModelRouting();

  console.log("\n  Model Aliases");
  printDivider("─", 40);
  for (const [alias, model] of Object.entries(config.aliases ?? {})) {
    console.log(`  ${alias.padEnd(12)} → ${model}`);
  }

  console.log("\n  1. Add/edit alias");
  console.log("  2. Remove alias");
  console.log("  b. Back");

  const choice = await prompt("\n> ");
  if (choice === "1") {
    const models = getAvailableModels(config);
    console.log(`\n  Available models: ${models.join(", ")}`);
    const alias = await prompt("  Alias name (empty to cancel): ");
    if (!alias) return;
    const model = await prompt("  Model (empty to cancel): ");
    if (!model) return;
    if (!config.aliases) config.aliases = {};
    config.aliases[alias] = model;
    writeModelRouting(config);
    console.log(`  Alias "${alias}" → "${model}" saved.`);
  } else if (choice === "2") {
    const existing = Object.keys(config.aliases ?? {});
    if (existing.length === 0) { console.log("  No aliases to remove."); return; }
    console.log(`  Existing: ${existing.join(", ")}`);
    const alias = await prompt("  Alias to remove (empty to cancel): ");
    if (!alias) return;
    if (config.aliases?.[alias]) {
      delete config.aliases[alias];
      writeModelRouting(config);
      console.log(`  Alias "${alias}" removed.`);
    } else {
      console.log(`  Alias "${alias}" not found.`);
    }
  }
}

async function roleDefaultsMenu(): Promise<void> {
  const config = loadModelRouting();
  const tierNames = Object.keys(config.tiers ?? {});

  console.log("\n  Role Defaults");
  printDivider("─", 40);
  const roles = Object.keys(config.roleDefaults ?? {});
  for (let i = 0; i < roles.length; i++) {
    const role = roles[i]!;
    const defaults = config.roleDefaults[role]!;
    console.log(`  ${(i + 1)}. ${role.padEnd(14)} tier: ${defaults.tier.padEnd(8)} thinking: ${defaults.thinking}`);
  }
  console.log("  b. Back");

  const choice = await prompt("\n  Edit role (1-" + roles.length + "): ");
  const idx = parseInt(choice) - 1;
  if (idx >= 0 && idx < roles.length) {
    const role = roles[idx]!;
    const defaults = config.roleDefaults[role]!;

    const tier = await prompt(`  Tier [${defaults.tier}] (${tierNames.join("/")} or empty to keep): `);
    if (tier && tierNames.includes(tier)) {
      defaults.tier = tier;
    }

    const thinkingLevels: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
    const thinking = await prompt(`  Thinking [${defaults.thinking}] (${thinkingLevels.join("/")} or empty to keep): `);
    if (thinking && thinkingLevels.includes(thinking as ThinkingLevel)) {
      defaults.thinking = thinking as ThinkingLevel;
    }

    if (tier || thinking) {
      writeModelRouting(config);
      console.log(`  Role "${role}" updated.`);
    }
  }
}
