/**
 * Pi Embedded Adapter
 * 
 * Uses the Pi SDK's createAgentSession() directly instead of spawning
 * a pi subprocess. Lower latency, better control, direct event streaming.
 * 
 * Requires @earendil-works/pi-coding-agent to be installed separately.
 * The adapter gracefully degrades (isAvailable() returns false) if the
 * SDK is not present.
 */

import { join } from "path";
import { mkdirSync } from "fs";
import type { PlatformAdapter, DelegateOptions, DelegateResult } from "../types";

// Pi SDK types -- kept loose to avoid hard compile-time dependency.
// The SDK is loaded dynamically at runtime; CI can type-check without it.
interface PiAuthStorage {
  setRuntimeApiKey(provider: string, key: string): void;
}
interface PiModel {
  provider: string;
  id: string;
}
interface PiModelRegistry {
  find(provider: string, id: string): PiModel | undefined;
}
interface PiSessionStats {
  cost: number;
  tokens: { total: number };
}
interface PiAgentSession {
  prompt(msg: string): Promise<void>;
  steer(msg: string): void;
  subscribe(listener: (event: any) => void): () => void;
  dispose(): void;
  isStreaming: boolean;
  getLastAssistantText(): string | undefined;
  getSessionStats(): PiSessionStats;
}

// Dynamic loader for Pi SDK
let piModule: any = null;

async function loadSdk(): Promise<{
  createAgentSession: (opts: any) => Promise<{ session: PiAgentSession }>;
  AuthStorage: { inMemory(): PiAuthStorage };
  ModelRegistry: { create(auth: PiAuthStorage, path: string): PiModelRegistry };
} | null> {
  if (piModule) return piModule;
  try {
    // Use variable to prevent tsc from resolving the module at compile time
    const sdkName = "@earendil-works/pi-coding-agent";
    piModule = await import(/* webpackIgnore: true */ sdkName);
    return piModule;
  } catch {
    return null;
  }
}

export class PiEmbeddedAdapter implements PlatformAdapter {
  name = "pi-embedded";

  private configDir: string;

  constructor(configDir?: string) {
    this.configDir = configDir ?? join(process.cwd(), "configs", "bilby-pi");
  }

  async isAvailable(): Promise<boolean> {
    const sdk = await loadSdk();
    return sdk !== null;
  }

  async delegate(opts: DelegateOptions): Promise<DelegateResult> {
    const pi = await loadSdk();
    if (!pi) {
      return {
        agentId: "pi-emb-unavailable",
        agentName: opts.persona.name,
        output: "ERROR: @earendil-works/pi-coding-agent SDK not installed",
        grade: "FAILED",
        findings: ["sdk_not_installed"],
        costUsd: 0,
        tokensUsed: 0,
      };
    }

    const agentId = `pi-emb-${opts.persona.name.toLowerCase().replace(/\s+/g, "-")}`;
    mkdirSync(opts.sessionDir, { recursive: true });

    // Create auth storage with API keys from environment
    const authStorage = pi.AuthStorage.inMemory();
    if (process.env.ANTHROPIC_API_KEY) {
      authStorage.setRuntimeApiKey("anthropic", process.env.ANTHROPIC_API_KEY);
    }
    if (process.env.OPENAI_API_KEY) {
      authStorage.setRuntimeApiKey("openai", process.env.OPENAI_API_KEY);
    }
    if (process.env.LITELLM_API_KEY) {
      authStorage.setRuntimeApiKey("litellm", process.env.LITELLM_API_KEY);
    }

    // Create model registry from config
    const modelsJsonPath = join(this.configDir, "models.json");
    const modelRegistry = pi.ModelRegistry.create(authStorage, modelsJsonPath);

    // Resolve model string to SDK Model object
    const modelParts = opts.model.split("/");
    const provider = modelParts.length > 1 ? modelParts[0]! : "anthropic";
    const modelId = modelParts.length > 1 ? modelParts[1]! : modelParts[0]!;
    const model = modelRegistry.find(provider, modelId);

    if (!model) {
      console.error(`[pi-embedded] Model not found: ${opts.model} (provider=${provider}, id=${modelId})`);
      return {
        agentId,
        agentName: opts.persona.name,
        output: `ERROR: Model not found: ${opts.model}`,
        grade: "FAILED",
        findings: [`model_not_found: ${opts.model}`],
        costUsd: 0,
        tokensUsed: 0,
      };
    }

    console.log(`[pi-embedded] Creating session for ${opts.persona.name} with ${model.provider}/${model.id}`);

    let session: Awaited<ReturnType<typeof pi.createAgentSession>>["session"] | null = null;
    let unsubscribeFn: (() => void) | null = null;
    try {
      const created = await pi.createAgentSession({
        cwd: opts.workingDir,
        model,
        thinkingLevel: opts.thinking,
        authStorage,
        modelRegistry,
        tools: opts.tools.filter((t: string) => t !== "delegate"),
      });
      session = created.session;

      let totalCost = 0;
      let totalTokens = 0;

      // Subscribe to events for streaming to dashboard
      unsubscribeFn = session.subscribe((event: any) => {
        switch (event.type) {
          case "tool_use_begin":
            opts.onStreamEvent?.({
              type: "tool_call",
              tool: event.tool?.name ?? "unknown",
              status: "running",
            });
            break;
          case "tool_use_end":
            opts.onStreamEvent?.({
              type: "tool_result",
              tool: event.tool?.name ?? "unknown",
              status: "success",
            });
            break;
          case "message_end": {
            if (event.usage) {
              totalCost += event.usage.cost?.total ?? 0;
              totalTokens += event.usage.totalTokens ?? 0;
              opts.onStreamEvent?.({
                type: "cost",
                costUsd: totalCost,
                tokensUsed: totalTokens,
              });
            }
            break;
          }
        }
      });

      // Register steering callback
      if (opts.sendMessage) {
        opts.sendMessage((msg: string) => {
          session!.steer(msg);
        });
      }

      // Send prompt and wait for completion
      await session!.prompt(opts.userPrompt);

      // Wait for agent to finish processing tool calls (with timeout)
      const streamDeadline = Date.now() + (opts.timeoutMs ?? 300_000);
      while (session!.isStreaming && Date.now() < streamDeadline) {
        await new Promise(r => setTimeout(r, 100));
      }
      if (session!.isStreaming) {
        console.error(`[pi-embedded] ${opts.persona.name} stream timed out, force-disposing`);
        const partialText = session!.getLastAssistantText?.() ?? "";
        unsubscribeFn?.();
        session!.dispose();
        return {
          agentId,
          agentName: opts.persona.name,
          output: partialText || `ERROR: Stream timed out after ${opts.timeoutMs ?? 300_000}ms`,
          grade: partialText ? this.extractGrade(partialText) : "FAILED",
          findings: partialText ? this.extractFindings(partialText) : ["timeout"],
          costUsd: totalCost,
          tokensUsed: totalTokens,
        };
      }

      // Extract results
      const finalText = session!.getLastAssistantText() ?? "";
      const stats = session!.getSessionStats();
      totalCost = stats.cost;
      totalTokens = stats.tokens.total;

      unsubscribeFn?.();
      session!.dispose();

      return {
        agentId,
        agentName: opts.persona.name,
        output: finalText || "ERROR: Empty output",
        grade: this.extractGrade(finalText),
        findings: this.extractFindings(finalText),
        costUsd: totalCost,
        tokensUsed: totalTokens,
      };
    } catch (err) {
      console.error(`[pi-embedded] Session error for ${opts.persona.name}:`, err);
      try { unsubscribeFn?.(); } catch {}
      try { session?.dispose(); } catch {}
      return {
        agentId,
        agentName: opts.persona.name,
        output: `ERROR: ${err instanceof Error ? err.message : String(err)}`,
        grade: "FAILED",
        findings: [String(err)],
        costUsd: 0,
        tokensUsed: 0,
      };
    }
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
