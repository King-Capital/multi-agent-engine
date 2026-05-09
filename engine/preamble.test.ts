import { describe, test, expect } from "bun:test";
import { buildSystemPrompt, loadPreamble } from "./config";
import type { PersonaConfig } from "./types";

function makePersona(overrides?: Partial<PersonaConfig>): PersonaConfig {
  return {
    name: "Test Agent",
    model: "main",
    expertise: "agents/expertise/builder.md",
    skills: [],
    tools: ["read", "write"],
    domain: { read: ["**/*"], write: ["**/*"], update: ["**/*"] },
    ...overrides,
  };
}

describe("per-role preambles", () => {
  describe("loadPreamble", () => {
    test("worker role loads worker preamble", () => {
      const preamble = loadPreamble("worker");
      expect(preamble).toContain("Worker Principles");
      expect(preamble).toContain("Smallest change");
    });

    test("lead role loads lead preamble", () => {
      const preamble = loadPreamble("lead");
      expect(preamble).toContain("Lead Principles");
      expect(preamble).toContain("Define success");
    });

    test("orchestrator role loads lead preamble", () => {
      const preamble = loadPreamble("orchestrator");
      expect(preamble).toContain("Lead Principles");
    });

    test("sr role loads lead preamble", () => {
      const preamble = loadPreamble("sr");
      expect(preamble).toContain("Lead Principles");
    });

    test("scout role loads scout preamble", () => {
      const preamble = loadPreamble("scout");
      expect(preamble).toContain("Scout Principles");
      expect(preamble).toContain("read-only");
    });

    test("worker with reviewer persona name loads reviewer preamble", () => {
      const preamble = loadPreamble("worker", "Code Reviewer");
      expect(preamble).toContain("Reviewer Principles");
      expect(preamble).toContain("evidence");
    });

    test("worker with adversarial persona name loads reviewer preamble", () => {
      const preamble = loadPreamble("worker", "Adversarial Reviewer");
      expect(preamble).toContain("Reviewer Principles");
    });

    test("worker with validator persona name loads reviewer preamble", () => {
      const preamble = loadPreamble("worker", "Validation Lead");
      expect(preamble).toContain("Reviewer Principles");
    });

    test("worker with builder persona name loads worker preamble", () => {
      const preamble = loadPreamble("worker", "Builder Alpha");
      expect(preamble).toContain("Worker Principles");
    });
  });

  describe("buildSystemPrompt with role", () => {
    test("includes preamble when role is provided", () => {
      const prompt = buildSystemPrompt(makePersona(), "worker");
      expect(prompt).toContain("Worker Principles");
      expect(prompt).toContain("# Test Agent");
    });

    test("includes lead preamble for lead role", () => {
      const prompt = buildSystemPrompt(makePersona({ name: "Planning Lead" }), "lead");
      expect(prompt).toContain("Lead Principles");
      expect(prompt).toContain("# Planning Lead");
    });

    test("includes reviewer preamble for reviewer persona", () => {
      const prompt = buildSystemPrompt(makePersona({ name: "Code Reviewer" }), "worker");
      expect(prompt).toContain("Reviewer Principles");
    });

    test("no preamble when role is omitted", () => {
      const prompt = buildSystemPrompt(makePersona());
      expect(prompt).not.toContain("Worker Principles");
      expect(prompt).not.toContain("Lead Principles");
      expect(prompt).toContain("# Test Agent");
    });

    test("preamble appears before persona name", () => {
      const prompt = buildSystemPrompt(makePersona(), "worker");
      const preambleIdx = prompt.indexOf("Worker Principles");
      const nameIdx = prompt.indexOf("# Test Agent");
      expect(preambleIdx).toBeLessThan(nameIdx);
    });
  });
});
