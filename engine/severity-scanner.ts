export type Severity = "P0" | "P1" | "P2" | "P3" | null;

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

export function shouldAutoPause(severity: Severity): boolean {
  return severity === "P0" || severity === "P1";
}

export function extractFindingExcerpt(text: string, severity: Severity): string {
  if (!severity) return "";
  const pattern = severity === "P0"
    ? /^.*\b(P0|CRITICAL|SECURITY).*$/im
    : /^.*\bP1.*$/im;
  const match = text.match(pattern);
  return match ? match[0].trim().slice(0, 500) : text.slice(0, 200);
}
