import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import { Auth, hashPassword, parseCredentials, SESSION_COOKIE, SESSION_TTL_MS, verifyPassword } from "./auth.js";
import { parseConfig, type Config } from "./config.js";
import { Store } from "./db.js";

describe("parseCredentials", () => {
  it("normalizes username", () => {
    expect(parseCredentials({ username: "  Alice ", password: "x" })).toEqual({ username: "alice", password: "x" });
  });
  it("rejects bad usernames and missing fields", () => {
    expect(() => parseCredentials({ username: "a/b", password: "x" })).toThrow(/Username/);
    expect(() => parseCredentials({ username: "../x", password: "x" })).toThrow(/Username/);
    expect(() => parseCredentials({ username: "a" })).toThrow(/required/);
    expect(() => parseCredentials(null)).toThrow(/required/);
  });
});

describe("password hashing", () => {
  it("round-trips and rejects wrong/garbled input", async () => {
    const h = await hashPassword("correct horse");
    expect(h).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);
    expect(await verifyPassword("correct horse", h)).toBe(true);
    expect(await verifyPassword("wrong horse", h)).toBe(false);
    expect(await verifyPassword("correct horse", "garbage")).toBe(false);
  });
});

describe("Auth", () => {
  let dir: string;
  let store: Store;
  let config: Config;
  let t: number;
  let auth: Auth;
  const req = (token?: string) => ({ headers: { cookie: token ? `${SESSION_COOKIE}=${token}` : undefined } }) as IncomingMessage;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pa-auth-"));
    store = new Store(dir);
    config = parseConfig({ users: ["alice"] });
    t = 1_000_000;
    auth = new Auth(store, () => config, () => t);
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("signup reports enabled status; duplicate username refused case-insensitively", async () => {
    expect((await auth.signup({ username: "Alice", password: "password1" })).enabled).toBe(true);
    expect((await auth.signup({ username: "bob", password: "password1" })).enabled).toBe(false);
    await expect(auth.signup({ username: "ALICE", password: "password2" })).rejects.toMatchObject({ status: 409 });
    await expect(auth.signup({ username: "carol", password: "short" })).rejects.toMatchObject({ status: 400 });
  });

  it("login: 401 on bad creds / unknown user, 403 when disabled, session otherwise", async () => {
    await auth.signup({ username: "alice", password: "password1" });
    await auth.signup({ username: "bob", password: "password1" });
    await expect(auth.login({ username: "alice", password: "nope-nope" })).rejects.toMatchObject({ status: 401 });
    await expect(auth.login({ username: "zed", password: "password1" })).rejects.toMatchObject({ status: 401 });
    await expect(auth.login({ username: "bob", password: "password1" })).rejects.toMatchObject({ status: 403 });
    const { token } = await auth.login({ username: "alice", password: "password1" });
    expect(auth.authedUser(req(token))?.username).toBe("alice");
  });

  it("disabling a user in config revokes existing sessions immediately", async () => {
    await auth.signup({ username: "alice", password: "password1" });
    const { token } = await auth.login({ username: "alice", password: "password1" });
    config = parseConfig({ users: [] });
    expect(auth.authedUser(req(token))).toBeNull();
    config = parseConfig({ users: ["alice"] });
    expect(auth.authedUser(req(token))).not.toBeNull();
  });

  it("sessions expire, slide on use, and die on logout", async () => {
    await auth.signup({ username: "alice", password: "password1" });
    const { token } = await auth.login({ username: "alice", password: "password1" });
    expect(auth.authedUser(req("forged"))).toBeNull();
    t += SESSION_TTL_MS - 1000;
    expect(auth.authedUser(req(token))).not.toBeNull(); // slides
    t += SESSION_TTL_MS - 1000;
    expect(auth.authedUser(req(token))).not.toBeNull();
    t += SESSION_TTL_MS + 1;
    expect(auth.authedUser(req(token))).toBeNull();

    const { token: t2 } = await auth.login({ username: "alice", password: "password1" });
    auth.logout(req(t2));
    expect(auth.authedUser(req(t2))).toBeNull();
  });

  it("stores only token hashes", async () => {
    await auth.signup({ username: "alice", password: "password1" });
    const { token } = await auth.login({ username: "alice", password: "password1" });
    const rows = store.app.prepare("SELECT token_hash FROM sessions").all() as { token_hash: string }[];
    expect(rows.length).toBe(1);
    expect(rows[0].token_hash).not.toContain(token);
  });
});
