export type Severity = "P0" | "P1" | "P2" | "P3" | null;

// Known limitation: These patterns are intentionally broad and may produce false positives.
// The design philosophy is "better to over-pause than miss a real P0". Agent output that
// happens to contain words like "CRITICAL" or "SECURITY" in non-finding context can trigger
// a false pause. This is acceptable for safety but may need tuning for specific workflows.

const P0_PATTERNS = [
  /\bP0\s*:/i,
  /\bCRITICAL\b/i,
  /\bSECURITY\s*(VULNERABILITY|ISSUE|BUG|FLAW)\b/i,
  /\bRCE\b/,
  /\bSQL\s*INJECTION\b/i,
  /\bCOMMAND\s*INJECTION\b/i,
];

const P1_PATTERNS = [
  /\bP1\s*:/i,
  /\bHIGH\s*SEVERITY\b/i,
  /\bBREAKING\s*CHANGE\b/i,
  /\bDATA\s*LOSS\b/i,
];

const P2_PATTERN = /\bP2\s*:/i;
const P3_PATTERN = /\bP3\s*:/i;

export function scanSeverity(text: string): Severity {
  if (P0_PATTERNS.some((p) => p.test(text))) return "P0";
  if (P1_PATTERNS.some((p) => p.test(text))) return "P1";
  if (P2_PATTERN.test(text)) return "P2";
  if (P3_PATTERN.test(text)) return "P3";
  return null;
}

// Rate limit: track last fire time per session to avoid repeated pauses within 60s
const lastPauseFireTime = new Map<string, number>();
const PAUSE_COOLDOWN_MS = 60_000;

export function shouldAutoPause(severity: Severity, sessionId?: string): boolean {
  if (severity !== "P0" && severity !== "P1") return false;

  if (sessionId) {
    const lastFire = lastPauseFireTime.get(sessionId) ?? 0;
    const now = Date.now();
    if (now - lastFire < PAUSE_COOLDOWN_MS) return false;
    lastPauseFireTime.set(sessionId, now);
  }

  return true;
}

export function extractFindingExcerpt(text: string, severity: Severity): string {
  if (!severity) return "";
  const pattern = severity === "P0"
    ? /^.*\b(P0|CRITICAL|SECURITY).*$/im
    : /^.*\bP1.*$/im;
  const match = text.match(pattern);
  return match ? match[0].trim().slice(0, 500) : text.slice(0, 200);
}
