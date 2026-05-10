import { $ } from "bun";
import { mkdirSync, existsSync } from "fs";
import { join } from "path";
import type { PlatformAdapter, DelegateOptions, DelegateResult, StreamEvent, GradeLevel } from "../types";

export class PiAdapter implements PlatformAdapter {
  name = "pi";

  private static MODEL_PRICING: Record<string, { input: number; output: number; cacheRead?: number }> = {
    // Anthropic (per million tokens)
    "opus-nocache": { input: 15, output: 75, cacheRead: 1.5 },
    "sonnet-nocache": { input: 3, output: 15, cacheRead: 0.3 },
    "claude-opus-4.6": { input: 15, output: 75, cacheRead: 1.5 },
    "claude-sonnet-4.6": { input: 3, output: 15, cacheRead: 0.3 },
    // Gemini
    "gemini-3.1-pro": { input: 1.25, output: 5 },
    "pro-nocache": { input: 1.25, output: 5 },
    // OpenAI
    "gpt-5.5": { input: 2, output: 8 },
    "o3-mini": { input: 1.1, output: 4.4 },
  };


  private static MODEL_TIMEOUTS: Record<string, number> = {
    "opus-nocache": 600_000,
    "claude-opus-4.6": 600_000,
    "sonnet-nocache": 300_000,
    "claude-sonnet-4.6": 300_000,
    "gpt-5.5": 300_000,
    "pro-nocache": 300_000,
    "o3-mini": 180_000,
  };

  private getModelTimeout(model: string): number {
    const mapped = this.mapModel(model);
    return PiAdapter.MODEL_TIMEOUTS[mapped] ?? 300_000;
  }

  private isTransientError(output: string): boolean {
    const transient = ["rate_limit", "429", "503", "overloaded", "context_length", "server_error", "connection", "timeout"];
    const lower = output.toLowerCase();
    return transient.some(t => lower.includes(t));
  }

  private computeCostFromTokens(model: string, inputTokens: number, outputTokens: number, cacheReadTokens: number, totalTokens?: number): number {
    const mapped = this.mapModel(model);
    const pricing = PiAdapter.MODEL_PRICING[mapped];
    if (!pricing) return 0;
    // If we have granular token counts, use them
    if (inputTokens > 0 || outputTokens > 0) {
      const billableInput = Math.max(0, inputTokens - cacheReadTokens);
      const inputCost = billableInput * pricing.input / 1_000_000;
      const outputCost = outputTokens * pricing.output / 1_000_000;
      const cacheCost = cacheReadTokens * (pricing.cacheRead ?? pricing.input * 0.1) / 1_000_000;
      return inputCost + outputCost + cacheCost;
    }
    // Fallback: only totalTokens available -- estimate 70% input, 30% output
    if (totalTokens && totalTokens > 0) {
      const estInput = Math.round(totalTokens * 0.7);
      const estOutput = totalTokens - estInput;
      return (estInput * pricing.input + estOutput * pricing.output) / 1_000_000;
    }
    return 0;
  }

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

    const piModel = this.mapModel(opts.model);
    const args = [
      "pi",
      "--mode", "rpc",
      "--no-session",
      "--model", piModel,
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

    const timeout = opts.timeoutMs ?? this.getModelTimeout(opts.model);

    let totalCost = 0;
    let totalTokens = 0;
    let cacheReadTokens = 0;
    let finalText = "";

    return new Promise<DelegateResult>((resolve) => {
      let resolved = false;
      const safeResolve = (result: DelegateResult) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        resolve(result);
      };

      const proc = Bun.spawn(args, {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        cwd: opts.workingDir,
        env: {
          ...process.env,
          MAE_SESSION_ID: opts.sessionDir?.split("/").pop() ?? "",
          MAE_AGENT_ID: opts.persona.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
          MAE_PARENT_ID: opts.parentId ?? "",
          MAE_DASHBOARD_URL: process.env.MAE_DASHBOARD_URL ?? "",
          MAE_API_TOKEN: process.env.MAE_API_TOKEN ?? "",
        },
      });

      const timer = setTimeout(async () => {
        console.error(`[pi-rpc] ${opts.persona.name} timed out after ${timeout}ms`);
        // Step 1: send abort RPC + cancel reader
        this.sendCmd(proc, { type: "abort" });
        try { reader.cancel(); } catch {}
        try { const stdin = proc.stdin; if (stdin && "end" in stdin) (stdin as any).end(); } catch {}
        // Step 2: wait 5s, then SIGTERM
        await Bun.sleep(5000);
        if (resolved) return;
        try { proc.kill(); } catch {}
        // Step 3: wait 3s more, then SIGKILL if still alive
        await Bun.sleep(3000);
        if (resolved) return;
        try { proc.kill(9); } catch {}
        // Step 4: force-resolve with timeout error
        safeResolve({
          agentId,
          agentName: opts.persona.name,
          output: finalText || `ERROR: Agent timed out after ${timeout}ms (force-killed)`,
          grade: finalText ? this.extractGrade(finalText) : "FAILED",
          findings: finalText ? this.extractFindings(finalText) : ["timeout"],
          costUsd: totalCost,
          tokensUsed: totalTokens,
        });
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
                  let toolResult = "";
                  if (evt.result) {
                    try {
                      toolResult = (typeof evt.result === "string" ? evt.result : JSON.stringify(evt.result)).slice(0, 2000);
                    } catch { /* ignore */ }
                  }
                  opts.onStreamEvent?.({
                    type: "tool_result",
                    tool: toolName,
                    toolResult,
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
                    // If no cost reported, compute from token counts
                    if (totalCost === 0 && totalTokens > 0) {
                      const inputTokens = messages.reduce((sum: number, m: { usage?: { inputTokens?: number; input_tokens?: number } }) =>
                        sum + (m.usage?.inputTokens ?? m.usage?.input_tokens ?? 0), 0);
                      const outputTokens = messages.reduce((sum: number, m: { usage?: { outputTokens?: number; output_tokens?: number } }) =>
                        sum + (m.usage?.outputTokens ?? m.usage?.output_tokens ?? 0), 0);
                      totalCost = this.computeCostFromTokens(opts.model, inputTokens, outputTokens, cacheReadTokens);
                    }
                    }
                  }
                  opts.onStreamEvent?.({ type: "cost", costUsd: totalCost, tokensUsed: totalTokens, cacheReadTokens });

                  // Agent done — kill RPC process and resolve
                  proc.kill();
                  safeResolve({
                    agentId,
                    agentName: opts.persona.name,
                    output: finalText || "ERROR: Empty output",
                    grade: this.extractGrade(finalText),
                    findings: this.extractFindings(finalText),
                    costUsd: totalCost,
                    tokensUsed: totalTokens,
                  });
                  return;
                }
              } catch {
                // not valid JSON
              }
            }
          }
        } catch {
          // stream closed
        }

        // Stream ended without agent_end — race with proc.exited
        const exitCode = await proc.exited;
        const stderr = await new Response(proc.stderr).text();

        if (resolved) return; // already resolved by timeout or agent_end

        if (exitCode === 137 || exitCode === 143) {
          safeResolve({
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
          safeResolve({
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

        safeResolve({
          agentId,
          agentName: opts.persona.name,
          output: finalText || "ERROR: Empty output",
          grade: this.extractGrade(finalText),
          findings: this.extractFindings(finalText),
          costUsd: totalCost,
          tokensUsed: totalTokens,
        });
      };

      // Race: processStream vs proc.exited (handles hung stream)
      void proc.exited.then(async (exitCode) => {
        // Give stream a moment to finish processing
        await Bun.sleep(1000);
        if (resolved) return;

        // Stream is hung — force resolve
        console.error(`[pi-rpc] ${opts.persona.name} exited (code ${exitCode}) but stream still open, force-resolving`);
        try { reader.cancel(); } catch {}

        const stderr = await new Response(proc.stderr).text().catch(() => "");

        if (exitCode !== 0 && !finalText) {
          safeResolve({
            agentId,
            agentName: opts.persona.name,
            output: `ERROR: Process exited ${exitCode}: ${stderr}`,
            grade: "FAILED",
            findings: [stderr || `exit code ${exitCode}`],
            costUsd: totalCost,
            tokensUsed: totalTokens,
          });
        } else {
          safeResolve({
            agentId,
            agentName: opts.persona.name,
            output: finalText || "ERROR: Empty output",
            grade: this.extractGrade(finalText),
            findings: this.extractFindings(finalText),
            costUsd: totalCost,
            tokensUsed: totalTokens,
          });
        }
      }).catch((err) => {
        console.error(`[pi-rpc] exitRace error for ${opts.persona.name}:`, err);
      });

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
      let toolArgs = "";
      if (args) {
        filePath = ((args.file_path ?? args.path ?? args.command ?? "") as string).slice(0, 500);
        // Capture full args as JSON for detail view
        try {
          toolArgs = JSON.stringify(args, null, 2).slice(0, 2000);
        } catch { /* ignore */ }
      }
      onStream({
        type: "tool_call",
        tool: toolName,
        filePath,
        toolArgs,
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
          let finalCost = costTotal;
          if (finalCost === 0 && tokens > 0) {
            // Pi/LiteLLM didn't report cost -- compute from token counts
            const inputTokens = (usage.inputTokens as number) ?? (usage.input_tokens as number) ?? 0;
            const outputTokens = (usage.outputTokens as number) ?? (usage.output_tokens as number) ?? 0;
            finalCost = this.computeCostFromTokens(
              (msg as Record<string, unknown>).model as string ?? "opus-nocache",
              inputTokens, outputTokens, cache, tokens
            );
          }
          if (finalCost > 0 || tokens > 0) {
            onCost(finalCost, tokens, cache);
            onStream({ type: "cost", costUsd: finalCost, tokensUsed: tokens, cacheReadTokens: cache });
          }
        }
      }
    }
  }

  private static readonly PI_MODEL_MAP: Record<string, string> = {
    "opus": "claude-opus-4-6",
    "sonnet": "claude-sonnet-4-6",
    "haiku": "claude-haiku-4-5",
    "quality": "claude-opus-4-6",
    "main": "claude-sonnet-4-6",
    "fast": "claude-sonnet-4-6",
    "gpt-5.5": "openai-codex/gpt-5.5",
    "gpt-5.4": "openai-codex/gpt-5.4",
    "gpt-5.4-mini": "openai-codex/gpt-5.4-mini",
    "gpt": "openai-codex/gpt-5.5",
    "gpt-mini": "openai-codex/gpt-5.4-mini",
    "gemini-3.1-pro": "gemini-2.5-pro",
    "gemini-3-pro": "gemini-2.5-pro",
    "flash": "gemini-2.5-flash",
    "pro": "openai-codex/gpt-5.5",
  };

  private mapModel(model: string): string {
    const parts = model.split("/");
    const name = parts[parts.length - 1]!;
    return PiAdapter.PI_MODEL_MAP[name] ?? name;
  }

  private extractGrade(output: string): GradeLevel | undefined {
    const match = output.match(/GRADE:\s*(PERFECT|VERIFIED|PASS|PARTIAL|FEEDBACK|NEEDS_WORK|FAILED)/i);
    if (!match?.[1]) return undefined;
    const raw = match[1].toUpperCase();
    if (raw === "PASS") return "VERIFIED";
    if (raw === "NEEDS_WORK") return "FEEDBACK";
    return raw as GradeLevel;
  }

  private extractFindings(output: string): string[] {
    const findings: string[] = [];
    for (const line of output.split("\n")) {
      if (/^\s*-\s*P[0-3]:/.test(line)) findings.push(line.trim());
    }
    return findings;
  }
}
