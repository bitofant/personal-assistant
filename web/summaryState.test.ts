import { describe, expect, it } from "vitest";
import type { JobState } from "../shared/api.js";
import { POLL_ACTIVE_MS, POLL_WAITING_MS, summaryStatusView } from "./summaryState.js";

const job = (over: Partial<JobState>): JobState => ({ status: "queued", attempts: 0, lastError: null, nextAttemptAt: null, ...over });

describe("summaryStatusView", () => {
  it("never queued: prompt to summarize; with a summary: nothing to say", () => {
    expect(summaryStatusView(null, false)).toMatchObject({ message: "No summary yet.", inProgress: false, pollMs: null, action: "Summarize" });
    expect(summaryStatusView(null, true)).toMatchObject({ message: null, action: "Re-summarize" });
  });

  it("queued / running: in progress, fast poll; wording depends on existing summary", () => {
    expect(summaryStatusView(job({}), false)).toMatchObject({ message: "Generating summary: queued…", tone: "info", inProgress: true, pollMs: POLL_ACTIVE_MS });
    expect(summaryStatusView(job({ status: "running", attempts: 1 }), false).message).toBe("Generating summary…");
    expect(summaryStatusView(job({ status: "running", attempts: 1 }), true).message).toBe("Updating summary…");
  });

  it("queued after a failed attempt (LLM down): warn, slow poll, shows error + next attempt", () => {
    const v = summaryStatusView(job({ attempts: 2, lastError: "local /chat/completions: ECONNREFUSED", nextAttemptAt: "2026-09-25T10:01:00.000Z" }), false, "UTC");
    expect(v).toMatchObject({ tone: "warn", inProgress: true, pollMs: POLL_WAITING_MS });
    expect(v.message).toBe("Generating summary: waiting to retry (attempt 2 failed: local /chat/completions: ECONNREFUSED). Next attempt 2026-09-25 10:01.");
  });

  it("failed: error, no poll, Retry", () => {
    expect(summaryStatusView(job({ status: "failed", attempts: 5, lastError: "empty summary" }), true)).toEqual({
      message: "Summary failed after 5 attempts: empty summary",
      tone: "error",
      inProgress: false,
      pollMs: null,
      action: "Retry",
    });
  });

  it("done: quiet", () => {
    expect(summaryStatusView(job({ status: "done", attempts: 1 }), true)).toMatchObject({ message: null, inProgress: false, pollMs: null, action: "Re-summarize" });
  });
});
