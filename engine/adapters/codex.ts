import { $ } from "bun";
import { mkdirSync } from "fs";
import type { PlatformAdapter, DelegateOptions, DelegateResult } from "../types";

export class CodexAdapter implements PlatformAdapter {
  name = "codex";

  async isAvailable(): Promise<boolean> {
    try {
      const result = await $`which codex`.text();
      return result.trim().length > 0;
    } catch {
      return false;
    }
  }

  async delegate(opts: DelegateOptions): Promise<DelegateResult> {
    const agentId = `codex-${opts.persona.name.toLowerCase().replace(/\s+/g, "-")}`;

    const args = [
      "codex",
      "--quiet",
      "--full-auto",
      "--model", this.mapModel(opts.model),
    ];

    const prompt = `${opts.systemPrompt}\n\n---\n\n${opts.userPrompt}`;

    console.log(`[codex] Spawning ${opts.persona.name} (${this.mapModel(opts.model)}) in ${opts.workingDir}`);

    mkdirSync(opts.sessionDir, { recursive: true });

    try {
      const proc = Bun.spawn(args, {
        stdin: new Response(prompt).body!,
        stdout: "pipe",
        stderr: "pipe",
        cwd: opts.workingDir,
      });

      const output = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;

      if (exitCode !== 0) {
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

      return {
        agentId,
        agentName: opts.persona.name,
        output,
        grade: this.extractGrade(output),
        findings: [],
        costUsd: 0,
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

  private mapModel(model: string): string {
    if (model.includes("gpt-5.5")) return "gpt-5.5";
    if (model.includes("gpt-5.4")) return "gpt-5.4-mini";
    return "gpt-5.5";
  }

  private extractGrade(output: string): "PERFECT" | "VERIFIED" | "PARTIAL" | "FEEDBACK" | "FAILED" | undefined {
    const match = output.match(/GRADE:\s*(PERFECT|VERIFIED|PARTIAL|FEEDBACK|FAILED)/i);
    return match?.[1]?.toUpperCase() as any;
  }

  private estimateTokens(output: string): number {
    return Math.ceil(output.length / 4);
  }
}
