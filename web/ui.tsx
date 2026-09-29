import type { LlmChoice, LlmRouteRef } from "../shared/api.js";

export function ErrorLine({ error }: { error: string | null }) {
  return error ? <p className="error">{error}</p> : null;
}

export const routeKey = (r: LlmRouteRef) => JSON.stringify([r.provider, r.model]);

export const routeLabel = (c: LlmChoice) => `${c.provider} · ${c.model}${c.isDefault ? " (default)" : ""}`;
