import type { LlmChoice, LlmRouteRef } from "../shared/api.js";

export function ErrorLine({ error }: { error: string | null }) {
  return error ? <p style={{ color: "crimson" }}>{error}</p> : null;
}

export const muted = { color: "#888", fontSize: "0.8rem" } as const;

export const routeKey = (r: LlmRouteRef) => JSON.stringify([r.provider, r.model]);

export const routeLabel = (c: LlmChoice) => `${c.provider} · ${c.model}${c.isDefault ? " (default)" : ""}`;
