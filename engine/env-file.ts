import { existsSync, readFileSync } from "fs";

type MutableEnv = Record<string, string | undefined>;

export function loadEnvFile(path: string, env: MutableEnv = process.env): void {
  if (!existsSync(path)) return;

  const raw = readFileSync(path, "utf-8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;

    const key = match[1]!;
    if (env[key] !== undefined) continue;

    env[key] = unquoteEnvValue(match[2]!.trim());
  }
}

function unquoteEnvValue(value: string): string {
  if (value.length >= 2) {
    const quote = value[0];
    if ((quote === `"` || quote === "'") && value[value.length - 1] === quote) {
      return value.slice(1, -1);
    }
  }
  return value;
}
