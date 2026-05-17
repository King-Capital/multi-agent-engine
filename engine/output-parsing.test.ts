import { test, expect, describe } from "bun:test";
import { parseAssignment, parseReviews, summarizeOutput, worstGrade } from "./output-parsing";
import type { DelegateResult } from "./types";

describe("parseAssignment", () => {
  test("extracts assignment for a named worker", () => {
    const leadOutput = [
      "### ASSIGNMENT: Code Reviewer",
      "Review the auth module for SQL injection risks.",
      "Focus on files: auth.ts, db.ts",
      "",
      "### ASSIGNMENT: Security Auditor",
      "Check all API endpoints for proper auth middleware.",
    ].join("\n");

    const result = parseAssignment(leadOutput, "Code Reviewer");
    expect(result).toBe("Review the auth module for SQL injection risks.\nFocus on files: auth.ts, db.ts");
  });

  test("extracts assignment for the last worker", () => {
    const leadOutput = [
      "### ASSIGNMENT: Code Reviewer",
      "Review the auth module.",
      "",
      "### ASSIGNMENT: Security Auditor",
      "Check API endpoints.",
    ].join("\n");

    const result = parseAssignment(leadOutput, "Security Auditor");
    expect(result).toBe("Check API endpoints.");
  });

  test("returns null when worker not found", () => {
    const leadOutput = "### ASSIGNMENT: Code Reviewer\nReview things.";
    expect(parseAssignment(leadOutput, "Unknown Worker")).toBeNull();
  });

  test("returns null for SKIP: assignments", () => {
    const leadOutput = "### ASSIGNMENT: Code Reviewer\nSKIP: Not needed for this task.";
    expect(parseAssignment(leadOutput, "Code Reviewer")).toBeNull();
  });

  test("is case insensitive on the header match", () => {
    const leadOutput = "### ASSIGNMENT: code reviewer\nDo the work.";
    expect(parseAssignment(leadOutput, "Code Reviewer")).toBe("Do the work.");
  });

  test("handles special regex characters in worker names", () => {
    const leadOutput = "### ASSIGNMENT: C++ Expert (Sr.)\nReview templates.";
    expect(parseAssignment(leadOutput, "C++ Expert (Sr.)")).toBe("Review templates.");
  });

  test("returns null for empty lead output", () => {
    expect(parseAssignment("", "Worker")).toBeNull();
  });

  test("returns null when no assignment headers exist", () => {
    const leadOutput = "Here is a general briefing for the team.\nEveryone should review auth.";
    expect(parseAssignment(leadOutput, "Worker")).toBeNull();
  });
});

describe("parseReviews", () => {
  const makeResult = (name: string, id: string): DelegateResult => ({
    agentId: id,
    agentName: name,
    output: "some output",
    grade: "VERIFIED",
    costUsd: 0.01,
    tokensUsed: 100,
  });

  test("parses PASS review", () => {
    const reviewOutput = [
      "### REVIEW: Code Reviewer",
      "GRADE: PASS",
    ].join("\n");

    const results = [makeResult("Code Reviewer", "review-code-reviewer")];
    const reviews = parseReviews(reviewOutput, results);

    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.grade).toBe("PASS");
    expect(reviews[0]!.workerName).toBe("Code Reviewer");
  });

  test("parses NEEDS_WORK review with feedback and reworked prompt", () => {
    const reviewOutput = [
      "### REVIEW: Code Reviewer",
      "GRADE: NEEDS_WORK",
      "FEEDBACK: Missing error handling in auth.ts",
      "REWORKED_PROMPT: Add try-catch blocks around all DB calls in auth.ts",
    ].join("\n");

    const results = [makeResult("Code Reviewer", "review-code-reviewer")];
    const reviews = parseReviews(reviewOutput, results);

    expect(reviews[0]!.grade).toBe("NEEDS_WORK");
    expect(reviews[0]!.feedback).toBe("Missing error handling in auth.ts");
    expect(reviews[0]!.reworkedPrompt).toBe("Add try-catch blocks around all DB calls in auth.ts");
  });

  test("parses DIRECT_FIX", () => {
    const reviewOutput = [
      "### REVIEW: Code Reviewer",
      "GRADE: NEEDS_WORK",
      "FEEDBACK: Typo in variable name",
      "DIRECT_FIX: Change `usrName` to `userName` on line 42",
    ].join("\n");

    const results = [makeResult("Code Reviewer", "review-code-reviewer")];
    const reviews = parseReviews(reviewOutput, results);

    expect(reviews[0]!.directFix).toBe("Change `usrName` to `userName` on line 42");
  });

  test("parses QUALITY_NOTE", () => {
    const reviewOutput = [
      "### REVIEW: Code Reviewer",
      "GRADE: PASS",
      "QUALITY_NOTE: Could extract the validation logic into a helper function",
    ].join("\n");

    const results = [makeResult("Code Reviewer", "review-code-reviewer")];
    const reviews = parseReviews(reviewOutput, results);

    expect(reviews[0]!.grade).toBe("PASS");
    expect(reviews[0]!.qualityNotes).toEqual(["Could extract the validation logic into a helper function"]);
  });

  test("parses SPAWN_SR and overrides grade to NEEDS_WORK", () => {
    const reviewOutput = [
      "### REVIEW: Code Reviewer",
      "GRADE: PASS",
      "SPAWN_SR: Frontend Expert, Backend Expert",
    ].join("\n");

    const results = [makeResult("Code Reviewer", "review-code-reviewer")];
    const reviews = parseReviews(reviewOutput, results);

    expect(reviews[0]!.grade).toBe("NEEDS_WORK");
    expect(reviews[0]!.spawnSr).toBe(true);
    expect(reviews[0]!.srDomains).toEqual(["Frontend Expert", "Backend Expert"]);
  });

  test("defaults to PASS when no review block matches", () => {
    const reviewOutput = "### REVIEW: Other Worker\nGRADE: NEEDS_WORK";
    const results = [makeResult("Code Reviewer", "review-code-reviewer")];
    const reviews = parseReviews(reviewOutput, results);

    expect(reviews[0]!.grade).toBe("PASS");
  });

  test("handles multiple workers", () => {
    const reviewOutput = [
      "### REVIEW: Code Reviewer",
      "GRADE: PASS",
      "",
      "### REVIEW: Security Auditor",
      "GRADE: NEEDS_WORK",
      "FEEDBACK: Missing CSRF protection",
    ].join("\n");

    const results = [
      makeResult("Code Reviewer", "r1"),
      makeResult("Security Auditor", "r2"),
    ];
    const reviews = parseReviews(reviewOutput, results);

    expect(reviews).toHaveLength(2);
    expect(reviews[0]!.grade).toBe("PASS");
    expect(reviews[1]!.grade).toBe("NEEDS_WORK");
    expect(reviews[1]!.feedback).toBe("Missing CSRF protection");
  });

  test("handles empty review output", () => {
    const results = [makeResult("Code Reviewer", "r1")];
    const reviews = parseReviews("", results);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.grade).toBe("PASS");
  });
});

describe("summarizeOutput", () => {
  test("returns '(no output)' for empty string", () => {
    expect(summarizeOutput("", 100)).toBe("(no output)");
  });

  test("returns full output if within limit", () => {
    expect(summarizeOutput("hello world", 100)).toBe("hello world");
  });

  test("truncates long output", () => {
    const long = "x".repeat(200);
    const result = summarizeOutput(long, 50);
    expect(result).toHaveLength(53); // 50 + "..."
    expect(result.endsWith("...")).toBe(true);
  });

  test("extracts grade line when present", () => {
    const output = "Some preamble\nGRADE: VERIFIED\nMore text after";
    const result = summarizeOutput(output, 1000);
    expect(result).toContain("GRADE: VERIFIED");
  });

  test("extracts findings with priority markers", () => {
    const output = [
      "Analysis complete.",
      "- P0: Critical SQL injection in auth.ts",
      "- P1: Missing rate limiting",
      "Other stuff",
    ].join("\n");
    const result = summarizeOutput(output, 1000);
    expect(result).toContain("P0: Critical SQL injection");
    expect(result).toContain("P1: Missing rate limiting");
  });

  test("extracts heading lines", () => {
    const output = "## Summary\nThe code is clean.\n## Findings\n- None.";
    const result = summarizeOutput(output, 1000);
    expect(result).toContain("## Summary");
    expect(result).toContain("## Findings");
  });

  test("extracts numbered list items", () => {
    const output = "Results:\n1. Fixed the bug\n2. Added tests\nDone.";
    const result = summarizeOutput(output, 1000);
    expect(result).toContain("1. Fixed the bug");
    expect(result).toContain("2. Added tests");
  });

  test("redacts secrets before dashboard summaries", () => {
    const output = "## Findings\n- P1: leaked OPENAI_API_KEY=sk-supersecret1234567890 in logs";
    const result = summarizeOutput(output, 1000);
    expect(result).toContain("[REDACTED_SECRET]");
    expect(result).not.toContain("sk-supersecret");
  });
});

describe("worstGrade", () => {
  test("returns undefined for empty array", () => {
    expect(worstGrade([])).toBeUndefined();
  });

  test("returns undefined for all-undefined grades", () => {
    expect(worstGrade([undefined, undefined])).toBeUndefined();
  });

  test("returns single grade", () => {
    expect(worstGrade(["VERIFIED"])).toBe("VERIFIED");
  });

  test("returns FAILED as worst", () => {
    expect(worstGrade(["PERFECT", "VERIFIED", "FAILED"])).toBe("FAILED");
  });

  test("returns FEEDBACK as worse than PARTIAL", () => {
    expect(worstGrade(["PARTIAL", "FEEDBACK"])).toBe("FEEDBACK");
  });

  test("returns PARTIAL as worse than VERIFIED", () => {
    expect(worstGrade(["VERIFIED", "PARTIAL"])).toBe("PARTIAL");
  });

  test("returns VERIFIED as worse than PERFECT", () => {
    expect(worstGrade(["PERFECT", "VERIFIED"])).toBe("VERIFIED");
  });

  test("skips undefined values", () => {
    expect(worstGrade([undefined, "VERIFIED", undefined, "PARTIAL"])).toBe("PARTIAL");
  });

  test("handles all grades in order", () => {
    expect(worstGrade(["PERFECT", "VERIFIED", "PARTIAL", "FEEDBACK", "FAILED"])).toBe("FAILED");
  });
});
