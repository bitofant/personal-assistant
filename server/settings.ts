import type { LlmChoice, LlmRouteRef } from "../shared/api.js";
import type { Db } from "./db.js";
import { HttpError, isRecord } from "./http.js";
import { sameRoute } from "./llm.js";

// Per-user settings: key/value JSON in the user's DB.

const SUMMARY_LLM = "summaryLlm";

/** Pure: `{provider, model}` or null; anything else = null (payloads/settings are untrusted). */
export function toRouteRef(v: unknown): LlmRouteRef | null {
  return isRecord(v) && typeof v.provider === "string" && typeof v.model === "string" ? { provider: v.provider, model: v.model } : null;
}

/** Request value must be null or one of the admin-configured choices. */
export function parseRouteChoice(v: unknown, choices: readonly LlmChoice[]): LlmRouteRef | null {
  if (v == null) return null;
  const ref = toRouteRef(v);
  if (!ref || !choices.some((c) => sameRoute(c, ref))) throw new HttpError(400, "llm must be one of the configured summary models.");
  return ref;
}

/** Stored pick, only while still offered (config may have changed): else null = default. */
export function effectiveChoice(stored: LlmRouteRef | null, choices: readonly LlmChoice[]): LlmRouteRef | null {
  return stored && choices.some((c) => sameRoute(c, stored)) ? stored : null;
}

export function getSummaryLlm(db: Db): LlmRouteRef | null {
  const r = db.prepare("SELECT value FROM settings WHERE key = ?").get(SUMMARY_LLM) as { value: string } | undefined;
  return r ? toRouteRef(JSON.parse(r.value)) : null;
}

export function setSummaryLlm(db: Db, ref: LlmRouteRef | null): void {
  if (!ref) db.prepare("DELETE FROM settings WHERE key = ?").run(SUMMARY_LLM);
  else
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(
      SUMMARY_LLM,
      JSON.stringify(ref),
    );
}
