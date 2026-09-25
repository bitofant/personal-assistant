import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import { Auth, type User } from "./auth.js";
import { parseConfig, type Config } from "./config.js";
import { Store } from "./db.js";
import { codesMatch, Devices, MAX_PENDING_PER_USER, PAIRING_TTL_MS } from "./devices.js";

const TOKEN = "t".repeat(40);
const req = (token: string) => ({ headers: { authorization: `Bearer ${token}` } }) as IncomingMessage;

describe("codesMatch", () => {
  it("ignores whitespace, rejects different lengths", () => {
    expect(codesMatch("123456", "123 456")).toBe(true);
    expect(codesMatch("123456", "12345")).toBe(false);
    expect(codesMatch("123456", "123457")).toBe(false);
  });
});

describe("Devices", () => {
  let dir: string;
  let store: Store;
  let config: Config;
  let t: number;
  let devices: Devices;
  let alice: User;
  let bob: User;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "pa-dev-"));
    store = new Store(dir);
    config = parseConfig({ users: ["alice", "bob"] });
    t = 1_000_000;
    const auth = new Auth(store, () => config, () => t);
    alice = (await auth.signup({ username: "alice", password: "password1" })).user;
    bob = (await auth.signup({ username: "bob", password: "password1" })).user;
    devices = new Devices(store, (u) => auth.isEnabled(u), () => t);
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("pair → pending (no device API) → approve with code → active", () => {
    const p = devices.pair(TOKEN, { account: " Alice ", deviceName: "MacBook" });
    expect(p.status).toBe("pending");
    expect(p.pairingCode).toMatch(/^\d{6}$/);
    expect(devices.me(req(TOKEN)).status).toBe("pending");
    expect(() => devices.requireActive(req(TOKEN))).toThrow(/not approved/);

    devices.approve(alice, p.deviceId, { pairingCode: p.pairingCode });
    expect(devices.requireActive(req(TOKEN)).userId).toBe(alice.id);
    expect(devices.list(alice)[0]).toMatchObject({ status: "active", expiresAt: null });
    expect(devices.list(alice)[0].lastUsedAt).not.toBeNull();
  });

  it("re-pair with same token is idempotent; other account → 409", () => {
    const a = devices.pair(TOKEN, { account: "alice", deviceName: "Mac" });
    expect(devices.pair(TOKEN, { account: "alice", deviceName: "Mac" })).toEqual(a);
    expect(() => devices.pair(TOKEN, { account: "bob", deviceName: "Mac" })).toThrow(/another account/);
  });

  it("rejects short tokens and unknown accounts", () => {
    expect(() => devices.pair("short", { account: "alice", deviceName: "Mac" })).toThrow(/Bearer/);
    expect(() => devices.pair(null, { account: "alice", deviceName: "Mac" })).toThrow(/Bearer/);
    expect(() => devices.pair(TOKEN, { account: "zed", deviceName: "Mac" })).toThrow(/Unknown account/);
  });

  it("wrong code burns the pairing", () => {
    const p = devices.pair(TOKEN, { account: "alice", deviceName: "Mac" });
    const wrong = p.pairingCode === "000000" ? "111111" : "000000";
    expect(() => devices.approve(alice, p.deviceId, { pairingCode: wrong })).toThrow(/Wrong pairing code/);
    expect(devices.authedDevice(req(TOKEN))).toBeNull();
    expect(() => devices.approve(alice, p.deviceId, { pairingCode: p.pairingCode })).toThrow(/No such device/);
  });

  it("users can't approve/revoke/see each other's devices", () => {
    const p = devices.pair(TOKEN, { account: "alice", deviceName: "Mac" });
    expect(() => devices.approve(bob, p.deviceId, { pairingCode: p.pairingCode })).toThrow(/No such device/);
    expect(() => devices.remove(bob, p.deviceId)).toThrow(/No such device/);
    expect(devices.list(bob)).toEqual([]);
  });

  it("pending pairings expire; active ones don't", () => {
    const p = devices.pair(TOKEN, { account: "alice", deviceName: "Mac" });
    t += PAIRING_TTL_MS;
    expect(devices.authedDevice(req(TOKEN))).toBeNull();
    expect(() => devices.approve(alice, p.deviceId, { pairingCode: p.pairingCode })).toThrow(/No such device/);

    const q = devices.pair(TOKEN, { account: "alice", deviceName: "Mac" });
    devices.approve(alice, q.deviceId, { pairingCode: q.pairingCode });
    t += 100 * PAIRING_TTL_MS;
    expect(devices.requireActive(req(TOKEN)).id).toBe(q.deviceId);
  });

  it("caps pending per user, evicting oldest", () => {
    const ids = Array.from({ length: MAX_PENDING_PER_USER + 2 }, (_, i) => {
      t += 1;
      return devices.pair(`${i}`.padEnd(40, "x"), { account: "alice", deviceName: `d${i}` }).deviceId;
    });
    const listed = devices.list(alice).map((d) => d.id);
    expect(listed.length).toBe(MAX_PENDING_PER_USER);
    expect(listed).not.toContain(ids[0]);
    expect(listed).toContain(ids.at(-1));
  });

  it("revoke kills the token; disabled account's devices are refused", () => {
    const p = devices.pair(TOKEN, { account: "alice", deviceName: "Mac" });
    devices.approve(alice, p.deviceId, { pairingCode: p.pairingCode });
    config = parseConfig({ users: ["bob"] });
    expect(devices.authedDevice(req(TOKEN))).toBeNull();
    config = parseConfig({ users: ["alice"] });
    devices.remove(alice, p.deviceId);
    expect(devices.authedDevice(req(TOKEN))).toBeNull();
  });
});
