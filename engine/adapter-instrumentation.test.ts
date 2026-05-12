import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PiAdapter } from "./adapters/pi";
import { EchoAdapter } from "./adapters/echo";
import { A2AAdapter } from "./adapters/a2a";
import { addSink, clearSinks, setLogLevel, type LogEntry } from "./logger";
import type { DelegateOptions, DomainConfig, PersonaConfig, StreamEvent } from "./types";

let entries: LogEntry[] = [];
let stderrOutput: string[] = [];
const originalWrite = process.stderr.write;

function makeDelegateOpts(overrides?: Partial<DelegateOptions>): DelegateOptions {
  const domain: DomainConfig = { read: ["**/*"], write: [], update: [] };
  const persona: PersonaConfig = {
    name: "Test Agent",
    model: "quality",
    expertise: "agents/expertise/test.md",
    skills: [],
    tools: ["read"],
    domain,
  };
  return {
    persona,
    systemPrompt: "You are a test agent.",
    userPrompt: "Do the test task.",
    model: "litellm/opus-nocache",
    thinking: "medium",
    tools: ["read"],
    domain,
    workingDir: "/tmp",
    sessionDir: "/tmp/mae-test-session",
    teamName: "Validation",
    teamColor: "#ffffff",
    ...overrides,
  };
}

beforeEach(() => {
  entries = [];
  stderrOutput = [];
  clearSinks();
  setLogLevel("DEBUG");
  addSink({ write: (entry) => { entries.push(entry); } });
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrOutput.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stderr.write = originalWrite;
  clearSinks();
  setLogLevel("INFO");
});

describe("adapter instrumentation", () => {
  test("Pi processRpcEvent logs llm.call with tokens and cost from message_end", () => {
    const adapter = new PiAdapter() as unknown as {
      processRpcEvent: (
        evt: Record<string, unknown>,
        onStream: ((event: StreamEvent) => void) | undefined,
        onCost: (cost: number, tokens: number, cacheRead: number) => void,
        context: { sessionId?: string; agentId: string; persona: string; team?: string; model: string },
      ) => void;
    };
    const costs: Array<{ cost: number; tokens: number; cache: number }> = [];

    adapter.processRpcEvent({
      type: "message_end",
      message: {
        role: "assistant",
        model: "claude-sonnet-4.6",
        usage: {
          inputTokens: 123,
          outputTokens: 45,
          totalTokens: 168,
          cacheRead: 12,
          cost: { total: 0.0042 },
        },
      },
    }, undefined, (cost, tokens, cache) => costs.push({ cost, tokens, cache }), {
      sessionId: "session-1",
      agentId: "pi-test-agent",
      persona: "Test Agent",
      team: "Validation",
      model: "claude-sonnet-4.6",
    });

    const llmLog = entries.find((entry) => entry.trace_type === "llm.call");
    expect(llmLog).toBeDefined();
    expect(llmLog!.session_id).toBe("session-1");
    expect(llmLog!.agent_id).toBe("pi-test-agent");
    expect(llmLog!.model).toBe("claude-sonnet-4.6");
    expect(llmLog!.prompt_tokens).toBe(123);
    expect(llmLog!.completion_tokens).toBe(45);
    expect(llmLog!.total_tokens).toBe(168);
    expect(llmLog!.cache_read_tokens).toBe(12);
    expect(llmLog!.cost).toBe(0.0042);
    expect(costs).toEqual([{ cost: 0.0042, tokens: 168, cache: 12 }]);
  });

  test("Pi processRpcEvent logs tool.call start and completion", () => {
    const adapter = new PiAdapter() as unknown as {
      processRpcEvent: (
        evt: Record<string, unknown>,
        onStream: ((event: StreamEvent) => void) | undefined,
        onCost: (cost: number, tokens: number, cacheRead: number) => void,
        context: { sessionId?: string; agentId: string; persona: string; team?: string; model: string },
      ) => void;
    };
    const streamEvents: StreamEvent[] = [];
    const context = {
      sessionId: "session-1",
      agentId: "pi-test-agent",
      persona: "Test Agent",
      team: "Validation",
      model: "claude-sonnet-4.6",
    };

    adapter.processRpcEvent({
      type: "tool_execution_start",
      toolName: "read",
      args: { file_path: "engine/langfuse-sink.ts", secret: "sk-test-secret" },
    }, (event) => streamEvents.push(event), () => {}, context);
    adapter.processRpcEvent({
      type: "tool_execution_end",
      toolName: "read",
      isError: false,
      result: "file contents",
    }, (event) => streamEvents.push(event), () => {}, context);

    const toolLogs = entries.filter((entry) => entry.trace_type === "tool.call");
    expect(toolLogs).toHaveLength(2);
    expect(toolLogs[0]!.tool).toBe("read");
    expect(toolLogs[0]!.args_preview).toBe("engine/langfuse-sink.ts");
    expect(toolLogs[1]!.success).toBe(true);
    expect(toolLogs[1]!.output_preview).toBe("file contents");
    expect(streamEvents.map((event) => event.type)).toEqual(["tool_call", "tool_result"]);
  });

  test("Echo adapter emits agent.start, llm.call, and agent.end", async () => {
    const adapter = new EchoAdapter();
    const result = await adapter.delegate(makeDelegateOpts());

    expect(result.grade).toBe("VERIFIED");
    expect(entries.map((entry) => entry.trace_type)).toEqual(["agent.start", "llm.call", "agent.end"]);
    expect(entries[0]!.session_id).toBe("mae-test-session");
    expect(entries[1]!.total_tokens).toBe(100);
    expect(entries[2]!.cost).toBe(0.001);
  });

  test("A2A adapter emits best-effort agent lifecycle logs with zero tokens when unavailable", async () => {
    const adapter = new A2AAdapter();
    const result = await adapter.delegate(makeDelegateOpts());

    expect(result.grade).toBe("FAILED");
    expect(entries.map((entry) => entry.trace_type)).toEqual(["agent.start", "agent.end"]);
    expect(entries[1]!.tokens).toBe(0);
    expect(entries[1]!.cost).toBe(0);
  });
});
