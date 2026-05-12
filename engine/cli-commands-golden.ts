import { getFlag } from "./cli-utils";
import { addGoldenTrace, getGoldenTraces, listGoldenCandidates } from "./replay";

function showGoldenHelp(): never {
  console.log(`
mae golden - Manage golden trace references

Usage:
  mae golden add <session_id> [--verdict pass|fail] [--notes "..."]
  mae golden list
  mae golden candidates [--limit 20]
  mae golden candidates --all

Golden traces are reference sessions used for regression detection.
Mark good runs as "pass" and bad runs as "fail" to build a test corpus.
Use candidates to rank bigger/high-signal runs before promotion.
`);
  process.exit(0);
}

function shouldHideCandidate(goalText: string): boolean {
  const goal = goalText.toLowerCase().trim();
  if (!goal) return true;
  if (goal === "list files in the current directory") return true;
  if (goal.includes("output verification test")) return true;
  if (goal.includes("smoke test")) return true;
  return false;
}

function handleGoldenAdd(args: string[]): void {
  const goldenId = args[2];
  if (!goldenId) {
    console.error("Usage: mae golden add <session_id> [--verdict pass|fail] [--notes \"...\"]");
    process.exit(1);
  }

  const verdict = (getFlag(args, "--verdict") ?? "pass") as "pass" | "fail";
  if (verdict !== "pass" && verdict !== "fail") {
    console.error("--verdict must be 'pass' or 'fail'");
    process.exit(1);
  }

  const notes = getFlag(args, "--notes");
  try {
    addGoldenTrace(goldenId, verdict, notes);
    console.log(`Added golden trace: ${goldenId} (${verdict})${notes ? ` - ${notes}` : ""}`);
  } catch (err: unknown) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

function handleGoldenCandidates(args: string[]): void {
  const limit = parseInt(getFlag(args, "--limit") ?? "20", 10);
  const showAll = args.includes("--all");
  const candidateLimit = Math.max(Number.isFinite(limit) ? limit : 20, 20);
  const candidates = listGoldenCandidates(undefined, candidateLimit)
    .filter((c) => showAll || !shouldHideCandidate(c.goal))
    .slice(0, Number.isFinite(limit) ? limit : 20);

  if (candidates.length === 0) {
    console.log("No trace candidates found.");
    return;
  }

  console.log(`\n${"Session ID".padEnd(38)} ${"Rank".padEnd(6)} ${"Score".padEnd(6)} ${"Verdict".padEnd(8)} ${"Status".padEnd(10)} ${"Chain".padEnd(20)} ${"Cost".padEnd(9)} ${"A/S/E".padEnd(9)} Golden  Goal`);
  console.log("-".repeat(150));
  for (const c of candidates) {
    const cost = c.totalCost === undefined ? "n/a" : `$${c.totalCost.toFixed(3)}`;
    const ase = `${c.agentCount}/${c.stepCount}/${c.errorCount}`;
    console.log(`${c.sessionId.slice(0, 36).padEnd(38)} ${c.signalScore.toFixed(1).padEnd(6)} ${c.replayScore.toFixed(2).padEnd(6)} ${c.suggestedVerdict.padEnd(8)} ${c.status.slice(0, 9).padEnd(10)} ${c.chain.slice(0, 19).padEnd(20)} ${cost.padEnd(9)} ${ase.padEnd(9)} ${(c.goldenVerdict ?? "-").padEnd(7)} ${(c.goal ?? "").slice(0, 80)}`);
  }

  console.log(`\nPromote with: mae golden add <session_id> --verdict pass --notes "why this is a reference run"`);
  console.log(`Mark known bad with: mae golden add <session_id> --verdict fail --notes "what regression this captures"`);
  if (!showAll) console.log(`Use --all to include smoke/empty/test traces.`);
}

function handleGoldenList(): void {
  const entries = getGoldenTraces();
  if (entries.length === 0) {
    console.log("No golden traces registered.");
    return;
  }

  console.log(`\n${"Session ID".padEnd(40)} ${"Verdict".padEnd(8)} ${"Date".padEnd(12)} Goal`);
  console.log("-".repeat(90));
  for (const entry of entries) {
    console.log(`${entry.sessionId.slice(0, 38).padEnd(40)} ${entry.verdict.padEnd(8)} ${entry.addedAt.padEnd(12)} ${(entry.goal ?? "").slice(0, 40)}`);
  }

  if (entries.some((e) => e.notes)) {
    console.log(`\nNotes:`);
    for (const entry of entries.filter((e) => e.notes)) {
      console.log(`  ${entry.sessionId.slice(0, 12)}: ${entry.notes}`);
    }
  }
}

export async function handleGoldenCommand(args: string[], subHelp: boolean): Promise<void> {
  if (subHelp) showGoldenHelp();

  const goldenSub = args[1];
  if (goldenSub === "add") {
    handleGoldenAdd(args);
  } else if (goldenSub === "candidates") {
    handleGoldenCandidates(args);
  } else if (goldenSub === "list") {
    handleGoldenList();
  } else {
    console.error("Usage: mae golden <add|list|candidates>");
    process.exit(1);
  }
}
