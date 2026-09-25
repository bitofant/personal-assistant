import { randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { DeviceInfo, DeviceMeResponse, DeviceStatus, PairResponse } from "../shared/api.js";
import type { User } from "./auth.js";
import { normalizeUsername, sha256 } from "./auth.js";
import type { Store } from "./db.js";
import { bearerToken, HttpError, isRecord } from "./http.js";

export const PAIRING_TTL_MS = 15 * 60_000;
// Pairing is unauthenticated; cap pending rows per account so strangers can't flood it.
export const MAX_PENDING_PER_USER = 5;
export const MIN_TOKEN_LENGTH = 32;
const MAX_NAME = 100;

export interface Device {
  id: string;
  userId: number;
  username: string;
  name: string;
  status: DeviceStatus;
}

interface DeviceRow {
  id: string;
  user_id: number;
  name: string;
  status: DeviceStatus;
  pairing_code: string | null;
  created_at: number;
  expires_at: number | null;
  approved_at: number | null;
  last_used_at: number | null;
}

export function parsePairRequest(raw: unknown): { account: string; deviceName: string } {
  if (!isRecord(raw) || typeof raw.account !== "string" || typeof raw.deviceName !== "string")
    throw new HttpError(400, "account and deviceName required.");
  const deviceName = raw.deviceName.trim().slice(0, MAX_NAME);
  if (!deviceName) throw new HttpError(400, "deviceName must not be empty.");
  return { account: normalizeUsername(raw.account), deviceName };
}

export function validateDeviceToken(token: string | null): string {
  if (!token || token.length < MIN_TOKEN_LENGTH)
    throw new HttpError(401, `Bearer token required (min ${MIN_TOKEN_LENGTH} chars).`);
  return token;
}

/** 6 digits, zero-padded: easy to read off the Mac and type into the web UI. */
export function newPairingCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export function codesMatch(expected: string, given: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(given.replace(/\s+/g, ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

const iso = (ms: number | null) => (ms == null ? null : new Date(ms).toISOString());

export class Devices {
  constructor(
    private readonly store: Store,
    private readonly isEnabled: (username: string) => boolean,
    private readonly now: () => number = Date.now,
  ) {}

  private get db() {
    return this.store.app;
  }

  private dropExpired(): void {
    this.db.prepare("DELETE FROM devices WHERE status = 'pending' AND expires_at <= ?").run(this.now());
  }

  /** Unauthenticated. Re-pairing with the same token is idempotent (lets the client re-show the code). */
  pair(token: string | null, raw: unknown): PairResponse {
    const tok = validateDeviceToken(token);
    const { account, deviceName } = parsePairRequest(raw);
    this.dropExpired();
    const user = this.db.prepare("SELECT id FROM users WHERE username = ?").get(account) as { id: number } | undefined;
    if (!user) throw new HttpError(404, "Unknown account.");

    const existing = this.db.prepare("SELECT * FROM devices WHERE token_hash = ?").get(sha256(tok)) as DeviceRow | undefined;
    if (existing) {
      if (existing.user_id !== user.id) throw new HttpError(409, "Token already paired to another account.");
      return pairResponse(existing);
    }

    const now = this.now();
    const row: DeviceRow = {
      id: randomUUID(),
      user_id: user.id,
      name: deviceName,
      status: "pending",
      pairing_code: newPairingCode(),
      created_at: now,
      expires_at: now + PAIRING_TTL_MS,
      approved_at: null,
      last_used_at: null,
    };
    this.db.transaction(() => {
      // Evict oldest pending beyond the cap rather than refusing: the real user's retry always wins.
      this.db
        .prepare(
          `DELETE FROM devices WHERE id IN (SELECT id FROM devices WHERE user_id = ? AND status = 'pending'
           ORDER BY created_at DESC LIMIT -1 OFFSET ?)`,
        )
        .run(user.id, MAX_PENDING_PER_USER - 1);
      this.db
        .prepare(
          `INSERT INTO devices (id, user_id, name, token_hash, status, pairing_code, created_at, expires_at)
           VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
        )
        .run(row.id, row.user_id, row.name, sha256(tok), row.pairing_code, row.created_at, row.expires_at);
    })();
    return pairResponse(row);
  }

  /** Bearer-authenticated device, pending or active; null = unknown/revoked token or disabled account. */
  authedDevice(req: IncomingMessage): Device | null {
    const token = bearerToken(req);
    if (!token) return null;
    const row = this.db
      .prepare(
        `SELECT d.id, d.user_id, d.name, d.status, d.expires_at, u.username FROM devices d
         JOIN users u ON u.id = d.user_id WHERE d.token_hash = ?`,
      )
      .get(sha256(token)) as (DeviceRow & { username: string }) | undefined;
    if (!row) return null;
    if (row.status === "pending" && (row.expires_at ?? 0) <= this.now()) return null;
    if (!this.isEnabled(row.username)) return null;
    return { id: row.id, userId: row.user_id, username: row.username, name: row.name, status: row.status };
  }

  /** Device API gate: active devices only; touches last_used_at. */
  requireActive(req: IncomingMessage): Device {
    const d = this.authedDevice(req);
    if (!d) throw new HttpError(401, "Unknown or revoked device token.");
    if (d.status !== "active") throw new HttpError(403, "Device pairing not approved yet.");
    this.db.prepare("UPDATE devices SET last_used_at = ? WHERE id = ?").run(this.now(), d.id);
    return d;
  }

  me(req: IncomingMessage): DeviceMeResponse {
    const d = this.authedDevice(req);
    if (!d) throw new HttpError(401, "Unknown or revoked device token.");
    return { deviceId: d.id, account: d.username, deviceName: d.name, status: d.status };
  }

  list(user: User): DeviceInfo[] {
    this.dropExpired();
    const rows = this.db
      .prepare("SELECT * FROM devices WHERE user_id = ? ORDER BY created_at DESC")
      .all(user.id) as DeviceRow[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      createdAt: iso(r.created_at)!,
      approvedAt: iso(r.approved_at),
      lastUsedAt: iso(r.last_used_at),
      expiresAt: r.status === "pending" ? iso(r.expires_at) : null,
    }));
  }

  approve(user: User, deviceId: string, raw: unknown): void {
    if (!isRecord(raw) || typeof raw.pairingCode !== "string") throw new HttpError(400, "pairingCode required.");
    this.dropExpired();
    const row = this.db
      .prepare("SELECT * FROM devices WHERE id = ? AND user_id = ?")
      .get(deviceId, user.id) as DeviceRow | undefined;
    if (!row) throw new HttpError(404, "No such device (pairing may have expired).");
    if (row.status === "active") return;
    // Wrong code burns the pairing: no brute-forcing 6 digits.
    if (!codesMatch(row.pairing_code ?? "", raw.pairingCode)) {
      this.db.prepare("DELETE FROM devices WHERE id = ?").run(row.id);
      throw new HttpError(403, "Wrong pairing code. Pairing cancelled; pair again from the Mac.");
    }
    this.db
      .prepare("UPDATE devices SET status = 'active', pairing_code = NULL, expires_at = NULL, approved_at = ? WHERE id = ?")
      .run(this.now(), row.id);
  }

  /** Revoke active or reject pending. */
  remove(user: User, deviceId: string): void {
    const res = this.db.prepare("DELETE FROM devices WHERE id = ? AND user_id = ?").run(deviceId, user.id);
    if (res.changes === 0) throw new HttpError(404, "No such device.");
  }

  /** Name lookup for display; null if revoked since. */
  names(userId: number): Map<string, string> {
    const rows = this.db.prepare("SELECT id, name FROM devices WHERE user_id = ?").all(userId) as { id: string; name: string }[];
    return new Map(rows.map((r) => [r.id, r.name]));
  }
}

function pairResponse(r: DeviceRow): PairResponse {
  const pending = r.status === "pending";
  return {
    deviceId: r.id,
    status: r.status,
    pairingCode: pending ? r.pairing_code : null,
    expiresAt: pending ? iso(r.expires_at) : null,
  };
}
