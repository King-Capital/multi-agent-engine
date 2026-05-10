/**
 * ADVISORY ONLY -- Security checks in this module are NOT enforced at the adapter level.
 *
 * The Pi adapter manages permissions via its own persona frontmatter (tools, domain).
 * These checks are not enforced at the adapter level.
 *
 * What these checks DO provide:
 *   - sanitizeAgentInput(): strips prompt injection patterns from task text
 *   - validateAgentOutput(): detects leaked credentials in agent output (used by orchestrator to redact)
 *   - registerPersonaHash() / verifyPersonaIntegrity(): detects persona file tampering after load
 *   - checkBashCommand(), checkFileAccess(), checkConfigMutation(): domain/path validation logic
 *
 * These functions are available for future enforcement (e.g., a sandboxed adapter mode)
 * but currently only sanitizeAgentInput and validateAgentOutput are called by the orchestrator.
 * The file-access and bash-command checks are never invoked in the current adapter flow.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { parse as parseYaml } from "yaml";
import { createHash } from "crypto";
import type { DomainConfig } from "./types";

const BASE_DIR = join(import.meta.dir, "..");

interface BashPattern {
  pattern: string;
  reason: string;
  action: "block" | "ask" | "warn";
}

interface DamageControlRules {
  bashPatterns: BashPattern[];
  zeroAccessPaths: string[];
  readOnlyPaths: string[];
  noDeletePaths: string[];
  domainTemplates: Record<string, DomainConfig>;
}

let _rules: DamageControlRules | null = null;

function loadRules(): DamageControlRules {
  if (_rules) return _rules;
  const raw = readFileSync(join(BASE_DIR, "configs/damage-control-rules.yaml"), "utf-8");
  _rules = parseYaml(raw) as DamageControlRules;
  return _rules;
}

export interface SecurityViolation {
  type: "bash_blocked" | "bash_warn" | "zero_access" | "read_only" | "no_delete" | "domain_escape" | "config_mutation" | "persona_tamper";
  path?: string;
  command?: string;
  reason: string;
  action: "block" | "warn";
}

export function checkBashCommand(command: string): SecurityViolation[] {
  const rules = loadRules();
  const violations: SecurityViolation[] = [];

  for (const pattern of rules.bashPatterns) {
    const re = new RegExp(pattern.pattern, "i");
    if (re.test(command)) {
      violations.push({
        type: pattern.action === "block" ? "bash_blocked" : "bash_warn",
        command,
        reason: pattern.reason,
        action: pattern.action === "warn" ? "warn" : "block",
      });
    }
  }

  return violations;
}

export function checkFileAccess(path: string, action: "read" | "write" | "delete", domain: DomainConfig): SecurityViolation[] {
  const rules = loadRules();
  const violations: SecurityViolation[] = [];

  for (const zeroPath of rules.zeroAccessPaths) {
    if (matchGlob(path, zeroPath)) {
      violations.push({
        type: "zero_access",
        path,
        reason: `Zero-access path: ${zeroPath}`,
        action: "block",
      });
      return violations;
    }
  }

  if (action === "write") {
    for (const roPath of rules.readOnlyPaths) {
      if (matchGlob(path, roPath)) {
        violations.push({
          type: "read_only",
          path,
          reason: `Read-only path: ${roPath}`,
          action: "block",
        });
      }
    }
  }

  if (action === "delete") {
    for (const ndPath of rules.noDeletePaths) {
      if (matchGlob(path, ndPath)) {
        violations.push({
          type: "no_delete",
          path,
          reason: `No-delete path: ${ndPath}`,
          action: "block",
        });
      }
    }
  }

  if (action === "write" || action === "delete") {
    const writePaths = domain.write ?? [];
    const allowed = writePaths.some((p) => matchGlob(path, p));
    if (!allowed) {
      violations.push({
        type: "domain_escape",
        path,
        reason: `Domain restriction: agent can only write to ${writePaths.join(", ")}`,
        action: "block",
      });
    }
  }

  return violations;
}

const CONFIG_PATHS = [
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".mcp.json",
  "agents/personas/",
  "agents/skills/",
  "agents/teams/",
  "configs/",
];

export function checkConfigMutation(path: string): SecurityViolation[] {
  const violations: SecurityViolation[] = [];

  for (const configPath of CONFIG_PATHS) {
    if (path.includes(configPath)) {
      violations.push({
        type: "config_mutation",
        path,
        reason: `Config-as-execution defense: ${configPath} is immutable after agent load`,
        action: "block",
      });
    }
  }

  return violations;
}

const personaHashes = new Map<string, string>();

export function registerPersonaHash(path: string): void {
  try {
    const content = readFileSync(join(BASE_DIR, path), "utf-8");
    const hash = createHash("sha256").update(content).digest("hex");
    personaHashes.set(path, hash);
  } catch {
    // file doesn't exist yet
  }
}

export function verifyPersonaIntegrity(path: string): SecurityViolation[] {
  const violations: SecurityViolation[] = [];
  const expectedHash = personaHashes.get(path);

  if (!expectedHash) return violations;

  try {
    const content = readFileSync(join(BASE_DIR, path), "utf-8");
    const currentHash = createHash("sha256").update(content).digest("hex");

    if (currentHash !== expectedHash) {
      violations.push({
        type: "persona_tamper",
        path,
        reason: `Persona file modified after load. Expected hash: ${expectedHash.slice(0, 12)}..., got: ${currentHash.slice(0, 12)}...`,
        action: "block",
      });
    }
  } catch {
    violations.push({
      type: "persona_tamper",
      path,
      reason: "Persona file deleted after load",
      action: "block",
    });
  }

  return violations;
}

export function sanitizeAgentInput(input: string): string {
  const injectionPatterns = [
    { pattern: /\bsystem\s*:\s*/gi, label: "system prefix" },
    { pattern: /\bignore\s+(previous|above|all)\s+instructions/gi, label: "ignore instructions" },
    { pattern: /\byou\s+are\s+now\b/gi, label: "role override" },
    { pattern: /\bforget\s+(everything|all|your)\b/gi, label: "memory wipe" },
    { pattern: /\bact\s+as\s+(if|though)\b/gi, label: "act as" },
    { pattern: /<\/?system>/gi, label: "system tag" },
    { pattern: /\[INST\]/gi, label: "inst tag" },
    { pattern: /<<SYS>>/gi, label: "sys tag" },
  ];

  let sanitized = input;
  for (const { pattern } of injectionPatterns) {
    sanitized = sanitized.replace(pattern, "[REDACTED]");
  }

  return sanitized;
}

export function validateAgentOutput(output: string): SecurityViolation[] {
  const violations: SecurityViolation[] = [];

  const sensitivePatterns = [
    { pattern: /(?:api[_-]?key|token|secret|password)\s*[:=]\s*["']?[A-Za-z0-9+/=_-]{20,}/gi, reason: "Possible credential in output" },
    { pattern: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/g, reason: "Private key in output" },
    { pattern: /ghp_[A-Za-z0-9_]{36}/g, reason: "GitHub personal access token in output" },
    { pattern: /sk-[A-Za-z0-9]{48}/g, reason: "OpenAI API key in output" },
    { pattern: /sk-ant-[A-Za-z0-9-]{95}/g, reason: "Anthropic API key in output" },
  ];

  for (const { pattern, reason } of sensitivePatterns) {
    // Use .match() to avoid lastIndex state bug with /g + .test()
    if (output.match(pattern)) {
      violations.push({ type: "zero_access", reason, action: "block" });
    }
  }

  return violations;
}

export function getDomainTemplate(name: string): DomainConfig | undefined {
  const rules = loadRules();
  return rules.domainTemplates[name];
}

function matchGlob(path: string, pattern: string): boolean {
  if (pattern === "**/*") return true;

  // Normalize -- block path traversal
  const { normalize } = require("path") as typeof import("path");
  let normalizedPath = normalize(path).replace(/\\/g, "/");
  if (normalizedPath.startsWith("../") || normalizedPath === "..") return false;

  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/{{GLOBSTAR}}/g, ".*");

  return new RegExp(`^${regexStr}$`).test(normalizedPath);
}
