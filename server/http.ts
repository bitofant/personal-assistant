import type { IncomingMessage, ServerResponse } from "node:http";
import type { ErrorResponse } from "../shared/api.js";

/** Thrown by handlers; router turns it into a JSON error response. */
export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function sendJson(res: ServerResponse, body: unknown, status = 200): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}

export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, { message } satisfies ErrorResponse, status);
}

export function sendNoContent(res: ServerResponse): void {
  res.statusCode = 204;
  res.end();
}

export const MAX_BODY_BYTES = 1024 * 1024;

/** Read body as text; rejects oversize bodies early rather than buffering them. */
export async function readBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<string> {
  const declared = Number(req.headers["content-length"]);
  if (declared > limit) throw new HttpError(413, `Body exceeds ${limit} bytes.`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, `Body exceeds ${limit} bytes.`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** JSON content-type required: also blocks CORS-simple cross-site form posts (CSRF). */
export async function readJson(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<{ raw: string; value: unknown }> {
  if (!/^application\/json\b/i.test(req.headers["content-type"] ?? ""))
    throw new HttpError(415, "Expected content-type: application/json.");
  const raw = await readBody(req, limit);
  try {
    return { raw, value: JSON.parse(raw) };
  } catch {
    throw new HttpError(400, "Body is not valid JSON.");
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    if (!name || name in out) continue; // first wins, per RFC 6265 ordering
    try {
      out[name] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      // malformed value: ignore cookie
    }
  }
  return out;
}

export function bearerToken(req: IncomingMessage): string | null {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? "");
  return m ? m[1] : null;
}

/** Behind a TLS proxy the socket is plain; trust x-forwarded-proto only for the Secure flag. */
export function isHttps(req: IncomingMessage): boolean {
  return (req.socket as { encrypted?: boolean }).encrypted === true || req.headers["x-forwarded-proto"] === "https";
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
