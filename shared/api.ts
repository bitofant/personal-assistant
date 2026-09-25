// Wire contract: source of truth for server, web, and (mirrored) Swift Codable.
// Timestamps = ISO 8601 UTC strings. Unknown values = null, never "" or 0.

/** Error body for every non-2xx /api response. */
export interface ErrorResponse {
  message: string;
}

/** GET /api/health — unauthenticated liveness probe. */
export interface HealthResponse {
  ok: true;
  version: string;
}

// ---- Web auth (cookie session) ----

/** POST /api/auth/signup, POST /api/auth/login */
export interface Credentials {
  username: string;
  password: string;
}

/** GET /api/auth/me, POST /api/auth/login */
export interface MeResponse {
  username: string;
}

/** POST /api/auth/signup → 201. Session cookie set only if enabled. */
export interface SignupResponse {
  username: string;
  /** false = admin must add username to config.json `users` before login works. */
  enabled: boolean;
}

// ---- Device pairing ----

/** POST /api/devices/pair, header `Authorization: Bearer <client-generated token>`. */
export interface PairRequest {
  account: string;
  deviceName: string;
}

export type DeviceStatus = "pending" | "active";

/** POST /api/devices/pair → 202. Show `pairingCode` on the Mac; user types it in the web UI to approve. */
export interface PairResponse {
  deviceId: string;
  status: DeviceStatus;
  /** null once active. */
  pairingCode: string | null;
  /** When a pending pairing lapses; null once active. */
  expiresAt: string | null;
}

/** GET /api/device/me (bearer) — works for pending devices too, so the client can poll for approval. */
export interface DeviceMeResponse {
  deviceId: string;
  account: string;
  deviceName: string;
  status: DeviceStatus;
}

/** GET /api/devices (web) */
export interface DeviceInfo {
  id: string;
  name: string;
  status: DeviceStatus;
  createdAt: string;
  approvedAt: string | null;
  lastUsedAt: string | null;
  /** Pending only. */
  expiresAt: string | null;
}

export interface DeviceListResponse {
  devices: DeviceInfo[];
}

/** POST /api/devices/:id/approve (web) — code as shown on the Mac. */
export interface ApproveDeviceRequest {
  pairingCode: string;
}

// ---- Transcripts ----

export interface Person {
  name: string | null;
  /** Normalized lowercase by the server. */
  email: string | null;
}

/** Calendar event the recording belongs to; null on the upload = ad-hoc call. */
export interface MeetingMeta {
  calendarName: string | null;
  eventId: string | null;
  /** Recurring series id; drives per-series summary instructions. */
  seriesId: string | null;
  title: string | null;
  start: string;
  end: string;
  organizer: Person | null;
  attendees: Person[];
}

export interface TranscriptSegment {
  /** Seconds since recording start. */
  start: number;
  end: number;
  /** Diarization label or resolved name; null = unknown. */
  speaker: string | null;
  text: string;
}

/** POST /api/device/transcripts (bearer). Idempotent on `id`: re-upload replaces. */
export interface TranscriptUpload {
  /** Client-generated UUID. */
  id: string;
  /** Recording window. */
  startedAt: string;
  endedAt: string;
  meeting: MeetingMeta | null;
  segments: TranscriptSegment[];
  asrModel: string;
  diarizationModel: string | null;
}

/** POST /api/device/transcripts → 201 created / 200 replaced. */
export interface TranscriptUploadResponse {
  id: string;
  created: boolean;
}

/** GET /api/transcripts (web) list item. */
export interface TranscriptListItem {
  id: string;
  title: string | null;
  startedAt: string;
  endedAt: string;
  calendarName: string | null;
  attendeeCount: number | null;
  segmentCount: number;
  /** null if the device was since revoked. */
  deviceName: string | null;
}

export interface TranscriptListResponse {
  transcripts: TranscriptListItem[];
}

/** GET /api/transcripts/:id (web) */
export interface TranscriptDetail extends TranscriptUpload {
  deviceId: string;
  deviceName: string | null;
  receivedAt: string;
  updatedAt: string;
}
