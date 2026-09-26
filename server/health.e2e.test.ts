import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { loadConfig, localUrl } from "./config.js";
import type { HealthResponse } from "../shared/api.js";

// Needs a running server (npm run dev / npm start); self-skips otherwise.
// Connect where server.host binds, else a non-loopback bind would silently skip.
const base = (() => {
  try {
    return localUrl(loadConfig().server);
  } catch {
    return null;
  }
})();
const up = base !== null && (await fetch(`${base}/api/health`).then(() => true, () => false));

describe.skipIf(!up)("GET /api/health (live)", () => {
  it("matches the shared fixture shape", async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthResponse;
    const fixture = JSON.parse(readFileSync("shared/fixtures/health.json", "utf8")) as HealthResponse;
    expect(Object.keys(body).sort()).toEqual(Object.keys(fixture).sort());
    expect(body.ok).toBe(true);
    expect(typeof body.version).toBe("string");
  });

  it("returns JSON 404 for unknown API routes", async () => {
    const res = await fetch(`${base}/api/nope`);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("application/json");
  });

  it("serves the SPA for non-API routes", async () => {
    const res = await fetch(`${base}/some/client/route`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<div id="root">');
  });
});
