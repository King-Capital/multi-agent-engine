/**
 * A2A (Agent-to-Agent) Protocol Adapter
 *
 * Implements PlatformAdapter by delegating tasks to remote A2A-compatible agents
 * via JSON-RPC 2.0 over HTTP(S).
 *
 * Protocol: https://a2a-protocol.org/latest/specification/
 * Spec version: 1.0.0
 *
 * Supports:
 * - Agent discovery via /.well-known/agent-card.json
 * - Synchronous message/send (immediate response)
 * - Streaming message/sendStream (SSE for long-running tasks)
 * - Task polling via tasks/get (fallback for non-streaming agents)
 */

import { randomUUID } from "crypto";
import type {
  PlatformAdapter,
  DelegateOptions,
  DelegateResult,
  StreamEvent,
} from "../types";

// --- A2A Protocol Types ---

interface AgentCard {
  name: string;
  description?: string;
  url: string;
  version?: string;
  protocolVersion?: string;
  skills?: Array<{
    id: string;
    name: string;
    description?: string;
    tags?: string[];
  }>;
  capabilities?: {
    streaming?: boolean;
    pushNotifications?: boolean;
  };
  defaultInputModes?: string[];
  defaultOutputModes?: string[];
}

interface A2APart {
  kind: "text" | "file" | "data";
  text?: string;
  mimeType?: string;
  data?: unknown;
}

interface A2AMessage {
  kind: "message";
  messageId: string;
  role: "user" | "agent";
  parts: A2APart[];
  contextId?: string;
}

interface A2ATask {
  kind: "task";
  id: string;
  contextId?: string;
  status: {
    state: "submitted" | "working" | "input-required" | "completed" | "failed" | "canceled" | "rejected";
    message?: A2AMessage;
    timestamp?: string;
  };
  artifacts?: Array<{
    artifactId: string;
    name?: string;
    parts: A2APart[];
  }>;
  history?: A2AMessage[];
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string;
  method: string;
  params: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string;
  result?: A2ATask | A2AMessage;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

// --- Configuration ---

export interface A2AEndpoint {
  /** Base URL of the remote A2A agent (e.g., "http://localhost:41271") */
  url: string;
  /** Optional bearer token for auth */
  token?: string;
  /** Path to agent card (default: /.well-known/agent-card.json) */
  agentCardPath?: string;
  /** Use streaming (SSE) if agent supports it (default: true) */
  streaming?: boolean;
  /** Poll interval in ms for non-streaming task completion (default: 2000) */
  pollIntervalMs?: number;
}

// --- Adapter ---

export class A2AAdapter implements PlatformAdapter {
  name = "a2a";

  private endpoints: Map<string, A2AEndpoint> = new Map();
  private agentCards: Map<string, AgentCard> = new Map();
  private defaultEndpoint: A2AEndpoint | null = null;

  /**
   * Register a named remote agent endpoint.
   * Names match team/persona names in MAE config for per-team routing.
   */
  registerEndpoint(name: string, endpoint: A2AEndpoint): void {
    this.endpoints.set(name.toLowerCase(), endpoint);
    if (!this.defaultEndpoint) {
      this.defaultEndpoint = endpoint;
    }
  }

  setDefaultEndpoint(endpoint: A2AEndpoint): void {
    this.defaultEndpoint = endpoint;
  }

  async isAvailable(): Promise<boolean> {
    if (!this.defaultEndpoint && this.endpoints.size === 0) return false;

    // Try to fetch agent card from at least one endpoint
    for (const [name, endpoint] of this.endpoints) {
      try {
        const card = await this.fetchAgentCard(endpoint);
        if (card) {
          this.agentCards.set(name, card);
          return true;
        }
      } catch {
        // endpoint unreachable, try next
      }
    }

    if (this.defaultEndpoint) {
      try {
        const card = await this.fetchAgentCard(this.defaultEndpoint);
        return card !== null;
      } catch {
        return false;
      }
    }

    return false;
  }

  async delegate(opts: DelegateOptions): Promise<DelegateResult> {
    const agentId = `a2a-${opts.persona.name.toLowerCase().replace(/\s+/g, "-")}`;
    const endpoint = this.resolveEndpoint(opts.persona.name, opts.teamName);

    if (!endpoint) {
      return {
        agentId,
        agentName: opts.persona.name,
        output: "ERROR: No A2A endpoint configured for this agent/team",
        grade: "FAILED",
        findings: ["no_endpoint"],
        costUsd: 0,
        tokensUsed: 0,
      };
    }

    const contextId = randomUUID();
    const messageId = randomUUID();

    // Build the A2A message from MAE's delegate options
    const userMessage: A2AMessage = {
      kind: "message",
      messageId,
      role: "user",
      parts: [
        {
          kind: "text",
          text: [
            opts.systemPrompt,
            "",
            "---",
            "",
            opts.userPrompt,
          ].join("\n"),
        },
      ],
      contextId,
    };

    const timeout = opts.timeoutMs ?? 300_000;

    console.log(`[a2a] Delegating to ${opts.persona.name} at ${endpoint.url}`);

    try {
      // Try streaming first if supported
      const agentCard = this.agentCards.get(opts.persona.name.toLowerCase())
        ?? await this.fetchAgentCard(endpoint);

      const useStreaming = (endpoint.streaming !== false)
        && (agentCard?.capabilities?.streaming !== false);

      let result: DelegateResult;

      if (useStreaming) {
        result = await this.delegateStreaming(endpoint, userMessage, opts, agentId, timeout);
      } else {
        result = await this.delegateSync(endpoint, userMessage, opts, agentId, timeout);
      }

      return result;
    } catch (err) {
      console.error(`[a2a] Error delegating to ${opts.persona.name}:`, err);
      return {
        agentId,
        agentName: opts.persona.name,
        output: `ERROR: A2A delegation failed: ${err}`,
        grade: "FAILED",
        findings: [`${err}`],
        costUsd: 0,
        tokensUsed: 0,
      };
    }
  }

  // --- Synchronous send (message/send) ---

  private async delegateSync(
    endpoint: A2AEndpoint,
    message: A2AMessage,
    opts: DelegateOptions,
    agentId: string,
    timeout: number
  ): Promise<DelegateResult> {
    const rpcRequest: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: randomUUID(),
      method: "message/send",
      params: {
        message,
      },
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (endpoint.token) {
      headers["Authorization"] = `Bearer ${endpoint.token}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(endpoint.url, {
        method: "POST",
        headers,
        body: JSON.stringify(rpcRequest),
        signal: controller.signal,
      });

      if (!response.ok) {
        clearTimeout(timer);
        const body = await response.text();
        return {
          agentId,
          agentName: opts.persona.name,
          output: `ERROR: A2A server returned HTTP ${response.status}: ${body.slice(0, 500)}`,
          grade: "FAILED",
          findings: [`http_${response.status}`],
          costUsd: 0,
          tokensUsed: 0,
        };
      }

      const rpcResponse = (await response.json()) as JsonRpcResponse;
      clearTimeout(timer);

      if (rpcResponse.error) {
        return {
          agentId,
          agentName: opts.persona.name,
          output: `ERROR: A2A RPC error ${rpcResponse.error.code}: ${rpcResponse.error.message}`,
          grade: "FAILED",
          findings: [rpcResponse.error.message],
          costUsd: 0,
          tokensUsed: 0,
        };
      }

      const resultObj = rpcResponse.result;

      // Response can be a direct Message or a Task
      if (resultObj?.kind === "message") {
        return this.messageToResult(resultObj as A2AMessage, opts.persona.name, agentId);
      }

      if (resultObj?.kind === "task") {
        const task = resultObj as A2ATask;

        // If task is already completed, extract result
        if (task.status.state === "completed" || task.status.state === "failed") {
          return this.taskToResult(task, opts.persona.name, agentId);
        }

        // Task is still running -- poll for completion
        return this.pollTask(endpoint, task.id, opts, agentId, timeout);
      }

      return {
        agentId,
        agentName: opts.persona.name,
        output: `ERROR: Unexpected A2A response kind: ${(resultObj as any)?.kind}`,
        grade: "FAILED",
        findings: ["unexpected_response"],
        costUsd: 0,
        tokensUsed: 0,
      };
    } catch (err: any) {
      clearTimeout(timer);
      if (err.name === "AbortError") {
        return {
          agentId,
          agentName: opts.persona.name,
          output: `ERROR: A2A request timed out after ${timeout}ms`,
          grade: "FAILED",
          findings: ["timeout"],
          costUsd: 0,
          tokensUsed: 0,
        };
      }
      throw err;
    }
  }

  // --- Streaming send (message/stream) via SSE ---

  private async delegateStreaming(
    endpoint: A2AEndpoint,
    message: A2AMessage,
    opts: DelegateOptions,
    agentId: string,
    timeout: number
  ): Promise<DelegateResult> {
    const rpcRequest: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: randomUUID(),
      // NOTE: A2A spec uses "message/sendStream" but many implementations use "message/stream".
      // Keeping "message/stream" for backwards compatibility with existing agents.
      method: "message/stream",
      params: {
        message,
      },
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept": "text/event-stream",
    };
    if (endpoint.token) {
      headers["Authorization"] = `Bearer ${endpoint.token}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(endpoint.url, {
        method: "POST",
        headers,
        body: JSON.stringify(rpcRequest),
        signal: controller.signal,
      });

      if (!response.ok) {
        clearTimeout(timer);
        // Fall back to sync if streaming not supported
        if (response.status === 405 || response.status === 501) {
          console.log(`[a2a] Streaming not supported by ${endpoint.url}, falling back to sync`);
          return this.delegateSync(endpoint, message, opts, agentId, timeout);
        }

        const body = await response.text();
        return {
          agentId,
          agentName: opts.persona.name,
          output: `ERROR: A2A stream returned HTTP ${response.status}: ${body.slice(0, 500)}`,
          grade: "FAILED",
          findings: [`http_${response.status}`],
          costUsd: 0,
          tokensUsed: 0,
        };
      }

      // Check if response is actually SSE
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("text/event-stream")) {
        // Not SSE -- treat as regular JSON-RPC response
        const rpcResponse = (await response.json()) as JsonRpcResponse;
        clearTimeout(timer);
        if (rpcResponse.error) {
          return {
            agentId,
            agentName: opts.persona.name,
            output: `ERROR: ${rpcResponse.error.message}`,
            grade: "FAILED",
            findings: [rpcResponse.error.message],
            costUsd: 0,
            tokensUsed: 0,
          };
        }
        const resultObj = rpcResponse.result;
        if (resultObj?.kind === "message") {
          return this.messageToResult(resultObj as A2AMessage, opts.persona.name, agentId);
        }
        if (resultObj?.kind === "task") {
          return this.taskToResult(resultObj as A2ATask, opts.persona.name, agentId);
        }
      }

      // Parse SSE stream (clearTimeout happens inside after body is fully consumed)
      const result = await this.parseSSEStream(response, opts, agentId);
      clearTimeout(timer);
      return result;
    } catch (err: any) {
      clearTimeout(timer);
      if (err.name === "AbortError") {
        return {
          agentId,
          agentName: opts.persona.name,
          output: `ERROR: A2A stream timed out after ${timeout}ms`,
          grade: "FAILED",
          findings: ["timeout"],
          costUsd: 0,
          tokensUsed: 0,
        };
      }
      throw err;
    }
  }

  // --- SSE Stream Parser ---

  private async parseSSEStream(
    response: Response,
    opts: DelegateOptions,
    agentId: string
  ): Promise<DelegateResult> {
    if (!response.body) {
      return {
        agentId,
        agentName: opts.persona.name,
        output: "ERROR: A2A stream response has no body",
        grade: "FAILED",
        findings: ["no_response_body"],
        costUsd: 0,
        tokensUsed: 0,
      };
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let resultText = "";
    let lastTask: A2ATask | null = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      let eventType = "";
      let eventData = "";

      for (const line of lines) {
        if (line.startsWith("event:")) {
          eventType = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          eventData += (eventData ? "\n" : "") + line.slice(5).trim();
        } else if (line.trim() === "" && eventData) {
          // End of SSE event -- process it
          try {
            const parsed = JSON.parse(eventData);

            // Handle JSON-RPC wrapper
            const result = parsed.result ?? parsed;

            if (result.kind === "message") {
              const msg = result as A2AMessage;
              const text = this.extractTextFromParts(msg.parts);
              if (text) resultText += text + "\n";

              opts.onStreamEvent?.({
                type: "assistant_text",
                content: text.slice(0, 500),
              });
            }

            if (result.kind === "task") {
              lastTask = result as A2ATask;

              // Emit status updates
              if (lastTask.status.state === "working") {
                opts.onStreamEvent?.({
                  type: "assistant_text",
                  content: `[${opts.persona.name}] working...`,
                });
              }
            }

            // TaskStatusUpdateEvent
            if (result.status) {
              if (result.status.message?.parts) {
                const text = this.extractTextFromParts(result.status.message.parts);
                if (text) resultText += text + "\n";
              }
              if (result.status.state) {
                if (lastTask) lastTask.status = result.status;
              }
            }

            // TaskArtifactUpdateEvent
            if (result.artifact?.parts) {
              const text = this.extractTextFromParts(result.artifact.parts);
              if (text) resultText += text + "\n";
            }
          } catch {
            // Non-JSON SSE data, skip
          }

          eventType = "";
          eventData = "";
        }
      }
    }

    // Build final result
    if (lastTask) {
      // Append any artifact text we haven't captured
      if (lastTask.artifacts) {
        for (const artifact of lastTask.artifacts) {
          const text = this.extractTextFromParts(artifact.parts);
          if (text && !resultText.includes(text)) {
            resultText += text + "\n";
          }
        }
      }
    }

    if (!resultText.trim()) {
      return {
        agentId,
        agentName: opts.persona.name,
        output: "ERROR: Empty response from A2A stream",
        grade: "FAILED",
        findings: ["empty_output"],
        costUsd: 0,
        tokensUsed: 0,
      };
    }

    return {
      agentId,
      agentName: opts.persona.name,
      output: resultText.trim(),
      grade: this.extractGrade(resultText),
      findings: this.extractFindings(resultText),
      costUsd: 0, // A2A doesn't expose cost in protocol
      tokensUsed: 0,
    };
  }

  // --- Task Polling ---

  private async pollTask(
    endpoint: A2AEndpoint,
    taskId: string,
    opts: DelegateOptions,
    agentId: string,
    remainingTimeout: number
  ): Promise<DelegateResult> {
    const pollInterval = endpoint.pollIntervalMs ?? 2000;
    const startTime = Date.now();

    console.log(`[a2a] Polling task ${taskId} every ${pollInterval}ms`);

    while (Date.now() - startTime < remainingTimeout) {
      await new Promise((resolve) => setTimeout(resolve, pollInterval));

      const rpcRequest: JsonRpcRequest = {
        jsonrpc: "2.0",
        id: randomUUID(),
        method: "tasks/get",
        params: { id: taskId },
      };

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (endpoint.token) {
        headers["Authorization"] = `Bearer ${endpoint.token}`;
      }

      try {
        const response = await fetch(endpoint.url, {
          method: "POST",
          headers,
          body: JSON.stringify(rpcRequest),
        });

        if (!response.ok) continue;

        const rpcResponse = (await response.json()) as JsonRpcResponse;
        if (rpcResponse.error) continue;

        const task = rpcResponse.result as A2ATask;
        if (!task?.status) continue;

        opts.onStreamEvent?.({
          type: "assistant_text",
          content: `[${opts.persona.name}] status: ${task.status.state}`,
        });

        if (task.status.state === "completed" || task.status.state === "failed" ||
            task.status.state === "canceled" || task.status.state === "rejected") {
          return this.taskToResult(task, opts.persona.name, agentId);
        }
      } catch {
        // Poll failure, continue trying
      }
    }

    return {
      agentId,
      agentName: opts.persona.name,
      output: `ERROR: A2A task ${taskId} timed out after ${remainingTimeout}ms`,
      grade: "FAILED",
      findings: ["timeout"],
      costUsd: 0,
      tokensUsed: 0,
    };
  }

  // --- Agent Card Discovery ---

  async fetchAgentCard(endpoint: A2AEndpoint): Promise<AgentCard | null> {
    const cardPath = endpoint.agentCardPath ?? "/.well-known/agent-card.json";
    const baseUrl = endpoint.url.replace(/\/+$/, "");
    // Agent card is served from the base URL, not the JSON-RPC endpoint
    const cardUrl = new URL(cardPath, baseUrl).toString();

    const headers: Record<string, string> = {};
    if (endpoint.token) {
      headers["Authorization"] = `Bearer ${endpoint.token}`;
    }

    try {
      const response = await fetch(cardUrl, { headers });
      if (!response.ok) return null;
      return (await response.json()) as AgentCard;
    } catch {
      return null;
    }
  }

  /**
   * Discover and register a remote agent by URL.
   * Fetches the agent card and registers the endpoint.
   */
  async discover(baseUrl: string, token?: string): Promise<AgentCard | null> {
    const endpoint: A2AEndpoint = { url: baseUrl, token };
    const card = await this.fetchAgentCard(endpoint);
    if (card) {
      // Use the agent card's URL as the actual endpoint
      endpoint.url = card.url ?? baseUrl;
      this.registerEndpoint(card.name, endpoint);
      this.agentCards.set(card.name.toLowerCase(), card);
      console.log(`[a2a] Discovered agent: ${card.name} at ${endpoint.url}`);
      return card;
    }
    return null;
  }

  // --- Helpers ---

  private resolveEndpoint(personaName: string, teamName: string): A2AEndpoint | null {
    // Try persona name first, then team name, then default
    const byPersona = this.endpoints.get(personaName.toLowerCase());
    if (byPersona) return byPersona;

    const byTeam = this.endpoints.get(teamName.toLowerCase());
    if (byTeam) return byTeam;

    return this.defaultEndpoint;
  }

  private messageToResult(message: A2AMessage, agentName: string, agentId: string): DelegateResult {
    const text = this.extractTextFromParts(message.parts);
    return {
      agentId,
      agentName,
      output: text || "ERROR: Empty message from A2A agent",
      grade: text ? this.extractGrade(text) : "FAILED",
      findings: text ? this.extractFindings(text) : ["empty_output"],
      costUsd: 0,
      tokensUsed: 0,
    };
  }

  private taskToResult(task: A2ATask, agentName: string, agentId: string): DelegateResult {
    let output = "";

    // Extract from status message
    if (task.status.message?.parts) {
      output += this.extractTextFromParts(task.status.message.parts);
    }

    // Extract from artifacts
    if (task.artifacts) {
      for (const artifact of task.artifacts) {
        const text = this.extractTextFromParts(artifact.parts);
        if (text) output += (output ? "\n\n" : "") + text;
      }
    }

    // Extract from history (last agent message)
    if (task.history) {
      const agentMessages = task.history.filter((m) => m.role === "agent");
      const lastMessage = agentMessages[agentMessages.length - 1];
      if (lastMessage) {
        const histText = this.extractTextFromParts(lastMessage.parts);
        if (histText && !output.includes(histText)) {
          output += (output ? "\n\n" : "") + histText;
        }
      }
    }

    const failed = task.status.state === "failed" ||
                   task.status.state === "canceled" ||
                   task.status.state === "rejected";

    return {
      agentId,
      agentName,
      output: output || (failed ? `ERROR: Task ${task.status.state}` : "ERROR: Empty task result"),
      grade: failed ? "FAILED" : (output ? this.extractGrade(output) : "FAILED"),
      findings: failed ? [task.status.state] : this.extractFindings(output),
      costUsd: 0,
      tokensUsed: 0,
    };
  }

  private extractTextFromParts(parts: A2APart[]): string {
    return parts
      .filter((p) => p.kind === "text" && p.text)
      .map((p) => p.text!)
      .join("\n");
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
