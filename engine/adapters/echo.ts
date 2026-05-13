import type { PlatformAdapter, DelegateOptions, DelegateResult } from "../types";
import { createLogger } from "../logger";
import { sanitizeAgentInput } from "../security";
import { trackPromptVersion } from "../langfuse-prompts";
import { writeAgentOutputArtifact } from "../trace-artifacts";

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

    const result: DelegateResult = {
      agentId,
      agentName: opts.persona.name,
      output: `[Echo] ${opts.persona.name} completed task. This is a test response from the echo adapter. In production, this would be the actual agent output.`,
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
    });

    return result;
  }
}
