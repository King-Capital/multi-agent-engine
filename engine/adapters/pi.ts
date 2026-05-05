import { $ } from "bun";
import { mkdirSync } from "fs";
import type { PlatformAdapter, DelegateOptions, DelegateResult } from "../types";

export class PiAdapter implements PlatformAdapter {
  name = "pi";

  async isAvailable(): Promise<boolean> {
    try {
      const result = await $`which pi`.text();
      return result.trim().length > 0;
    } catch {
      return false;
    }
  }

  async delegate(opts: DelegateOptions): Promise<DelegateResult> {
    const agentId = `pi-${opts.persona.name.toLowerCase().replace(/\s+/g, "-")}`;

    mkdirSync(opts.sessionDir, { recursive: true });

    const toolsFlag = opts.tools.filter((t) => t !== "delegate").join(",");

    const args = [
      "pi",
      "--print",
      "--model", opts.model,
      "--thinking", opts.thinking ?? "medium",
      "-p", opts.systemPrompt,
    ];

    if (toolsFlag) {
      args.push("--tools", toolsFlag);
    }

    console.log(`[pi] Spawning ${opts.persona.name} (${opts.model}) in ${opts.workingDir}`);

    const timeout = opts.timeoutMs ?? 300_000;

    try {
      const proc = Bun.spawn(args, {
        stdin: new Response(opts.userPrompt).body!,
        stdout: "pipe",
        stderr: "pipe",
        cwd: opts.workingDir,
      });

      const timer = setTimeout(() => proc.kill(), timeout);

      const output = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;

      clearTimeout(timer);

      if (exitCode === null || exitCode === 137 || exitCode === 143) {
        console.error(`[pi] ${opts.persona.name} timed out after ${timeout}ms`);
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
        console.error(`[pi] ${opts.persona.name} exited ${exitCode}: ${stderr.slice(0, 500)}`);
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

      if (!output.trim()) {
        console.warn(`[pi] ${opts.persona.name} returned empty output`);
        return {
          agentId,
          agentName: opts.persona.name,
          output: "ERROR: Empty output from agent",
          grade: "FAILED",
          findings: ["empty_output"],
          costUsd: 0,
          tokensUsed: 0,
        };
      }

      return {
        agentId,
        agentName: opts.persona.name,
        output,
        grade: this.extractGrade(output),
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
    const match = output.match(/GRADE:\s*(PERFECT|VERIFIED|PARTIAL|FEEDBACK|FAILED)/i);
    return match?.[1]?.toUpperCase() as any;
  }

  private extractFindings(output: string): string[] {
    const findings: string[] = [];
    for (const line of output.split("\n")) {
      if (/^\s*-\s*P[0-3]:/.test(line)) findings.push(line.trim());
    }
    return findings;
  }

  private estimateCost(output: string, model: string): number {
    const tokens = this.estimateTokens(output);
    const rate = model.includes("opus") ? 0.075 : model.includes("sonnet") ? 0.015 : 0.005;
    return (tokens / 1000) * rate;
  }

  private estimateTokens(output: string): number {
    return Math.ceil(output.length / 4);
  }
}
