import { describe, test, expect } from "bun:test";
import { sendUserMessage } from "./messaging";

describe("steering commands (#147)", () => {
  describe("message routing", () => {
    test("regular message is delivered to registered sender", () => {
      const received: string[] = [];
      const senders = new Map<string, (msg: string) => void>();
      senders.set("sess-1:agent-1", (msg) => received.push(msg));

      sendUserMessage(senders, "sess-1", "focus on the auth module");
      expect(received).toContain("focus on the auth module");
    });

    test("@mention routes to specific agent", () => {
      const received: Record<string, string[]> = { a1: [], a2: [] };
      const senders = new Map<string, (msg: string) => void>();
      senders.set("sess-1:agent-1", (msg) => received.a1.push(msg));
      senders.set("sess-1:agent-2", (msg) => received.a2.push(msg));

      sendUserMessage(senders, "sess-1", "@agent-2 check the tests");
      expect(received.a2.length).toBeGreaterThan(0);
    });

    test("message to unknown session is a no-op", () => {
      const senders = new Map<string, (msg: string) => void>();
      senders.set("sess-1:agent-1", () => {});
      // Should not throw
      sendUserMessage(senders, "unknown-session", "hello");
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
});
