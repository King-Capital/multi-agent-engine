/**
 * Pi Embedded Adapter
 * 
 * Uses the Pi SDK's createAgentSession() directly instead of spawning
 * a pi subprocess. Lower latency, better control, direct event streaming.
 * 
 * Requires:
 * - @earendil-works/pi-coding-agent SDK
 * - AuthStorage with API keys configured
 * - ModelRegistry with providers/models configured
 */

import { join } from "path";
import { mkdirSync } from "fs";
import type { PlatformAdapter, DelegateOptions, DelegateResult, StreamEvent } from "../types";

// Dynamic import for the Pi SDK (only loaded when adapter is used)
let piModule: typeof import("@earendil-works/pi-coding-agent") | null = null;

async function loadSdk() {
  if (!piModule) {
    piModule = await import("@earendil-works/pi-coding-agent");
  }
  return piModule;
}

export class PiEmbeddedAdapter implements PlatformAdapter {
  name = "pi-embedded";

  private configDir: string;

  constructor(configDir?: string) {
    this.configDir = configDir ?? join(process.cwd(), "configs", "bilby-pi");
  }

  async isAvailable(): Promise<boolean> {
    try {
      await loadSdk();
      return true;
    } catch {
      return false;
    }
  }

  async delegate(opts: DelegateOptions): Promise<DelegateResult> {
    const pi = await loadSdk();
    const agentId = `pi-emb-${opts.persona.name.toLowerCase().replace(/\s+/g, "-")}`;

    mkdirSync(opts.sessionDir, { recursive: true });

    // Create auth storage with API keys from environment
    const authStorage = pi.AuthStorage.inMemory();
    
    // Set API keys from environment
    if (process.env.ANTHROPIC_API_KEY) {
      authStorage.setRuntimeApiKey("anthropic", process.env.ANTHROPIC_API_KEY);
    }
    if (process.env.OPENAI_API_KEY) {
      authStorage.setRuntimeApiKey("openai", process.env.OPENAI_API_KEY);
    }
    // LiteLLM proxy key
    if (process.env.LITELLM_API_KEY) {
      authStorage.setRuntimeApiKey("litellm", process.env.LITELLM_API_KEY);
    }

    // Create model registry
    const modelsJsonPath = join(this.configDir, "models.json");
    const modelRegistry = pi.ModelRegistry.create(authStorage, modelsJsonPath);

    // Resolve the model string to a Model object
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

    try {
      const { session } = await pi.createAgentSession({
        cwd: opts.workingDir,
        model,
        thinkingLevel: opts.thinking as any,
        authStorage,
        modelRegistry,
        tools: opts.tools.filter(t => t !== "delegate"),
      });

      // Set system prompt
      // Note: AgentSession builds its own system prompt, but we can influence it
      // through the session's settings

      let finalText = "";
      let totalCost = 0;
      let totalTokens = 0;

      // Subscribe to events for streaming
      const unsubscribe = session.subscribe((event: any) => {
        switch (event.type) {
          case "tool_use_begin":
            opts.onStreamEvent?.({
              type: "tool_call",
              tool: (event as any).tool?.name ?? "unknown",
              status: "running",
            });
            break;
          case "tool_use_end":
            opts.onStreamEvent?.({
              type: "tool_result",
              tool: (event as any).tool?.name ?? "unknown",
              status: "success",
            });
            break;
          case "message_end": {
            const msg = event as any;
            if (msg.usage) {
              totalCost += msg.usage.cost?.total ?? 0;
              totalTokens += msg.usage.totalTokens ?? 0;
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

      // Register message sender for steering
      if (opts.sendMessage) {
        opts.sendMessage((msg: string) => {
          session.steer(msg);
        });
      }

      // Send the prompt and wait for completion
      await session.prompt(opts.userPrompt);

      // Wait for agent to finish (it processes tool calls automatically)
      // The agent loop runs until no more tool calls are pending
      while (session.isStreaming) {
        await new Promise(r => setTimeout(r, 100));
      }

      // Extract final output
      const lastAssistant = session.getLastAssistantText();
      finalText = lastAssistant ?? "";

      // Get session stats for cost
      const stats = session.getSessionStats();
      totalCost = stats.cost;
      totalTokens = stats.tokens.total;

      unsubscribe();
      session.dispose();

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
