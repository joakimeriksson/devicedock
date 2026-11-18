import { html, useState } from "./html.js";

// Folders from this computer shared into the sandbox at /shares/<name> (see server-rs/src/shares.rs).
/**
 * @typedef {{ path: string, display: string, readonly: boolean, target: string, problem?: string }} Share
 * @typedef {{ shares: Share[], container: boolean, pending: boolean, error?: string }} SharesView
 * @typedef {{ name: string, path: string }} Dir
 * @typedef {{ path: string, display: string, parent: string | null, dirs: Dir[], more: boolean, shareable: boolean, reason?: string }} Listing
 */

/** @param {{ csrf: string, view: SharesView | null, setView: (v: SharesView) => void }} props */
export function Shares({ csrf, view, setView }) {
  const [error, setError] = useState("");
  const [picker, setPicker] = useState(/** @type {Listing | null} */ (null));
  const [typed, setTyped] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function post(path, body) {
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
    return v;
  }
  const save = async (/** @type {{ path: string, readonly: boolean }[]} */ shares) => {
    const v = await post("/api/shares", { shares });
    if (v) setView(v);
    return v;
  };
  const browse = async (/** @type {string | undefined} */ path) => {
    const l = await post("/api/shares/browse", { path });
    if (l) setPicker(l);
  };
  async function restart() {
    setBusy(true);
    const v = await post("/api/shares/apply", {});
    setBusy(false);
    setConfirming(false);
    if (v) setView(v);
  }

  if (!view) return null;
  const list = view.shares.map((s) => ({ path: s.path, readonly: s.readonly }));
  async function add(path) {
    if (await save([...list, { path, readonly: false }])) {
      setPicker(null);
      setTyped("");
    }
  }

  return html`
    <section class="panel network shares" id="folders">
      <header>
        <span>
          Shared folders <small>${view.shares.length ? `${view.shares.length} from this computer` : "none"}</small>
        </span>
        ${view.pending && html`<span class="label warn">RESTART NEEDED</span>`}
      </header>
      <p class="network-note">
        Folders from this computer that agents can open in the sandbox. They can read and change everything in a
        read-write folder, so review their changes before you run code from it here.
      </p>

      ${view.shares.length > 0 &&
      html`
        <ul class="share-list">
          ${view.shares.map(
            (s, i) => html`
              <li key=${s.path} class=${s.problem ? "share-bad" : ""}>
                <div class="share-paths">
                  <span title=${s.path}>${s.display}</span>
                  <code>${s.target}</code>
                  ${s.problem && html`<em>${s.problem}</em>`}
                </div>
                <label class="share-ro" title="The sandbox can read but not change these files">
                  <input
                    type="checkbox"
                    checked=${s.readonly}
                    onChange=${(e) => {
                      // The box shows what the backend stored: it changes when the answer comes.
                      e.currentTarget.checked = s.readonly;
                      void save(list.map((x, j) => (j === i ? { ...x, readonly: !x.readonly } : x)));
                    }}
                  />${" "}read-only
                </label>
                <button aria-label=${`Stop sharing ${s.display}`} onClick=${() => void save(list.filter((_, j) => j !== i))}>
                  Remove
                </button>
              </li>
            `,
          )}
        </ul>
      `}
      ${view.pending &&
      html`
        <div class="network-ask share-pending">
          ${confirming
            ? html`
                <span>
                  Restart the sandbox now? Agents and terminals stop. Files in /workspace and your agent logins are kept.
                </span>
                <button onClick=${() => setConfirming(false)} disabled=${busy}>Cancel</button>
                <button class="primary" onClick=${() => void restart()} disabled=${busy}>
                  ${busy ? "Restarting…" : "Restart sandbox"}
                </button>
              `
            : html`
                <span>Changes take effect when the sandbox restarts.</span>
                <button class="primary" onClick=${() => setConfirming(true)}>Restart sandbox…</button>
              `}
        </div>
      `}
      ${!picker
        ? html`<button class="network-logtoggle" onClick=${() => void browse()}>Add a folder…</button>`
        : html`
            <div class="share-picker">
              <div class="share-crumb">
                <button
                  onClick=${() => picker.parent && void browse(picker.parent)}
                  disabled=${!picker.parent}
                  aria-label="Up one folder"
                >
                  ↑
                </button>
                <code>${picker.display}</code>
              </div>
              <ul class="share-dirs">
                ${picker.dirs.length === 0 && html`<li class="share-empty">No subfolders.</li>`}
                ${picker.dirs.map(
                  (d) => html`
                    <li key=${d.path}>
                      <button onClick=${() => void browse(d.path)}>${d.name}</button>
                    </li>
                  `,
                )}
                ${picker.more && html`<li class="share-empty">More folders not shown; type the path below.</li>`}
              </ul>
              ${!picker.shareable && picker.reason && html`<p class="network-note">${picker.reason}</p>`}
              <div class="network-add">
                <button
                  onClick=${() => {
                    setPicker(null);
                    setError("");
                  }}
                >
                  Cancel
                </button>
                <button class="primary" disabled=${!picker.shareable} onClick=${() => void add(picker.path)}>
                  Share ${picker.display}
                </button>
              </div>
              <form
                class="network-add"
                onSubmit=${(e) => {
                  e.preventDefault();
                  if (typed.trim()) void add(typed.trim());
                }}
              >
                <input
                  value=${typed}
                  onInput=${(e) => setTyped(e.currentTarget.value)}
                  placeholder="or type a path: ~/work/my-project"
                  aria-label="Folder path to share"
                />
                <button type="submit" disabled=${!typed.trim()}>Share</button>
              </form>
            </div>
          `}
      ${(error || view.error) && html`<p class="network-error">${error || view.error}</p>`}
    </section>
  `;
}
