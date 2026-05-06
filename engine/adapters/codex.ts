import { $ } from "bun";
import { mkdirSync } from "fs";
import type { PlatformAdapter, DelegateOptions, DelegateResult, StreamEvent } from "../types";

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

    const timeout = opts.timeoutMs ?? 300_000;

    try {
      const proc = Bun.spawn(args, {
        stdin: new Response(prompt).body!,
        stdout: "pipe",
        stderr: "pipe",
        cwd: opts.workingDir,
      });

      // Timeout with SIGKILL fallback (#71)
      const timer = setTimeout(() => {
        console.error(`[codex] ${opts.persona.name} timed out after ${timeout}ms`);
        proc.kill();
        setTimeout(() => { try { proc.kill(9); } catch {} }, 5000);
      }, timeout);

      // Emit start event for dashboard visibility (#71)
      opts.onStreamEvent?.({
        type: "tool_call",
        tool: "codex",
        filePath: opts.workingDir,
        status: "running",
      });

      // Drain stderr concurrently to prevent pipe deadlock (#71, same as #63)
      const stderrChunks: string[] = [];
      const stderrReader = proc.stderr.getReader();
      const stderrDecoder = new TextDecoder();
      const drainStderr = (async () => {
        try {
          while (true) {
            const { done, value } = await stderrReader.read();
            if (done) break;
            stderrChunks.push(stderrDecoder.decode(value, { stream: true }));
          }
        } catch {
          // stderr closed or process killed -- safe to ignore
        }
      })();

      const output = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;
      clearTimeout(timer);

      // Wait for stderr drain to complete
      await drainStderr;
      const stderr = stderrChunks.join("");

      if (exitCode === null || exitCode === 137 || exitCode === 143) {
        console.error(`[codex] ${opts.persona.name} timed out after ${timeout}ms`);
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
        // Emit cost event even on failure
        opts.onStreamEvent?.({ type: "cost", costUsd: 0, tokensUsed: 0, cacheReadTokens: 0 });
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

      const estimatedTokens = this.estimateTokens(output);
      const costUsd = this.estimateCost(output, stderr);

      // Emit completion cost event (#71)
      opts.onStreamEvent?.({
        type: "cost",
        costUsd,
        tokensUsed: estimatedTokens,
        cacheReadTokens: 0,
      });

      return {
        agentId,
        agentName: opts.persona.name,
        output,
        grade: this.extractGrade(output),
        findings: this.extractFindings(output),
        costUsd,
        tokensUsed: estimatedTokens,
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

  private extractFindings(output: string): string[] {
    const findings: string[] = [];
    for (const line of output.split("\n")) {
      if (/^\s*-\s*P[0-3]:/.test(line)) findings.push(line.trim());
    }
    return findings;
  }

  private estimateTokens(output: string): number {
    return Math.ceil(output.length / 4);
  }

  /**
   * Estimate cost from output. Tries to parse Codex cost output first,
   * falls back to token-based estimation (~$0.01 per 1K tokens for gpt-5.5).
   */
  private estimateCost(output: string, stderr: string): number {
    // Try to parse cost from Codex output (e.g. "Total cost: $0.42")
    const combined = output + "\n" + stderr;
    const costMatch = combined.match(/(?:total\s+)?cost:\s*\$?([\d.]+)/i);
    if (costMatch) {
      const parsed = parseFloat(costMatch[1] ?? "0");
      if (!isNaN(parsed) && parsed > 0) return parsed;
    }
    // Fallback: rough estimation based on output tokens
    const tokens = this.estimateTokens(output);
    return Math.round(tokens * 0.00001 * 1000) / 1000; // ~$0.01/1K tokens
  }
}
