import type { PlatformAdapter, DelegateOptions, DelegateResult } from "../types";

export class EchoAdapter implements PlatformAdapter {
  name = "echo";

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async delegate(opts: DelegateOptions): Promise<DelegateResult> {
    console.log(`[echo] Delegating to ${opts.persona.name} (${opts.model})`);
    console.log(`[echo] Team: ${opts.teamName}`);
    console.log(`[echo] Prompt: ${opts.userPrompt.slice(0, 200)}...`);
    console.log(`[echo] Domain write: ${opts.domain.write.join(", ")}`);

    await new Promise((r) => setTimeout(r, 500));

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
