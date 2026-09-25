import { useEffect, useState } from "react";
import type { HealthResponse } from "../shared/api.js";

export function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => (r.ok ? (r.json() as Promise<HealthResponse>) : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setHealth, (e: Error) => setError(e.message));
  }, []);

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
      <h1>personal-assistant</h1>
      <p>Server: {error ? `unreachable (${error})` : health ? `ok, v${health.version}` : "—"}</p>
    </main>
  );
}
