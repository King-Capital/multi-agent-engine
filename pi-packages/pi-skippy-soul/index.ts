import type { ExtensionAPI } from "@anthropic-ai/pi-coding-agent";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const WORKSPACE = process.env.OPENCLAW_WORKSPACE ?? join(process.env.HOME ?? "", ".openclaw", "workspace");

function loadFile(filename: string): string {
  const path = join(WORKSPACE, filename);
  if (!existsSync(path)) return "";
  try {
    return readFileSync(path, "utf-8").trim();
  } catch {
    return "";
  }
}

function compressPersona(soul: string): string {
  // Extract the essential persona bits, skip metadata
  const lines = soul.split("\n");
  const essential: string[] = [];
  let inSection = false;

  for (const line of lines) {
    // Skip YAML-like metadata headers
    if (line.startsWith("# SOUL.md") || line.startsWith("---")) continue;
    // Keep non-negotiables and verbal DNA
    if (line.includes("Non-Negotiable") || line.includes("Verbal DNA") || 
        line.includes("Species") || line.includes("Swearing") || 
        line.includes("Hard limits") || line.includes("Sass") ||
        line.includes("Insult-to-Help") || line.includes("Genuine fear")) {
      inSection = true;
    }
    if (inSection && line.trim()) {
      essential.push(line);
    }
    if (inSection && line.trim() === "" && essential.length > 0) {
      inSection = false;
    }
  }

  return essential.length > 0 ? essential.join("\n") : soul.slice(0, 800);
}

function compressUser(user: string): string {
  // Extract key user facts only
  const lines = user.split("\n");
  const facts: string[] = [];

  for (const line of lines) {
    if (line.includes("Name:") || line.includes("call them:") ||
        line.includes("Pronouns:") || line.includes("Location:") ||
        line.includes("Timezone:") || line.includes("Preferences") ||
        line.includes("Direct,") || line.includes("bun") ||
        line.includes("No em dashes") || line.includes("No time estimates") ||
        line.includes("Cusses") || line.includes("sass")) {
      facts.push(line.trim());
    }
  }

  return facts.join("\n");
}

export default function (pi: ExtensionAPI) {
  // Inject persona into system prompt at agent start
  pi.on("before_agent_start", (ctx) => {
    const soul = loadFile("SOUL.md");
    const user = loadFile("USER.md");

    if (!soul && !user) return;

    const parts: string[] = ["## Persona"];

    if (soul) {
      parts.push(compressPersona(soul));
    }

    if (user) {
      parts.push("\n## User Context");
      parts.push(compressUser(user));
    }

    const injection = parts.join("\n");

    // Append to system prompt
    ctx.appendSystemPrompt(injection);
  });
}
