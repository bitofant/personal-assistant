import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import type {
  DeviceInfo,
  DeviceListResponse,
  MeResponse,
  SettingsResponse,
  SignupResponse,
  SummarizeResponse,
  TranscriptDetail,
  TranscriptListItem,
  TranscriptListResponse,
  TranscriptSummaryResponse,
} from "../shared/api.js";
import { formatDateTime, formatDuration, formatOffset, formatValue } from "../shared/format.js";
import { describeInstructionsSource, meetingTypeLabel } from "../shared/instructions.js";
import { renderMarkdown } from "../shared/markdown.js";
import { api, ApiError } from "./api.js";
import { SummarySettings } from "./Settings.js";
import { summaryStatusView, type SummaryTone } from "./summaryState.js";
import { ErrorLine, muted, routeKey, routeLabel } from "./ui.js";

function useHash(): string {
  const [hash, setHash] = useState(location.hash || "#/");
  useEffect(() => {
    const on = () => setHash(location.hash || "#/");
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return hash;
}

export function App() {
  const [me, setMe] = useState<MeResponse | null | undefined>(undefined);
  const hash = useHash();

  useEffect(() => {
    api<MeResponse>("/auth/me").then(setMe, () => setMe(null));
  }, []);

  if (me === undefined) return <Shell>Loading…</Shell>;
  if (me === null) return <Shell><Login onLogin={setMe} /></Shell>;

  const logout = () => api("/auth/logout", { method: "POST" }).finally(() => setMe(null));
  const detail = /^#\/t\/(.+)$/.exec(hash);
  return (
    <Shell>
      <nav style={{ display: "flex", gap: "1rem", alignItems: "baseline" }}>
        <a href="#/">Transcripts</a>
        <a href="#/settings">Summary settings</a>
        <a href="#/devices">Devices</a>
        <span style={{ marginLeft: "auto" }}>{me.username}</span>
        <button onClick={logout}>Log out</button>
      </nav>
      {hash === "#/devices" ? <Devices /> : hash === "#/settings" ? <SummarySettings /> : detail ? <Transcript id={detail[1]} /> : <Transcripts />}
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "1rem 2rem", maxWidth: "60rem", margin: "0 auto" }}>
      <h1 style={{ fontSize: "1.3rem" }}>personal-assistant</h1>
      {children}
    </main>
  );
}

function Login({ onLogin }: { onLogin: (me: MeResponse) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  const submit = (mode: "login" | "signup") => async (e?: FormEvent) => {
    e?.preventDefault();
    setMsg(null);
    try {
      if (mode === "login") return onLogin(await api<MeResponse>("/auth/login", { body: { username, password } }));
      const r = await api<SignupResponse>("/auth/signup", { body: { username, password } });
      if (r.enabled) onLogin({ username: r.username });
      else setMsg(`Account "${r.username}" created. Ask the admin to enable it in config.json, then log in.`);
    } catch (err) {
      setMsg((err as Error).message);
    }
  };

  return (
    <form onSubmit={submit("login")} style={{ display: "grid", gap: "0.5rem", maxWidth: "20rem" }}>
      <input placeholder="username" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
      <input placeholder="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      <div style={{ display: "flex", gap: "0.5rem" }}>
        <button type="submit">Log in</button>
        <button type="button" onClick={() => void submit("signup")()}>Sign up</button>
      </div>
      <ErrorLine error={msg} />
    </form>
  );
}

function Transcripts() {
  const [items, setItems] = useState<TranscriptListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<TranscriptListResponse>("/transcripts").then((r) => setItems(r.transcripts), (e: Error) => setError(e.message));
  }, []);

  if (error) return <ErrorLine error={error} />;
  if (!items) return <p>Loading…</p>;
  if (!items.length) return <p>No transcripts yet. Pair a Mac under <a href="#/devices">Devices</a>.</p>;
  return (
    <table style={{ width: "100%", borderCollapse: "collapse" }}>
      <thead>
        <tr style={{ textAlign: "left" }}>
          <th>When</th><th>Title</th><th>Duration</th><th>Attendees</th><th>Calendar</th><th>Device</th>
        </tr>
      </thead>
      <tbody>
        {items.map((t) => (
          <tr key={t.id}>
            <td>{formatDateTime(t.startedAt)}</td>
            <td><a href={`#/t/${t.id}`}>{t.title ?? "(ad-hoc call)"}</a></td>
            <td>{formatDuration(t.startedAt, t.endedAt)}</td>
            <td>{formatValue(t.attendeeCount)}</td>
            <td>{formatValue(t.calendarName)}</td>
            <td>{formatValue(t.deviceName)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Transcript({ id }: { id: string }) {
  const [t, setT] = useState<TranscriptDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<TranscriptDetail>(`/transcripts/${encodeURIComponent(id)}`).then(setT, (e: Error) => setError(e.message));
  }, [id]);

  if (error) return <ErrorLine error={error} />;
  if (!t) return <p>Loading…</p>;
  const m = t.meeting;
  return (
    <article>
      <h2>{m?.title ?? "(ad-hoc call)"}</h2>
      <p>
        {formatDateTime(t.startedAt)} · {formatDuration(t.startedAt, t.endedAt)} · calendar {formatValue(m?.calendarName)} · device{" "}
        {formatValue(t.deviceName)}
      </p>
      {m && m.attendees.length > 0 && (
        <p>Attendees: {m.attendees.map((a) => a.name ?? a.email).join(", ")}</p>
      )}
      <SummaryPanel key={t.id} transcriptId={t.id} initial={{ summary: t.summary, summaryJob: t.summaryJob }} />
      <h3>Transcript</h3>
      <div>
        {t.segments.map((s, i) => (
          <p key={i} style={{ margin: "0.3rem 0" }}>
            <span style={{ color: "#888", fontVariantNumeric: "tabular-nums" }}>{formatOffset(s.start)}</span>{" "}
            <strong>{formatValue(s.speaker)}:</strong> {s.text}
          </p>
        ))}
      </div>
      <p style={{ color: "#888", fontSize: "0.8rem" }}>
        ASR {t.asrModel} · diarization {formatValue(t.diarizationModel)} · received {formatDateTime(t.receivedAt)}
      </p>
    </article>
  );
}

const TONE_COLOR: Record<SummaryTone, string> = { info: "#555", warn: "#a15c00", error: "crimson" };

function SummaryPanel({ transcriptId, initial }: { transcriptId: string; initial: TranscriptSummaryResponse }) {
  const [state, setState] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const { summary, summaryJob } = state;
  const view = summaryStatusView(summaryJob, summary !== null);
  const html = useMemo(() => (summary ? renderMarkdown(summary.text) : ""), [summary]);
  const path = `/transcripts/${encodeURIComponent(transcriptId)}`;
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  useEffect(() => {
    api<SettingsResponse>("/settings").then(setSettings, () => setSettings(null));
  }, []);
  const choices = settings?.summaryLlmChoices ?? [];
  const current = settings && (settings.summaryLlm ?? choices.find((c) => c.isDefault) ?? null);
  const picked = choices.find((c) => routeKey(c) === (pick ?? (current && routeKey(current))));

  // Poll the cheap summary endpoint only while the job is still going.
  useEffect(() => {
    if (view.pollMs === null) return;
    const timer = setTimeout(() => {
      api<TranscriptSummaryResponse>(`${path}/summary`).then(
        (r) => (setState(r), setError(null)),
        // Keep polling on a blip; a changed-but-equal state object re-arms this effect.
        (e: Error) => (setError(e.message), setState((s) => ({ ...s }))),
      );
    }, view.pollMs);
    return () => clearTimeout(timer);
  }, [state, view.pollMs, path]);

  const summarize = () =>
    api<SummarizeResponse>(`${path}/summarize`, { body: picked ? { llm: { provider: picked.provider, model: picked.model } } : {} }).then(
      (r) => (setState((s) => ({ ...s, summaryJob: r.summaryJob })), setError(null)),
      (e: Error) => setError(e.message),
    );

  return (
    <section style={{ border: "1px solid #ddd", borderRadius: 6, padding: "0.5rem 1rem", margin: "1rem 0" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: "1rem" }}>
        <h3 style={{ margin: "0.5rem 0" }}>Summary</h3>
        <span style={{ marginLeft: "auto" }} />
        {choices.length > 1 && picked && (
          <select aria-label="Model" value={routeKey(picked)} onChange={(e) => setPick(e.target.value)} disabled={view.inProgress}>
            {choices.map((c) => (
              <option key={routeKey(c)} value={routeKey(c)}>
                {routeLabel(c)}
              </option>
            ))}
          </select>
        )}
        <button disabled={view.inProgress} onClick={() => void summarize()}>
          {view.action}
        </button>
      </div>
      {view.message && (
        <p role="status" style={{ color: TONE_COLOR[view.tone] }}>
          {view.inProgress && view.tone === "info" && "⏳ "}
          {view.message}
        </p>
      )}
      <ErrorLine error={error} />
      {summary && (
        <>
          {summary.stale && !view.inProgress && (
            <p style={{ color: TONE_COLOR.warn }}>The transcript changed after this summary was made.</p>
          )}
          <div className="summary" style={{ opacity: view.inProgress ? 0.6 : 1 }} dangerouslySetInnerHTML={{ __html: html }} />
          <p style={muted}>
            {meetingTypeLabel(summary.meetingType)}
            {summary.meetingTypeSource === "llm" && " (detected by LLM)"}
            {summary.meetingTypeSource === "fallback" && " (type not detected)"} · {summary.provider}/{summary.model} · {describeInstructionsSource(summary.instructionsSource)} (
            <a href="#/settings">edit</a>) · {formatDateTime(summary.createdAt)}
          </p>
        </>
      )}
    </section>
  );
}

function Devices() {
  const [devices, setDevices] = useState<DeviceInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [codes, setCodes] = useState<Record<string, string>>({});

  const load = useCallback(() => {
    api<DeviceListResponse>("/devices").then((r) => setDevices(r.devices), (e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  const act = (p: Promise<unknown>) =>
    p.then(() => setError(null), (e: ApiError) => setError(e.message)).finally(load);

  if (!devices) return error ? <ErrorLine error={error} /> : <p>Loading…</p>;
  return (
    <section>
      <p>
        Pair a Mac with <code>pa pair &lt;server&gt; &lt;account&gt;</code>, then enter the code it shows. <button onClick={load}>Refresh</button>
      </p>
      <ErrorLine error={error} />
      {!devices.length && <p>No devices.</p>}
      <ul>
        {devices.map((d) => (
          <li key={d.id} style={{ marginBottom: "0.5rem" }}>
            <strong>{d.name}</strong> — {d.status}
            {d.status === "pending" ? (
              <>
                {" "}(expires {formatDateTime(d.expiresAt)}){" "}
                <input
                  placeholder="6-digit code"
                  inputMode="numeric"
                  size={8}
                  value={codes[d.id] ?? ""}
                  onChange={(e) => setCodes({ ...codes, [d.id]: e.target.value })}
                />{" "}
                <button onClick={() => act(api(`/devices/${d.id}/approve`, { body: { pairingCode: codes[d.id] ?? "" } }))}>Approve</button>{" "}
                <button onClick={() => act(api(`/devices/${d.id}`, { method: "DELETE" }))}>Reject</button>
              </>
            ) : (
              <>
                {" "}· paired {formatDateTime(d.approvedAt)} · last used {formatDateTime(d.lastUsedAt)}{" "}
                <button onClick={() => confirm(`Revoke ${d.name}?`) && act(api(`/devices/${d.id}`, { method: "DELETE" }))}>Revoke</button>
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
