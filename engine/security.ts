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
import { join, normalize } from "path";
import { parse as parseYaml } from "yaml";
import { createHash } from "crypto";
import type { DomainConfig } from "./types";
import { BASE_DIR } from "./config";

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

// Compiled bash patterns cache (built on first use from rules)
let _compiledBashPatterns: { re: RegExp; reason: string; action: "block" | "ask" | "warn" }[] | null = null;

function getCompiledBashPatterns(): typeof _compiledBashPatterns & {} {
  if (_compiledBashPatterns) return _compiledBashPatterns;
  const rules = loadRules();
  _compiledBashPatterns = rules.bashPatterns.map((p) => ({
    re: new RegExp(p.pattern, "i"),
    reason: p.reason,
    action: p.action,
  }));
  return _compiledBashPatterns;
}

export function checkBashCommand(command: string): SecurityViolation[] {
  const patterns = getCompiledBashPatterns();
  const violations: SecurityViolation[] = [];

  for (const { re, reason, action } of patterns) {
    if (re.test(command)) {
      violations.push({
        type: action === "block" ? "bash_blocked" : "bash_warn",
        command,
        reason,
        action: action === "warn" ? "warn" : "block",
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

// Pre-compiled injection patterns (compiled once at module load)
const INJECTION_PATTERNS = [
  /\bsystem\s*:\s*/gi,
  /\bignore\s+(previous|above|all)\s+instructions/gi,
  /\byou\s+are\s+now\b/gi,
  /\bforget\s+(everything|all|your)\b/gi,
  /\bact\s+as\s+(if|though)\b/gi,
  /<\/?system>/gi,
  /\[INST\]/gi,
  /<<SYS>>/gi,
];

export function sanitizeAgentInput(input: string): string {
  let sanitized = input;
  for (const pattern of INJECTION_PATTERNS) {
    pattern.lastIndex = 0;
    sanitized = sanitized.replace(pattern, "[REDACTED]");
  }

  return sanitized;
}

// Pre-compiled sensitive output patterns (compiled once at module load)
const SENSITIVE_OUTPUT_PATTERNS = [
  { pattern: /(?:api[_-]?key|token|secret|password)\s*[:=]\s*["']?[A-Za-z0-9+/=_-]{20,}/gi, reason: "Possible credential in output" },
  { pattern: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/g, reason: "Private key in output" },
  { pattern: /ghp_[A-Za-z0-9_]{36}/g, reason: "GitHub personal access token in output" },
  { pattern: /sk-[A-Za-z0-9]{48}/g, reason: "OpenAI API key in output" },
  { pattern: /sk-ant-[A-Za-z0-9-]{95}/g, reason: "Anthropic API key in output" },
];

export function validateAgentOutput(output: string): SecurityViolation[] {
  const violations: SecurityViolation[] = [];

  for (const { pattern, reason } of SENSITIVE_OUTPUT_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(output)) {
      violations.push({ type: "zero_access", reason, action: "block" });
    }
  }

  return violations;
}

export function getDomainTemplate(name: string): DomainConfig | undefined {
  const rules = loadRules();
  return rules.domainTemplates[name];
}

export function isInternalUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^\[|\]$/g, "");
    if (u.protocol === "file:") return true;
    if (host === "localhost" || host === "0.0.0.0" || host === "[::]") return true;
    if (host === "127.0.0.1" || host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
    if (host.startsWith("::ffff:")) return true;
    if (host.startsWith("10.") || host.startsWith("192.168.")) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
    if (/^169\.254\./.test(host)) return true;
    if (host.startsWith("fe80:") || host.startsWith("fc00:") || host.startsWith("fd00:")) return true;
    if (/^0x/i.test(host) || /^0\d/.test(host)) return true;
    if (host === "metadata.google.internal") return true;
    return false;
  } catch { return true; }
}

function matchGlob(path: string, pattern: string): boolean {
  if (pattern === "**/*") return true;

  // Normalize -- block path traversal
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
