import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, watchFile } from "node:fs";
import { resolve } from "node:path";
import { createApp } from "./app.js";
import { CONFIG_PATH, loadConfig } from "./config.js";
import { serveStatic } from "./static.js";

// One port for UI + /api. --dev: Vite middleware (HMR). Prod: prebuilt dist/web.
const DEV = process.argv.includes("--dev");
let config = loadConfig();
const PORT = config.server.port;
const WEB_DIST = resolve(process.cwd(), "dist/web");
const DATA_DIR = resolve(process.cwd(), "data");
const VERSION = (JSON.parse(readFileSync("package.json", "utf8")) as { version: string }).version;

// Enabling a user = editing config.json; pick it up live. Polling survives editors' atomic renames.
watchFile(CONFIG_PATH, { interval: 2000 }, () => {
  try {
    config = loadConfig();
    console.log(`config.json reloaded (${config.users.length} enabled users).`);
  } catch (err) {
    console.error(`config.json reload failed, keeping previous config:\n${(err as Error).message}`);
  }
});

const app = createApp({ dataDir: DATA_DIR, getConfig: () => config, version: VERSION });

type Middleware = (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => void;
let viteMiddlewares: Middleware | undefined;

const server = createServer((req, res) => {
  const url = req.url ?? "/";
  if (url.startsWith("/api/")) return void app.handleApi(req, res);
  if (viteMiddlewares) {
    viteMiddlewares(req, res, () => {
      res.statusCode = 404;
      res.end("Not found");
    });
    return;
  }
  serveStatic(WEB_DIST, url, res);
});

if (DEV) {
  const { createServer: createViteServer } = await import("vite");
  const vite = await createViteServer({
    server: { middlewareMode: true, hmr: { server } },
    appType: "spa",
  });
  viteMiddlewares = vite.middlewares as unknown as Middleware;
}

// Port collision = a stale server still serving old code; fail loudly.
server.on("error", (err: NodeJS.ErrnoException) => {
  console.error(err.code === "EADDRINUSE" ? `Port ${PORT} already in use; stop the other server first.` : err);
  process.exit(1);
});

// A handler bug must not take down ingest; log and keep serving.
process.on("uncaughtException", (err) => console.error("Uncaught exception (kept alive):", err));
process.on("unhandledRejection", (err) => console.error("Unhandled rejection (kept alive):", err));

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    server.close();
    await app.close();
    console.log(`personal-assistant stopped (${sig}).`);
    process.exit(0);
  });
}

server.listen(PORT, () => {
  console.log(`personal-assistant ${DEV ? "(dev) " : ""}listening on http://localhost:${PORT}`);
});
