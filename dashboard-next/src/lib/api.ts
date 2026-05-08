/**
 * API client for the MAE dashboard.
 *
 * Dev proxy in vite.config.ts forwards /api and /metrics to the Go server.
 * In production, VITE_API_URL overrides the base URL.
 */

import type {
  DBSession,
  DBAgent,
  DBEvent,
  StatsResponse,
  HealthResponse,
  HistoryEntry,
  DiffResponse,
  DiffFile,
  LiveEvent,
  LiveAgent,
} from "./types";

// ─── Base URL ─────────────────────────────────────────────────────────────────

// In dev the Vite proxy handles /api → MAE server, so BASE is empty string.
// VITE_API_BASE_URL or VITE_API_URL can override for production builds.
export const API_BASE_URL = (
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ||
  (import.meta.env.VITE_API_URL as string | undefined) ||
  ""
).replace(/\/$/, "");

// ─── Core fetch helpers ───────────────────────────────────────────────────────

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    signal,
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`API ${path} → ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

/** Generic fetch returning JSON — exported for components that need raw access */
export async function apiFetch<T>(path: string, signal?: AbortSignal): Promise<T> {
  return get<T>(path, signal);
}

/** Fetch raw text (e.g. Prometheus /metrics endpoint) */
export async function apiText(path: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(`${API_BASE_URL}${path}`, { signal });
  if (!res.ok) throw new Error(`API ${path} → ${res.status}`);
  return res.text();
}

// ─── Typed API surface ────────────────────────────────────────────────────────

export const api = {
  // Sessions list
  sessions: (signal?: AbortSignal) =>
    get<DBSession[]>("/api/pg/sessions", signal),

  // Single session
  session: (id: string, signal?: AbortSignal) =>
    get<DBSession>(`/api/pg/sessions/${encodeURIComponent(id)}`, signal),

  /**
   * Returns full agent records from the in-memory session store.
   * Shape matches models.Agent (Go) → LiveAgent (TS).
   */
  sessionAgents: (id: string, signal?: AbortSignal) =>
    get<LiveAgent[]>(
      `/api/pg/sessions/${encodeURIComponent(id)}/agents`,
      signal,
    ),

  /** DB agent rows — lighter shape without team_color / model detail. */
  sessionDBAgents: (id: string, signal?: AbortSignal) =>
    get<DBAgent[]>(
      `/api/pg/sessions/${encodeURIComponent(id)}/agents`,
      signal,
    ),

  // Historical events (Postgres)
  sessionEvents: (id: string, signal?: AbortSignal) =>
    get<DBEvent[]>(`/api/pg/sessions/${encodeURIComponent(id)}/events`, signal),

  // Files touched — Go API returns { files: string[], count: number }.
  // We normalise to DiffFile[] for consumers expecting the richer shape.
  sessionDiff: async (
    id: string,
    signal?: AbortSignal,
  ): Promise<{ files: DiffFile[]; count: number }> => {
    const raw = await get<DiffResponse>(
      `/api/pg/sessions/${encodeURIComponent(id)}/diff`,
      signal,
    );
    const files: DiffFile[] = (raw.files as Array<string | DiffFile>).map((f) =>
      typeof f === "string"
        ? ({ path: f, additions: 0, deletions: 0, status: "modified" } as DiffFile)
        : f,
    );
    return { files, count: raw.count };
  },

  // Aggregated stats
  stats: (signal?: AbortSignal) =>
    get<StatsResponse>("/api/pg/stats", signal),

  // History with cost/agent aggregates
  history: (limit = 50, signal?: AbortSignal) =>
    get<HistoryEntry[]>(`/api/pg/history?limit=${limit}`, signal),

  // Health
  health: (signal?: AbortSignal) =>
    get<HealthResponse>("/api/health", signal),

  // SSE stream URL builder (used by components that open EventSource directly)
  streamUrl: (id: string) =>
    `${API_BASE_URL}/api/sessions/${encodeURIComponent(id)}/stream`,

  // Prometheus metrics (raw text format)
  metricsText: (signal?: AbortSignal) => apiText("/metrics", signal),

  // Send a message to a session
  sendMessage: async (id: string, content: string): Promise<void> => {
    // The Go handler uses r.FormValue("content"), so send form-encoded
    const body = new URLSearchParams({ content });
    const res = await fetch(
      `${API_BASE_URL}/api/sessions/${encodeURIComponent(id)}/message`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      },
    );
    if (!res.ok)
      throw new Error(`POST message → ${res.status} ${res.statusText}`);
  },
};

// ─── SSE helpers ──────────────────────────────────────────────────────────────

export type SSEHandler = (event: LiveEvent) => void;

const SSE_EVENT_TYPES = [
  "session_start",
  "session_end",
  "agent_spawn",
  "agent_done",
  "message",
  "tool_call",
  "cost_update",
  "tilldone",
  "domain_block",
  "self_heal",
  "error",
  "pause",
  "resume",
  "waiting",
] as const;

/**
 * Subscribe to a session's SSE stream (or the global stream with id="*").
 * Returns a cleanup function that closes the EventSource.
 */
export function subscribeToSession(
  sessionId: string,
  onEvent: SSEHandler,
  onError?: (e: Event) => void,
): () => void {
  const path =
    sessionId === "*"
      ? "/api/stream"
      : `/api/sessions/${encodeURIComponent(sessionId)}/stream`;

  const url = `${API_BASE_URL}${path}`;
  const es = new EventSource(url);

  const parseAndEmit = (data: string) => {
    try {
      onEvent(JSON.parse(data) as LiveEvent);
    } catch {
      // Ignore malformed frames
    }
  };

  // Default onmessage for events without an explicit event: field
  es.onmessage = (e) => parseAndEmit(e.data);

  // Named event listeners for each typed SSE event
  for (const type of SSE_EVENT_TYPES) {
    es.addEventListener(type, (e: MessageEvent) => parseAndEmit(e.data));
  }

  if (onError) es.onerror = onError;

  return () => es.close();
}
