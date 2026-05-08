import { useCallback, useEffect, useRef, useState } from "react";
import { subscribeToSession } from "@/lib/api";
import type { LiveEvent } from "@/lib/types";

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;
const DEFAULT_MAX_EVENTS = 500;

export interface UseEventStreamOptions {
  /** Session ID, or "*" for global stream */
  sessionId: string;
  /** Max events to keep in the ring buffer (default 500) */
  maxEvents?: number;
  /** Called with each raw event (useful for side-effects) */
  onEvent?: (event: LiveEvent) => void;
  /** Whether to connect at all (default true) */
  enabled?: boolean;
}

export interface UseEventStreamResult {
  events: LiveEvent[];
  connected: boolean;
  error: string | null;
  /** Manually clear the local event buffer */
  clear: () => void;
}

export function useEventStream({
  sessionId,
  maxEvents = DEFAULT_MAX_EVENTS,
  onEvent,
  enabled = true,
}: UseEventStreamOptions): UseEventStreamResult {
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Stable refs so reconnect logic doesn't re-subscribe unnecessarily
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const maxEventsRef = useRef(maxEvents);
  maxEventsRef.current = maxEvents;

  const clear = useCallback(() => setEvents([]), []);

  useEffect(() => {
    if (!enabled || !sessionId) return;

    let retryDelay = BASE_DELAY_MS;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let cleanup: (() => void) | null = null;
    let cancelled = false;

    function connect() {
      if (cancelled) return;

      cleanup = subscribeToSession(
        sessionId,
        (evt: LiveEvent) => {
          if (cancelled) return;
          setConnected(true);
          setError(null);
          retryDelay = BASE_DELAY_MS; // reset backoff on successful message

          setEvents((prev) => {
            const next = [...prev, evt];
            return next.length > maxEventsRef.current
              ? next.slice(next.length - maxEventsRef.current)
              : next;
          });

          onEventRef.current?.(evt);
        },
        (_e: Event) => {
          if (cancelled) return;
          setConnected(false);
          setError("Stream disconnected — reconnecting…");

          cleanup?.();
          cleanup = null;

          retryTimer = setTimeout(() => {
            if (!cancelled) {
              retryDelay = Math.min(retryDelay * 2, MAX_DELAY_MS);
              connect();
            }
          }, retryDelay);
        }
      );
    }

    connect();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      cleanup?.();
      setConnected(false);
    };
  }, [sessionId, enabled]);

  return { events, connected, error, clear };
}
