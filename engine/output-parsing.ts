import type { DelegateResult, WorkerReview } from "./types";

/**
 * Extract a specific worker's assignment from the lead's briefing output.
 * Returns null if no assignment found or if the assignment says "SKIP:".
 */
export function parseAssignment(leadOutput: string, workerName: string): string | null {
  const pattern = new RegExp(
    `### ASSIGNMENT:\\s*${workerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\n([\\s\\S]*?)(?=### ASSIGNMENT:|$)`, "i"
  );
  const match = leadOutput.match(pattern);
  if (!match?.[1]) return null;
  const assignment = match[1].trim();
  return assignment.startsWith("SKIP:") ? null : assignment;
}

/**
 * Parse the lead's review output into structured WorkerReview objects.
 * If a worker has no review block, they default to PASS.
 */
export function parseReviews(reviewOutput: string, workerResults: DelegateResult[]): WorkerReview[] {
  const reviews: WorkerReview[] = [];

  for (const worker of workerResults) {
    const pattern = new RegExp(
      `### REVIEW:\\s*${worker.agentName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\n([\\s\\S]*?)(?=### REVIEW:|$)`, "i"
    );
    const match = reviewOutput.match(pattern);

    if (!match?.[1]) {
      reviews.push({ workerId: worker.agentId, workerName: worker.agentName, grade: "PASS" });
      continue;
    }

    const block = match[1];
    const grade = /GRADE:\s*NEEDS_WORK/i.test(block) ? "NEEDS_WORK" as const : "PASS" as const;
    const feedback = block.match(/FEEDBACK:\s*(.+?)(?=\n(?:REWORKED_PROMPT|DIRECT_FIX|QUALITY_NOTE)|$)/is)?.[1]?.trim();
    const reworkedPrompt = block.match(/REWORKED_PROMPT:\s*(.+?)(?=\n(?:DIRECT_FIX|QUALITY_NOTE)|$)/is)?.[1]?.trim();
    const directFix = block.match(/DIRECT_FIX:\s*(.+?)(?=\n(?:QUALITY_NOTE)|$)/is)?.[1]?.trim();
    const qualityNotes = [...block.matchAll(/QUALITY_NOTE:\s*(.+)/gi)].map(m => m[1]!.trim()).filter(Boolean);
    const srMatch = block.match(/SPAWN_SR:\s*(.+)/i);
    const spawnSr = !!srMatch;
    const srDomains = srMatch ? srMatch[1]!.split(",").map(s => s.trim()) : undefined;

    reviews.push({
      workerId: worker.agentId,
      workerName: worker.agentName,
      grade: spawnSr ? "NEEDS_WORK" : grade,
      feedback: feedback || undefined,
      reworkedPrompt: reworkedPrompt || undefined,
      directFix: directFix || undefined,
      qualityNotes: qualityNotes.length ? qualityNotes : undefined,
      spawnSr: spawnSr || undefined,
      srDomains,
    });
  }

  return reviews;
}

/**
 * Summarize agent output for display in the conversation stream.
 * Tries to extract grade lines and findings first, falls back to truncation.
 */
export function summarizeOutput(output: string, maxLen: number): string {
  if (!output || output.length === 0) return "(no output)";
  // Try to extract a grade line if present
  const gradeLine = output.match(/GRADE:\s*\w+.*/i)?.[0] ?? "";
  // Try to extract findings
  const findings = output.split("\n")
    .filter(l => /^\s*-\s*P[0-3]:/.test(l) || /^\s*\d+\./.test(l) || /^##\s/.test(l))
    .slice(0, 5)
    .join("\n");

  if (gradeLine || findings) {
    const parts = [gradeLine, findings].filter(Boolean).join("\n\n");
    return parts.length <= maxLen ? parts : parts.slice(0, maxLen) + "...";
  }

  // Fallback: first N chars
  return output.length <= maxLen ? output : output.slice(0, maxLen) + "...";
}

/**
 * Determine the worst grade from a list of grades.
 * Order: PERFECT < VERIFIED < PARTIAL < FEEDBACK < FAILED.
 */
export function worstGrade(grades: (string | undefined)[]): "PERFECT" | "VERIFIED" | "PARTIAL" | "FEEDBACK" | "FAILED" | undefined {
  const order: Record<string, number> = { PERFECT: 0, VERIFIED: 1, PARTIAL: 2, FEEDBACK: 3, FAILED: 4 };
  let worst: string | undefined;
  for (const g of grades) {
    if (!g) continue;
    if (!worst || (order[g] ?? 0) > (order[worst] ?? 0)) worst = g;
  }
  return worst as ReturnType<typeof worstGrade>;
}
