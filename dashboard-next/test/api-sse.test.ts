import { afterEach, describe, expect, test } from "bun:test";
import { subscribeToSession } from "../src/lib/api";
import type { LiveEvent } from "../src/lib/types";

type Listener = (event: MessageEvent<string>) => void;

class MockEventSource {
  static instances: MockEventSource[] = [];
  readonly listeners = new Map<string, Listener[]>();
  onmessage: Listener | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;

  constructor(readonly url: string, readonly init?: EventSourceInit) {
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener as Listener);
    this.listeners.set(type, listeners);
  }

  close(): void {
    this.closed = true;
  }

  dispatchNamed(type: string, payload: LiveEvent): void {
    const event = new MessageEvent(type, { data: JSON.stringify(payload) });
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

const originalEventSource = globalThis.EventSource;

afterEach(() => {
  globalThis.EventSource = originalEventSource;
  MockEventSource.instances = [];
});

describe("subscribeToSession", () => {
  test("delivers named participant heartbeat SSE frames", () => {
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    const received: LiveEvent[] = [];
    const cleanup = subscribeToSession("s1", (event) => received.push(event));
    const source = MockEventSource.instances[0]!;

    source.dispatchNamed("participant_heartbeat", {
      session_id: "s1",
      agent_id: "lead-1",
      event_type: "participant_heartbeat",
      timestamp: "2026-05-18T00:00:00.000Z",
      data: {
        participant_id: "lead-1",
        status: "active",
        last_heartbeat_ts: "2026-05-18T00:00:00.000Z",
      },
    });

    expect(received.map((event) => event.event_type)).toEqual(["participant_heartbeat"]);
    cleanup();
    expect(source.closed).toBe(true);
  });
});
