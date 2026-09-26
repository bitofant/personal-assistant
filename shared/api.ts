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
  /** Latest stored summary; may be stale while a re-summarize is queued. */
  summary: TranscriptSummary | null;
  /** null = never queued (e.g. uploaded before summaries existed). */
  summaryJob: JobState | null;
}

// ---- Summaries ----

/** Rule-based: 2 attendees = 1on1; calendar event = meeting; no event = adhoc. */
export type MeetingType = "1on1" | "meeting" | "adhoc";

export interface TranscriptSummary {
  /** Markdown. */
  text: string;
  meetingType: MeetingType;
  /** Which instructions produced it, e.g. "builtin:1on1"; most specific wins. */
  instructionsSource: string;
  provider: string;
  model: string;
  createdAt: string;
  /** Transcript was re-uploaded after this summary was made. */
  stale: boolean;
}

export type JobStatus = "queued" | "running" | "done" | "failed";

export interface JobState {
  status: JobStatus;
  attempts: number;
  /** Last failure (outage or error); null once done. */
  lastError: string | null;
  /** When a queued job is due; null unless queued. */
  nextAttemptAt: string | null;
}

/** GET /api/transcripts/:id/summary (web): cheap poll target while a summary is generating. */
export interface TranscriptSummaryResponse {
  summary: TranscriptSummary | null;
  summaryJob: JobState | null;
}

/** POST /api/transcripts/:id/summarize (web, body `{}`) → 202. Re-runs even if a summary exists. */
export interface SummarizeResponse {
  summaryJob: JobState;
}

// ---- LLM ----

export type LlmTaskName = "summary" | "search" | "embed";

/** One routed task's reachability; unrouted task = ok false, provider/model null. */
export interface LlmTaskStatus {
  task: LlmTaskName;
  ok: boolean;
  provider: string | null;
  model: string | null;
  /** Model id present in provider `/models`; null = provider unreachable. */
  modelListed: boolean | null;
  error: string | null;
}

/** GET /api/llm/status (web session). */
export interface LlmStatusResponse {
  tasks: LlmTaskStatus[];
}
