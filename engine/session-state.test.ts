import { describe, test, expect } from "bun:test";
import { transitionStatus } from "./session-state";

function makeSession(status: string) {
  return { id: "test-session", status };
}

describe("transitionStatus", () => {
  // --- Valid transitions from active ---
  test("allows active → paused", () => {
    const session = makeSession("active");
    expect(transitionStatus(session, "paused", "test")).toBe(true);
    expect(session.status).toBe("paused");
  });

  test("allows active → completed", () => {
    const session = makeSession("active");
    expect(transitionStatus(session, "completed", "test")).toBe(true);
    expect(session.status).toBe("completed");
  });

  test("allows active → error", () => {
    const session = makeSession("active");
    expect(transitionStatus(session, "error", "test")).toBe(true);
    expect(session.status).toBe("error");
  });

  // --- Valid transitions from paused ---
  test("allows paused → active", () => {
    const session = makeSession("paused");
    expect(transitionStatus(session, "active", "test")).toBe(true);
    expect(session.status).toBe("active");
  });

  test("allows paused → completed", () => {
    const session = makeSession("paused");
    expect(transitionStatus(session, "completed", "test")).toBe(true);
    expect(session.status).toBe("completed");
  });

  test("allows paused → error", () => {
    const session = makeSession("paused");
    expect(transitionStatus(session, "error", "test")).toBe(true);
    expect(session.status).toBe("error");
  });

  // --- Terminal states ---
  test("rejects completed → active (terminal state)", () => {
    const session = makeSession("completed");
    expect(transitionStatus(session, "active", "test")).toBe(false);
    expect(session.status).toBe("completed");
  });

  test("rejects completed → paused (terminal state)", () => {
    const session = makeSession("completed");
    expect(transitionStatus(session, "paused", "test")).toBe(false);
    expect(session.status).toBe("completed");
  });

  test("rejects completed → error (terminal state)", () => {
    const session = makeSession("completed");
    expect(transitionStatus(session, "error", "test")).toBe(false);
    expect(session.status).toBe("completed");
  });

  test("rejects error → active (terminal state)", () => {
    const session = makeSession("error");
    expect(transitionStatus(session, "active", "test")).toBe(false);
    expect(session.status).toBe("error");
  });

  test("rejects error → paused (terminal state)", () => {
    const session = makeSession("error");
    expect(transitionStatus(session, "paused", "test")).toBe(false);
    expect(session.status).toBe("error");
  });

  // --- Self-transitions ---
  test("rejects active → active (same state)", () => {
    const session = makeSession("active");
    expect(transitionStatus(session, "active", "test")).toBe(false);
    expect(session.status).toBe("active");
  });

  // --- Source tracking ---
  test("preserves source identity (does not crash with any source string)", () => {
    const session = makeSession("active");
    expect(transitionStatus(session, "paused", "orchestrator:run")).toBe(true);
    expect(session.status).toBe("paused");
  });

  // --- Session without id ---
  test("works when session has no id field", () => {
    const session = { status: "active" };
    expect(transitionStatus(session, "completed", "test")).toBe(true);
    expect(session.status).toBe("completed");
  });

  // --- Unknown status ---
  test("rejects transition from unknown status", () => {
    const session = makeSession("unknown");
    expect(transitionStatus(session, "active", "test")).toBe(false);
    expect(session.status).toBe("unknown");
  });
});
