/**
 * Structured JSONL Logger
 *
 * Outputs JSON-per-line to stderr (always) and to any registered sinks.
 * Compatible with the MAE trace schema (specs/trace-schema.md).
 *
 * Usage:
 *   const log = createLogger("orchestrator");
 *   log.info("Session started", { session_id: "abc", chain: "plan-build-review" });
 *
 * Child loggers inherit parent context:
 *   const sessionLog = log.child({ session_id: "abc" });
 *   const agentLog = sessionLog.child({ agent_id: "pi-frontend-dev", component: "pi-adapter" });
 */

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR" | "CRITICAL";

export interface LogEntry {
  ts: string;
  level: LogLevel;
  component: string;
  msg: string;
  session_id?: string;
  agent_id?: string;
  [key: string]: unknown;
}

export interface LogSink {
  write(entry: LogEntry): void | Promise<void>;
  flush?(): Promise<void>;
  close?(): Promise<void>;
}

const LOG_LEVELS: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  CRITICAL: 4,
};

let globalMinLevel: LogLevel = (process.env.MAE_LOG_LEVEL?.toUpperCase() as LogLevel) || "INFO";
let globalSinks: LogSink[] = [];

export function setLogLevel(level: LogLevel): void {
  globalMinLevel = level;
}

export function getLogLevel(): LogLevel {
  return globalMinLevel;
}

export function addSink(sink: LogSink): void {
  globalSinks.push(sink);
}

export function removeSink(sink: LogSink): void {
  globalSinks = globalSinks.filter((s) => s !== sink);
}

export function clearSinks(): void {
  globalSinks = [];
}

export interface Logger {
  debug: (msg: string, ctx?: Record<string, unknown>) => void;
  info: (msg: string, ctx?: Record<string, unknown>) => void;
  warn: (msg: string, ctx?: Record<string, unknown>) => void;
  error: (msg: string, ctx?: Record<string, unknown>) => void;
  critical: (msg: string, ctx?: Record<string, unknown>) => void;
  child: (extra: { session_id?: string; agent_id?: string; component?: string }) => Logger;
}

export function createLogger(
  component: string,
  context?: { session_id?: string; agent_id?: string },
): Logger {
  const log = (level: LogLevel, msg: string, ctx?: Record<string, unknown>) => {
    if (LOG_LEVELS[level] < LOG_LEVELS[globalMinLevel]) return;

    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      component,
      msg,
      ...context,
      ...ctx,
    };

    // Always write to stderr as JSONL
    process.stderr.write(JSON.stringify(entry) + "\n");

    // Write to all registered sinks
    for (const sink of globalSinks) {
      try {
        sink.write(entry);
      } catch {
        // Don't let a broken sink crash the engine
      }
    }
  };

  return {
    debug: (msg: string, ctx?: Record<string, unknown>) => log("DEBUG", msg, ctx),
    info: (msg: string, ctx?: Record<string, unknown>) => log("INFO", msg, ctx),
    warn: (msg: string, ctx?: Record<string, unknown>) => log("WARN", msg, ctx),
    error: (msg: string, ctx?: Record<string, unknown>) => log("ERROR", msg, ctx),
    critical: (msg: string, ctx?: Record<string, unknown>) => log("CRITICAL", msg, ctx),
    child: (extra: { session_id?: string; agent_id?: string; component?: string }) =>
      createLogger(extra.component ?? component, { ...context, ...extra }),
  };
}
