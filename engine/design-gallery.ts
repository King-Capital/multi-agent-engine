import { readFileSync, readdirSync, existsSync, watch, mkdirSync } from "fs";
import { join, extname, resolve } from "path";
import type { DesignVariant } from "./types";

const DEFAULT_PORT = 8401;
const DEFAULT_HOST = process.env.MAE_GALLERY_HOST ?? process.env.MAE_AGENT_HOST ?? "127.0.0.1";

export function startDesignGallery(outputDir: string, port = DEFAULT_PORT, hostname = DEFAULT_HOST): { stop: () => void; url: string } {
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const server = Bun.serve({
    port,
    hostname,
    fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/" || url.pathname === "/index.html") {
        return new Response(buildGalleryIndex(outputDir), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      if (url.pathname === "/api/variants") {
        return Response.json(listVariants(outputDir));
      }

      const resolvedOutput = resolve(outputDir);
      const resolvedFile = resolve(join(outputDir, url.pathname.slice(1)));
      if (existsSync(resolvedFile) && resolvedFile.startsWith(resolvedOutput + "/")) {
        const file = Bun.file(resolvedFile);
        return new Response(file, {
          headers: { "Content-Security-Policy": "sandbox allow-same-origin" },
        });
      }

      if (url.pathname === "/events") {
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream({
            start(controller) {
              let debounceTimer: ReturnType<typeof setTimeout> | null = null;
              const watcher = watch(outputDir, () => {
                if (debounceTimer) clearTimeout(debounceTimer);
                debounceTimer = setTimeout(() => {
                  controller.enqueue(encoder.encode("data: reload\n\n"));
                }, 300);
              });
              req.signal.addEventListener("abort", () => watcher.close());
            },
          }),
          { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" } },
        );
      }

      return new Response("Not found", { status: 404 });
    },
  });

  console.log(`[design-gallery] Serving at http://localhost:${port}`);
  console.log(`[design-gallery] Watching: ${outputDir}`);

  return {
    stop: () => server.stop(),
    url: `http://localhost:${port}`,
  };
}

export function listVariants(outputDir: string): DesignVariant[] {
  if (!existsSync(outputDir)) return [];
  return readdirSync(outputDir)
    .filter(f => extname(f) === ".html")
    .map(f => {
      const content = readFileSync(join(outputDir, f), "utf-8");
      const nameMatch = /<meta\s+name="variant-name"\s+content="([^"]*)"/.exec(content);
      const descMatch = /<meta\s+name="variant-description"\s+content="([^"]*)"/.exec(content);
      return {
        name: nameMatch?.[1] ?? f.replace(".html", ""),
        description: descMatch?.[1] ?? "",
        html: content,
        filePath: join(outputDir, f),
      };
    });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/`/g, "&#96;");
}

function buildGalleryIndex(outputDir: string): string {
  const variants = readdirSync(outputDir).filter(f => extname(f) === ".html");

  const variantLinks = variants.map(f => {
    const name = f.replace(".html", "").replace(/-/g, " ");
    return `<li><a href="/${encodeURIComponent(f)}" target="preview">${escapeHtml(name)}</a></li>`;
  }).join("\n        ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>MAE Design Gallery</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; display: flex; height: 100vh; background: #0a0a0a; color: #e5e5e5; }
    nav { width: 260px; padding: 20px; border-right: 1px solid #262626; overflow-y: auto; flex-shrink: 0; }
    nav h1 { font-size: 16px; font-weight: 600; margin-bottom: 16px; color: #a78bfa; }
    nav ul { list-style: none; }
    nav li { margin-bottom: 4px; }
    nav a { display: block; padding: 8px 12px; border-radius: 6px; color: #d4d4d4; text-decoration: none; font-size: 14px; transition: background 0.15s; }
    nav a:hover { background: #1a1a2e; color: #fff; }
    .preview { flex: 1; }
    iframe { width: 100%; height: 100%; border: none; background: #fff; }
    .empty { display: flex; align-items: center; justify-content: center; height: 100%; color: #737373; font-size: 14px; }
  </style>
</head>
<body>
  <nav>
    <h1>Design Gallery</h1>
    <ul>
      ${variantLinks || '<li class="empty">No variants yet</li>'}
    </ul>
  </nav>
  <div class="preview">
    ${variants.length > 0
      ? `<iframe name="preview" src="/${escapeAttr(encodeURIComponent(variants[0]!))}"></iframe>`
      : '<div class="empty">Design variants will appear here as the agent produces them.</div>'}
  </div>
  <script>
    const evtSource = new EventSource('/events');
    evtSource.onmessage = () => location.reload();
  </script>
</body>
</html>`;
}
