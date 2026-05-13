export type Severity = "P0" | "P1" | "P2" | "P3" | null;

// Keep patterns specific enough that final audit reports can mention priority/severity
// headings without pausing an otherwise useful run. Still pause on explicit finding
// labels and concrete exploit-class language.

const P0_PATTERNS = [
  /\bP0\s*[:—-]/i,
  /\bSEVERITY\s*[:=]\s*(P0|CRITICAL)\b/i,
  /\bCRITICAL\s*[:—-]\s*.+/i,
  /\bCRITICAL\s+(VULNERABILITY|SECURITY|RISK|BUG|ISSUE|FINDING)\b/i,
  /\bSECURITY\s*(VULNERABILITY|ISSUE|BUG|FLAW)\b/i,
  /\bRCE\b/,
  /\bREMOTE\s+CODE\s+EXECUTION\b/i,
  /\bSQL\s*INJECTION\b/i,
  /\bCOMMAND\s*INJECTION\b/i,
  /\bAUTH(?:ENTICATION|ORIZATION)?\s+BYPASS\b/i,
  /\bPRIVILEGE\s+ESCALATION\b/i,
  /\bSECRET\s+EXPOSURE\b/i,
  /\bCREDENTIAL\s+LEAK\b/i,
  /\bDATA\s+EXFILTRATION\b/i,
];

const P1_PATTERNS = [
  /\bP1\s*[:—-]/i,
  /\bSEVERITY\s*[:=]\s*(P1|HIGH)\b/i,
  /\bHIGH\s+SEVERITY\s+(ISSUE|FINDING|BUG|RISK)\b/i,
  /\bBREAKING\s*CHANGE\b/i,
  /\bDATA\s*LOSS\b/i,
];

const P2_PATTERN = /\bP2\s*[:—-]/i;
const P3_PATTERN = /\bP3\s*[:—-]/i;
const FILE_LINE_PATTERN = /^[\w./-]+\.(?:ts|tsx|js|jsx|go|py|md|yaml|yml|json|toml|sh):\d+\b/i;

function hasStructuredStandaloneFinding(text: string, labels: string[]): boolean {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim() ?? "";
    if (!labels.some((label) => new RegExp(`^${label}$`, "i").test(line))) continue;
    const following = lines.slice(i + 1, i + 5).map((next) => next.trim()).filter(Boolean);
    if (following.some((next) => FILE_LINE_PATTERN.test(next))) return true;
  }
  return false;
}

export function scanSeverity(text: string): Severity {
  if (P0_PATTERNS.some((p) => p.test(text))) return "P0";
  if (hasStructuredStandaloneFinding(text, ["CRITICAL"])) return "P0";
  if (P1_PATTERNS.some((p) => p.test(text))) return "P1";
  if (hasStructuredStandaloneFinding(text, ["HIGH"])) return "P1";
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
    ? /^.*\b(P0|CRITICAL|SECURITY|RCE|SQL\s*INJECTION|COMMAND\s*INJECTION).*$/im
    : /^.*\b(P1|HIGH\s+SEVERITY|BREAKING\s+CHANGE|DATA\s+LOSS).*$/im;
  const match = text.match(pattern);
  return match ? match[0].trim().slice(0, 500) : text.slice(0, 200);
}
