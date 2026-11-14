import { useEffect, useState } from "react";

// Folders from this computer shared into the sandbox at /shares/<name> (Rust backend only; see server-rs/src/shares.rs).
type Share = { path: string; display: string; readonly: boolean; target: string; problem?: string };
type View = { shares: Share[]; container: boolean; pending: boolean; error?: string };
type Dir = { name: string; path: string };
type Listing = {
  path: string;
  display: string;
  parent: string | null;
  dirs: Dir[];
  more: boolean;
  shareable: boolean;
  reason?: string;
};

export function Shares({ csrf }: { csrf: string }) {
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState("");
  const [picker, setPicker] = useState<Listing | null>(null);
  const [typed, setTyped] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    const poll = () =>
      fetch("/api/shares")
        .then((r) => (r.ok ? r.json() : null))
        .then((v) => alive && v && setView(v))
        .catch(() => {});
    void poll();
    const t = setInterval(poll, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  async function post<T>(path: string, body: unknown): Promise<T | null> {
    setError("");
    const r = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify(body),
    }).catch(() => null);
    if (!r) {
      setError("The backend did not answer.");
      return null;
    }
    const v = await r.json().catch(() => ({}));
    if (!r.ok) {
      setError(v.error ?? `Failed (${r.status})`);
      return null;
    }
    return v as T;
  }
  const save = async (shares: { path: string; readonly: boolean }[]) => {
    const v = await post<View>("/api/shares", { shares });
    if (v) setView(v);
    return v;
  };
  const browse = async (path?: string) => {
    const l = await post<Listing>("/api/shares/browse", { path });
    if (l) setPicker(l);
  };
  async function restart() {
    setBusy(true);
    const v = await post<View>("/api/shares/apply", {});
    setBusy(false);
    setConfirming(false);
    if (v) setView(v);
  }

  if (!view) return null;
  const list = view.shares.map((s) => ({ path: s.path, readonly: s.readonly }));
  async function add(path: string) {
    if (await save([...list, { path, readonly: false }])) {
      setPicker(null);
      setTyped("");
    }
  }

  return (
    <section className="panel network shares">
      <header>
        <span>
          Shared folders <small>{view.shares.length ? `${view.shares.length} from this computer` : "none"}</small>
        </span>
        {view.pending && <span className="label warn">RESTART NEEDED</span>}
      </header>
      <p className="network-note">
        Folders from this computer that agents can open in the sandbox. They can read and change everything in a
        read-write folder, so review their changes before you run code from it here.
      </p>

      {view.shares.length > 0 && (
        <ul className="share-list">
          {view.shares.map((s, i) => (
            <li key={s.path} className={s.problem ? "share-bad" : ""}>
              <div className="share-paths">
                <span title={s.path}>{s.display}</span>
                <code>{s.target}</code>
                {s.problem && <em>{s.problem}</em>}
              </div>
              <label className="share-ro" title="The sandbox can read but not change these files">
                <input
                  type="checkbox"
                  checked={s.readonly}
                  onChange={() => void save(list.map((x, j) => (j === i ? { ...x, readonly: !x.readonly } : x)))}
                />{" "}
                read-only
              </label>
              <button aria-label={`Stop sharing ${s.display}`} onClick={() => void save(list.filter((_, j) => j !== i))}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {view.pending && (
        <div className="network-ask share-pending">
          {confirming ? (
            <>
              <span>
                Restart the sandbox now? Agents and terminals stop. Files in /workspace and your agent logins are kept.
              </span>
              <button onClick={() => setConfirming(false)} disabled={busy}>
                Cancel
              </button>
              <button className="primary" onClick={() => void restart()} disabled={busy}>
                {busy ? "Restarting…" : "Restart sandbox"}
              </button>
            </>
          ) : (
            <>
              <span>Changes take effect when the sandbox restarts.</span>
              <button className="primary" onClick={() => setConfirming(true)}>
                Restart sandbox…
              </button>
            </>
          )}
        </div>
      )}

      {!picker ? (
        <button className="network-logtoggle" onClick={() => void browse()}>
          Add a folder…
        </button>
      ) : (
        <div className="share-picker">
          <div className="share-crumb">
            <button onClick={() => picker.parent && void browse(picker.parent)} disabled={!picker.parent} aria-label="Up one folder">
              ↑
            </button>
            <code>{picker.display}</code>
          </div>
          <ul className="share-dirs">
            {picker.dirs.length === 0 && <li className="share-empty">No subfolders.</li>}
            {picker.dirs.map((d) => (
              <li key={d.path}>
                <button onClick={() => void browse(d.path)}>{d.name}</button>
              </li>
            ))}
            {picker.more && <li className="share-empty">More folders not shown; type the path below.</li>}
          </ul>
          {!picker.shareable && picker.reason && <p className="network-note">{picker.reason}</p>}
          <div className="network-add">
            <button onClick={() => setPicker(null)}>Cancel</button>
            <button className="primary" disabled={!picker.shareable} onClick={() => void add(picker.path)}>
              Share {picker.display}
            </button>
          </div>
          <form
            className="network-add"
            onSubmit={(e) => {
              e.preventDefault();
              if (typed.trim()) void add(typed.trim());
            }}
          >
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="or type a path: ~/work/my-project"
              aria-label="Folder path to share"
            />
            <button type="submit" disabled={!typed.trim()}>
              Share
            </button>
          </form>
        </div>
      )}
      {(error || view.error) && <p className="network-error">{error || view.error}</p>}
    </section>
  );
}
