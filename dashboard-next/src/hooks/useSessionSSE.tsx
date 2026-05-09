/**
 * useSessionSSE — shared SSE context for a session.
 *
 * Only ONE EventSource is opened per session. All consumers (stream tab,
 * agent graph, till-done) receive events from the same connection.
 *
 * Usage:
 *   <SessionSSEProvider sessionId={id}>
 *     <AgentGraph />
 *     <TillDone />
 *   </SessionSSEProvider>
 *
 *   // Inside child:
 *   const { events, subscribe } = useSessionSSE();
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { subscribeToSession } from "@/lib/api";
import type { LiveEvent } from "@/lib/types";

type SSEListener = (event: LiveEvent) => void;

interface SessionSSEContextValue {
  /** All events received since the provider mounted (ring buffer, max 500) */
  events: LiveEvent[];
  /** Whether the SSE connection is currently open */
  connected: boolean;
  /** Current error message, if any */
  error: string | null;
  /** Subscribe to events — returns unsubscribe function */
  subscribe: (listener: SSEListener) => () => void;
}

const SessionSSEContext = createContext<SessionSSEContextValue | null>(null);

const MAX_EVENTS = 500;

interface SessionSSEProviderProps {
  sessionId: string;
  children: React.ReactNode;
}

export function SessionSSEProvider({ sessionId, children }: SessionSSEProviderProps) {
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listenersRef = useRef<Set<SSEListener>>(new Set());

  const subscribe = useCallback((listener: SSEListener) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const cleanup = subscribeToSession(
      sessionId,
      (evt: LiveEvent) => {
        if (cancelled) return;
        setConnected(true);
        setError(null);

        setEvents((prev) => {
          const next = [...prev, evt];
          return next.length > MAX_EVENTS ? next.slice(next.length - MAX_EVENTS) : next;
        });

        // Fan out to all subscribers
        for (const listener of listenersRef.current) {
          try {
            listener(evt);
          } catch {
            // Don't let one listener break others
          }
        }
      },
      (_e: Event) => {
        if (cancelled) return;
        setConnected(false);
        setError("SSE reconnecting…");
      },
    );

    return () => {
      cancelled = true;
      cleanup();
      setConnected(false);
    };
  }, [sessionId]);

  // Reset events when session changes
  useEffect(() => {
    setEvents([]);
    setError(null);
  }, [sessionId]);

  const value: SessionSSEContextValue = {
    events,
    connected,
    error,
    subscribe,
  };

  return (
    <SessionSSEContext.Provider value={value}>
      {children}
    </SessionSSEContext.Provider>
  );
}

/**
 * Access the shared SSE stream for the current session.
 * Must be used within a <SessionSSEProvider>.
 */
export function useSessionSSE(): SessionSSEContextValue {
  const ctx = useContext(SessionSSEContext);
  if (!ctx) {
    throw new Error("useSessionSSE must be used within a <SessionSSEProvider>");
  }
  return ctx;
}
