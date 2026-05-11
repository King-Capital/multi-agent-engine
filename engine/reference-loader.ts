import { readFileSync, readdirSync, existsSync, statSync } from "fs";
import { join, extname, basename } from "path";
import { isInternalUrl } from "./security";
import { createLogger } from "./logger";

const log = createLogger("reference-loader");

export interface DesignReference {
  source: "file" | "url" | "project";
  name: string;
  content: string;
}

export function loadFileReferences(paths: string[]): DesignReference[] {
  const refs: DesignReference[] = [];
  for (const p of paths) {
    if (!existsSync(p)) {
      log.warn(`File not found: ${p}`);
      continue;
    }
    const ext = extname(p).toLowerCase();
    const name = basename(p);

    if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(ext)) {
      const stat = statSync(p);
      refs.push({
        source: "file",
        name,
        content: `[Image reference: ${name}]\nFile: ${p}\nSize: ${stat.size} bytes\nType: ${ext.slice(1)}\nAnalyze this image for: color palette, typography, spacing, component styles, overall aesthetic.`,
      });
    } else {
      const text = readFileSync(p, "utf-8");
      refs.push({
        source: "file",
        name,
        content: text.slice(0, 10_000),
      });
    }
  }
  return refs;
}

export async function loadUrlReferences(urls: string[]): Promise<DesignReference[]> {
  const refs: DesignReference[] = [];
  for (const url of urls) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        log.warn(`Blocked non-HTTP URL: ${url}`);
        continue;
      }
      if (isInternalUrl(url)) {
        log.warn(`Blocked internal URL: ${url}`);
        continue;
      }
      const resp = await fetch(url, {
        headers: { "User-Agent": "MAE-DesignLoader/1.0" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) {
        log.warn(`Failed to fetch ${url}: ${resp.status}`);
        continue;
      }
      const contentLength = parseInt(resp.headers.get("content-length") ?? "0", 10);
      if (contentLength > 5_000_000) {
        log.warn(`Response too large (${contentLength} bytes): ${url}`);
        continue;
      }
      const contentType = resp.headers.get("content-type") ?? "";
      if (contentType.includes("text/html")) {
        const html = await resp.text();
        const styleBlocks = extractStyleBlocks(html);
        const meta = extractMetaTags(html);
        refs.push({
          source: "url",
          name: url,
          content: [
            `URL: ${url}`,
            meta ? `Meta: ${meta}` : "",
            styleBlocks.length > 0
              ? `CSS (${styleBlocks.length} blocks):\n${styleBlocks.join("\n\n").slice(0, 8_000)}`
              : "No inline styles found",
            `HTML structure (first 5000 chars):\n${html.slice(0, 5_000)}`,
          ].filter(Boolean).join("\n\n"),
        });
      } else if (contentType.includes("text/css")) {
        const css = await resp.text();
        refs.push({ source: "url", name: url, content: css.slice(0, 10_000) });
      } else {
        log.warn(`Unsupported content type for ${url}: ${contentType}`);
      }
    } catch (err: any) {
      log.warn(`Error fetching ${url}: ${err.message}`);
    }
  }
  return refs;
}

export async function scanProjectDesign(projectDir: string): Promise<DesignReference[]> {
  const refs: DesignReference[] = [];
  const findings: string[] = [];

  const cssFiles = findFiles(projectDir, [".css", ".scss", ".less"]);
  const customProperties: string[] = [];
  const fontFamilies = new Set<string>();
  const colors = new Set<string>();

  for (const file of cssFiles.slice(0, 20)) {
    const content = readFileSync(file, "utf-8");

    const propMatches = content.matchAll(/--[\w-]+:\s*[^;]+/g);
    for (const m of propMatches) customProperties.push(m[0]);

    const fontMatches = content.matchAll(/font-family:\s*([^;]+)/g);
    for (const m of fontMatches) fontFamilies.add(m[1]!.trim());

    const colorMatches = content.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]+\)|hsla?\([^)]+\)/g);
    for (const m of colorMatches) colors.add(m[0]);
  }

  if (customProperties.length > 0) {
    findings.push(`Design Tokens (${customProperties.length} CSS custom properties):\n${customProperties.slice(0, 50).join("\n")}`);
  }
  if (fontFamilies.size > 0) {
    findings.push(`Font Families: ${[...fontFamilies].join(", ")}`);
  }
  if (colors.size > 0) {
    const uniqueColors = [...colors].slice(0, 30);
    findings.push(`Colors (${colors.size} unique): ${uniqueColors.join(", ")}`);
  }

  const componentDirs = ["components", "src/components", "app/components", "dashboard-next/src/components"];
  for (const dir of componentDirs) {
    const fullDir = join(projectDir, dir);
    if (existsSync(fullDir)) {
      const components = readdirSync(fullDir).filter(f => !f.startsWith(".")).slice(0, 30);
      findings.push(`Components in ${dir}/ (${components.length}): ${components.join(", ")}`);
    }
  }

  const tailwindConfig = ["tailwind.config.js", "tailwind.config.ts", "tailwind.config.cjs"].find(
    f => existsSync(join(projectDir, f))
  );
  if (tailwindConfig) {
    const content = readFileSync(join(projectDir, tailwindConfig), "utf-8");
    findings.push(`Tailwind config (${tailwindConfig}):\n${content.slice(0, 3_000)}`);
  }

  if (findings.length > 0) {
    refs.push({
      source: "project",
      name: projectDir,
      content: `Project Design System Scan:\n\n${findings.join("\n\n")}`,
    });
  }

  return refs;
}

function extractStyleBlocks(html: string): string[] {
  const blocks: string[] = [];
  const regex = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    if (match[1]?.trim()) blocks.push(match[1].trim());
  }
  return blocks;
}

function extractMetaTags(html: string): string {
  const metas: string[] = [];
  const regex = /<meta\s+[^>]*(?:name|property)="([^"]*)"[^>]*content="([^"]*)"[^>]*>/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    metas.push(`${match[1]}: ${match[2]}`);
  }
  return metas.slice(0, 10).join("; ");
}

function findFiles(dir: string, extensions: string[], maxDepth = 4, depth = 0): string[] {
  if (depth >= maxDepth || !existsSync(dir)) return [];
  const results: string[] = [];
  try {
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith(".") || entry === "node_modules" || entry === "dist" || entry === "build") continue;
      const fullPath = join(dir, entry);
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          results.push(...findFiles(fullPath, extensions, maxDepth, depth + 1));
        } else if (extensions.includes(extname(entry).toLowerCase())) {
          results.push(fullPath);
        }
      } catch { /* skip unreadable */ }
    }
  } catch { /* skip unreadable */ }
  return results;
}
