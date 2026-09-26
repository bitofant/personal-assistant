import type { JobState } from "../shared/api.js";
import { formatDateTime } from "../shared/format.js";

// Pure: what the summary panel shows for a job state. Tested; the component only renders it.

export type SummaryTone = "info" | "warn" | "error";

export interface SummaryStatusView {
  /** null = nothing to say (done, or never queued with no summary → just the button). */
  message: string | null;
  tone: SummaryTone;
  /** Job still going: poll, disable the button. */
  inProgress: boolean;
  /** Poll interval while in progress; null = don't poll. */
  pollMs: number | null;
  action: "Summarize" | "Re-summarize" | "Retry";
}

export const POLL_ACTIVE_MS = 2_000;
/** Waiting out a backoff (LLM down): no point polling fast. */
export const POLL_WAITING_MS = 15_000;

export function summaryStatusView(job: JobState | null, hasSummary: boolean, timeZone?: string): SummaryStatusView {
  const idle = hasSummary ? "Re-summarize" : "Summarize";
  if (!job) return { message: hasSummary ? null : "No summary yet.", tone: "info", inProgress: false, pollMs: null, action: idle };
  const verb = hasSummary ? "Updating summary" : "Generating summary";
  switch (job.status) {
    case "running":
      return { message: `${verb}…`, tone: "info", inProgress: true, pollMs: POLL_ACTIVE_MS, action: idle };
    case "queued":
      if (!job.lastError) return { message: `${verb}: queued…`, tone: "info", inProgress: true, pollMs: POLL_ACTIVE_MS, action: idle };
      // A queued job with an error = waiting out an outage/backoff; it will retry by itself.
      return {
        message: `${verb}: waiting to retry (attempt ${job.attempts} failed: ${job.lastError}). Next attempt ${formatDateTime(job.nextAttemptAt, timeZone)}.`,
        tone: "warn",
        inProgress: true,
        pollMs: POLL_WAITING_MS,
        action: idle,
      };
    case "failed":
      return {
        message: `Summary failed after ${job.attempts} attempts: ${job.lastError ?? "unknown error"}`,
        tone: "error",
        inProgress: false,
        pollMs: null,
        action: "Retry",
      };
    case "done":
      return { message: null, tone: "info", inProgress: false, pollMs: null, action: idle };
  }
}
