import { $ } from "bun";
import { mkdirSync, existsSync } from "fs";
import { join } from "path";
import type { PlatformAdapter, DelegateOptions, DelegateResult, StreamEvent } from "../types";

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
      "--mode", "rpc",
      "--no-session",
      "--model", opts.model,
      "--thinking", opts.thinking ?? "medium",
      "-p", opts.systemPrompt,
    ];

    if (toolsFlag) {
      args.push("--tools", toolsFlag);
    }

    const baseDir = process.cwd();
    for (const skill of opts.persona.skills) {
      const skillPath = typeof skill === "string" ? skill : skill.path;
      const filename = skillPath.split("/").pop()!;
      const piSkillPath = join(baseDir, ".pi", "skills", filename);
      const agentSkillPath = join(baseDir, skillPath);
      const resolved = existsSync(piSkillPath) ? piSkillPath : existsSync(agentSkillPath) ? agentSkillPath : null;
      if (resolved) {
        args.push("--skill", resolved);
      }
    }

    if (opts.persona.expertise) {
      const expertisePath = join(baseDir, opts.persona.expertise);
      if (existsSync(expertisePath)) {
        args.push("--append-system-prompt", expertisePath);
      }
    }

    console.log(`[pi-rpc] Spawning ${opts.persona.name} (${this.mapModel(opts.model)}) [${opts.persona.skills.length} skills] in ${opts.workingDir}`);

    const timeout = opts.timeoutMs ?? 300_000;

    let totalCost = 0;
    let totalTokens = 0;
    let cacheReadTokens = 0;
    let finalText = "";

    return new Promise<DelegateResult>((resolve) => {
      const proc = Bun.spawn(args, {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        cwd: opts.workingDir,
      });

      const timer = setTimeout(() => {
        console.error(`[pi-rpc] ${opts.persona.name} timed out after ${timeout}ms`);
        this.sendCmd(proc, { type: "abort" });
        setTimeout(() => proc.kill(), 5000);
      }, timeout);

      // Register message sender so orchestrator/dashboard can inject messages
      if (opts.sendMessage) {
        opts.sendMessage((msg: string) => {
          this.sendCmd(proc, { type: "follow_up", message: msg });
        });
      }

      // Send the initial prompt
      this.sendCmd(proc, { type: "prompt", message: opts.userPrompt });

      // Stream stdout JSONL
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const processStream = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            let newlineIdx: number;
            while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
              const line = buffer.slice(0, newlineIdx);
              buffer = buffer.slice(newlineIdx + 1);
              const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
              if (!trimmed) continue;

              try {
                const evt = JSON.parse(trimmed);
                this.processRpcEvent(evt, opts.onStreamEvent, (cost, tokens, cache) => {
                  totalCost += cost;
                  totalTokens = tokens;
                  cacheReadTokens = cache;
                });

                if (evt.type === "tool_execution_end") {
                  const toolName = evt.toolName ?? "unknown";
                  const isError = evt.isError ?? false;
                  opts.onStreamEvent?.({
                    type: "tool_result",
                    tool: toolName,
                    status: isError ? "error" : "success",
                  });
                }

                if (evt.type === "agent_end") {
                  const messages = evt.messages ?? [];
                  const lastAssistant = [...messages].reverse().find((m: { role: string }) => m.role === "assistant");
                  if (lastAssistant) {
                    const content = lastAssistant.content;
                    if (Array.isArray(content)) {
                      const textBlock = content.find((b: { type: string }) => b.type === "text");
                      if (textBlock?.text) finalText = textBlock.text;
                    }
                    const usage = lastAssistant.usage;
                    if (usage) {
                      totalCost = messages.reduce((sum: number, m: { usage?: { cost?: { total?: number } } }) =>
                        sum + (m.usage?.cost?.total ?? 0), 0);
                    }
                  }
                  opts.onStreamEvent?.({ type: "cost", costUsd: totalCost, tokensUsed: totalTokens, cacheReadTokens });
                }
              } catch {
                // not valid JSON
              }
            }
          }
        } catch {
          // stream closed
        }

        clearTimeout(timer);

        const exitCode = await proc.exited;
        const stderr = await new Response(proc.stderr).text();

        if (exitCode === 137 || exitCode === 143) {
          resolve({
            agentId,
            agentName: opts.persona.name,
            output: finalText || `ERROR: Agent timed out after ${timeout}ms`,
            grade: finalText ? this.extractGrade(finalText) : "FAILED",
            findings: finalText ? this.extractFindings(finalText) : ["timeout"],
            costUsd: totalCost,
            tokensUsed: totalTokens,
          });
          return;
        }

        if (exitCode !== 0 && !finalText) {
          console.error(`[pi-rpc] ${opts.persona.name} exited ${exitCode}: ${stderr.slice(0, 500)}`);
          resolve({
            agentId,
            agentName: opts.persona.name,
            output: `ERROR: ${stderr}`,
            grade: "FAILED",
            findings: [stderr],
            costUsd: totalCost,
            tokensUsed: totalTokens,
          });
          return;
        }

        resolve({
          agentId,
          agentName: opts.persona.name,
          output: finalText || "ERROR: Empty output",
          grade: this.extractGrade(finalText),
          findings: this.extractFindings(finalText),
          costUsd: totalCost,
          tokensUsed: totalTokens,
        });
      };

      processStream();
    });
  }

  private sendCmd(proc: ReturnType<typeof Bun.spawn>, cmd: Record<string, unknown>): void {
    try {
      const stdin = proc.stdin;
      if (stdin && typeof stdin === "object" && "write" in stdin) {
        (stdin as { write(data: string | Uint8Array): void }).write(JSON.stringify(cmd) + "\n");
      }
    } catch {
      // process may have exited
    }
  }

  private processRpcEvent(
    evt: Record<string, unknown>,
    onStream: ((event: StreamEvent) => void) | undefined,
    onCost: (cost: number, tokens: number, cacheRead: number) => void,
  ): void {
    if (!onStream) return;

    // Tool execution events — real-time tool call visibility
    if (evt.type === "tool_execution_start") {
      const toolName = (evt.toolName as string) ?? "unknown";
      const args = evt.args as Record<string, unknown> | undefined;
      let filePath = "";
      if (args) {
        filePath = ((args.file_path ?? args.path ?? args.command ?? "") as string).slice(0, 200);
      }
      onStream({
        type: "tool_call",
        tool: toolName,
        filePath,
        status: "running",
      });
    }

    // Streaming text deltas
    if (evt.type === "message_update") {
      const ame = evt.assistantMessageEvent as Record<string, unknown> | undefined;
      if (ame?.type === "text_delta" && ame.delta) {
        // Don't emit individual deltas as full messages — accumulate
      }
      if (ame?.type === "text_end" && ame.content) {
        onStream({
          type: "assistant_text",
          content: ame.content as string,
        });
      }
    }

    // Cost updates from message_end
    if (evt.type === "message_end") {
      const msg = evt.message as Record<string, unknown> | undefined;
      if (msg?.role === "assistant") {
        const usage = msg.usage as Record<string, unknown> | undefined;
        if (usage) {
          const cost = usage.cost as Record<string, number> | undefined;
          const costTotal = cost?.total ?? 0;
          const tokens = (usage.totalTokens as number) ?? 0;
          const cache = (usage.cacheRead as number) ?? 0;
          if (costTotal > 0) {
            onCost(costTotal, tokens, cache);
            onStream({ type: "cost", costUsd: costTotal, tokensUsed: tokens, cacheReadTokens: cache });
          }
        }
      }
    }
  }

  private mapModel(model: string): string {
    const parts = model.split("/");
    return parts[parts.length - 1]!;
  }

  private extractGrade(output: string): "PERFECT" | "VERIFIED" | "PARTIAL" | "FEEDBACK" | "FAILED" | undefined {
    const match = output.match(/GRADE:\s*(PERFECT|VERIFIED|PARTIAL|FEEDBACK|FAILED)/i);
    return match?.[1]?.toUpperCase() as ReturnType<typeof this.extractGrade>;
  }

  private extractFindings(output: string): string[] {
    const findings: string[] = [];
    for (const line of output.split("\n")) {
      if (/^\s*-\s*P[0-3]:/.test(line)) findings.push(line.trim());
    }
    return findings;
  }
}
