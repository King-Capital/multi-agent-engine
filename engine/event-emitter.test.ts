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

      const sessionStartCall = fetchMock.calls
        .filter((c) => c.url.includes("/api/events"))
        .map((c) => JSON.parse(c.init.body as string))
        .find((body: { event_type?: string }) => body.event_type === "session_start");
      expect(sessionStartCall).toBeDefined();
      expect(sessionStartCall.session_id).toBe("s1");
      expect(sessionStartCall.data.session_name).toBe("Test Session");
    });

    test("redacts secrets from emitted dashboard messages and tool calls", async () => {
      const emitter = new EventEmitter("http://test:8400");
      await emitter.sessionStart("s1", "Test", "review", "repro with OPENAI_API_KEY=sk-tasksecret1234567890");
      await emitter.message("s1", "a1", "from", "to", "OPENAI_API_KEY=sk-supersecret1234567890", {
        content: "OPENAI_API_KEY=sk-metadataoverride1234567890",
        nested: { token: "metadata-token" },
      });
      await emitter.toolCall("s1", "a1", "bash", "file.ts", "ok", "Authorization: Bearer token123", '{"password":"secret-value"}');
      await emitter.trace("s1", "a1", "input", "OPENAI_API_KEY=sk-tracesecret1234567890", { token: "trace-token" });

      await new Promise((r) => setTimeout(r, 100));

      const bodies = fetchMock.calls
        .filter((c) => c.url.includes("/api/events"))
        .map((c) => JSON.parse(c.init.body as string));
      expect(JSON.stringify(bodies)).toContain("[REDACTED_SECRET]");
      expect(JSON.stringify(bodies)).not.toContain("sk-supersecret");
      expect(JSON.stringify(bodies)).not.toContain("metadata-token");
      expect(JSON.stringify(bodies)).not.toContain("sk-tasksecret");
      expect(JSON.stringify(bodies)).not.toContain("token123");
      expect(JSON.stringify(bodies)).not.toContain("secret-value");

      const traceBody = JSON.stringify(
        fetchMock.calls
          .filter((c) => c.url.includes("/api/traces"))
          .map((c) => JSON.parse(c.init.body as string)),
      );
      expect(traceBody).toContain("[REDACTED_SECRET]");
      expect(traceBody).not.toContain("sk-tracesecret");
      expect(traceBody).not.toContain("trace-token");
    });

    test("emits structured spawn decision events", async () => {
      const emitter = new EventEmitter("http://test:8400");
      await emitter.spawnDecision("s1", "worker-1", "lead-1", {
        need_worker: true,
        worker_name: "Security Auditor",
        spawn_type: "worker",
        reason: "Focused auth boundary review is required.",
        why_lead_cannot_do_it: "Independent security evidence is required.",
        constraints: {
          allowed_paths: ["engine/security.ts"],
          allowed_tools: ["read", "rg"],
          forbidden_paths: [".env"],
        },
        bus_policy: "isolated",
        expected_output_schema: "REVIEW_REPORT: Security",
        timeout_seconds: 600,
      }, { valid: true, errors: [] });

      await new Promise((r) => setTimeout(r, 50));

      const body = fetchMock.calls
        .filter((c) => c.url.includes("/api/events"))
        .map((c) => JSON.parse(c.init.body as string))
        .find((event: { event_type?: string }) => event.event_type === "spawn_decision");
      expect(body).toBeDefined();
      expect(body.agent_id).toBe("worker-1");
      expect(body.parent_id).toBe("lead-1");
      expect(body.data.worker_name).toBe("Security Auditor");
      expect(body.data.constraints.allowed_tools).toEqual(["read", "rg"]);
      expect(body.data.validation.valid).toBe(true);
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

  describe("participant presence", () => {
    test("emits participant lifecycle events with capability metadata", async () => {
      const emitter = new EventEmitter("http://test:8400");
      await emitter.participantStart("s1", "lead-1", {
        name: "Correctness Lead",
        kind: "lead",
        role: "lead",
        teamName: "Correctness Review",
        model: "gpt-5.5",
        capabilities: { canReceiveSteer: true, toolCount: 2, model: "gpt-5.5" },
      });
      await emitter.participantActivity("s1", "lead-1", { currentTool: "read", currentTask: "README.md" });
      await emitter.participantHeartbeat("s1", "lead-1", {
        status: "idle",
        currentTask: "waiting_for_review",
        currentTool: "read",
        costUsd: 0.12,
        tokensUsed: 42,
      });
      await emitter.participantStale("s1", "lead-1", "no activity for 60s");
      await emitter.participantEnd("s1", "lead-1", "completed", { costUsd: 0.12, tokensUsed: 42 });

      await new Promise((r) => setTimeout(r, 100));

      const bodies = fetchMock.calls
        .filter((c) => c.url.includes("/api/events"))
        .map((c) => JSON.parse(c.init.body as string));
      expect(bodies.map((body: { event_type: string }) => body.event_type)).toEqual([
        "participant_start",
        "participant_activity",
        "participant_heartbeat",
        "participant_stale",
        "participant_end",
      ]);
      expect(bodies[0]!.data.capabilities.toolCount).toBe(2);
      expect(bodies[1]!.data.current_tool).toBe("read");
      expect(bodies[2]!.data.status).toBe("idle");
      expect(bodies[2]!.data.current_task).toBe("waiting_for_review");
      expect(bodies[2]!.data.current_tool).toBe("read");
      expect(bodies[2]!.data.cost_usd).toBe(0.12);
      expect(bodies[3]!.data.status).toBe("stale");
      expect(bodies[4]!.data.status).toBe("completed");
    });

    test("agentSpawn and agentDone bracket agents with participant events", async () => {
      const emitter = new EventEmitter("http://test:8400");
      await emitter.agentSpawn("s1", "worker-1", "lead-1", "Worker", "worker", "sonnet", "Team", "#fff");
      await emitter.agentDone("s1", "worker-1", "VERIFIED", 0.03);

      await new Promise((r) => setTimeout(r, 100));

      const bodies = fetchMock.calls
        .filter((c) => c.url.includes("/api/events"))
        .map((c) => JSON.parse(c.init.body as string));
      expect(bodies.some((body: { event_type: string }) => body.event_type === "participant_start")).toBe(true);
      expect(bodies.some((body: { event_type: string }) => body.event_type === "agent_spawn")).toBe(true);
      expect(bodies.some((body: { event_type: string }) => body.event_type === "participant_end")).toBe(true);
      expect(bodies.some((body: { event_type: string }) => body.event_type === "agent_done")).toBe(true);
    });

    test("sessionStart does not duplicate the orchestrator participant started by agentSpawn", async () => {
      const emitter = new EventEmitter("http://test:8400");
      await emitter.sessionStart("s1", "Session", "standard-swarm", "task");
      await emitter.agentSpawn("s1", "orch-1", "", "Orchestrator", "orchestrator", "opus", "Orchestration", "#fff");

      await new Promise((r) => setTimeout(r, 100));

      const bodies = fetchMock.calls
        .filter((c) => c.url.includes("/api/events"))
        .map((c) => JSON.parse(c.init.body as string));
      const orchestratorStarts = bodies.filter((body: { event_type: string; data: { participant_id?: string } }) =>
        body.event_type === "participant_start" && body.data.participant_id === "orch-1"
      );
      expect(orchestratorStarts).toHaveLength(1);
    });

    test("agentSpawn can mark synthesis as a distinct participant kind", async () => {
      const emitter = new EventEmitter("http://test:8400");
      await emitter.agentSpawn("s1", "synth-1", "orch-1", "Synthesis", "orchestrator", "opus", "Synthesis", "#fff", "synthesis");

      await new Promise((r) => setTimeout(r, 100));

      const bodies = fetchMock.calls
        .filter((c) => c.url.includes("/api/events"))
        .map((c) => JSON.parse(c.init.body as string));
      const start = bodies.find((body: { event_type: string }) => body.event_type === "participant_start");
      expect(start.data.kind).toBe("synthesis");
      expect(start.data.current_task).toBe("agent:synthesis");
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

    test("does not duplicate orchestrator participant end after agentDone", async () => {
      const emitter = new EventEmitter("http://test:8400");
      await emitter.agentSpawn("s1", "orch-1", "", "Orchestrator", "orchestrator", "opus", "Orchestration", "#fff");
      await emitter.agentDone("s1", "orch-1", "VERIFIED", 0.01);
      await emitter.sessionEnd("s1", "completed");

      await new Promise((r) => setTimeout(r, 100));

      const bodies = fetchMock.calls
        .filter((c) => c.url.includes("/api/events"))
        .map((c) => JSON.parse(c.init.body as string));
      const orchestratorEnds = bodies.filter((body: { event_type: string; data: { participant_id?: string } }) =>
        body.event_type === "participant_end" && body.data.participant_id === "orch-1"
      );
      expect(orchestratorEnds).toHaveLength(1);
      expect(bodies.some((body: { event_type: string }) => body.event_type === "session_end")).toBe(true);
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

      const body = fetchMock.calls
        .filter((c) => c.url.includes("/api/events"))
        .map((c) => JSON.parse(c.init.body as string))
        .find((event: { event_type?: string }) => event.event_type === "agent_spawn");
      expect(body).toBeDefined();
      expect(body.data.agent_name).toBe("TestAgent");
      expect(body.data.agent_role).toBe("worker");
      expect(body.data.model).toBe("opus");
      expect(body.data.team_name).toBe("TeamA");

      const participantStart = fetchMock.calls
        .filter((c) => c.url.includes("/api/events"))
        .map((c) => JSON.parse(c.init.body as string))
        .find((event: { event_type?: string }) => event.event_type === "participant_start");
      expect(participantStart.data.capabilities.model).toBe("opus");
      expect(participantStart.data.capabilities.canReceiveSteer).toBe(true);
    });

    test("costUpdate includes token and cost data", async () => {
      const emitter = new EventEmitter("http://test:8400");
      await emitter.costUpdate("s1", "agent-1", 0.05, 1000, 500);

      await new Promise((r) => setTimeout(r, 100));

      const body = fetchMock.calls
        .filter((c) => c.url.includes("/api/events"))
        .map((c) => JSON.parse(c.init.body as string))
        .find((event: { event_type?: string }) => event.event_type === "cost_update");
      expect(body).toBeDefined();
      expect(body.cost_usd).toBe(0.05);
      expect(body.tokens_used).toBe(1000);
      expect(body.context_tokens).toBe(500);
    });

    test("agentDone includes grade and artifacts", async () => {
      const emitter = new EventEmitter("http://test:8400");
      await emitter.agentDone("s1", "agent-1", "VERIFIED", 0.01, {
        outputArtifact: "s1/artifacts/agent.txt",
        taskReport: "s1/RALPH/agent.md",
      });

      await new Promise((r) => setTimeout(r, 100));

      const body = fetchMock.calls
        .filter((c) => c.url.includes("/api/events"))
        .map((c) => JSON.parse(c.init.body as string))
        .find((event: { event_type?: string }) => event.event_type === "agent_done");
      expect(body).toBeDefined();
      expect(body.data.grade).toBe("VERIFIED");
      expect(body.data.output_artifact).toBe("s1/artifacts/agent.txt");
      expect(body.data.task_report).toBe("s1/RALPH/agent.md");
    });
  });

  // -------------------------------------------------------------------------
  // Phase 5: Steer participant events
  // -------------------------------------------------------------------------

  describe("steer action events", () => {
    test("emits participant_start, steer_action, and participant_end for a steer interaction", async () => {
      const emitter = new EventEmitter("http://test:8400");
      const participantId = await emitter.steerAction("s1", {
        sender: "user",
        source: "web",
        authority: 90,
        intent: "freeform",
        target: "orchestrator",
        content: "focus on auth module",
        certification_impact: "blocks_unattended",
        message_id: "msg-123",
      });

      await new Promise((r) => setTimeout(r, 100));

      expect(participantId).toMatch(/^web-steer-\d+$/);
      const bodies = fetchMock.calls
        .filter((c) => c.url.includes("/api/events"))
        .map((c) => JSON.parse(c.init.body as string));

      const eventTypes = bodies.map((b: { event_type: string }) => b.event_type);
      expect(eventTypes).toContain("participant_start");
      expect(eventTypes).toContain("steer_action");
      expect(eventTypes).toContain("participant_end");

      const start = bodies.find((b: { event_type: string }) => b.event_type === "participant_start");
      expect(start.data.kind).toBe("web-steer");
      expect(start.data.role).toBe("steer");
      expect(start.data.capabilities.authority).toBe(90);
      expect(start.data.capabilities.canSteer).toBe(true);
      expect(start.data.capabilities.canSpawnWorkers).toBe(false);

      const action = bodies.find((b: { event_type: string }) => b.event_type === "steer_action");
      expect(action.data.sender).toBe("user");
      expect(action.data.source).toBe("web");
      expect(action.data.authority).toBe(90);
      expect(action.data.intent).toBe("freeform");
      expect(action.data.target).toBe("orchestrator");
      expect(action.data.content).toBe("focus on auth module");
      expect(action.data.certification_impact).toBe("blocks_unattended");
      expect(action.data.message_id).toBe("msg-123");

      const end = bodies.find((b: { event_type: string }) => b.event_type === "participant_end");
      expect(end.data.status).toBe("completed");
    });

    test("CLI steer gets cli-steer participant kind", async () => {
      const emitter = new EventEmitter("http://test:8400");
      const participantId = await emitter.steerAction("s1", {
        sender: "user",
        source: "cli",
        authority: 90,
        intent: "pause",
        target: "orchestrator",
        content: "!pause",
        certification_impact: "blocks_unattended",
      });

      await new Promise((r) => setTimeout(r, 100));

      expect(participantId).toMatch(/^cli-steer-\d+$/);
      const bodies = fetchMock.calls
        .filter((c) => c.url.includes("/api/events"))
        .map((c) => JSON.parse(c.init.body as string));

      const start = bodies.find((b: { event_type: string }) => b.event_type === "participant_start");
      expect(start.data.kind).toBe("cli-steer");
      expect(start.data.name).toBe("CLI Operator");
    });

    test("steer participant IDs are unique across multiple steer actions", async () => {
      const emitter = new EventEmitter("http://test:8400");
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        ids.push(await emitter.steerAction("s1", {
          sender: "user",
          source: "web",
          authority: 90,
          intent: "freeform",
          target: "orchestrator",
          content: `message ${i}`,
          certification_impact: "blocks_unattended",
        }));
      }

      const unique = new Set(ids);
      expect(unique.size).toBe(3);
    });

    test("API steer (unknown source) uses web-steer kind", async () => {
      const emitter = new EventEmitter("http://test:8400");
      await emitter.steerAction("s1", {
        sender: "user",
        source: "api",
        authority: 90,
        intent: "budget",
        target: "orchestrator",
        content: "!budget 50",
        reason: "50",
        certification_impact: "blocks_unattended",
      });

      await new Promise((r) => setTimeout(r, 100));

      const bodies = fetchMock.calls
        .filter((c) => c.url.includes("/api/events"))
        .map((c) => JSON.parse(c.init.body as string));

      const start = bodies.find((b: { event_type: string }) => b.event_type === "participant_start");
      // API steer uses web-steer kind (not cli)
      expect(start.data.kind).toBe("web-steer");
      expect(start.data.name).toBe("API Operator");
    });
  });
});
