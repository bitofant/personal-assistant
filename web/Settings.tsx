import { useCallback, useEffect, useState } from "react";
import type { CustomInstruction, InstructionScope, InstructionsResponse, SeriesInfo, SettingsResponse } from "../shared/api.js";
import { formatDateTime } from "../shared/format.js";
import { BUILTIN_INSTRUCTIONS, MEETING_TYPES } from "../shared/instructions.js";
import { api } from "./api.js";
import { ErrorLine, muted, routeKey, routeLabel } from "./ui.js";

export function SummarySettings() {
  return (
    <section>
      <h2>Summary settings</h2>
      <ModelSetting />
      <Instructions />
    </section>
  );
}

function ModelSetting() {
  const [s, setS] = useState<SettingsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<SettingsResponse>("/settings").then(setS, (e: Error) => setError(e.message));
  }, []);

  if (!s) return error ? <ErrorLine error={error} /> : <p>Loading…</p>;
  const choices = s.summaryLlmChoices;
  const selected = s.summaryLlm ?? choices.find((c) => c.isDefault) ?? null;
  const pick = (i: number) => {
    const c = choices[i];
    const summaryLlm = c.isDefault ? null : { provider: c.provider, model: c.model };
    const prev = s;
    setS({ ...s, summaryLlm }); // optimistic: controlled radio would otherwise lag the request
    api<SettingsResponse>("/settings", { method: "PUT", body: { summaryLlm } }).then(
      (r) => (setS(r), setError(null)),
      (e: Error) => (setS(prev), setError(e.message)),
    );
  };
  return (
    <>
      <h3>Model</h3>
      {!choices.length && <p>No summary model configured (admin: <code>llm.tasks.summary</code> in config.json).</p>}
      {choices.length === 1 && <p>{routeLabel(choices[0])}. To offer more (e.g. a paid remote model), list them under <code>llm.tasks.summary</code> in config.json.</p>}
      {choices.length > 1 && (
        <fieldset style={{ border: "none", padding: 0 }}>
          {choices.map((c, i) => (
            <label key={routeKey(c)} style={{ display: "block" }}>
              <input type="radio" name="summaryLlm" checked={!!selected && routeKey(selected) === routeKey(c)} onChange={() => pick(i)} /> {routeLabel(c)}
            </label>
          ))}
          <p style={muted}>Used for new summaries and meeting-type detection. Existing summaries keep their model until re-summarized.</p>
        </fieldset>
      )}
      <ErrorLine error={error} />
    </>
  );
}

function Instructions() {
  const [data, setData] = useState<InstructionsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api<InstructionsResponse>("/instructions").then((r) => (setData(r), setError(null)), (e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  if (!data) return error ? <ErrorLine error={error} /> : <p>Loading…</p>;
  const find = (scope: InstructionScope, key: string) => data.custom.find((c) => c.scope === scope && c.key === key) ?? null;
  const def = find("default", "");
  // Custom series no longer in any transcript still need to be editable/removable.
  const known = new Set(data.series.map((s) => s.seriesId));
  const series: SeriesInfo[] = [
    ...data.series,
    ...data.custom.filter((c) => c.scope === "series" && !known.has(c.key)).map((c) => ({ seriesId: c.key, title: null, count: 0, lastStartedAt: "" })),
  ];

  return (
    <>
      <h3>Instructions</h3>
      <p>
        The most specific instructions win: <strong>recurring series</strong> → <strong>meeting type</strong> → <strong>your default</strong> → built-in for the type.
        Each level replaces the ones below it. Common rules (transcript language, Markdown, no invented facts) always apply. Changes apply to new summaries; use
        Re-summarize on a transcript to update it.
      </p>
      <ErrorLine error={error} />

      <h4>Default</h4>
      <Editor path="/instructions/default" saved={def} placeholder="Empty: built-in instructions per meeting type." inherited="built-in instructions per meeting type" onSaved={load} />

      <h4>Per meeting type</h4>
      <p style={muted}>Types are detected from the calendar event (title keywords, 2 attendees = 1:1), else by the LLM.</p>
      {MEETING_TYPES.map((m) => {
        const saved = find("type", m.type);
        return (
          <details key={m.type} open={!!saved}>
            <summary>
              <strong>{m.label}</strong> — {m.description} <Badge custom={!!saved} />
            </summary>
            <Editor
              path={`/instructions/type/${m.type}`}
              saved={saved}
              placeholder={def ? def.text : BUILTIN_INSTRUCTIONS[m.type]}
              inherited={def ? "your default" : `built-in ${m.label} instructions (shown greyed)`}
              template={BUILTIN_INSTRUCTIONS[m.type]}
              onSaved={load}
            />
          </details>
        );
      })}

      <h4>Per recurring series</h4>
      {!series.length && <p style={muted}>No recurring meetings recorded yet.</p>}
      {series.map((s) => {
        const saved = find("series", s.seriesId);
        return (
          <details key={s.seriesId} open={!!saved}>
            <summary>
              <strong>{s.title ?? s.seriesId}</strong>{" "}
              <span style={muted}>{s.count ? `${s.count} recorded, last ${formatDateTime(s.lastStartedAt)}` : "no recordings left"}</span> <Badge custom={!!saved} />
            </summary>
            <Editor
              path={`/instructions/series/${encodeURIComponent(s.seriesId)}`}
              saved={saved}
              placeholder="Empty: instructions for the meeting's type."
              inherited="instructions for the meeting's type"
              onSaved={load}
            />
          </details>
        );
      })}
    </>
  );
}

function Badge({ custom }: { custom: boolean }) {
  return custom ? <span style={{ fontSize: "0.75rem", background: "#e6f0ff", borderRadius: 4, padding: "0 0.3rem" }}>custom</span> : null;
}

function Editor(props: { path: string; saved: CustomInstruction | null; placeholder: string; inherited: string; template?: string; onSaved: () => void }) {
  const { path, saved, placeholder, inherited, template, onSaved } = props;
  const [draft, setDraft] = useState(saved?.text ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(saved?.text ?? ""), [saved?.text]);
  const dirty = draft.trim() !== (saved?.text ?? "");

  const run = (p: Promise<unknown>) => {
    setBusy(true);
    p.then(() => (setError(null), onSaved()), (e: Error) => setError(e.message)).finally(() => setBusy(false));
  };
  // Empty = remove: falls back to the inherited level.
  const save = () => run(draft.trim() ? api(path, { method: "PUT", body: { text: draft } }) : api(path, { method: "DELETE" }));

  return (
    <div style={{ margin: "0.5rem 0 1rem" }}>
      <textarea
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        rows={Math.min(14, Math.max(4, draft.split("\n").length + 1))}
        style={{ width: "100%", fontFamily: "ui-monospace, monospace", fontSize: "0.85rem" }}
      />
      <div style={{ display: "flex", gap: "0.5rem", alignItems: "baseline" }}>
        <button disabled={!dirty || busy} onClick={save}>Save</button>
        {saved && <button disabled={busy} onClick={() => run(api(path, { method: "DELETE" }))}>Remove</button>}
        {template && !draft && <button onClick={() => setDraft(template)}>Start from built-in</button>}
        <span style={muted}>{saved ? `Custom, saved ${formatDateTime(saved.updatedAt)}` : `Not set: uses ${inherited}.`}</span>
      </div>
      <ErrorLine error={error} />
    </div>
  );
}
