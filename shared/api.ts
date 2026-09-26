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

/** Descriptions + built-in instructions: `shared/instructions.ts`. */
export type MeetingType = "1on1" | "standup" | "interview" | "external" | "meeting" | "adhoc";

/** rule = metadata/title; llm = classified by the LLM; fallback = LLM gave no usable answer → "meeting". */
export type MeetingTypeSource = "rule" | "llm" | "fallback";

export interface TranscriptSummary {
  /** Markdown. */
  text: string;
  meetingType: MeetingType;
  /** null = summary made before this was recorded. */
  meetingTypeSource: MeetingTypeSource | null;
  /** Which instructions produced it: "series:<id>" | "type:<type>" | "default" | "builtin:<type>". */
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

/** POST /api/transcripts/:id/summarize (web) → 202. Re-runs even if a summary exists. */
export interface SummarizeRequest {
  /** One-off model for this run; must be one of `summaryLlmChoices`. Omitted/null = user setting. */
  llm?: LlmRouteRef | null;
}

export interface SummarizeResponse {
  summaryJob: JobState;
}

// ---- Custom summary instructions ----

/** default: key "" · type: key = MeetingType · series: key = MeetingMeta.seriesId. */
export type InstructionScope = "default" | "type" | "series";

export interface CustomInstruction {
  scope: InstructionScope;
  key: string;
  text: string;
  updatedAt: string;
}

/** Recurring series seen in the user's transcripts (offered for per-series instructions). */
export interface SeriesInfo {
  seriesId: string;
  /** Title of the latest occurrence. */
  title: string | null;
  count: number;
  lastStartedAt: string;
}

/** GET /api/instructions */
export interface InstructionsResponse {
  custom: CustomInstruction[];
  series: SeriesInfo[];
}

/** PUT /api/instructions/default | /type/:type | /series/:seriesId → 200 CustomInstruction. DELETE same paths → 204. */
export interface PutInstructionRequest {
  text: string;
}

// ---- User settings ----

export interface LlmRouteRef {
  provider: string;
  model: string;
}

export interface LlmChoice extends LlmRouteRef {
  /** Server default (first route in config `llm.tasks.summary`). */
  isDefault: boolean;
}

/** GET /api/settings, PUT /api/settings → 200. */
export interface SettingsResponse {
  /** Model for summaries; null = server default (also when the saved pick was removed from config). */
  summaryLlm: LlmRouteRef | null;
  /** Admin-configured options; empty = summaries not configured. */
  summaryLlmChoices: LlmChoice[];
}

/** PUT /api/settings */
export interface SettingsRequest {
  summaryLlm: LlmRouteRef | null;
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
