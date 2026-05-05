import { $ } from "bun";
import type { PlatformAdapter, DelegateOptions, DelegateResult } from "../types";

export class ClaudeCodeAdapter implements PlatformAdapter {
  name = "claude-code";

  async isAvailable(): Promise<boolean> {
    try {
      const result = await $`which claude`.text();
      return result.trim().length > 0;
    } catch {
      return false;
    }
  }

  async delegate(opts: DelegateOptions): Promise<DelegateResult> {
    const agentId = `cc-${opts.persona.name.toLowerCase().replace(/\s+/g, "-")}`;

    const systemPrompt = [
      opts.systemPrompt,
      "",
      "## Domain Restrictions",
      `You may only write to: ${opts.domain.write.join(", ")}`,
      `You may read: ${opts.domain.read.join(", ")}`,
    ].join("\n");

    const args = [
      "claude",
      "--print",
      "--model", opts.model,
      "--system-prompt", systemPrompt,
      "--max-turns", "25",
      "--output-format", "text",
    ];

    // Enforce tool restrictions -- strip "delegate" (our concept, not a CC tool)
    // and pass the remaining tools as the ONLY allowed tools
    const allowedTools = opts.tools.filter((t) => t !== "delegate");
    if (allowedTools.length > 0) {
      args.push("--allowedTools", allowedTools.join(","));
    } else {
      // Orchestrator: delegate-only means NO CC tools at all (read-only prompt/response)
      args.push("--allowedTools", "none");
    }

    console.log(`[claude-code] Spawning ${opts.persona.name} (${opts.model})`);

    const timeout = opts.timeoutMs ?? 300_000; // 5 min default

    try {
      const proc = Bun.spawn(args, {
        stdin: new Response(opts.userPrompt).body!,
        stdout: "pipe",
        stderr: "pipe",
        cwd: opts.sessionDir,
      });

      const timer = setTimeout(() => proc.kill(), timeout);

      const output = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;

      clearTimeout(timer);

      if (exitCode === null || exitCode === 137 || exitCode === 143) {
        console.error(`[claude-code] ${opts.persona.name} timed out after ${timeout}ms`);
        return {
          agentId,
          agentName: opts.persona.name,
          output: `ERROR: Agent timed out after ${timeout}ms`,
          grade: "FAILED",
          findings: ["timeout"],
          costUsd: 0,
          tokensUsed: 0,
        };
      }

      if (exitCode !== 0) {
        console.error(`[claude-code] ${opts.persona.name} failed: ${stderr}`);
        return {
          agentId,
          agentName: opts.persona.name,
          output: `ERROR: ${stderr}`,
          grade: "FAILED",
          findings: [stderr],
          costUsd: 0,
          tokensUsed: 0,
        };
      }

      const grade = this.extractGrade(output);

      return {
        agentId,
        agentName: opts.persona.name,
        output,
        grade,
        findings: this.extractFindings(output),
        costUsd: this.estimateCost(output, opts.model),
        tokensUsed: this.estimateTokens(output),
      };
    } catch (err) {
      return {
        agentId,
        agentName: opts.persona.name,
        output: `ERROR: ${err}`,
        grade: "FAILED",
        findings: [`${err}`],
        costUsd: 0,
        tokensUsed: 0,
      };
    }
  }

  private extractGrade(output: string): "PERFECT" | "VERIFIED" | "PARTIAL" | "FEEDBACK" | "FAILED" | undefined {
    const gradeMatch = output.match(/GRADE:\s*(PERFECT|VERIFIED|PARTIAL|FEEDBACK|FAILED)/i);
    return gradeMatch?.[1]?.toUpperCase() as any;
  }

  private extractFindings(output: string): string[] {
    const findings: string[] = [];
    const lines = output.split("\n");
    for (const line of lines) {
      if (/^\s*-\s*P[0-3]:/.test(line)) {
        findings.push(line.trim());
      }
    }
    return findings;
  }

  private estimateCost(output: string, model: string): number {
    const tokens = this.estimateTokens(output);
    const costPer1k = model.includes("opus") ? 0.075 : model.includes("sonnet") ? 0.015 : 0.005;
    return (tokens / 1000) * costPer1k;
  }

  private estimateTokens(output: string): number {
    return Math.ceil(output.length / 4);
  }
}
