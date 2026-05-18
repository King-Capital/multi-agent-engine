// Security enforcement is delegated to adapter extensions (Pi tool_call interception).
// This module provides input sanitization and URL validation only.

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

const SECRET_PATTERNS: RegExp[] = [
  /\b(Authorization\s*:\s*Bearer\s+)([A-Za-z0-9._~+\/-]+=*)/gi,
  /((?:api[_-]?key|token|secret|password|passwd|pwd|access[_-]?token|refresh[_-]?token)\b\s*[:=]\s*)([^\s'\"`;,}]+)/gi,
  /("(?:api[_-]?key|token|secret|password|passwd|pwd|access[_-]?token|refresh[_-]?token)"\s*:\s*")([^"\\]*(?:\\.[^"\\]*)*)"/gi,
  /\b()(sk-[A-Za-z0-9]{16,})\b/g,
  /\b()(ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|sk-ant-[A-Za-z0-9-_]{16,}|AIza[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})\b/g,
  /()-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b([A-Za-z0-9_]*KEY[A-Za-z0-9_]*\s*=\s*)([^\s'\"`;,}]+)/g,
  /("[A-Za-z0-9_]*KEY[A-Za-z0-9_]*"\s*:\s*")([^"\\]*(?:\\.[^"\\]*)*)"/g,
];

export function redactSecrets(input: string): string {
  let redacted = input;
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    redacted = redacted.replace(pattern, (_match, prefix: string) => `${prefix}[REDACTED_SECRET]${prefix.endsWith('"') ? '"' : ''}`);
  }
  return redacted;
}

export function redactUnknown<T>(value: T): T {
  if (typeof value === "string") return redactSecrets(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactUnknown(item)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (/secret|token|password|api[_-]?key|authorization|credential/i.test(key) && typeof item === "string") {
        out[key] = "[REDACTED_SECRET]";
      } else {
        out[key] = redactUnknown(item);
      }
    }
    return out as T;
  }
  return value;
}

export function sanitizeAgentInput(input: string): string {
  let sanitized = redactSecrets(input);
  for (const pattern of INJECTION_PATTERNS) {
    pattern.lastIndex = 0;
    sanitized = sanitized.replace(pattern, "[REDACTED]");
  }

  return sanitized;
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
  } catch { return false; }
}
