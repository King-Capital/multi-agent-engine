import { getFlag, getFlags } from "./cli-utils";
import { provisionLangfuseForMae } from "./langfuse-admin";
import { runRalphLoop } from "./ralph-loop";

function showRalphHelp(): never {
  console.log(`
mae ralph - Advisory self-improvement loop (evaluator + evolver)

Usage:
  mae ralph                    Run the improvement loop (default: 5 iterations)
  mae ralph --iterations 10    Run 10 iterations
  mae ralph --model quality    Use specific model for evaluator/evolver
  mae ralph --trace <id>       Train on a specific trace (repeatable)
  mae ralph --golden-only      Train only on curated golden traces
  mae ralph --recent           Use newest traces instead of high-signal traces
  mae ralph --limit 20         Number of high-signal/recent traces to include

By default Ralph uses high-signal sessions (larger/richer runs) plus
available golden traces. It outputs suggestions only; no files are changed
until a replay/golden verification ratchet is available.
`);
  process.exit(0);
}

function showLangfuseHelp(): never {
  console.log(`
mae langfuse - Configure Langfuse for MAE evaluation

Usage:
  mae langfuse setup          Create MAE score configs and LiteLLM connection
  mae langfuse setup --dry-run  Print the planned score/judge/model setup

Requires:
  LANGFUSE_PUBLIC_KEY + LANGFUSE_SECRET_KEY
  LANGFUSE_HOST                       Defaults to http://localhost:3000
  LANGFUSE_LITELLM_BASE_URL           Or MAE_LLM_GATEWAY_URL/LITELLM_URL/LITELLM_API_BASE
  LANGFUSE_LITELLM_API_KEY            Or MAE_LLM_GATEWAY_KEY/LITELLM_API_KEY

Hosted LLM-as-judge evaluator creation still requires Langfuse UI setup.
This command provisions the score schemas and LiteLLM model connection it should use.
`);
  process.exit(0);
}

export async function handleRalphCommand(args: string[], subHelp: boolean, dryRun: boolean): Promise<void> {
  if (subHelp) showRalphHelp();

  const iterations = parseInt(getFlag(args, "--iterations") ?? "5", 10);
  const ralphModel = getFlag(args, "--model") ?? "quality";
  const traceIds = getFlags(args, "--trace");
  const traceLimit = parseInt(getFlag(args, "--limit") ?? "20", 10);
  const goldenOnly = args.includes("--golden-only");
  const includeGolden = !args.includes("--no-golden");
  const selectionMode = args.includes("--recent") ? "recent" : "high_signal";

  try {
    const result = await runRalphLoop({
      maxIterations: iterations,
      traceIds,
      traceLimit,
      goldenOnly,
      includeGolden,
      selectionMode,
      model: ralphModel,
      dryRun,
    });

    console.log(`\nRalph loop complete:`);
    console.log(`  Training:   ${result.traces.length} trace(s)`);
    console.log(`  Findings:   ${result.findings.length}`);
    console.log(`  Suggested:  ${result.suggestions.length}`);
    console.log(`  Applied:    0 (advisory mode)`);

    if (result.traces.length > 0) {
      console.log(`\nTraining traces:`);
      for (const t of result.traces.slice(0, 12)) {
        const cost = t.totalCost === undefined ? "n/a" : `$${t.totalCost.toFixed(3)}`;
        console.log(`  ${t.sessionId.slice(0, 12)}  score=${t.score.toFixed(2)}  cost=${cost}  errors=${t.errorCount}  ${t.chain || "(no chain)"}`);
        if (t.goal) console.log(`      ${t.goal.slice(0, 100)}`);
      }
      if (result.traces.length > 12) console.log(`  ... ${result.traces.length - 12} more`);
    }

    if (result.findings.length > 0) {
      console.log(`\nFindings:`);
      for (const f of result.findings) {
        console.log(`  [${f.severity}] ${f.type} / ${f.targetType ?? "persona"}:${f.target ?? f.persona}: ${f.suggestion}`);
        console.log(`      ${f.evidence.slice(0, 140)}`);
      }
    }

    if (result.suggestions.length > 0) {
      console.log(`\nSuggestions:`);
      for (const m of result.suggestions) {
        console.log(`  [?] ${m.targetType}:${m.target} ${m.field}.${m.action}${m.file ? ` (${m.file})` : ""}`);
        console.log(`      ${m.change}`);
        console.log(`      ${m.reason}`);
        if (m.verification) console.log(`      Verify: ${m.verification}`);
        if (m.diffPreview) {
          console.log(`      Diff preview:`);
          for (const line of m.diffPreview.split("\n").slice(0, 8)) console.log(`        ${line}`);
        }
      }
    } else {
      const reason = result.findings.length > 0
        ? "findings were produced, but the evolver did not return parseable suggestions."
        : "traces look healthy.";
      console.log(`\nNo suggestions proposed - ${reason}`);
    }
  } catch (err: unknown) {
    console.error(`Ralph loop failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

export async function handleLangfuseCommand(args: string[], subHelp: boolean, dryRun: boolean): Promise<void> {
  if (subHelp) showLangfuseHelp();

  const sub = args[1];
  if (sub !== "setup") {
    console.error("Usage: mae langfuse setup [--dry-run]");
    process.exit(1);
  }

  try {
    const result = await provisionLangfuseForMae({ dryRun });
    console.log(`\nLangfuse MAE setup ${result.dryRun ? "plan" : "result"}:`);
    console.log(`  Host:       ${result.plan.host}`);
    console.log(`  Connection: ${result.plan.llmConnection.name} -> ${result.plan.llmConnection.baseUrl || "(missing base URL)"}`);
    console.log(`  Models:     ${result.plan.llmConnection.customModels.join(", ") || "(none)"}`);

    console.log(`\nScore configs:`);
    for (const cfg of result.scoreConfigs) {
      console.log(`  [${cfg.status}] ${cfg.name}${cfg.message ? ` - ${cfg.message}` : ""}`);
    }

    console.log(`\nJudge configs:`);
    for (const judge of result.plan.judgeConfigs) {
      console.log(`  ${judge.name}: score=${judge.scoreName}, model=${judge.model}, type=${judge.scoreType}`);
    }

    console.log(`\nLLM connection: [${result.llmConnection.status}] ${result.llmConnection.name}${result.llmConnection.message ? ` - ${result.llmConnection.message}` : ""}`);
    console.log(`\nNote: create hosted Langfuse evaluators from the Judge configs above, using the MAE LiteLLM connection.`);
  } catch (err: unknown) {
    console.error(`Langfuse setup failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
