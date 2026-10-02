import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type {
  DeviceInfo,
  DeviceListResponse,
  MeResponse,
  SettingsResponse,
  SignupResponse,
  SpeakerNamesResponse,
  SpeakerSuggestionsResponse,
  AuthOptionsResponse,
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
import { emptySearch, parseSearchHash, parseTranscriptHash, transcriptHash } from "./routes.js";
import { Account } from "./Account.js";
import { LiveTranscript } from "./Live.js";
import { Search, SearchBox } from "./Search.js";
import { deviceActivityLine, REVOKE_HELP, revokeConfirmText } from "./devices.js";
import { displaySpeaker, matchFor, matchReason, nameSuggestions, speakerEdits, speakerLabels, suggestionFor, suggestJobView } from "./speakers.js";
import { SummarySettings } from "./Settings.js";
import { summaryStatusView, type SummaryTone } from "./summaryState.js";
import { ErrorLine, routeKey, routeLabel } from "./ui.js";

function useHash(): string {
  const [hash, setHash] = useState(location.hash || "#/");
  useEffect(() => {
    const on = () => setHash(location.hash || "#/");
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return hash;
}

type Page = "transcripts" | "search" | "settings" | "devices" | "account";

const NAV: { page: Page; href: string; name: string; sub: string }[] = [
  { page: "transcripts", href: "#/", name: "Transcripts", sub: "All recorded meetings" },
  { page: "settings", href: "#/settings", name: "Summary settings", sub: "Model · instructions" },
  { page: "devices", href: "#/devices", name: "Devices", sub: "Paired Macs" },
  { page: "account", href: "#/account", name: "Account", sub: "Export · delete" },
];

export function App() {
  const [me, setMe] = useState<MeResponse | null | undefined>(undefined);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const hash = useHash();

  useEffect(() => {
    api<MeResponse>("/auth/me").then(setMe, () => setMe(null));
  }, []);
  // Mobile drawer covers what was just opened.
  useEffect(() => {
    setSidebarOpen(false);
  }, [hash]);

  if (me === undefined) return <div className="app" />;
  if (me === null) return <Login onLogin={setMe} />;

  const logout = () => api("/auth/logout", { method: "POST" }).finally(() => setMe(null));
  const detail = parseTranscriptHash(hash);
  const search = parseSearchHash(hash);
  const page: Page =
    hash === "#/devices" ? "devices" : hash === "#/settings" ? "settings" : hash === "#/account" ? "account" : search ? "search" : "transcripts";
  const title = { transcripts: detail ? "Transcript" : "Transcripts", search: "Search", settings: "Summary settings", devices: "Devices", account: "Account" }[page];
  return (
    <div className="app">
      <button className="menu-toggle" onClick={() => setSidebarOpen(true)} aria-label="Open menu">
        ☰
      </button>
      {sidebarOpen && <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} />}
      <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
        <div className="sidebar-header">
          <h1>personal-assistant</h1>
          <button className="logout-button" onClick={logout} title={`Log out ${me.username}`}>
            Log out
          </button>
        </div>
        <div className="sidebar-search">
          <SearchBox params={search ?? emptySearch} />
        </div>
        <nav className="nav-list">
          {NAV.map((n) => (
            <a key={n.page} href={n.href} className={`nav-item ${page === n.page ? "active" : ""}`}>
              <span className="nav-item-name">{n.name}</span>
              <span className="nav-item-sub">{n.sub}</span>
            </a>
          ))}
        </nav>
        <div className="sidebar-user">Signed in as {me.username}</div>
      </aside>
      <main className="main">
        <div className="page-header">{title}</div>
        {/* key: new page starts scrolled to top. */}
        <div className="content" key={detail ? `t/${detail.id}` : hash.split("?")[0]}>
          <div className="content-inner">
            {page === "devices" ? (
              <Devices />
            ) : page === "account" ? (
              <Account username={me.username} onDeleted={() => setMe(null)} />
            ) : page === "settings" ? (
              <SummarySettings />
            ) : search ? (
              <Search params={search} />
            ) : detail ? (
              <Transcript id={detail.id} seg={detail.seg} />
            ) : (
              <Transcripts />
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

function Login({ onLogin }: { onLogin: (me: MeResponse) => void }) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Hidden until the server says signup is on (default off); a failed fetch keeps it hidden.
  const [signup, setSignup] = useState(false);
  useEffect(() => {
    api<AuthOptionsResponse>("/auth/options").then((o) => setSignup(o.signup), () => {});
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setMessage(null);
    setBusy(true);
    try {
      if (mode === "login") return onLogin(await api<MeResponse>("/auth/login", { body: { username, password } }));
      const r = await api<SignupResponse>("/auth/signup", { body: { username, password } });
      if (r.enabled) return onLogin({ username: r.username });
      setMessage(`Account "${r.username}" created. Ask the admin to enable it in config.json, then log in.`);
      setMode("login");
      setPassword("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const switchMode = (m: "login" | "signup") => (setMode(m), setError(null), setMessage(null));

  return (
    <div className="login">
      <form className="login-card" onSubmit={(e) => void submit(e)}>
        <h1>personal-assistant</h1>
        {signup && (
          <div className="login-tabs">
            <button type="button" className={mode === "login" ? "active" : ""} onClick={() => switchMode("login")}>
              Log in
            </button>
            <button type="button" className={mode === "signup" ? "active" : ""} onClick={() => switchMode("signup")}>
              Sign up
            </button>
          </div>
        )}
        <label className="field-label" htmlFor="login-username">Username</label>
        <input id="login-username" autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
        <label className="field-label" htmlFor="login-password">Password</label>
        <input
          id="login-password"
          type="password"
          autoComplete={mode === "login" ? "current-password" : "new-password"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <ErrorLine error={error} />
        {message && <p className="login-message">{message}</p>}
        <button className="primary" type="submit" disabled={busy || !username.trim() || !password}>
          {mode === "login" ? "Log in" : "Sign up"}
        </button>
      </form>
    </div>
  );
}

function Transcripts() {
  const [items, setItems] = useState<TranscriptListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<TranscriptListResponse>("/transcripts").then((r) => setItems(r.transcripts), (e: Error) => setError(e.message));
  }, []);

  if (error) return <ErrorLine error={error} />;
  if (!items) return <p className="muted">Loading…</p>;
  if (!items.length) return <p className="empty-state">No transcripts yet. Pair a Mac under <a href="#/devices">Devices</a>.</p>;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>When</th><th>Title</th><th>Duration</th><th className="wide-only">Attendees</th><th className="wide-only">Calendar</th><th className="wide-only">Device</th>
          </tr>
        </thead>
        <tbody>
          {items.map((t) => (
            <tr key={t.id}>
              <td>{formatDateTime(t.startedAt)}</td>
              <td>
                <a href={transcriptHash(t.id)}>{t.title ?? "(ad-hoc call)"}</a>
                {t.live && <span className={t.live === "live" ? "badge live-badge" : "badge"}>{t.live === "live" ? "● live" : "processing"}</span>}
              </td>
              <td>{formatDuration(t.startedAt, t.endedAt)}</td>
              <td className="wide-only">{formatValue(t.attendeeCount)}</td>
              <td className="wide-only">{formatValue(t.calendarName)}</td>
              <td className="wide-only">{formatValue(t.deviceName)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Transcript({ id, seg }: { id: string; seg: number | null }) {
  const [t, setT] = useState<TranscriptDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 404 = maybe still recording → live preview (it calls `load` again once the final transcript exists).
  const [live, setLive] = useState(false);
  const target = useRef<HTMLParagraphElement>(null);
  const load = useCallback(() => {
    api<TranscriptDetail>(`/transcripts/${encodeURIComponent(id)}`).then(
      (d) => (setT(d), setLive(false)),
      (e: Error) => (e instanceof ApiError && e.status === 404 ? setLive(true) : setError(e.message)),
    );
  }, [id]);
  const missing = useCallback(() => (setLive(false), setError("No such transcript.")), []);
  useEffect(load, [load]);
  // Deep link from search: bring the matched segment into view once loaded.
  // Braces: newer Chromium's scrollIntoView returns a Promise, which React rejects as an effect cleanup.
  useEffect(() => {
    target.current?.scrollIntoView({ block: "center" });
  }, [t, seg]);

  if (error) return <ErrorLine error={error} />;
  if (live) return <LiveTranscript id={id} onFinal={load} onMissing={missing} />;
  if (!t) return <p className="muted">Loading…</p>;
  const m = t.meeting;
  return (
    <article>
      <h2>{m?.title ?? "(ad-hoc call)"}</h2>
      <p className="meta">
        {formatDateTime(t.startedAt)} · {formatDuration(t.startedAt, t.endedAt)} · calendar {formatValue(m?.calendarName)} · device{" "}
        {formatValue(t.deviceName)}
      </p>
      {m && m.attendees.length > 0 && (
        <p className="meta">With {m.attendees.map((a) => a.name ?? a.email).join(", ")}</p>
      )}
      {/* key includes updatedAt: renaming a speaker reloads the detail → panel shows the summary as stale. */}
      <SummaryPanel key={`${t.id}:${t.updatedAt}`} transcriptId={t.id} initial={{ summary: t.summary, summaryJob: t.summaryJob }} />
      <SpeakerNames t={t} onSaved={load} />
      <h3>Transcript</h3>
      <div className="segments">
        {t.segments.map((s, i) => (
          <p key={i} ref={i === seg ? target : undefined} className={i === seg ? "target" : undefined}>
            <span className="offset">{formatOffset(s.start)}</span> <span className="speaker" title={s.speaker ?? undefined}>{formatValue(displaySpeaker(s.speaker, t.speakerNames))}:</span> {s.text}
          </p>
        ))}
      </div>
      <p className="muted">
        ASR {t.asrModel} · diarization {formatValue(t.diarizationModel)} · received {formatDateTime(t.receivedAt)}
      </p>
      <DeleteTranscript id={t.id} title={m?.title ?? "this ad-hoc call"} />
    </article>
  );
}

/**
 * Name diarization labels; attendees offered as suggestions, voice/calendar matches, plus LLM proposals on request
 * ("Use" only fills the input: nothing is saved until the user saves). Auto names (set at upload) can be confirmed
 * (→ user name, used as a voiceprint) or edited. Saving re-labels transcript + search, marks the summary stale.
 */
function SpeakerNames({ t, onSaved }: { t: TranscriptDetail; onSaved: () => void }) {
  const labels = useMemo(() => speakerLabels(t), [t]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sugg, setSugg] = useState<SpeakerSuggestionsResponse | null>(null);
  const suggPath = `/transcripts/${encodeURIComponent(t.id)}/speakers/suggestions`;
  const suggCount = sugg ? new Set([...Object.keys(sugg.suggestions), ...Object.keys(sugg.matches)]).size : 0;
  const autoCount = Object.keys(t.autoSpeakers).length;
  const suggView = suggestJobView(sugg?.job ?? null, suggCount);
  // Reload on t change too: saving a name hides that label's suggestion server-side.
  useEffect(() => {
    api<SpeakerSuggestionsResponse>(suggPath).then(setSugg, () => setSugg(null));
  }, [suggPath, t]);
  useEffect(() => {
    if (suggView.pollMs === null) return;
    const timer = setTimeout(() => {
      api<SpeakerSuggestionsResponse>(suggPath).then(setSugg, (e: Error) => (setError(e.message), setSugg((s) => s && { ...s })));
    }, suggView.pollMs);
    return () => clearTimeout(timer);
  }, [sugg, suggView.pollMs, suggPath]);
  const suggest = () =>
    api<SpeakerSuggestionsResponse>(suggPath, { body: {} }).then(
      (r) => (setSugg(r), setError(null)),
      (e: Error) => setError(e.message),
    );
  if (!labels.length) return null;
  // Input = draft, else saved name, else empty (placeholder shows the label).
  const valueOf = (l: string) => drafts[l] ?? (Object.hasOwn(t.speakerNames, l) ? t.speakerNames[l] : "");
  const edits = speakerEdits(t.speakerNames, Object.fromEntries(labels.map((l) => [l, valueOf(l)])));
  const listId = `speaker-suggestions-${t.id}`;
  const putNames = async (names: Record<string, string | null>) => {
    setBusy(true);
    try {
      await api<SpeakerNamesResponse>(`/transcripts/${encodeURIComponent(t.id)}/speakers`, { method: "PUT", body: { names } });
      // Only the sent labels: confirming one auto name keeps other unsaved edits.
      setDrafts((d) => Object.fromEntries(Object.entries(d).filter(([k]) => !Object.hasOwn(names, k))));
      setError(null);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const save = (e: FormEvent) => {
    e.preventDefault();
    void putNames(edits);
  };
  return (
    <details className="speakers">
      <summary>
        Speakers ({labels.length})
        {autoCount > 0 && <span className="badge">{autoCount} auto-named</span>}
        {suggCount > 0 && <span className="badge">{suggCount} suggested</span>}
      </summary>
      <form onSubmit={save}>
        <datalist id={listId}>
          {nameSuggestions(t).map((n) => (
            <option key={n} value={n} />
          ))}
        </datalist>
        {labels.map((l) => {
          const s = sugg && suggestionFor(l, t.speakerNames, valueOf(l), sugg.suggestions);
          const m = sugg && matchFor(l, t.speakerNames, valueOf(l), sugg.matches, s);
          const auto = Object.hasOwn(t.autoSpeakers, l) ? t.autoSpeakers[l] : null;
          return (
            <div key={l} className="speaker-row">
              <label className="row">
                <span className="speaker-label">{l}</span>
                <input className="grow" list={listId} placeholder={l} maxLength={100} value={valueOf(l)} onChange={(e) => setDrafts({ ...drafts, [l]: e.target.value })} />
              </label>
              {auto && (
                <p className="speaker-suggestion">
                  <button type="button" disabled={busy || Object.hasOwn(drafts, l)} onClick={() => void putNames({ [l]: auto.name })} title="Keep this name; it then also helps recognize this voice in other meetings">
                    Confirm
                  </button>
                  <span className="muted">Named automatically ({matchReason(auto)}). Confirm, or type the right name.</span>
                </p>
              )}
              {m && (
                <p className="speaker-suggestion">
                  <button type="button" onClick={() => setDrafts({ ...drafts, [l]: m.name })}>
                    Use
                  </button>
                  <span>
                    Suggested: <strong>{m.name}</strong>
                    <span className="muted"> — {matchReason(m)}</span>
                  </span>
                </p>
              )}
              {s && (
                <p className="speaker-suggestion">
                  <button type="button" onClick={() => setDrafts({ ...drafts, [l]: s.name })}>
                    Use
                  </button>
                  <span>
                    Suggested: <strong>{s.name}</strong>
                    {s.evidence && <span className="muted"> — “{s.evidence}”</span>}
                  </span>
                </p>
              )}
            </div>
          );
        })}
        <p className="row">
          <button className="primary" disabled={busy || !Object.keys(edits).length}>
            {busy ? "Saving…" : "Save names"}
          </button>
          <span className="muted grow">Empty = keep the label. Re-summarize afterwards to use the names in the summary.</span>
          <button type="button" disabled={suggView.inProgress} onClick={() => void suggest()} title="Ask the LLM who is speaking, from introductions and names used in the call">
            {suggView.inProgress ? "Suggesting…" : "Suggest names"}
          </button>
        </p>
        {suggView.message && (
          <p role="status" className={TONE_CLASS[suggView.tone]}>
            {suggView.message}
          </p>
        )}
        <ErrorLine error={error} />
      </form>
    </details>
  );
}

function DeleteTranscript({ id, title }: { id: string; title: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = async () => {
    // Nightly backups still hold it until they rotate out; say so rather than promise instant erasure.
    if (!confirm(`Delete "${title}" with its summary? This can't be undone, and the Mac won't be able to upload it again. Existing backups keep it until they expire.`)) return;
    setBusy(true);
    try {
      await api(`/transcripts/${encodeURIComponent(id)}`, { method: "DELETE" });
      location.hash = "#/";
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <p>
      <button className="danger" disabled={busy} onClick={() => void remove()}>
        {busy ? "Deleting…" : "Delete transcript"}
      </button>
      {error && <ErrorLine error={error} />}
    </p>
  );
}

const TONE_CLASS: Record<SummaryTone, string> = { info: "muted", warn: "warn", error: "error" };

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
    <section className="card">
      <div className="card-head">
        <h3>Summary</h3>
        {choices.length > 1 && picked && (
          <select aria-label="Model" value={routeKey(picked)} onChange={(e) => setPick(e.target.value)} disabled={view.inProgress}>
            {choices.map((c) => (
              <option key={routeKey(c)} value={routeKey(c)}>
                {routeLabel(c)}
              </option>
            ))}
          </select>
        )}
        <button className="primary" disabled={view.inProgress} onClick={() => void summarize()}>
          {view.action}
        </button>
      </div>
      {view.message && (
        <p role="status" className={TONE_CLASS[view.tone]}>
          {view.inProgress && view.tone === "info" && "⏳ "}
          {view.message}
        </p>
      )}
      <ErrorLine error={error} />
      {summary && (
        <>
          {summary.stale && !view.inProgress && (
            <p className="warn">The transcript changed after this summary was made.</p>
          )}
          {summary.instructionsChanged && !view.inProgress && (
            <p className="warn">The instructions for this meeting changed after this summary was made. Re-summarize to apply them.</p>
          )}
          <div className={`summary ${view.inProgress ? "dim" : ""}`} dangerouslySetInnerHTML={{ __html: html }} />
          <p className="muted">
            {meetingTypeLabel(summary.meetingType)}
            {summary.meetingTypeSource === "llm" && " (detected by LLM)"}
            {summary.meetingTypeSource === "series" && " (same as earlier meetings in this series)"}
            {summary.meetingTypeSource === "fallback" && " (type not detected)"} · {summary.provider}/{summary.model}
            {summary.parts !== null && summary.parts > 1 && ` · long meeting: summarized in ${summary.parts} parts`} ·{describeInstructionsSource(summary.instructionsSource)} (
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
  // Device being renamed → draft name.
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);

  const load = useCallback(() => {
    api<DeviceListResponse>("/devices").then((r) => setDevices(r.devices), (e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  const act = (p: Promise<unknown>) =>
    p.then(() => setError(null), (e: ApiError) => setError(e.message)).finally(load);
  const rename = (e: FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    void api<DeviceInfo>(`/devices/${editing.id}`, { method: "PATCH", body: { name: editing.name } }).then(
      () => (setEditing(null), setError(null), load()),
      (err: ApiError) => setError(err.message),
    );
  };
  const nameCell = (d: DeviceInfo) =>
    editing?.id === d.id ? (
      <form className="row device-rename" onSubmit={rename}>
        <input aria-label="Device name" autoFocus maxLength={100} value={editing.name} onChange={(e) => setEditing({ id: d.id, name: e.target.value })} />
        <button className="primary" disabled={!editing.name.trim() || editing.name.trim() === d.name}>
          Save
        </button>
        <button type="button" onClick={() => setEditing(null)}>
          Cancel
        </button>
      </form>
    ) : (
      <>
        <strong>{d.name}</strong>
        <button className="link-button" onClick={() => setEditing({ id: d.id, name: d.name })}>
          Rename
        </button>
      </>
    );

  if (!devices) return error ? <ErrorLine error={error} /> : <p className="muted">Loading…</p>;
  return (
    <section>
      <div className="row">
        <p className="grow">
          Pair a Mac with <code>pa pair &lt;server&gt; &lt;account&gt;</code>, then enter the code it shows.
        </p>
        <button onClick={load}>Refresh</button>
      </div>
      <ErrorLine error={error} />
      {!devices.length && <p className="empty-state">No devices.</p>}
      <ul className="list">
        {devices.map((d) => (
          <li key={d.id} className="device">
            <div className="row">
              {nameCell(d)}
              <span className={d.status === "pending" ? "badge" : "muted"}>{d.status}</span>
              {d.status === "pending" ? (
                <>
                  <span className="muted grow">expires {formatDateTime(d.expiresAt)}</span>
                  <input
                    placeholder="6-digit code"
                    inputMode="numeric"
                    size={10}
                    value={codes[d.id] ?? ""}
                    onChange={(e) => setCodes({ ...codes, [d.id]: e.target.value })}
                  />
                  <button className="primary" onClick={() => act(api(`/devices/${d.id}/approve`, { body: { pairingCode: codes[d.id] ?? "" } }))}>
                    Approve
                  </button>
                  <button onClick={() => act(api(`/devices/${d.id}`, { method: "DELETE" }))}>Reject</button>
                </>
              ) : (
                <>
                  <span className="grow" />
                  <button className="danger" onClick={() => confirm(revokeConfirmText(d)) && act(api(`/devices/${d.id}`, { method: "DELETE" }))}>
                    Revoke
                  </button>
                </>
              )}
            </div>
            {d.status === "active" && <p className="muted device-activity">{deviceActivityLine(d)}</p>}
          </li>
        ))}
      </ul>
      {devices.some((d) => d.status === "active") && <p className="muted device-help">
          {REVOKE_HELP.before}
          <code>{REVOKE_HELP.command}</code>
          {REVOKE_HELP.after}
        </p>}
    </section>
  );
}
