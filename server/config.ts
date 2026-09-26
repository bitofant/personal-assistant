import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { resolve } from "node:path";
import type { LlmTaskName } from "../shared/api.js";

// All config lives in gitignored config.json; no env vars by design.

export interface LlmProvider {
  id: string;
  /** OpenAI-compatible base, e.g. http://localhost:8000/v1 */
  baseUrl: string;
  apiKey: string | null;
  models: string[];
}

export interface LlmRoute {
  provider: string;
  model: string;
  /** Model's context window (prompt + reply); null = unknown → try whole transcript, chunk only on overflow. */
  contextTokens: number | null;
}

/** Below this, prompt overhead + reply leave no room for transcript. */
export const MIN_CONTEXT_TOKENS = 4096;

// Wire type is the source of truth; `satisfies` keeps this list from drifting.
export const LLM_TASKS = ["summary", "search", "embed"] as const satisfies readonly LlmTaskName[];
export type LlmTask = LlmTaskName;

export interface Config {
  /** host = IP literal to bind; default loopback (reverse proxy / tunnel in front). Restart to apply. */
  server: { host: string; port: number };
  /** Usernames allowed to log in; registered accounts stay disabled until listed. */
  users: string[];
  llm: {
    providers: LlmProvider[];
    /** Non-empty; first = default, others = user-selectable alternatives. Unrouted task = feature disabled (fail safe), not an error. */
    tasks: Partial<Record<LlmTask, LlmRoute[]>>;
  };
  /** `npm run backup` (systemd timer): snapshots of data/*.db. dir relative to the repo; keep = newest N snapshots. */
  backup: { dir: string; keep: number };
}

export const DEFAULT_PORT = 4200;
// Loopback: plain HTTP must never be reachable from the LAN by default.
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_BACKUP = { dir: "data/backups", keep: 14 } as const;
export const CONFIG_PATH = resolve(process.cwd(), "config.json");

/** Validate + normalize parsed config.json. Throws with a readable message. */
export function parseConfig(raw: unknown): Config {
  const errors: string[] = [];
  const obj = isRecord(raw) ? raw : (errors.push("root must be an object"), {});

  const server = isRecord(obj.server) ? obj.server : {};
  const port = server.port ?? DEFAULT_PORT;
  if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535)
    errors.push("server.port must be an integer 1-65535");
  // IP literal only: a hostname like "localhost" may resolve to ::1 or 127.0.0.1 → ambiguous bind.
  const host = typeof server.host === "string" ? server.host.trim().toLowerCase() : server.host ?? DEFAULT_HOST;
  if (typeof host !== "string" || isIP(host) === 0)
    errors.push('server.host must be an IP address, e.g. "127.0.0.1", "172.17.0.1" or "0.0.0.0" (no hostnames, no [brackets])');

  const users: string[] = [];
  if (obj.users !== undefined && !Array.isArray(obj.users))
    errors.push("users must be an array of strings");
  for (const u of Array.isArray(obj.users) ? obj.users : []) {
    if (typeof u !== "string" || !u.trim()) errors.push("users entries must be non-empty strings");
    // Canonical usernames: trimmed, lowercase.
    else users.push(u.trim().toLowerCase());
  }

  const llm = isRecord(obj.llm) ? obj.llm : {};
  const providers: LlmProvider[] = [];
  for (const [i, p] of (Array.isArray(llm.providers) ? llm.providers : []).entries()) {
    const at = `llm.providers[${i}]`;
    if (!isRecord(p)) { errors.push(`${at} must be an object`); continue; }
    if (typeof p.id !== "string" || !p.id) errors.push(`${at}.id required`);
    else if (providers.some((q) => q.id === p.id)) errors.push(`${at}.id "${p.id}" duplicated`);
    if (typeof p.baseUrl !== "string" || !/^https?:\/\//.test(p.baseUrl))
      errors.push(`${at}.baseUrl must be an http(s) URL`);
    if (p.apiKey != null && typeof p.apiKey !== "string") errors.push(`${at}.apiKey must be a string`);
    const models = Array.isArray(p.models) ? p.models.filter((m) => typeof m === "string") : [];
    providers.push({
      id: String(p.id ?? ""),
      baseUrl: String(p.baseUrl ?? "").replace(/\/+$/, ""),
      apiKey: typeof p.apiKey === "string" && p.apiKey ? p.apiKey : null,
      models,
    });
  }

  const tasks: Config["llm"]["tasks"] = {};
  const rawTasks = isRecord(llm.tasks) ? llm.tasks : {};
  for (const key of Object.keys(rawTasks)) {
    const at = `llm.tasks.${key}`;
    if (!(LLM_TASKS as readonly string[]).includes(key)) { errors.push(`${at}: unknown task`); continue; }
    // Single route or list (first = default); normalized to a list.
    const list = Array.isArray(rawTasks[key]) ? (rawTasks[key] as unknown[]) : [rawTasks[key]];
    if (!list.length) { errors.push(`${at} must not be empty`); continue; }
    const routes: LlmRoute[] = [];
    for (const [i, r] of list.entries()) {
      const rat = Array.isArray(rawTasks[key]) ? `${at}[${i}]` : at;
      if (!isRecord(r) || typeof r.provider !== "string" || typeof r.model !== "string" || !r.model) {
        errors.push(`${rat} must be {provider, model}`);
        continue;
      }
      if (!providers.some((p) => p.id === r.provider))
        errors.push(`${rat}.provider "${r.provider}" not in llm.providers`);
      if (routes.some((q) => q.provider === r.provider && q.model === r.model))
        errors.push(`${rat} duplicated`);
      const ctx = r.contextTokens ?? null;
      if (ctx !== null && (!Number.isInteger(ctx) || (ctx as number) < MIN_CONTEXT_TOKENS))
        errors.push(`${rat}.contextTokens must be an integer ≥ ${MIN_CONTEXT_TOKENS}`);
      routes.push({ provider: r.provider, model: r.model, contextTokens: (ctx as number | null) });
    }
    tasks[key as LlmTask] = routes;
  }

  const rawBackup = isRecord(obj.backup) ? obj.backup : {};
  if (obj.backup !== undefined && !isRecord(obj.backup)) errors.push("backup must be an object");
  const backupDir = rawBackup.dir ?? DEFAULT_BACKUP.dir;
  if (typeof backupDir !== "string" || !backupDir.trim()) errors.push("backup.dir must be a non-empty string");
  const keep = rawBackup.keep ?? DEFAULT_BACKUP.keep;
  if (!Number.isInteger(keep) || (keep as number) < 1) errors.push("backup.keep must be an integer ≥ 1");

  if (errors.length) throw new Error(`Invalid config.json:\n  - ${errors.join("\n  - ")}`);
  return {
    server: { host: host as string, port: port as number },
    users,
    llm: { providers, tasks },
    backup: { dir: (backupDir as string).trim(), keep: keep as number },
  };
}

const WILDCARDS = new Set(["0.0.0.0", "::"]);

/** Bound on every interface → reachable from the network. */
export function isWildcardHost(host: string): boolean {
  return WILDCARDS.has(host);
}

/** URL a local client (tests, logs) can connect to; wildcard binds are reachable via loopback. */
export function localUrl({ host, port }: Config["server"]): string {
  const h = isWildcardHost(host) ? "127.0.0.1" : host;
  return `http://${isIP(h) === 6 ? `[${h}]` : h}:${port}`;
}

export function loadConfig(path = CONFIG_PATH): Config {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(`config.json not found at ${path}. Run ./config-gen.sh to generate it.`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`config.json is not valid JSON: ${(err as Error).message}`);
  }
  return parseConfig(raw);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
