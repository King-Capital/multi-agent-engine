import type { PlatformAdapter, DelegateOptions, DelegateResult } from "../types";
import { createLogger } from "../logger";

const log = createLogger("echo-adapter");

export class EchoAdapter implements PlatformAdapter {
  name = "echo";

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async delegate(opts: DelegateOptions): Promise<DelegateResult> {
    log.info("Delegating to echo agent", {
      agent: opts.persona.name,
      model: opts.model,
      team: opts.teamName,
      system_prompt_length: opts.systemPrompt.length,
      has_instructions: opts.systemPrompt.includes("## Instructions"),
      prompt_preview: opts.userPrompt.slice(0, 200),
      domain_write: opts.domain.write.join(", "),
    });

    await new Promise((r) => setTimeout(r, 50));

    return {
      agentId: `echo-${opts.persona.name.toLowerCase().replace(/\s+/g, "-")}`,
      agentName: opts.persona.name,
      output: `[Echo] ${opts.persona.name} completed task. This is a test response from the echo adapter. In production, this would be the actual agent output.`,
      grade: "VERIFIED",
      findings: [],
      costUsd: 0.001,
      tokensUsed: 100,
    };
  }
}
