// Wire contract: source of truth for server, web, and (mirrored) Swift Codable.

/** GET /api/health — unauthenticated liveness probe. */
export interface HealthResponse {
  ok: true;
  version: string;
}
