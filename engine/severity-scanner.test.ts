import { describe, test, expect } from "bun:test";
import { scanSeverity, shouldAutoPause, extractFindingExcerpt } from "./severity-scanner";

describe("scanSeverity", () => {
  test("detects P0: prefix", () => {
    expect(scanSeverity("- P0: SQL injection in login handler")).toBe("P0");
  });

  test("detects CRITICAL keyword", () => {
    expect(scanSeverity("This is a CRITICAL vulnerability")).toBe("P0");
  });

  test("detects SECURITY VULNERABILITY", () => {
    expect(scanSeverity("Found a security vulnerability in auth")).toBe("P0");
  });

  test("detects RCE", () => {
    expect(scanSeverity("Potential RCE via unsanitized input")).toBe("P0");
  });

  test("detects SQL INJECTION", () => {
    expect(scanSeverity("SQL injection possible in query builder")).toBe("P0");
  });

  test("detects COMMAND INJECTION", () => {
    expect(scanSeverity("Command injection via shell exec")).toBe("P0");
  });

  test("detects P1: prefix", () => {
    expect(scanSeverity("- P1: Missing input validation")).toBe("P1");
  });

  test("detects HIGH SEVERITY", () => {
    expect(scanSeverity("This is a high severity issue")).toBe("P1");
  });

  test("detects BREAKING CHANGE", () => {
    expect(scanSeverity("This introduces a breaking change")).toBe("P1");
  });

  test("detects DATA LOSS", () => {
    expect(scanSeverity("Risk of data loss during migration")).toBe("P1");
  });

  test("detects P2: prefix", () => {
    expect(scanSeverity("- P2: Missing error handling")).toBe("P2");
  });

  test("detects P3: prefix", () => {
    expect(scanSeverity("- P3: Naming convention inconsistency")).toBe("P3");
  });

  test("returns null for no severity", () => {
    expect(scanSeverity("This code looks good, well structured")).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(scanSeverity("")).toBeNull();
  });

  test("P0 takes precedence over P1", () => {
    expect(scanSeverity("P1: issue\nP0: critical bug")).toBe("P0");
  });

  test("case insensitive for keywords", () => {
    expect(scanSeverity("p0: something bad")).toBe("P0");
    expect(scanSeverity("critical issue found")).toBe("P0");
  });
});

describe("shouldAutoPause", () => {
  test("pauses on P0", () => {
    expect(shouldAutoPause("P0")).toBe(true);
  });

  test("pauses on P1", () => {
    expect(shouldAutoPause("P1")).toBe(true);
  });

  test("does not pause on P2", () => {
    expect(shouldAutoPause("P2")).toBe(false);
  });

  test("does not pause on P3", () => {
    expect(shouldAutoPause("P3")).toBe(false);
  });

  test("does not pause on null", () => {
    expect(shouldAutoPause(null)).toBe(false);
  });
});

describe("extractFindingExcerpt", () => {
  test("extracts P0 line", () => {
    const text = "Good code here\n- P0: SQL injection in login\nMore text";
    const excerpt = extractFindingExcerpt(text, "P0");
    expect(excerpt).toContain("P0");
    expect(excerpt).toContain("SQL injection");
  });

  test("extracts CRITICAL line", () => {
    const text = "Review:\nCRITICAL: auth bypass possible\nOther notes";
    const excerpt = extractFindingExcerpt(text, "P0");
    expect(excerpt).toContain("CRITICAL");
  });

  test("extracts P1 line", () => {
    const text = "- P1: Missing rate limiting\n- P3: Style issue";
    const excerpt = extractFindingExcerpt(text, "P1");
    expect(excerpt).toContain("P1");
  });

  test("returns empty for null severity", () => {
    expect(extractFindingExcerpt("some text", null)).toBe("");
  });

  test("truncates long excerpts", () => {
    const longLine = "P0: " + "x".repeat(600);
    const excerpt = extractFindingExcerpt(longLine, "P0");
    expect(excerpt.length).toBeLessThanOrEqual(500);
  });
});
