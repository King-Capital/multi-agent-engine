import { describe, test, expect, mock } from "bun:test";
import { delegateWithHealing } from "./self-healing";
import type { PlatformAdapter, DelegateOptions, DelegateResult } from "./types";

function makeFailed(output = "", grade = "FAILED"): DelegateResult {
  return {
    agentId: "test",
    agentName: "Test Agent",
    output,
    grade: grade as any,
    findings: [],
    costUsd: 0.01,
    tokensUsed: 100,
  };
}

function makeSuccess(output = "Done"): DelegateResult {
  return {
    agentId: "test",
    agentName: "Test Agent",
    output,
    grade: "VERIFIED",
    findings: [],
    costUsd: 0.05,
    tokensUsed: 500,
  };
}

function makeOpts(): DelegateOptions {
  return {
    persona: { name: "Test", model: "main", expertise: "", skills: [], tools: ["read"], domain: { read: ["**/*"], write: [], update: [] } },
    systemPrompt: "test",
    userPrompt: "test task",
    model: "litellm/sonnet-nocache",
    thinking: "medium",
    tools: ["read"],
    domain: { read: ["**/*"], write: [], update: [] },
    workingDir: "/tmp",
    sessionDir: "/tmp/test-session",
    teamName: "Test",
    teamColor: "#fff",
  };
}

const noopEvent = async () => {};

describe("self-healing", () => {
  test("succeeds on first attempt", async () => {
    let callCount = 0;
    const adapter: PlatformAdapter = {
      name: "test",
      isAvailable: async () => true,
      delegate: async () => { callCount++; return makeSuccess(); },
    };

    const result = await delegateWithHealing({
      adapter,
      opts: makeOpts(),
      sessionId: "test",
      agentRole: "worker",
      onEvent: noopEvent,
    });

    expect(result.grade).toBe("VERIFIED");
    expect(callCount).toBe(1);
  });

  test("retries with context on first failure", async () => {
    let callCount = 0;
    const adapter: PlatformAdapter = {
      name: "test",
      isAvailable: async () => true,
      delegate: async (opts) => {
        callCount++;
        if (callCount === 1) return makeFailed("ERROR: something broke");
        return makeSuccess();
      },
    };

    const result = await delegateWithHealing({
      adapter,
      opts: makeOpts(),
      sessionId: "test",
      agentRole: "worker",
      onEvent: noopEvent,
    });

    expect(result.grade).toBe("VERIFIED");
    expect(callCount).toBe(2);
  });

  test("upgrades model on second failure", async () => {
    let callCount = 0;
    let lastModel = "";
    const adapter: PlatformAdapter = {
      name: "test",
      isAvailable: async () => true,
      delegate: async (opts) => {
        callCount++;
        lastModel = opts.model;
        if (callCount <= 2) return makeFailed("still broken");
        return makeSuccess();
      },
    };

    const result = await delegateWithHealing({
      adapter,
      opts: makeOpts(),
      sessionId: "test",
      agentRole: "worker",
      onEvent: noopEvent,
    });

    expect(result.grade).toBe("VERIFIED");
    expect(callCount).toBe(3);
    expect(lastModel).toContain("opus");
  });

  test("returns FAILED after all attempts exhausted", async () => {
    let callCount = 0;
    const adapter: PlatformAdapter = {
      name: "test",
      isAvailable: async () => true,
      delegate: async () => { callCount++; return makeFailed("always broken"); },
    };

    const result = await delegateWithHealing({
      adapter,
      opts: makeOpts(),
      sessionId: "test",
      agentRole: "worker",
      onEvent: noopEvent,
    });

    expect(result.grade).toBe("FAILED");
    expect(callCount).toBe(3);
  });

  test("detects empty output as failure", async () => {
    let callCount = 0;
    const adapter: PlatformAdapter = {
      name: "test",
      isAvailable: async () => true,
      delegate: async () => {
        callCount++;
        if (callCount === 1) return { ...makeSuccess(), output: "", grade: undefined };
        return makeSuccess();
      },
    };

    const result = await delegateWithHealing({
      adapter,
      opts: makeOpts(),
      sessionId: "test",
      agentRole: "worker",
      onEvent: noopEvent,
    });

    expect(result.grade).toBe("VERIFIED");
    expect(callCount).toBe(2);
  });

  test("detects timeout as failure", async () => {
    let callCount = 0;
    const adapter: PlatformAdapter = {
      name: "test",
      isAvailable: async () => true,
      delegate: async () => {
        callCount++;
        if (callCount === 1) return makeFailed("timeout");
        return makeSuccess();
      },
    };

    const result = await delegateWithHealing({
      adapter,
      opts: { ...makeOpts(), timeoutMs: 1000 },
      sessionId: "test",
      agentRole: "scout",
      onEvent: noopEvent,
    });

    expect(result.grade).toBe("VERIFIED");
    expect(callCount).toBe(2);
  });

  test("emits self_heal events on escalation", async () => {
    let eventCount = 0;
    const adapter: PlatformAdapter = {
      name: "test",
      isAvailable: async () => true,
      delegate: async () => makeFailed("broken"),
    };

    await delegateWithHealing({
      adapter,
      opts: makeOpts(),
      sessionId: "test",
      agentRole: "worker",
      onEvent: async () => { eventCount++; },
    });

    expect(eventCount).toBeGreaterThan(0);
  });
});
