import { addValidatedGoldenTrace, loadTrace, scoreSession } from "./replay";

export interface GoldenGenerationGoal {
  chain: string;
  goal: string;
}

export interface GoldenGenerationRun {
  chain: string;
  goal: string;
  sessionId?: string;
  added: boolean;
  scoreOverall?: "pass" | "partial" | "fail";
  reason?: string;
}

export interface GoldenGenerationResult {
  runs: GoldenGenerationRun[];
  added: number;
  failed: number;
}

export type GoldenGoalRunner = (goal: GoldenGenerationGoal, opts: { adapter: string; dryRun: boolean }) => Promise<{ sessionId: string; output: string }>;

export const DEFAULT_GOLDEN_GOALS: GoldenGenerationGoal[] = [
  {
    chain: "build-verify",
    goal: "Create a tiny TypeScript utility and verify it with a focused test. Keep all scratch files under .goal-runs/build-verify.",
  },
  {
    chain: "scout-then-plan",
    goal: "Inspect the engine replay module and produce a concise implementation plan. Do not edit files.",
  },
  {
    chain: "review-only",
    goal: "Review engine/replay.ts for regression risks and summarize findings only. Do not edit files.",
  },
];

function extractSessionId(output: string): string | undefined {
  const explicit = output.match(/Session\s+([0-9a-fA-F-]{32,36})\s+/);
  if (explicit?.[1]) return explicit[1];
  const logMatch = output.match(/"session_id"\s*:\s*"([0-9a-fA-F-]{32,36})"/);
  return logMatch?.[1];
}

async function defaultRunner(goal: GoldenGenerationGoal, opts: { adapter: string; dryRun: boolean }): Promise<{ sessionId: string; output: string }> {
  const args = ["engine/cli.ts", "task", goal.goal, "--chain", goal.chain, "--adapter", opts.adapter, "--cwd", ".goal-runs"];
  if (opts.dryRun) args.push("--dry-run");
  const proc = Bun.spawn(["bun", ...args], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, MAE_GOAL_RUN_DIR: ".goal-runs" },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const output = `${stdout}\n${stderr}`;
  const sessionId = extractSessionId(output);
  if (!sessionId) throw new Error(`Could not find session id in golden generation output for ${goal.chain}`);
  if (exitCode !== 0) throw new Error(`Golden generation failed for ${goal.chain}: ${output.slice(-800)}`);
  return { sessionId, output };
}

export async function generateGoldenTraces(opts?: {
  adapter?: string;
  dryRun?: boolean;
  goals?: GoldenGenerationGoal[];
  runner?: GoldenGoalRunner;
  traceDirOverride?: string;
}): Promise<GoldenGenerationResult> {
  const adapter = opts?.adapter ?? "echo";
  const dryRun = opts?.dryRun ?? adapter === "echo";
  const goals = opts?.goals ?? DEFAULT_GOLDEN_GOALS;
  const runner = opts?.runner ?? defaultRunner;
  const runs: GoldenGenerationRun[] = [];

  for (const goal of goals) {
    try {
      const { sessionId } = await runner(goal, { adapter, dryRun });
      const trace = loadTrace(sessionId, opts?.traceDirOverride);
      const score = scoreSession(trace);
      if (score.overall !== "pass") {
        runs.push({ ...goal, sessionId, added: false, scoreOverall: score.overall, reason: "score did not pass" });
        continue;
      }
      addValidatedGoldenTrace(sessionId, "pass", `bootstrap:${goal.chain}`, { traceDirOverride: opts?.traceDirOverride });
      runs.push({ ...goal, sessionId, added: true, scoreOverall: score.overall });
    } catch (err: unknown) {
      runs.push({ ...goal, added: false, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  const added = runs.filter((run) => run.added).length;
  return { runs, added, failed: runs.length - added };
}
