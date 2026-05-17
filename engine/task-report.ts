import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { redactSecrets, sanitizeAgentInput } from "./security";
import { getTraceDir } from "./trace-artifacts";
import { createLogger } from "./logger";
import type { DelegateOptions, DelegateResult } from "./types";

const log = createLogger("task-report");

function safeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 120) || "unknown";
}

function extractModifiedFiles(output: string): string[] {
  const files = new Set<string>();
  const modifiedSection = output.match(/(?:Modified Files|Files Modified|Changed Files)\s*:?\s*\n(?<body>(?:[-*]\s+[^\n]+\n?)+)/i);
  if (modifiedSection?.groups?.body) {
    for (const line of modifiedSection.groups.body.split("\n")) {
      const match = line.match(/^[-*]\s+(.+)$/);
      if (match?.[1]) files.add(match[1].trim());
    }
  }
  return [...files].slice(0, 50);
}

function boundedResult(output: string): string {
  const clean = sanitizeAgentInput(redactSecrets(output)).trim();
  if (!clean) return "No textual result captured.";
  return clean.length > 1200 ? `${clean.slice(0, 1200)}…` : clean;
}

export interface TaskReportArtifact {
  task_report: string;
}

export function writeTaskReport(sessionId: string, agentId: string, opts: DelegateOptions, result: DelegateResult): TaskReportArtifact | undefined {
  const sessionPart = safeFilePart(sessionId);
  const agentPart = safeFilePart(agentId);
  const reportDir = join(getTraceDir(), sessionPart, "RALPH");
  const reportName = `${agentPart}.md`;
  const reportPath = join(reportDir, reportName);
  const modifiedFiles = extractModifiedFiles(result.output ?? "");
  const status = result.grade === "FAILED" ? "❌ Failed" : result.grade === "PARTIAL" || result.grade === "FEEDBACK" ? "⚠️ Partial" : "✅ Complete";
  const report = [
    `# Task ${agentPart} — ${opts.persona.name}`,
    "",
    "## Result",
    boundedResult(result.output ?? ""),
    "",
    "## Modified Files",
    ...(modifiedFiles.length > 0 ? modifiedFiles.map((file) => `- ${file}`) : ["- none reported"]),
    "",
    "## Status",
    status,
    "",
    "## Metadata",
    `- Agent ID: ${agentId}`,
    `- Team: ${opts.teamName ?? "unknown"}`,
    `- Model: ${opts.model}`,
    `- Cost USD: ${result.costUsd.toFixed(6)}`,
    `- Tokens: ${result.tokensUsed}`,
    `- Timestamp: ${new Date().toISOString()}`,
    "",
  ].join("\n");

  try {
    mkdirSync(reportDir, { recursive: true, mode: 0o700 });
    writeFileSync(reportPath, report, { mode: 0o600 });
  } catch (err) {
    log.warn("Failed to write task report", {
      session_id: sessionPart,
      agent_id: agentId,
      report_name: reportName,
      error_type: err instanceof Error ? err.name : typeof err,
      error_preview: redactSecrets(String(err)).slice(0, 300),
    });
    return undefined;
  }

  return { task_report: `${sessionPart}/RALPH/${reportName}` };
}
