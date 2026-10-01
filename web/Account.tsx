import { useState, type FormEvent } from "react";
import { api } from "./api.js";
import { ErrorLine } from "./ui.js";

export function Account({ username, onDeleted }: { username: string; onDeleted: () => void }) {
  return (
    <section>
      <h3>Export</h3>
      <p>Download everything stored for you (transcripts, summaries, speaker names, instructions, settings, devices) as one JSON file.</p>
      {/* Plain navigation: the server sends Content-Disposition: attachment, so the page stays. */}
      <p>
        <button onClick={() => (location.href = "/api/export")}>Download export</button>
      </p>
      <DeleteAccount username={username} onDeleted={onDeleted} />
    </section>
  );
}

function DeleteAccount({ username, onDeleted }: { username: string; onDeleted: () => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!confirm(`Delete account "${username}" and all its data, including backup copies? This can't be undone.`)) return;
    setBusy(true);
    try {
      await api("/account", { method: "DELETE", body: { password } });
      onDeleted();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <>
      <h3>Delete account</h3>
      <p>
        Deletes your account, every transcript and summary, your paired devices, and your data in the server's backups.
        Paired Macs stop uploading. Download an export first if you want to keep anything.
      </p>
      <form className="row" onSubmit={(e) => void submit(e)}>
        <input type="password" placeholder="Your password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <button className="danger" disabled={busy || !password}>
          {busy ? "Deleting…" : "Delete account"}
        </button>
      </form>
      <ErrorLine error={error} />
    </>
  );
}
