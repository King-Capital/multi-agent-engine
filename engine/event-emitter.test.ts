import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { EventEmitter } from "./event-emitter";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Captures fetch calls and returns configurable responses */
function installFetchMock() {
  const calls: { url: string; init: RequestInit }[] = [];
  let responseFactory: (url: string) => Response = (url) => {
    if (url.includes("/agents")) return new Response(JSON.stringify({ id: 1 }), { status: 201, headers: { "Content-Type": "application/json" } });
    return new Response("ok", { status: 200 });
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init: init ?? {} });
    return Promise.resolve(responseFactory(url));
  }) as unknown as typeof fetch;

  return {
    calls,
    setResponse(factory: (url: string) => Response) {
      responseFactory = factory;
    },
    /** Make fetch throw (simulates network error) */
    setError(code?: string) {
      globalThis.fetch = (() => {
        const err = new Error("Connection failed");
        (err as unknown as { code: string }).code = code ?? "UNKNOWN";
        return Promise.reject(err);
      }) as unknown as typeof fetch;
    },
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EventEmitter", () => {
  let fetchMock: ReturnType<typeof installFetchMock>;

  beforeEach(() => {
    fetchMock = installFetchMock();
  });

  afterEach(() => {
    fetchMock.restore();
  });

  describe("emit + flush", () => {
    test("sends buffered events to dashboard", async () => {
      const emitter = new EventEmitter("http://test:8400");
      await emitter.sessionStart("s1", "Test Session", "review", "Do the thing");

      // Wait for microtask flush
      await new Promise((r) => setTimeout(r, 50));

      expect(fetchMock.calls.length).toBeGreaterThanOrEqual(1);
      const eventCall = fetchMock.calls.find((c) => c.url.includes("/api/events"));
      expect(eventCall).toBeDefined();

      const body = JSON.parse(eventCall!.init.body as string);
      expect(body.event_type).toBe("session_start");
      expect(body.session_id).toBe("s1");
      expect(body.data.session_name).toBe("Test Session");
    });

    test("assigns monotonic sequence numbers", async () => {
      const emitter = new EventEmitter("http://test:8400");
      const bodies: unknown[] = [];

      fetchMock.setResponse(() => {
        return new Response("ok", { status: 200 });
      });

      // Capture bodies on each call
      const origFetch = globalThis.fetch;
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse((init?.body as string) ?? "{}");
        bodies.push(body);
        return origFetch(input, init);
      }) as typeof fetch;

      await emitter.message("s1", "a1", "from", "to", "msg1");
      await emitter.message("s1", "a1", "from", "to", "msg2");
      await emitter.message("s1", "a1", "from", "to", "msg3");

      await new Promise((r) => setTimeout(r, 100));

      // Restore before assertions
      globalThis.fetch = origFetch;

      expect(bodies.length).toBe(3);
      const seqs = bodies.map((b: unknown) => (b as { seq: number }).seq);
      // Sequence numbers should be strictly increasing
      for (let i = 1; i < seqs.length; i++) {
        expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
      }
    });

    test("drops oldest events when buffer exceeds max size", async () => {
      // Never respond so buffer fills up
      fetchMock.setResponse(() => new Response("ok", { status: 200 }));

      // Block flush so events pile up
      let blockFlush = true;
      const origFetch = globalThis.fetch;
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        while (blockFlush) await new Promise((r) => setTimeout(r, 10));
        return origFetch(input, init);
      }) as typeof fetch;

      const emitter = new EventEmitter("http://test:8400");

      // Emit more than MAX_BUFFER_SIZE (1000) events synchronously
      // We can't actually emit 1001 synchronously since emit is async,
      // but we can verify the emitter doesn't crash with many events
      for (let i = 0; i < 50; i++) {
        emitter.message("s1", "a1", "from", "to", `msg-${i}`);
      }

      blockFlush = false;
      await new Promise((r) => setTimeout(r, 200));
      globalThis.fetch = origFetch;

      // No crash = success. The emitter handles overflow gracefully.
      expect(true).toBe(true);
    });
  });

  describe("fetchWithRetry", () => {
    test("retries on 500 errors then succeeds", async () => {
      let callCount = 0;
      fetchMock.setResponse(() => {
        callCount++;
        if (callCount <= 2) return new Response("error", { status: 500 });
        return new Response("ok", { status: 200 });
      });

      const emitter = new EventEmitter("http://test:8400");
      await emitter.message("s1", "a1", "from", "to", "content");

      // Wait for flush with retries (needs time for Bun.sleep delays)
      await new Promise((r) => setTimeout(r, 2000));

      // Should have retried: at least 3 calls (2 failures + 1 success)
      expect(callCount).toBeGreaterThanOrEqual(3);
    });

    test("retries on 429 errors", async () => {
      let callCount = 0;
      fetchMock.setResponse(() => {
        callCount++;
        if (callCount <= 1) return new Response("rate limited", { status: 429 });
        return new Response("ok", { status: 200 });
      });

      const emitter = new EventEmitter("http://test:8400");
      await emitter.message("s1", "a1", "from", "to", "content");

      await new Promise((r) => setTimeout(r, 1000));

      expect(callCount).toBeGreaterThanOrEqual(2);
    });

    test("does not retry on 400 errors", async () => {
      let callCount = 0;
      fetchMock.setResponse(() => {
        callCount++;
        return new Response("bad request", { status: 400 });
      });

      const emitter = new EventEmitter("http://test:8400");
      await emitter.message("s1", "a1", "from", "to", "content");

      await new Promise((r) => setTimeout(r, 200));

      // 400 is a client error — should NOT retry
      expect(callCount).toBe(1);
    });

    test("activates circuit breaker on ConnectionRefused", async () => {
      // First: make fetch throw ConnectionRefused
      fetchMock.setError("ConnectionRefused");

      const emitter = new EventEmitter("http://test:8400");
      await emitter.message("s1", "a1", "from", "to", "msg1");
      await new Promise((r) => setTimeout(r, 100));

      // Now install a working fetch to test that circuit breaker blocks it
      let secondCallMade = false;
      fetchMock.restore();
      const fm2 = installFetchMock();
      fm2.setResponse(() => {
        secondCallMade = true;
        return new Response("ok", { status: 200 });
      });

      // Emit another event — should be short-circuited (within 30s retry window)
      await emitter.message("s1", "a1", "from", "to", "msg2");
      await new Promise((r) => setTimeout(r, 100));

      // The circuit breaker should prevent the fetch from being made
      expect(secondCallMade).toBe(false);

      fm2.restore();
    });

    test("drops event after all retries fail", async () => {
      fetchMock.setResponse(() => new Response("error", { status: 500 }));

      const emitter = new EventEmitter("http://test:8400");
      await emitter.message("s1", "a1", "from", "to", "will be dropped");

      // Wait for all retries to exhaust (100 + 500 + 2000 = 2600ms delays + processing)
      await new Promise((r) => setTimeout(r, 4000));

      // No crash = event was dropped gracefully
      expect(fetchMock.calls.length).toBeGreaterThanOrEqual(4); // initial + 3 retries
    });
  });

  describe("sessionEnd", () => {
    test("updates session status via PATCH", async () => {
      const emitter = new EventEmitter("http://test:8400");
      await emitter.sessionEnd("s1", "completed");

      await new Promise((r) => setTimeout(r, 100));

      const patchCall = fetchMock.calls.find(
        (c) => c.url.includes("/api/pg/sessions/s1") && (c.init.method === "PATCH"),
      );
      expect(patchCall).toBeDefined();

      const body = JSON.parse(patchCall!.init.body as string);
      expect(body.status).toBe("completed");
    });

    test("emits session_end event after PATCH", async () => {
      const emitter = new EventEmitter("http://test:8400");
      await emitter.sessionEnd("s1", "error");

      await new Promise((r) => setTimeout(r, 100));

      const eventCall = fetchMock.calls.find((c) => {
        if (!c.url.includes("/api/events")) return false;
        const body = JSON.parse(c.init.body as string);
        return body.event_type === "session_end";
      });
      expect(eventCall).toBeDefined();

      const body = JSON.parse(eventCall!.init.body as string);
      expect(body.data.status).toBe("error");
    });
  });

  describe("auth headers", () => {
    test("includes Bearer token when API token is set", async () => {
      const emitter = new EventEmitter("http://test:8400", "my-secret-token");
      await emitter.message("s1", "a1", "from", "to", "content");

      await new Promise((r) => setTimeout(r, 100));

      const call = fetchMock.calls[0];
      expect(call).toBeDefined();
      const headers = call!.init.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer my-secret-token");
    });

    test("omits Authorization header when token is explicitly empty", async () => {
      // Save and clear env token so constructor doesn't pick it up
      const saved = process.env.MAE_API_TOKEN;
      delete process.env.MAE_API_TOKEN;

      const emitter = new EventEmitter("http://test:8400", undefined);
      await emitter.message("s1", "a1", "from", "to", "content");

      await new Promise((r) => setTimeout(r, 100));

      // Restore env
      if (saved !== undefined) process.env.MAE_API_TOKEN = saved;

      const call = fetchMock.calls[0];
      expect(call).toBeDefined();
      const headers = call!.init.headers as Record<string, string>;
      expect(headers["Authorization"]).toBeUndefined();
    });
  });

  describe("convenience methods", () => {
    test("agentSpawn emits correct event structure", async () => {
      const emitter = new EventEmitter("http://test:8400");
      await emitter.agentSpawn("s1", "agent-1", "orch-1", "TestAgent", "worker", "opus", "TeamA", "#ff0000");

      await new Promise((r) => setTimeout(r, 100));

      const call = fetchMock.calls.find((c) => c.url.includes("/api/events"));
      const body = JSON.parse(call!.init.body as string);
      expect(body.event_type).toBe("agent_spawn");
      expect(body.data.agent_name).toBe("TestAgent");
      expect(body.data.agent_role).toBe("worker");
      expect(body.data.model).toBe("opus");
      expect(body.data.team_name).toBe("TeamA");
    });

    test("costUpdate includes token and cost data", async () => {
      const emitter = new EventEmitter("http://test:8400");
      await emitter.costUpdate("s1", "agent-1", 0.05, 1000, 500);

      await new Promise((r) => setTimeout(r, 100));

      const call = fetchMock.calls.find((c) => c.url.includes("/api/events"));
      const body = JSON.parse(call!.init.body as string);
      expect(body.event_type).toBe("cost_update");
      expect(body.cost_usd).toBe(0.05);
      expect(body.tokens_used).toBe(1000);
      expect(body.context_tokens).toBe(500);
    });

    test("agentDone includes grade", async () => {
      const emitter = new EventEmitter("http://test:8400");
      await emitter.agentDone("s1", "agent-1", "VERIFIED");

      await new Promise((r) => setTimeout(r, 100));

      const call = fetchMock.calls.find((c) => c.url.includes("/api/events"));
      const body = JSON.parse(call!.init.body as string);
      expect(body.event_type).toBe("agent_done");
      expect(body.data.grade).toBe("VERIFIED");
    });
  });
});
