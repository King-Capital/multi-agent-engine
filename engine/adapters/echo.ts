import type { PlatformAdapter, DelegateOptions, DelegateResult } from "../types";
import { createLogger } from "../logger";
import { sanitizeAgentInput } from "../security";
import { trackPromptVersion } from "../langfuse-prompts";
import { writeAgentOutputArtifact } from "../trace-artifacts";
import { writeTaskReport } from "../task-report";

const log = createLogger("echo-adapter");

export class EchoAdapter implements PlatformAdapter {
  name = "echo";

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async delegate(opts: DelegateOptions): Promise<DelegateResult> {
    const agentId = `echo-${opts.persona.name.toLowerCase().replace(/\s+/g, "-")}`;
    const sessionId = opts.sessionDir?.split(/[\\/]/).pop() ?? "unknown-session";
    const promptMeta = trackPromptVersion(opts.persona.name, opts.systemPrompt, {
      workingDir: opts.workingDir,
      sourceRoot: process.cwd(),
      team: opts.teamName,
    });

    log.info("Delegating to echo agent", {
      trace_type: "agent.start",
      session_id: sessionId,
      agent_id: agentId,
      agent: opts.persona.name,
      persona: opts.persona.name,
      model: opts.model,
      team: opts.teamName,
      system_prompt_length: opts.systemPrompt.length,
      ...promptMeta,
      has_instructions: opts.systemPrompt.includes("## Instructions"),
      prompt_preview: opts.userPrompt.slice(0, 200),
      domain_write: opts.domain.write.join(", "),
    });

    await new Promise((r) => setTimeout(r, 50));

    const verificationKeywords = [
      "GRADE: PASS",
      "SWARM_COORDINATION_READY",
      "Implementation plan produced with files risks steps",
      "All relevant files read understood",
      "Codebase mapped",
      "Key files identified",
      "Dependencies documented",
      "Plan produced based on scout findings",
      "All code changes implemented per plan",
      "Code changes implemented",
      "Tests pass",
      "Build succeeds",
      "Code reviewed grade assigned",
      "Security reviewed no P0 P1 vulnerabilities",
      "All corrections applied escalated",
      "Red team adversarial security review complete",
      "Blue team correctness quality review complete",
      "All findings graded P0 P1 P2 P3 evidence",
      "Build verification passed",
      "Validation complete",
      "Correctness squad logic errors type safety edge cases API contracts verified",
      "Correctness reviewer verified logic type runtime safety and regressions",
      "Adversarial squad assumptions broken failure modes implicit coupling identified",
      "Adversarial reviewer challenged assumptions and failure modes",
      "Quality squad SOLID violations anti-patterns duplication dead code assessed",
      "Quality reviewer assessed maintainability simplicity and test quality",
      "Security squad OWASP injection SSRF path traversal credential handling checked",
      "Security reviewer checked auth injection SSRF secrets and unsafe operations",
      "Domain squad architectural fit framework conventions integration correctness reviewed",
      "Domain reviewer checked repo-specific business and operational correctness",
      "SQUAD_REPORT: Correctness SCOPE: files inspected COMMANDS_RUN: none FINDINGS: P3 none BLOCKERS: none VERDICT: pass",
      "SQUAD_REPORT: Adversarial SCOPE: files inspected COMMANDS_RUN: none FINDINGS: P3 none BLOCKERS: none VERDICT: pass",
      "SQUAD_REPORT: Quality SCOPE: files inspected COMMANDS_RUN: none FINDINGS: P3 none BLOCKERS: none VERDICT: pass",
      "SQUAD_REPORT: Security SCOPE: files inspected COMMANDS_RUN: none FINDINGS: P3 none BLOCKERS: none VERDICT: pass",
      "SQUAD_REPORT: Domain SCOPE: files inspected COMMANDS_RUN: none FINDINGS: P3 none BLOCKERS: none VERDICT: pass",
      "REVIEW_REPORT: Correctness SCOPE: files inspected COMMANDS_RUN: none FINDINGS: P3 none BLOCKERS: none VERDICT: pass",
      "REVIEW_REPORT: Adversarial SCOPE: files inspected COMMANDS_RUN: none FINDINGS: P3 none BLOCKERS: none VERDICT: pass",
      "REVIEW_REPORT: Quality SCOPE: files inspected COMMANDS_RUN: none FINDINGS: P3 none BLOCKERS: none VERDICT: pass",
      "REVIEW_REPORT: Security SCOPE: files inspected COMMANDS_RUN: none FINDINGS: P3 none BLOCKERS: none VERDICT: pass",
      "REVIEW_REPORT: Domain SCOPE: files inspected COMMANDS_RUN: none FINDINGS: P3 none BLOCKERS: none VERDICT: pass",
      "Orchestrator synthesizes across all squads",
      "Orchestrator synthesizes conflicting findings",
    ].join(". ");

    const result: DelegateResult = {
      agentId,
      agentName: opts.persona.name,
      output: `[Echo] ${opts.persona.name} completed task. This is a test response from the echo adapter. In production, this would be the actual agent output. ${verificationKeywords}.`,
      grade: "VERIFIED",
      findings: [],
      costUsd: 0.001,
      tokensUsed: 100,
    };

    log.info("LLM call completed", {
      trace_type: "llm.call",
      session_id: sessionId,
      agent_id: agentId,
      model: opts.model,
      prompt_tokens: 70,
      completion_tokens: 30,
      total_tokens: result.tokensUsed,
      cost: result.costUsd,
      persona: opts.persona.name,
      team: opts.teamName,
      prompt_name: promptMeta.prompt_name,
      prompt_version: promptMeta.prompt_version,
      prompt_hash: promptMeta.prompt_hash,
      prompt_context_repo: promptMeta.prompt_context_repo,
      prompt_context_root: promptMeta.prompt_context_root,
      prompt_context_stack: promptMeta.prompt_context_stack,
    });

    const outputArtifact = writeAgentOutputArtifact(sessionId, agentId, result.output);
    const taskReport = writeTaskReport(sessionId, agentId, opts, result);
    log.info("Agent completed", {
      trace_type: "agent.end",
      session_id: sessionId,
      agent_id: agentId,
      persona: opts.persona.name,
      team: opts.teamName,
      grade: result.grade,
      cost: result.costUsd,
      tokens: result.tokensUsed,
      output_preview: sanitizeAgentInput(result.output).slice(0, 500),
      ...outputArtifact,
      ...taskReport,
    });

    return result;
  }
}
