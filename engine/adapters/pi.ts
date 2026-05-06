import { $ } from "bun";
import { mkdirSync } from "fs";
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
      "--print",
      "--mode", "json",
      "--model", opts.model,
      "--thinking", opts.thinking ?? "medium",
      "-p", opts.systemPrompt,
    ];

    if (toolsFlag) {
      args.push("--tools", toolsFlag);
    }

    console.log(`[pi] Spawning ${opts.persona.name} (${this.mapModel(opts.model)}) in ${opts.workingDir}`);

    const timeout = opts.timeoutMs ?? 300_000;

    let totalCost = 0;
    let totalTokens = 0;
    let cacheReadTokens = 0;
    let finalText = "";
    let toolCallCount = 0;

    try {
      const proc = Bun.spawn(args, {
        stdin: new Response(opts.userPrompt).body!,
        stdout: "pipe",
        stderr: "pipe",
        cwd: opts.workingDir,
      });

      const timer = setTimeout(() => proc.kill(), timeout);

      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newlineIdx: number;
        while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newlineIdx).trim();
          buffer = buffer.slice(newlineIdx + 1);
          if (!line) continue;

          try {
            const evt = JSON.parse(line);
            this.processJsonEvent(evt, opts.onStreamEvent, (cost, tokens, cache) => {
              totalCost = cost;
              totalTokens = tokens;
              cacheReadTokens = cache;
            });

            if (evt.type === "message_end" && evt.message?.role === "assistant") {
              const content = evt.message.content;
              if (Array.isArray(content)) {
                for (const block of content) {
                  if (block.type === "text" && block.text) {
                    finalText = block.text;
                  }
                  if (block.type === "toolCall") {
                    toolCallCount++;
                  }
                }
              }
              const usage = evt.message.usage;
              if (usage?.cost?.total) {
                totalCost += usage.cost.total;
                totalTokens = usage.totalTokens ?? totalTokens;
                cacheReadTokens = usage.cacheRead ?? cacheReadTokens;
              }
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
                if (usage?.cost?.total != null) {
                  totalCost = messages.reduce((sum: number, m: { usage?: { cost?: { total?: number } } }) => sum + (m.usage?.cost?.total ?? 0), 0);
                  const lastUsage = lastAssistant.usage;
                  totalTokens = lastUsage?.totalTokens ?? totalTokens;
                  cacheReadTokens = lastUsage?.cacheRead ?? cacheReadTokens;
                }
              }
            }
          } catch {
            // not JSON, skip
          }
        }
      }

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
          costUsd: totalCost,
          tokensUsed: totalTokens,
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
          costUsd: totalCost,
          tokensUsed: totalTokens,
        };
      }

      if (!finalText.trim()) {
        console.warn(`[pi] ${opts.persona.name} returned empty output`);
        return {
          agentId,
          agentName: opts.persona.name,
          output: "ERROR: Empty output from agent",
          grade: "FAILED",
          findings: ["empty_output"],
          costUsd: totalCost,
          tokensUsed: totalTokens,
        };
      }

      opts.onStreamEvent?.({ type: "cost", costUsd: totalCost, tokensUsed: totalTokens, cacheReadTokens });

      return {
        agentId,
        agentName: opts.persona.name,
        output: finalText,
        grade: this.extractGrade(finalText),
        findings: this.extractFindings(finalText),
        costUsd: totalCost,
        tokensUsed: totalTokens,
      };
    } catch (err) {
      return {
        agentId,
        agentName: opts.persona.name,
        output: `ERROR: ${err}`,
        grade: "FAILED",
        findings: [`${err}`],
        costUsd: totalCost,
        tokensUsed: totalTokens,
      };
    }
  }

  private processJsonEvent(
    evt: Record<string, unknown>,
    onStream: ((event: StreamEvent) => void) | undefined,
    onCost: (cost: number, tokens: number, cacheRead: number) => void,
  ): void {
    if (!onStream) return;

    if (evt.type === "message_end") {
      const msg = evt.message as Record<string, unknown> | undefined;
      if (!msg) return;
      const role = msg.role as string;
      const content = msg.content as Array<Record<string, unknown>> | undefined;
      const usage = msg.usage as Record<string, unknown> | undefined;

      if (role === "assistant" && Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "toolCall") {
            const args = block.arguments as Record<string, unknown> | undefined;
            const toolName = (block.name as string) ?? "unknown";
            let filePath = "";
            if (args && typeof args === "object") {
              filePath = (args.file_path ?? args.path ?? args.command ?? "") as string;
            }
            onStream({
              type: "tool_call",
              tool: toolName,
              filePath: typeof filePath === "string" ? filePath.slice(0, 200) : "",
              status: "running",
            });
          }

          if (block.type === "text" && block.text) {
            onStream({
              type: "assistant_text",
              content: block.text as string,
            });
          }
        }

        if (usage) {
          const cost = usage.cost as Record<string, number> | undefined;
          onCost(
            cost?.total ?? 0,
            (usage.totalTokens as number) ?? 0,
            (usage.cacheRead as number) ?? 0,
          );
          onStream({
            type: "cost",
            costUsd: cost?.total ?? 0,
            tokensUsed: (usage.totalTokens as number) ?? 0,
            cacheReadTokens: (usage.cacheRead as number) ?? 0,
          });
        }
      }

      if (role === "toolResult") {
        const toolName = (msg.toolName as string) ?? "unknown";
        const isError = msg.isError as boolean;
        onStream({
          type: "tool_result",
          tool: toolName,
          status: isError ? "error" : "success",
        });
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
