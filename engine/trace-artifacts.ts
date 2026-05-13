import { createHash } from "crypto";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

export const TRACE_DIR =
  process.env.MAE_TRACE_DIR ?? join(process.env.HOME ?? "/tmp", ".mae", "traces");

const MAX_AGENT_OUTPUT_CHARS = Number(process.env.MAE_AGENT_OUTPUT_ARTIFACT_CHARS ?? 20_000);

function safeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 120) || "unknown";
}

export interface AgentOutputArtifact {
  output_artifact: string;
  output_hash: string;
  output_bytes: number;
}

export function writeAgentOutputArtifact(sessionId: string, agentId: string, output: string): AgentOutputArtifact | undefined {
  const bounded = output.slice(0, Math.max(0, MAX_AGENT_OUTPUT_CHARS));
  if (!bounded) return undefined;

  const output_hash = createHash("sha256").update(bounded).digest("hex");
  const sessionPart = safeFilePart(sessionId);
  const agentPart = safeFilePart(agentId);
  const artifactDir = join(TRACE_DIR, sessionPart, "artifacts");
  const artifactName = `${agentPart}-output-${output_hash.slice(0, 12)}.txt`;
  const artifactPath = join(artifactDir, artifactName);

  try {
    mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
    writeFileSync(artifactPath, bounded, { mode: 0o600 });
  } catch {
    return undefined;
  }

  return {
    output_artifact: `${sessionPart}/artifacts/${artifactName}`,
    output_hash,
    output_bytes: Buffer.byteLength(bounded, "utf8"),
  };
}
