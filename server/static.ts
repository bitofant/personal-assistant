import { readFileSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import type { ServerResponse } from "node:http";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json",
  ".woff2": "font/woff2",
};

/** Map a request URL to a file inside `root`, or null for SPA fallback. Never escapes `root`. */
export function resolveStaticPath(root: string, url: string): string | null {
  let path: string;
  try {
    path = decodeURIComponent(url.split(/[?#]/)[0]);
  } catch {
    return null;
  }
  if (path === "/" || path.includes("\0")) return null;
  const candidate = normalize(join(root, path));
  return candidate.startsWith(root + sep) ? candidate : null;
}

export function contentTypeFor(file: string): string {
  return CONTENT_TYPES[extname(file)] ?? "application/octet-stream";
}

export function serveStatic(root: string, url: string, res: ServerResponse): void {
  const candidate = resolveStaticPath(root, url);
  const file = candidate && isFile(candidate) ? candidate : join(root, "index.html");
  // rebuild.sh swaps dist/web under a live server; a vanished file must not throw.
  let body: Buffer;
  try {
    body = readFileSync(file);
  } catch {
    res.statusCode = 503;
    res.setHeader("retry-after", "5");
    res.end("Frontend not available (not built, or rebuilding). Run `npm run build` or `npm run dev`.");
    return;
  }
  res.setHeader("content-type", contentTypeFor(file));
  res.end(body);
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}
