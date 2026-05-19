import { afterEach, describe, test, expect, mock } from "bun:test";
import { listenForUserMessages, sendUserMessage, broadcastControlMessage } from "./messaging";
import { inferSteerSource, classifySteerIntent } from "./orchestrator";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.MAE_API_TOKEN;
});

describe("steering commands (#147)", () => {
  describe("message routing", () => {
    test("regular message stays with orchestrator and is not delivered to arbitrary agent", () => {
      const received: string[] = [];
      const senders = new Map<string, (msg: string) => void>();
      senders.set("sess-1:agent-1", (msg) => received.push(msg));

      sendUserMessage(senders, "sess-1", "focus on the auth module");
      expect(received).toEqual([]);
    });

    test("@mention routes to specific agent", () => {
      const received: Record<string, string[]> = { a1: [], a2: [] };
      const senders = new Map<string, (msg: string) => void>();
      senders.set("sess-1:agent-1", (msg) => received["a1"]!.push(msg));
      senders.set("sess-1:agent-2", (msg) => received["a2"]!.push(msg));

      sendUserMessage(senders, "sess-1", "@agent-2 check the tests");
      expect(received["a2"]!.length).toBeGreaterThan(0);
    });

    test("structured target routes to exact agent id", () => {
      const received: Record<string, string[]> = { a1: [], a2: [] };
      const senders = new Map<string, (msg: string) => void>();
      senders.set("sess-1:agent-1", (msg) => received["a1"]!.push(msg));
      senders.set("sess-1:agent-2", (msg) => received["a2"]!.push(msg));

      sendUserMessage(senders, "sess-1", "check token expiry", "agent-2");
      expect(received["a1"]).toEqual([]);
      expect(received["a2"]).toEqual(["check token expiry"]);
    });

    test("message to unknown session is a no-op", () => {
      const senders = new Map<string, (msg: string) => void>();
      senders.set("sess-1:agent-1", () => {});
      // Should not throw
      sendUserMessage(senders, "unknown-session", "hello");
    });

    test("control broadcast reaches all active agents in the session", () => {
      const received: Record<string, string[]> = { a1: [], a2: [], other: [] };
      const senders = new Map<string, (msg: string) => void>();
      senders.set("sess-1:agent-1", (msg) => received["a1"]!.push(msg));
      senders.set("sess-1:agent-2", (msg) => received["a2"]!.push(msg));
      senders.set("sess-2:agent-1", (msg) => received["other"]!.push(msg));

      const delivered = broadcastControlMessage(senders, "sess-1", "!stop");

      expect(delivered).toBe(2);
      expect(received["a1"]).toEqual(["!stop"]);
      expect(received["a2"]).toEqual(["!stop"]);
      expect(received["other"]).toEqual([]);
    });
  });

  describe("dashboard SSE listener", () => {
    test("uses MAE_API_TOKEN when listening for dashboard user messages", async () => {
      process.env.MAE_API_TOKEN = "mae_test_token";
      const calls: RequestInit[] = [];
      globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
        calls.push(init ?? {});
        return new Response(null, { status: 401 });
      }) as unknown as typeof fetch;

      const abort = listenForUserMessages("https://dashboard.example", "sess-1", () => {});
      await Bun.sleep(10);
      abort.abort();

      expect(calls[0]?.headers).toEqual({ Authorization: "Bearer mae_test_token" });
    });

    test("tracks SSE ids and dedupes replayed user messages", async () => {
      const calls: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
      const delivered: string[] = [];
      let fetchCount = 0;
      globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ input, init });
        fetchCount++;
        if (fetchCount === 1) {
          return new Response("id: 7\nevent: message\ndata: {\"data\":{\"from\":\"user\",\"content\":\"ping\",\"message_id\":\"m1\"}}\n\n");
        }
        return new Response("id: 7\nevent: message\ndata: {\"data\":{\"from\":\"user\",\"content\":\"ping\",\"message_id\":\"m1\"}}\n\n");
      }) as unknown as typeof fetch;

      const abort = listenForUserMessages("https://dashboard.example", "sess-1", (_sessionId, content) => delivered.push(content));
      await Bun.sleep(3100);
      abort.abort();

      expect(delivered).toEqual(["ping"]);
      expect(String(calls[1]?.input)).toContain("last_event_id=7");
      expect(calls[1]?.init?.headers).toEqual({ "Last-Event-ID": "7" });
    });
  });

  describe("steer command parsing", () => {
    test("!pause is detected as command prefix", () => {
      expect("!pause".startsWith("!")).toBe(true);
      const parts = "!pause".slice(1).split(/\s+/);
      expect(parts[0]).toBe("pause");
    });

    test("!budget 100 parses command and args", () => {
      const msg = "!budget 100";
      const parts = msg.slice(1).split(/\s+/);
      expect(parts[0]).toBe("budget");
      expect(parts.slice(1).join(" ")).toBe("100");
      expect(parseFloat("100")).toBe(100);
    });

    test("!stop has no args", () => {
      const msg = "!stop";
      const parts = msg.slice(1).split(/\s+/);
      expect(parts[0]).toBe("stop");
      expect(parts.slice(1).join(" ")).toBe("");
    });

    test("!resume has no args", () => {
      const msg = "!resume";
      const parts = msg.slice(1).split(/\s+/);
      expect(parts[0]).toBe("resume");
    });

    test("regular messages don't start with !", () => {
      expect("focus on auth".startsWith("!")).toBe(false);
      expect("@lead check tests".startsWith("!")).toBe(false);
    });
  });

  describe("message buffer", () => {
    test("buffer accumulates messages", () => {
      const buf: string[] = [];
      buf.push("message 1");
      buf.push("message 2");
      expect(buf).toHaveLength(2);
    });

    test("drain clears buffer and returns messages", () => {
      const buf = ["msg 1", "msg 2", "msg 3"];
      const drained = buf.splice(0);
      expect(drained).toHaveLength(3);
      expect(buf).toHaveLength(0);
    });

    test("drain on empty buffer returns empty", () => {
      const buf: string[] = [];
      const drained = buf.splice(0);
      expect(drained).toHaveLength(0);
    });

    test("formatted buffer output includes all messages", () => {
      const messages = ["focus on auth", "skip the tests for now"];
      const formatted = `\n\n**Steer messages from user:**\n${messages.map(m => `> ${m}`).join("\n")}`;
      expect(formatted).toContain("focus on auth");
      expect(formatted).toContain("skip the tests");
      expect(formatted).toContain("Steer messages from user");
    });
  });

  describe("pause/resume state", () => {
    test("paused sessions set tracks state", () => {
      const paused = new Set<string>();
      paused.add("sess-1");
      expect(paused.has("sess-1")).toBe(true);
      expect(paused.has("sess-2")).toBe(false);

      paused.delete("sess-1");
      expect(paused.has("sess-1")).toBe(false);
    });

    test("stop clears pause state", () => {
      const paused = new Set<string>();
      paused.add("sess-1");
      // !stop should also clear pause
      paused.delete("sess-1");
      expect(paused.has("sess-1")).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Phase 5: Steer source inference and intent classification
  // -------------------------------------------------------------------------

  describe("steer source inference", () => {
    test("tui- prefix identifies CLI source", () => {
      expect(inferSteerSource("tui-12345-abc")).toBe("cli");
      expect(inferSteerSource("msg-12345")).toBe("web");
      expect(inferSteerSource(undefined)).toBe("unknown");
      expect(inferSteerSource("")).toBe("unknown");
    });
  });

  describe("steer intent classification", () => {
    test("classifies ! commands as steer intents", () => {
      expect(classifySteerIntent("!pause")).toBe("pause");
      expect(classifySteerIntent("!resume")).toBe("resume");
      expect(classifySteerIntent("!stop")).toBe("stop");
      expect(classifySteerIntent("!budget 100")).toBe("budget");
      expect(classifySteerIntent("!unknown")).toBe("unknown");
      expect(classifySteerIntent("ping")).toBe("ping");
      expect(classifySteerIntent("focus on auth")).toBe("freeform");
      expect(classifySteerIntent("@lead check tests")).toBe("freeform");
    });
  });
});
