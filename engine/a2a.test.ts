import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { A2AAdapter, type A2AEndpoint } from "./adapters/a2a";
import type { DelegateOptions, PersonaConfig, DomainConfig } from "./types";

// --- Mock A2A Server ---

let mockServer: ReturnType<typeof Bun.serve> | null = null;
const githubRunId = Number(Bun.env.GITHUB_RUN_ID ?? 0);
const MOCK_PORT = githubRunId ? 20000 + (githubRunId % 20000) : 19876;
const mockUrl = `http://localhost:${MOCK_PORT}`;

// Track requests for assertions
const receivedRequests: Array<{ method: string; params: any }> = [];

// Configurable response behavior
let mockBehavior: "message" | "task-immediate" | "task-polling" | "error" | "timeout" = "message";
let mockTaskState: "completed" | "working" | "failed" = "completed";
let pollCount = 0;

beforeAll(() => {
  mockServer = Bun.serve({
    port: MOCK_PORT,
    async fetch(req) {
      const url = new URL(req.url);

      // Agent card endpoint
      if (url.pathname === "/.well-known/agent-card.json") {
        return new Response(JSON.stringify({
          name: "Mock A2A Agent",
          description: "A test agent for A2A adapter testing",
          url: `${mockUrl}/a2a/jsonrpc`,
          version: "1.0.0",
          protocolVersion: "1.0.0",
          skills: [
            { id: "review", name: "Code Review", description: "Reviews code", tags: ["review"] },
            { id: "build", name: "Build", description: "Builds stuff", tags: ["build"] },
          ],
          capabilities: { streaming: true },
          defaultInputModes: ["text"],
          defaultOutputModes: ["text"],
        }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      // JSON-RPC endpoint
      if (url.pathname === "/a2a/jsonrpc") {
        const body = await req.json() as any;
        receivedRequests.push({ method: body.method, params: body.params });

        if (mockBehavior === "error") {
          return new Response(JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32000, message: "Test error from mock agent" },
          }), { headers: { "Content-Type": "application/json" } });
        }

        if (body.method === "message/send" || body.method === "message/stream") {
          if (mockBehavior === "message") {
            return new Response(JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                kind: "message",
                messageId: "resp-1",
                role: "agent",
                parts: [{ kind: "text", text: "GRADE: VERIFIED\n\nCode review complete. No issues found.\n\n- P2: Minor naming inconsistency in auth module" }],
              },
            }), { headers: { "Content-Type": "application/json" } });
          }

          if (mockBehavior === "task-immediate") {
            return new Response(JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                kind: "task",
                id: "task-123",
                status: {
                  state: mockTaskState,
                  message: {
                    kind: "message",
                    messageId: "status-1",
                    role: "agent",
                    parts: [{ kind: "text", text: mockTaskState === "failed" ? "ERROR: Build failed" : "Task completed successfully" }],
                  },
                },
                artifacts: mockTaskState === "completed" ? [{
                  artifactId: "art-1",
                  name: "review-report",
                  parts: [{ kind: "text", text: "GRADE: PERFECT\n\nAll checks passed." }],
                }] : [],
              },
            }), { headers: { "Content-Type": "application/json" } });
          }

          if (mockBehavior === "task-polling") {
            pollCount = 0;
            return new Response(JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                kind: "task",
                id: "task-poll-1",
                status: { state: "working" },
              },
            }), { headers: { "Content-Type": "application/json" } });
          }
        }

        if (body.method === "tasks/get") {
          pollCount++;
          const state = pollCount >= 2 ? "completed" : "working";
          return new Response(JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              kind: "task",
              id: body.params.id,
              status: {
                state,
                message: state === "completed" ? {
                  kind: "message",
                  messageId: "poll-done",
                  role: "agent",
                  parts: [{ kind: "text", text: "Polling complete -- task done." }],
                } : undefined,
              },
            },
          }), { headers: { "Content-Type": "application/json" } });
        }

        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32601, message: "Method not found" },
        }), { headers: { "Content-Type": "application/json" } });
      }

      return new Response("Not Found", { status: 404 });
    },
  });
});

afterAll(() => {
  mockServer?.stop();
});

// --- Test Helpers ---

function makeDelegateOpts(overrides?: Partial<DelegateOptions>): DelegateOptions {
  const persona: PersonaConfig = {
    name: "Test Reviewer",
    model: "quality",
    expertise: "agents/expertise/reviewer.md",
    skills: [],
    tools: ["read"],
    domain: { read: ["**/*"], write: ["expertise/reviewer.md"], update: ["expertise/reviewer.md"] },
  };

  return {
    persona,
    systemPrompt: "You are a code reviewer.",
    userPrompt: "Review the auth module.",
    model: "litellm/opus-nocache",
    thinking: "high" as const,
    tools: ["read"],
    domain: persona.domain,
    workingDir: "/tmp/test",
    sessionDir: "/tmp/test/session",
    teamName: "Validation",
    teamColor: "#ff6b9d",
    ...overrides,
  };
}

// --- Tests ---

describe("A2A adapter", () => {
  describe("agent discovery", () => {
    it("fetches agent card from /.well-known/agent-card.json", async () => {
      const adapter = new A2AAdapter();
      const endpoint: A2AEndpoint = { url: mockUrl };
      const card = await adapter.fetchAgentCard(endpoint);

      expect(card).not.toBeNull();
      expect(card!.name).toBe("Mock A2A Agent");
      expect(card!.skills).toHaveLength(2);
      expect(card!.capabilities?.streaming).toBe(true);
    });

    it("discovers and registers remote agent", async () => {
      const adapter = new A2AAdapter();
      const card = await adapter.discover(mockUrl);

      expect(card).not.toBeNull();
      expect(card!.name).toBe("Mock A2A Agent");

      // After discovery, adapter should be available
      const available = await adapter.isAvailable();
      expect(available).toBe(true);
    });

    it("returns null for unreachable agent", async () => {
      const adapter = new A2AAdapter();
      const card = await adapter.discover("http://localhost:1");
      expect(card).toBeNull();
    });
  });

  describe("message/send (sync)", () => {
    it("delegates and receives direct message response", async () => {
      mockBehavior = "message";
      receivedRequests.length = 0;

      const adapter = new A2AAdapter();
      adapter.setDefaultEndpoint({ url: `${mockUrl}/a2a/jsonrpc`, streaming: false });

      const result = await adapter.delegate(makeDelegateOpts());

      expect(result.output).toContain("Code review complete");
      expect(result.grade).toBe("VERIFIED");
      expect(result.findings).toHaveLength(1);
      expect(result.findings![0]).toContain("P2:");

      // Verify JSON-RPC request format
      expect(receivedRequests).toHaveLength(1);
      expect(receivedRequests[0]!.method).toBe("message/send");
      expect(receivedRequests[0]!.params.message.role).toBe("user");
      expect(receivedRequests[0]!.params.message.parts[0].kind).toBe("text");
    });

    it("handles RPC error responses", async () => {
      mockBehavior = "error";
      receivedRequests.length = 0;

      const adapter = new A2AAdapter();
      adapter.setDefaultEndpoint({ url: `${mockUrl}/a2a/jsonrpc`, streaming: false });

      const result = await adapter.delegate(makeDelegateOpts());

      expect(result.grade).toBe("FAILED");
      expect(result.output).toContain("Test error from mock agent");
    });

    it("handles completed task response", async () => {
      mockBehavior = "task-immediate";
      mockTaskState = "completed";
      receivedRequests.length = 0;

      const adapter = new A2AAdapter();
      adapter.setDefaultEndpoint({ url: `${mockUrl}/a2a/jsonrpc`, streaming: false });

      const result = await adapter.delegate(makeDelegateOpts());

      expect(result.output).toContain("Task completed successfully");
      expect(result.output).toContain("All checks passed");
      expect(result.grade).toBe("PERFECT");
    });

    it("handles failed task response", async () => {
      mockBehavior = "task-immediate";
      mockTaskState = "failed";
      receivedRequests.length = 0;

      const adapter = new A2AAdapter();
      adapter.setDefaultEndpoint({ url: `${mockUrl}/a2a/jsonrpc`, streaming: false });

      const result = await adapter.delegate(makeDelegateOpts());

      expect(result.grade).toBe("FAILED");
      expect(result.output).toContain("Build failed");
    });
  });

  describe("task polling", () => {
    it("polls working task until completed", async () => {
      mockBehavior = "task-polling";
      receivedRequests.length = 0;

      const adapter = new A2AAdapter();
      adapter.setDefaultEndpoint({
        url: `${mockUrl}/a2a/jsonrpc`,
        streaming: false,
        pollIntervalMs: 100,
      });

      const result = await adapter.delegate(makeDelegateOpts({ timeoutMs: 10_000 }));

      expect(result.output).toContain("Polling complete");

      // Should have: 1 message/send + 2 tasks/get polls
      const sendRequests = receivedRequests.filter((r) => r.method === "message/send");
      const pollRequests = receivedRequests.filter((r) => r.method === "tasks/get");
      expect(sendRequests).toHaveLength(1);
      expect(pollRequests.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("endpoint resolution", () => {
    it("returns error when no endpoint configured", async () => {
      const adapter = new A2AAdapter();
      // No endpoints registered

      const result = await adapter.delegate(makeDelegateOpts());

      expect(result.grade).toBe("FAILED");
      expect(result.output).toContain("No A2A endpoint configured");
    });

    it("resolves endpoint by team name", async () => {
      mockBehavior = "message";
      receivedRequests.length = 0;

      const adapter = new A2AAdapter();
      adapter.registerEndpoint("validation", { url: `${mockUrl}/a2a/jsonrpc`, streaming: false });

      const result = await adapter.delegate(makeDelegateOpts({ teamName: "Validation" }));

      expect(result.output).toContain("Code review complete");
    });
  });

  describe("adapter detection", () => {
    it("is not available with no endpoints", async () => {
      const adapter = new A2AAdapter();
      expect(await adapter.isAvailable()).toBe(false);
    });

    it("is available when endpoint has valid agent card", async () => {
      const adapter = new A2AAdapter();
      adapter.registerEndpoint("test", { url: mockUrl });
      expect(await adapter.isAvailable()).toBe(true);
    });
  });
});
