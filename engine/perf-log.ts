import { join, dirname } from "path";

export interface PerfRecord {
  model: string;
  role: string;
  grade: string;
  cost_usd: number;
  latency_ms: number;
  findings_count: number;
  agent_name: string;
  session_id: string;
  timestamp: string;
}

export interface ModelScore {
  model: string;
  role: string;
  runs: number;
  avg_cost_usd: number;
  avg_latency_ms: number;
  avg_findings: number;
  pass_rate: number;
}

const PASS_GRADES = new Set(["PASS", "VERIFIED", "PERFECT"]);

function getDataPath(): string {
  return join(dirname(import.meta.dir), "data", "model-performance.jsonl");
}

export async function logPerformance(record: PerfRecord): Promise<void> {
  const filePath = getDataPath();
  const dir = dirname(filePath);
  await Bun.write(join(dir, ".keep"), ""); // ensure directory exists
  const line = JSON.stringify(record) + "\n";
  const { appendFileSync } = await import("fs");
  appendFileSync(filePath, line);
}

export async function loadPerformance(): Promise<PerfRecord[]> {
  const filePath = getDataPath();
  const file = Bun.file(filePath);
  if (!(await file.exists())) return [];
  const text = await file.text();
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as PerfRecord);
}

export function buildScorecard(records?: PerfRecord[]): ModelScore[] {
  if (!records || records.length === 0) return [];

  const groups = new Map<string, PerfRecord[]>();
  for (const r of records) {
    const key = `${r.model}/${r.role}`;
    const arr = groups.get(key) ?? [];
    arr.push(r);
    groups.set(key, arr);
  }

  const scores: ModelScore[] = [];
  for (const [, recs] of groups) {
    const first = recs[0]!;
    const runs = recs.length;
    const avg_cost_usd = recs.reduce((s, r) => s + r.cost_usd, 0) / runs;
    const avg_latency_ms = recs.reduce((s, r) => s + r.latency_ms, 0) / runs;
    const avg_findings = recs.reduce((s, r) => s + r.findings_count, 0) / runs;
    const passCount = recs.filter((r) => PASS_GRADES.has(r.grade)).length;
    const pass_rate = (passCount / runs) * 100;

    scores.push({
      model: first.model,
      role: first.role,
      runs,
      avg_cost_usd,
      avg_latency_ms,
      avg_findings,
      pass_rate,
    });
  }

  // Sort by pass rate descending, then by cost ascending
  scores.sort((a, b) => b.pass_rate - a.pass_rate || a.avg_cost_usd - b.avg_cost_usd);
  return scores;
}
