import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Config } from "./config.js";
import type { Store } from "./db.js";
import { HttpError, isHttps, parseCookies } from "./http.js";

export interface User {
  id: number;
  username: string;
}

export const SESSION_COOKIE = "pa_session";
export const SESSION_TTL_MS = 30 * 24 * 3600_000;
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;
export const MIN_PASSWORD = 8;
const MAX_PASSWORD = 1024; // bound scrypt input

/** Canonical username (same rule as config.json `users`). */
export function normalizeUsername(u: string): string {
  return u.trim().toLowerCase();
}

/** Pure validation of signup/login payloads; returns normalized credentials. */
export function parseCredentials(raw: unknown): { username: string; password: string } {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  if (typeof r.username !== "string" || typeof r.password !== "string")
    throw new HttpError(400, "username and password required.");
  const username = normalizeUsername(r.username);
  if (!USERNAME_RE.test(username))
    throw new HttpError(400, "Username: 1-32 chars, a-z 0-9 . _ -, starting with a letter or digit.");
  if (r.password.length > MAX_PASSWORD) throw new HttpError(400, "Password too long.");
  return { username, password: r.password };
}

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 } as const;

function scryptAsync(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );
}

/** `salt:hash`, hex. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  return `${salt.toString("hex")}:${(await scryptAsync(password, salt)).toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = await scryptAsync(password, Buffer.from(saltHex, "hex"));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Tokens are stored hashed only; a DB leak doesn't leak live sessions/device tokens. */
export function sha256(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

// Burned on unknown-user logins so response time doesn't reveal which usernames exist.
const DUMMY_HASH = hashPassword("dummy-password-for-timing");

export class Auth {
  constructor(
    private readonly store: Store,
    private readonly getConfig: () => Config,
    private readonly now: () => number = Date.now,
  ) {}

  isEnabled(username: string): boolean {
    return this.getConfig().users.includes(username);
  }

  async signup(raw: unknown): Promise<{ user: User; enabled: boolean }> {
    const { username, password } = parseCredentials(raw);
    if (password.length < MIN_PASSWORD) throw new HttpError(400, `Password must be at least ${MIN_PASSWORD} characters.`);
    const hash = await hashPassword(password);
    const db = this.store.app;
    const res = db
      .prepare("INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?) ON CONFLICT(username) DO NOTHING")
      .run(username, hash, this.now());
    if (res.changes === 0) throw new HttpError(409, "Username already taken.");
    return { user: { id: Number(res.lastInsertRowid), username }, enabled: this.isEnabled(username) };
  }

  /** Returns a new session token. Disabled status revealed only after the password checks out. */
  async login(raw: unknown): Promise<{ user: User; token: string }> {
    const { username, password } = parseCredentials(raw);
    const row = this.store.app
      .prepare("SELECT id, password_hash FROM users WHERE username = ?")
      .get(username) as { id: number; password_hash: string } | undefined;
    const ok = await verifyPassword(password, row?.password_hash ?? (await DUMMY_HASH));
    if (!row || !ok) throw new HttpError(401, "Invalid username or password.");
    if (!this.isEnabled(username))
      throw new HttpError(403, "Account not enabled yet. Ask the admin to add it to config.json.");
    return { user: { id: row.id, username }, token: this.createSession(row.id) };
  }

  createSession(userId: number): string {
    const token = newToken();
    const now = this.now();
    this.store.app
      .prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .run(sha256(token), userId, now, now + SESSION_TTL_MS);
    return token;
  }

  logout(req: IncomingMessage): void {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) this.store.app.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
  }

  /** The only way the rest of the server learns who's calling (web). null = not logged in / disabled. */
  authedUser(req: IncomingMessage): User | null {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!token) return null;
    const now = this.now();
    const row = this.store.app
      .prepare(
        `SELECT u.id, u.username, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ?`,
      )
      .get(sha256(token)) as { id: number; username: string; expires_at: number } | undefined;
    if (!row || row.expires_at <= now) return null;
    // Re-checked per request: removing a user from config.json cuts them off immediately.
    if (!this.isEnabled(row.username)) return null;
    // Sliding expiry; only write when meaningfully stale to avoid a write per request.
    if (row.expires_at - now < SESSION_TTL_MS - 24 * 3600_000)
      this.store.app.prepare("UPDATE sessions SET expires_at = ? WHERE token_hash = ?").run(now + SESSION_TTL_MS, sha256(token));
    return { id: row.id, username: row.username };
  }

  requireUser(req: IncomingMessage): User {
    const user = this.authedUser(req);
    if (!user) throw new HttpError(401, "Not logged in.");
    return user;
  }

  pruneExpired(): void {
    this.store.app.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(this.now());
  }
}

export function sessionCookie(token: string, req: IncomingMessage): string {
  const secure = isHttps(req) ? "; Secure" : "";
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}${secure}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
