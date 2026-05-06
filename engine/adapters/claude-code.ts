import { mkdirSync } from "fs";
import type { PlatformAdapter, DelegateOptions, DelegateResult, StreamEvent } from "../types";

export class ClaudeCodeAdapter implements PlatformAdapter {
  name = "claude-code";

  private static readonly MODEL_MAP: Record<string, string> = {
    "litellm/opus-nocache": "claude-opus-4-6",
    "litellm/opus": "claude-opus-4-6",
    "litellm/sonnet-nocache": "claude-sonnet-4-6",
    "litellm/sonnet": "claude-sonnet-4-6",
    "litellm/haiku": "claude-haiku-4-5",
    "litellm/pro-nocache": "claude-sonnet-4-6",
    "litellm/flash": "claude-haiku-4-5",
  };

  private resolveCliModel(model: string): string {
    if (ClaudeCodeAdapter.MODEL_MAP[model]) return ClaudeCodeAdapter.MODEL_MAP[model];
    if (model.startsWith("claude-")) return model;
    if (model.startsWith("litellm/")) return "claude-sonnet-4-6";
    return model;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const result = await Bun.$`which claude`.text();
      return result.trim().length > 0;
    } catch {
      return false;
    }
  }

  async delegate(opts: DelegateOptions): Promise<DelegateResult> {
    const agentId = `cc-${opts.persona.name.toLowerCase().replace(/\s+/g, "-")}`;

    mkdirSync(opts.sessionDir, { recursive: true });

    const systemPrompt = [
      opts.systemPrompt,
      "",
      "## Domain Restrictions",
      `You may only write to: ${opts.domain.write.join(", ")}`,
      `You may read: ${opts.domain.read.join(", ")}`,
      "",
      `## Session`,
      `Session dir for artifacts: ${opts.sessionDir}`,
    ].join("\n");

    const args = [
      "claude",
      "--print",
      "--verbose",
      "--model", this.resolveCliModel(opts.model),
      "--system-prompt", systemPrompt,
      "--max-turns", "25",
      "--output-format", "stream-json",
      "--permission-mode", "bypassPermissions",
    ];

    const allowedTools = opts.tools.filter((t) => t !== "delegate");
    if (allowedTools.length > 0) {
      args.push("--allowedTools", allowedTools.join(","));
    } else {
      args.push("--allowedTools", "none");
    }

    console.log(`[claude-code] Spawning ${opts.persona.name} (${this.resolveCliModel(opts.model)}) in ${opts.workingDir}`);

    const timeout = opts.timeoutMs ?? 1_800_000;

    try {
      const proc = Bun.spawn(args, {
        stdin: new Response(opts.userPrompt).body!,
        stdout: "pipe",
        stderr: "pipe",
        cwd: opts.workingDir,
      });

      const timer = timeout > 0 ? setTimeout(() => proc.kill(), timeout) : null;

      let resultText = "";
      let costUsd = 0;
      let tokensUsed = 0;
      let cacheReadTokens = 0;

      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const evt = JSON.parse(line);
            this.processStreamEvent(evt, opts.onStreamEvent);

            if (evt.type === "assistant" && evt.message?.content) {
              for (const block of evt.message.content) {
                if (block.type === "text" && block.text) {
                  resultText += block.text;
                }
              }
            }

            if (evt.type === "result") {
              resultText = evt.result ?? resultText;
              costUsd = evt.total_cost_usd ?? 0;
              const usage = evt.usage;
              if (usage) {
                tokensUsed = (usage.output_tokens ?? 0) + (usage.input_tokens ?? 0);
                cacheReadTokens = usage.cache_read_input_tokens ?? 0;
              }
            }
          } catch {
            // non-JSON line, skip
          }
        }
      }

      // process remaining buffer
      if (buffer.trim()) {
        try {
          const evt = JSON.parse(buffer);
          this.processStreamEvent(evt, opts.onStreamEvent);
          if (evt.type === "result") {
            resultText = evt.result ?? resultText;
            costUsd = evt.total_cost_usd ?? 0;
          }
        } catch { /* skip */ }
      }

      const exitCode = await proc.exited;
      if (timer) clearTimeout(timer);

      if (exitCode === null || exitCode === 137 || exitCode === 143) {
        console.error(`[claude-code] ${opts.persona.name} timed out after ${timeout}ms`);
        return {
          agentId, agentName: opts.persona.name,
          output: `ERROR: Agent timed out after ${timeout}ms`,
          grade: "FAILED", findings: ["timeout"], costUsd: 0, tokensUsed: 0,
        };
      }

      if (exitCode !== 0 && !resultText.trim()) {
        const stderr = await new Response(proc.stderr).text();
        console.error(`[claude-code] ${opts.persona.name} exited ${exitCode}: ${stderr.slice(0, 500)}`);
        return {
          agentId, agentName: opts.persona.name,
          output: `ERROR: exit ${exitCode}: ${stderr}`,
          grade: "FAILED", findings: [stderr], costUsd, tokensUsed,
        };
      }

      if (!resultText.trim()) {
        return {
          agentId, agentName: opts.persona.name,
          output: "ERROR: Empty output from agent",
          grade: "FAILED", findings: ["empty_output"], costUsd, tokensUsed,
        };
      }

      // emit final cost
      opts.onStreamEvent?.({ type: "cost", costUsd, tokensUsed, cacheReadTokens });

      return {
        agentId,
        agentName: opts.persona.name,
        output: resultText,
        grade: this.extractGrade(resultText),
        findings: this.extractFindings(resultText),
        costUsd,
        tokensUsed,
      };
    } catch (err) {
      return {
        agentId, agentName: opts.persona.name,
        output: `ERROR: ${err}`,
        grade: "FAILED", findings: [`${err}`], costUsd: 0, tokensUsed: 0,
      };
    }
  }

  private processStreamEvent(evt: any, callback?: (event: StreamEvent) => void): void {
    if (!callback) return;

    if (evt.type === "assistant" && evt.message?.content) {
      for (const block of evt.message.content) {
        if (block.type === "tool_use") {
          const filePath = block.input?.file_path ?? block.input?.path ?? block.input?.command?.slice(0, 80) ?? "";
          callback({
            type: "tool_call",
            tool: block.name,
            filePath,
            status: "running",
          });
        }
        if (block.type === "text" && block.text) {
          callback({ type: "assistant_text", content: block.text });
        }
      }
    }

    if (evt.type === "result") {
      callback({
        type: "cost",
        costUsd: evt.total_cost_usd ?? 0,
        tokensUsed: (evt.usage?.output_tokens ?? 0) + (evt.usage?.input_tokens ?? 0),
        cacheReadTokens: evt.usage?.cache_read_input_tokens ?? 0,
      });
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
}
