import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import {
  createLogger,
  setLogLevel,
  addSink,
  clearSinks,
  type LogEntry,
  type LogSink,
} from "./logger";

// Capture stderr output
let stderrOutput: string[] = [];
const originalWrite = process.stderr.write;

function captureStderr() {
  stderrOutput = [];
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrOutput.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  }) as typeof process.stderr.write;
}

function restoreStderr() {
  process.stderr.write = originalWrite;
}

describe("Logger", () => {
  beforeEach(() => {
    clearSinks();
    setLogLevel("DEBUG");
    captureStderr();
  });

  afterEach(() => {
    restoreStderr();
    clearSinks();
    setLogLevel("INFO");
  });

  test("produces valid JSONL per line", () => {
    const log = createLogger("test-component");
    log.info("hello world");

    expect(stderrOutput.length).toBe(1);
    const line = stderrOutput[0]!;
    expect(line.endsWith("\n")).toBe(true);

    const parsed = JSON.parse(line);
    expect(parsed.level).toBe("INFO");
    expect(parsed.component).toBe("test-component");
    expect(parsed.msg).toBe("hello world");
    expect(parsed.ts).toBeDefined();
    // Verify ts is valid ISO 8601
    expect(new Date(parsed.ts).toISOString()).toBe(parsed.ts);
  });

  test("log level filtering suppresses lower levels", () => {
    setLogLevel("WARN");
    const log = createLogger("test");

    log.debug("should be suppressed");
    log.info("should also be suppressed");
    log.warn("should appear");
    log.error("should also appear");

    expect(stderrOutput.length).toBe(2);
    expect(JSON.parse(stderrOutput[0]!).level).toBe("WARN");
    expect(JSON.parse(stderrOutput[1]!).level).toBe("ERROR");
  });

  test("DEBUG messages pass when level is DEBUG", () => {
    setLogLevel("DEBUG");
    const log = createLogger("test");
    log.debug("debug message");
    expect(stderrOutput.length).toBe(1);
    expect(JSON.parse(stderrOutput[0]!).level).toBe("DEBUG");
  });

  test("context fields are included in output", () => {
    const log = createLogger("orchestrator", { session_id: "sess-123" });
    log.info("session started", { chain: "plan-build-review", step: 1 });

    const parsed = JSON.parse(stderrOutput[0]!);
    expect(parsed.session_id).toBe("sess-123");
    expect(parsed.chain).toBe("plan-build-review");
    expect(parsed.step).toBe(1);
  });

  test("child() inherits parent context", () => {
    const parent = createLogger("engine", { session_id: "sess-abc" });
    const child = parent.child({ agent_id: "pi-frontend-dev" });
    child.info("doing work");

    const parsed = JSON.parse(stderrOutput[0]!);
    expect(parsed.session_id).toBe("sess-abc");
    expect(parsed.agent_id).toBe("pi-frontend-dev");
    expect(parsed.component).toBe("engine");
  });

  test("child() can override component", () => {
    const parent = createLogger("engine");
    const child = parent.child({ component: "pi-adapter", agent_id: "worker-1" });
    child.warn("timeout");

    const parsed = JSON.parse(stderrOutput[0]!);
    expect(parsed.component).toBe("pi-adapter");
    expect(parsed.agent_id).toBe("worker-1");
  });

  test("child() can chain multiple levels", () => {
    const engine = createLogger("engine");
    const session = engine.child({ session_id: "s1" });
    const agent = session.child({ agent_id: "a1", component: "pi-adapter" });
    agent.info("test");

    const parsed = JSON.parse(stderrOutput[0]!);
    expect(parsed.component).toBe("pi-adapter");
    expect(parsed.session_id).toBe("s1");
    expect(parsed.agent_id).toBe("a1");
  });

  test("custom sinks receive entries", () => {
    const entries: LogEntry[] = [];
    const sink: LogSink = {
      write: (entry) => {
        entries.push(entry);
      },
    };
    addSink(sink);

    const log = createLogger("test");
    log.info("sink test");

    expect(entries.length).toBe(1);
    expect(entries[0]!.msg).toBe("sink test");
    expect(entries[0]!.component).toBe("test");
  });

  test("sink errors do not crash the logger", () => {
    const badSink: LogSink = {
      write: () => {
        throw new Error("sink exploded");
      },
    };
    addSink(badSink);

    const log = createLogger("test");
    // Should not throw
    expect(() => log.info("should not crash")).not.toThrow();
    // stderr should still get the entry
    expect(stderrOutput.length).toBe(1);
  });

  test("all log levels produce correct level field", () => {
    const log = createLogger("test");
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    log.critical("c");

    const levels = stderrOutput.map((s) => JSON.parse(s).level);
    expect(levels).toEqual(["DEBUG", "INFO", "WARN", "ERROR", "CRITICAL"]);
  });

  test("MAE_LOG_LEVEL env var is respected via setLogLevel", () => {
    // We can't easily test process.env at module load time without re-importing,
    // but we can test that the level filtering works as expected
    setLogLevel("ERROR");
    const log = createLogger("test");
    log.debug("no");
    log.info("no");
    log.warn("no");
    log.error("yes");
    log.critical("yes");
    expect(stderrOutput.length).toBe(2);
  });

  test("multiple sinks all receive entries", () => {
    const entries1: LogEntry[] = [];
    const entries2: LogEntry[] = [];
    addSink({ write: (e) => entries1.push(e) });
    addSink({ write: (e) => entries2.push(e) });

    const log = createLogger("test");
    log.info("multi-sink");

    expect(entries1.length).toBe(1);
    expect(entries2.length).toBe(1);
  });

  test("inline ctx overrides parent context for same key", () => {
    const log = createLogger("test", { session_id: "original" });
    log.info("override", { session_id: "overridden" });

    const parsed = JSON.parse(stderrOutput[0]!);
    expect(parsed.session_id).toBe("overridden");
  });
});
