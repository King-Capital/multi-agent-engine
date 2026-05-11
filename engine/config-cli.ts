import * as p from "@clack/prompts";
import { readFileSync } from "fs";
import { loadModelRouting, writeModelRouting } from "./config";
import { loadPerformance, buildScorecard } from "./perf-log";
import type { ModelRoutingConfig, ThinkingLevel } from "./types";
import { createLogger } from "./logger";

const log = createLogger("config-cli");

const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
const DEFAULT_BUDGETS = { max_per_session_usd: 50, warn_at_usd: 25, max_per_agent_usd: 15, max_total_tokens: 10_000_000 };

function getAvailableModels(config: ModelRoutingConfig): string[] {
  const models = new Set<string>();
  for (const tier of Object.values(config.tiers ?? {})) {
    if (tier.default) models.add(tier.default);
    for (const opt of tier.options ?? []) models.add(opt.model);
  }
  return [...models];
}

export async function configShow(): Promise<void> {
  const config = loadModelRouting();
  console.log("\nMAE Configuration");
  console.log("─".repeat(50));
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
    const aliasStr = Object.entries(config.aliases)
      .map(([k, v]) => `${k}→${v.split("/").pop() ?? v}`).join("  ");
    console.log(`\n  Aliases:  ${aliasStr}`);
  }
  if (config.roleDefaults) {
    const roleStr = Object.entries(config.roleDefaults).map(([k, v]) => `${k}→${v.tier}`).join("  ");
    console.log(`  Roles:    ${roleStr}`);
  }
  if (config.crossModelPairs?.length) {
    console.log(`\n  Cross-model pairs: ${config.crossModelPairs.length}`);
    for (const pair of config.crossModelPairs) {
      console.log(`    ${(pair.builder.split("/").pop() ?? pair.builder)} ↔ ${(pair.verifier.split("/").pop() ?? pair.verifier)}`);
    }
  }
  const records = await loadPerformance();
  if (records.length > 0) {
    const scores = buildScorecard(records);
    if (scores.length > 0) {
      console.log(`\n  Model Performance (${records.length} runs):`);
      for (const s of scores) {
        const label = `${(s.model.split("/").pop() ?? s.model)}/${s.role}:`.padEnd(30);
        console.log(`    ${label} ${s.pass_rate.toFixed(0)}% pass, $${s.avg_cost_usd.toFixed(2)} avg, ${s.avg_findings.toFixed(1)} findings, ${(s.avg_latency_ms / 1000).toFixed(0)}s avg`);
      }
    }
  }
  console.log();
}

export function configExport(): void {
  const config = loadModelRouting();
  console.log(JSON.stringify(config, null, 2));
}

export async function configImport(fileOrStdin?: string): Promise<void> {
  const json = readFileSync(!fileOrStdin || fileOrStdin === "-" ? "/dev/stdin" : fileOrStdin, "utf-8");
  let partial: Partial<ModelRoutingConfig>;
  try { partial = JSON.parse(json); } catch { log.error("Invalid JSON input"); process.exit(1); }

  const current = loadModelRouting();
  const merged: ModelRoutingConfig = {
    ...current, ...partial,
    tiers: { ...current.tiers, ...partial.tiers },
    aliases: { ...current.aliases, ...partial.aliases },
    roleDefaults: { ...current.roleDefaults, ...partial.roleDefaults },
  };
  if (partial.budgets) merged.budgets = { ...current.budgets, ...partial.budgets };
  if (partial.crossModelPairs) merged.crossModelPairs = partial.crossModelPairs;

  writeModelRouting(merged);
  console.log("Config updated successfully.");
  await configShow();
}

export async function configDiscover(): Promise<void> {
  const config = loadModelRouting();
  const gatewayUrl = process.env.MAE_LLM_GATEWAY_URL ?? process.env.LITELLM_URL;
  if (!gatewayUrl) { p.log.error("MAE_LLM_GATEWAY_URL not set. Configure in ~/.mae/config"); return; }
  const apiKey = process.env.MAE_LLM_GATEWAY_KEY ?? process.env.LITELLM_API_KEY ?? "";
  const models = new Set<string>();
  for (const tier of Object.values(config.tiers ?? {})) {
    if (tier.default) models.add(tier.default);
    for (const opt of tier.options ?? []) models.add(opt.model);
  }
  const s = p.spinner();
  s.start(`Probing ${models.size} models via ${gatewayUrl}`);
  const results: string[] = [];
  for (const model of models) {
    const start = Date.now();
    try {
      const resp = await fetch(`${gatewayUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply with just the word ok." }], max_tokens: 5 }),
        signal: AbortSignal.timeout(15000),
      });
      const ms = Date.now() - start;
      if (resp.ok) results.push(`${model.padEnd(30)} ✓  ${String(ms).padStart(5)}ms`);
      else {
        const body = await resp.text().catch(() => "");
        results.push(`${model.padEnd(30)} ✗  ${String(ms).padStart(5)}ms  HTTP ${resp.status} ${body.slice(0, 60)}`);
      }
    } catch (e: any) {
      results.push(`${model.padEnd(30)} ✗  ${String(Date.now() - start).padStart(5)}ms  ${e.message?.slice(0, 40) ?? "error"}`);
    }
  }
  s.stop(`Probed ${models.size} models`);
  p.note(results.join("\n"), "Discovery Results");
}

export async function configInteractive(): Promise<void> {
  p.intro("MAE Configuration");

  while (true) {
    const config = loadModelRouting();
    const b = config.budgets ?? DEFAULT_BUDGETS;
    const tierEntries = Object.entries(config.tiers ?? {});
    const aliasCount = Object.keys(config.aliases ?? {}).length;
    const roleCount = Object.keys(config.roleDefaults ?? {}).length;

    const tierHint = tierEntries.map(([n, t]) => {
      const short = t.default.split("/").pop() ?? t.default;
      return `${n}→${short}`;
    }).join(", ");

    const section = await p.select({
      message: "Pick a section to configure",
      options: [
        { value: "budget", label: "Budget settings", hint: `$${b.max_per_session_usd}/session, $${b.max_per_agent_usd}/agent, warn at $${b.warn_at_usd}` },
        { value: "tiers", label: "Model tiers", hint: tierHint },
        { value: "aliases", label: "Aliases", hint: `${aliasCount} aliases configured` },
        { value: "roles", label: "Role defaults", hint: `${roleCount} roles configured` },
        { value: "discover", label: "Discover models", hint: "Probe configured models via LiteLLM" },
        { value: "export", label: "Export as JSON" },
        { value: "show", label: "Show full config" },
        { value: "quit", label: "Quit" },
      ],
    });
    if (p.isCancel(section) || section === "quit") break;

    switch (section) {
      case "budget": await budgetMenu(); break;
      case "tiers": await tiersMenu(); break;
      case "aliases": await aliasesMenu(); break;
      case "roles": await roleDefaultsMenu(); break;
      case "discover": await configDiscover(); break;
      case "export": configExport(); break;
      case "show": await configShow(); break;
    }
  }

  p.outro("Done.");
}

async function budgetMenu(): Promise<void> {
  const config = loadModelRouting();
  const b = config.budgets ?? { ...DEFAULT_BUDGETS };

  p.note(
    `Session: $${b.max_per_session_usd}  Agent: $${b.max_per_agent_usd}  Warn: $${b.warn_at_usd}  Tokens: ${(b.max_total_tokens / 1_000_000).toFixed(0)}M`,
    "Current Budget",
  );

  const action = await p.select({
    message: "Budget action",
    options: [
      { value: "edit", label: "Edit values" },
      { value: "reset", label: "Reset to defaults" },
      { value: "back", label: "← Back" },
    ],
  });
  if (p.isCancel(action) || action === "back") return;

  if (action === "edit") {
    const session = await p.text({ message: "Session limit ($)", defaultValue: String(b.max_per_session_usd), validate: validateNumber });
    if (p.isCancel(session)) return;
    const agent = await p.text({ message: "Agent limit ($)", defaultValue: String(b.max_per_agent_usd), validate: validateNumber });
    if (p.isCancel(agent)) return;
    const warn = await p.text({ message: "Warn at ($)", defaultValue: String(b.warn_at_usd), validate: validateNumber });
    if (p.isCancel(warn)) return;

    b.max_per_session_usd = parseFloat(session);
    b.max_per_agent_usd = parseFloat(agent);
    b.warn_at_usd = parseFloat(warn);
    config.budgets = b;
    writeModelRouting(config);
    p.log.success("Budget updated.");
  } else {
    const ok = await p.confirm({ message: "Reset budget to defaults?" });
    if (p.isCancel(ok) || !ok) return;
    config.budgets = { ...DEFAULT_BUDGETS };
    writeModelRouting(config);
    p.log.success("Budget reset to defaults.");
  }
}

async function tiersMenu(): Promise<void> {
  const config = loadModelRouting();
  const tierEntries = Object.entries(config.tiers ?? {});
  if (tierEntries.length === 0) { p.log.warn("No tiers configured."); return; }

  const tierName = await p.select({
    message: "Select tier to edit",
    options: [
      ...tierEntries.map(([name, tier]) => ({
        value: name,
        label: name,
        hint: `default: ${tier.default}  thinking: ${tier.default_thinking}`,
      })),
      { value: "back", label: "← Back" },
    ],
  });
  if (p.isCancel(tierName) || tierName === "back") return;

  const tier = config.tiers[tierName]!;
  const modelOptions = tier.options?.map(o => o.model) ?? [tier.default];

  const newDefault = await p.select({
    message: `Default model for "${tierName}"`,
    options: [
      ...modelOptions.map(m => ({
        value: m,
        label: m,
        hint: m === tier.default ? "(current)" : undefined,
      })),
      { value: "back", label: "← Back" },
    ],
    initialValue: tier.default,
  });
  if (p.isCancel(newDefault) || newDefault === "back") return;

  const newThinking = await p.select({
    message: `Thinking level for "${tierName}"`,
    options: THINKING_LEVELS.map(t => ({
      value: t,
      label: t,
      hint: t === tier.default_thinking ? "(current)" : undefined,
    })),
    initialValue: tier.default_thinking,
  });
  if (p.isCancel(newThinking)) return;

  const changed = newDefault !== tier.default || newThinking !== tier.default_thinking;
  if (!changed) { p.log.info("No changes."); return; }

  const ok = await p.confirm({ message: `Set "${tierName}" to ${newDefault} / ${newThinking}?` });
  if (p.isCancel(ok) || !ok) return;

  tier.default = newDefault;
  tier.default_thinking = newThinking;
  writeModelRouting(config);
  p.log.success(`Tier "${tierName}" updated.`);
}

async function aliasesMenu(): Promise<void> {
  const config = loadModelRouting();
  const existing = Object.entries(config.aliases ?? {});

  if (existing.length > 0) {
    const lines = existing.map(([k, v]) => `${k} → ${v}`).join("\n");
    p.note(lines, "Current Aliases");
  }

  const action = await p.select({
    message: "Alias action",
    options: [
      { value: "add", label: "Add / edit alias" },
      { value: "remove", label: "Remove alias", hint: existing.length === 0 ? "none to remove" : undefined },
      { value: "back", label: "← Back" },
    ],
  });
  if (p.isCancel(action) || action === "back") return;

  if (action === "add") {
    const models = getAvailableModels(config);
    const alias = await p.text({ message: "Alias name", placeholder: "my-alias", validate: v => { if (!v) return "Required"; } });
    if (p.isCancel(alias)) return;

    const model = await p.select({
      message: "Target model",
      options: models.map(m => ({ value: m, label: m })),
    });
    if (p.isCancel(model)) return;

    if (!config.aliases) config.aliases = {};
    config.aliases[alias] = model;
    writeModelRouting(config);
    p.log.success(`Alias "${alias}" → "${model}" saved.`);
  } else {
    if (existing.length === 0) { p.log.warn("No aliases to remove."); return; }

    const alias = await p.select({
      message: "Alias to remove",
      options: existing.map(([k, v]) => ({ value: k, label: k, hint: v })),
    });
    if (p.isCancel(alias)) return;

    const ok = await p.confirm({ message: `Remove alias "${alias}"?` });
    if (p.isCancel(ok) || !ok) return;

    delete config.aliases![alias];
    writeModelRouting(config);
    p.log.success(`Alias "${alias}" removed.`);
  }
}

async function roleDefaultsMenu(): Promise<void> {
  const config = loadModelRouting();
  const tierNames = Object.keys(config.tiers ?? {});
  const roleEntries = Object.entries(config.roleDefaults ?? {});
  if (roleEntries.length === 0) { p.log.warn("No role defaults configured."); return; }

  const role = await p.select({
    message: "Select role to edit",
    options: [
      ...roleEntries.map(([name, defaults]) => ({
        value: name,
        label: name,
        hint: `tier: ${defaults.tier}  thinking: ${defaults.thinking}`,
      })),
      { value: "back", label: "← Back" },
    ],
  });
  if (p.isCancel(role) || role === "back") return;

  const defaults = config.roleDefaults[role]!;

  const newTier = await p.select({
    message: `Tier for "${role}"`,
    options: tierNames.map(t => ({
      value: t,
      label: t,
      hint: t === defaults.tier ? "(current)" : undefined,
    })),
    initialValue: defaults.tier,
  });
  if (p.isCancel(newTier)) return;

  const newThinking = await p.select({
    message: `Thinking level for "${role}"`,
    options: THINKING_LEVELS.map(t => ({
      value: t,
      label: t,
      hint: t === defaults.thinking ? "(current)" : undefined,
    })),
    initialValue: defaults.thinking,
  });
  if (p.isCancel(newThinking)) return;

  const changed = newTier !== defaults.tier || newThinking !== defaults.thinking;
  if (!changed) { p.log.info("No changes."); return; }

  const ok = await p.confirm({ message: `Set "${role}" to tier=${newTier}, thinking=${newThinking}?` });
  if (p.isCancel(ok) || !ok) return;

  defaults.tier = newTier;
  defaults.thinking = newThinking as ThinkingLevel;
  writeModelRouting(config);
  p.log.success(`Role "${role}" updated.`);
}

function validateNumber(v: string | undefined): string | undefined {
  if (!v) return "Required";
  if (isNaN(parseFloat(v))) return "Must be a number";
}
