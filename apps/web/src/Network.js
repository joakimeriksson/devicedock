import { html, useState } from "./html.js";
import { postJson } from "./access.js";

// The sandbox's network firewall: which internet hosts the sandbox may reach (through the tunnel to the backend's firewall).
/**
 * @typedef {"offline" | "allowlist" | "open"} Mode
 * @typedef {{ mode: Mode, allow: string[] }} Policy
 * @typedef {{ id: string, host: string, port: number, t: number }} Ask
 * @typedef {{ t: number, host: string, port: number, result: string }} Entry
 * @typedef {{ id: string, label: string, hosts: string[] }} Preset
 * @typedef {object} FirewallView
 * @property {boolean} active
 * @property {"on" | "connecting" | "open" | "absent"} [state] Why it is (not) active: "open" is an older sandbox with
 *   open internet, the only state that needs the human.
 * @property {string} [reason]
 * @property {Policy} policy
 * @property {Preset[]} presets
 * @property {Ask[]} [pending]
 * @property {Entry[]} [log]
 * @typedef {{ csrf: string, view: FirewallView | null, setView: (v: FirewallView) => void }} Props
 */

/** @type {{ id: Mode, label: string, hint: string }[]} */
const MODES = [
  { id: "offline", label: "Offline", hint: "The sandbox reaches nothing on the internet." },
  { id: "allowlist", label: "Allow list", hint: "Only the hosts below. Anything else waits for your Allow or Block." },
  { id: "open", label: "Open", hint: "Any host. The log still shows every connection." },
];

/** @type {Record<string, string>} */
const RESULT = {
  allowed: "allowed",
  approved: "you allowed",
  blocked: "blocked",
  denied: "you blocked",
  timeout: "blocked, no answer",
  failed: "unreachable",
};

const hostLabel = (h, port) => (port === 443 || port === 80 ? h : `${h}:${port}`);

/** The firewall's settings: mode, allow list, waiting questions and the connection log (on the settings page).
 * @param {Props} props */
export function Network({ csrf, view, setView }) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [showLog, setShowLog] = useState(false);

  async function post(path, body) {
    setError("");
    try {
      setView(await postJson(path, body, csrf));
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    }
  }
  const save = (/** @type {Policy} */ p) => post("/api/firewall", p);

  if (!view) return null;
  const { policy, presets } = view;
  const pending = view.pending ?? [];
  const log = (view.log ?? []).slice().reverse();
  const has = (h) => policy.allow.includes(h);

  function togglePreset(/** @type {Preset} */ p) {
    const on = p.hosts.every(has);
    const allow = on ? policy.allow.filter((h) => !p.hosts.includes(h)) : [...policy.allow, ...p.hosts.filter((h) => !has(h))];
    void save({ ...policy, allow });
  }
  async function addHost() {
    const h = draft.trim().toLowerCase();
    if (!h) return;
    if (await save({ ...policy, allow: [...policy.allow, h] })) setDraft("");
  }

  const presetHosts = new Set(presets.flatMap((p) => p.hosts));
  const own = policy.allow.filter((h) => !presetHosts.has(h));

  return html`
    <section class="panel network" id="internet">
      <header>
        <span>
          Internet <small>${view.active ? MODES.find((m) => m.id === policy.mode)?.label : "firewall off"}</small>
        </span>
        <span class=${view.active ? "label" : "label warn"}>${view.active ? "FIREWALL ON" : "NOT ACTIVE"}</span>
      </header>
      ${!view.active && view.reason && html`<p class="network-note">${view.reason}</p>`}
      <div class="network-modes" role="radiogroup" aria-label="Internet access for the sandbox">
        ${MODES.map(
          (m) => html`
            <button
              key=${m.id}
              role="radio"
              aria-checked=${policy.mode === m.id}
              class=${policy.mode === m.id ? "primary" : ""}
              onClick=${() => void save({ ...policy, mode: m.id })}
            >
              ${m.label}
            </button>
          `,
        )}
      </div>
      <p class="network-note">${MODES.find((m) => m.id === policy.mode)?.hint}</p>

      ${pending.length > 0 &&
      html`
        <div class="network-asks">
          ${pending.map(
            (a) => html`
              <div key=${a.id} class="network-ask">
                <span>The sandbox wants to reach <b>${hostLabel(a.host, a.port)}</b></span>
                <button class="danger" onClick=${() => void post("/api/firewall/decide", { id: a.id, allow: false })}>
                  Block
                </button>
                <button class="primary" onClick=${() => void post("/api/firewall/decide", { id: a.id, allow: true })}>
                  Allow
                </button>
              </div>
            `,
          )}
        </div>
      `}
      ${policy.mode === "allowlist" &&
      html`
        <div class="network-presets">
          ${presets.map(
            (p) => html`
              <label key=${p.id} title=${p.hosts.join("\n")}>
                <input
                  type="checkbox"
                  checked=${p.hosts.every(has)}
                  onChange=${(e) => {
                    // The box shows the stored list: it changes when the backend answers.
                    e.currentTarget.checked = p.hosts.every(has);
                    togglePreset(p);
                  }}
                />${" "}${p.label}
              </label>
            `,
          )}
        </div>
        <div class="network-hosts">
          ${own.map(
            (h) => html`
              <span key=${h} class="chip">
                ${h}
                <button
                  aria-label=${`Remove ${h}`}
                  onClick=${() => void save({ ...policy, allow: policy.allow.filter((x) => x !== h) })}
                >
                  ×
                </button>
              </span>
            `,
          )}
        </div>
        <form
          class="network-add"
          onSubmit=${(e) => {
            e.preventDefault();
            void addHost();
          }}
        >
          <input
            value=${draft}
            onInput=${(e) => setDraft(e.currentTarget.value)}
            placeholder="example.com or *.example.com"
            aria-label="Host to allow"
          />
          <button type="submit" disabled=${!draft.trim()}>Allow host</button>
        </form>
      `}
      ${error && html`<p class="network-error">${error}</p>`}

      <button class="network-logtoggle" onClick=${() => setShowLog((s) => !s)} aria-expanded=${showLog}>
        ${showLog ? "Hide" : "Show"} recent connections (${log.length})
      </button>
      ${showLog &&
      html`
        <ul class="network-log">
          ${log.length === 0 && html`<li>No connections yet.</li>`}
          ${log.slice(0, 40).map(
            (e, i) => html`
              <li key=${i} class=${`r-${e.result}`}>
                <time>${new Date(e.t).toLocaleTimeString()}</time>
                <span>${hostLabel(e.host, e.port)}</span>
                <em>${RESULT[e.result] ?? e.result}</em>
              </li>
            `,
          )}
        </ul>
      `}
    </section>
  `;
}

/** A host the sandbox is waiting to reach, shown over every page: the firewall holds the connection until the human
 * answers or the question times out.
 * @param {Props} props */
export function FirewallAsks({ csrf, view, setView }) {
  const pending = view?.pending ?? [];
  if (!pending.length) return null;
  const decide = (allow) => postJson("/api/firewall/decide", { id: pending[0].id, allow }, csrf).then(setView, () => {});
  return html`
    <div class="network-toast" role="alert">
      <span>
        The sandbox wants to reach <b>${hostLabel(pending[0].host, pending[0].port)}</b>
        ${pending.length > 1 && ` (+${pending.length - 1} more)`}
      </span>
      <button class="danger" onClick=${() => void decide(false)}>Block</button>
      <button class="primary" onClick=${() => void decide(true)}>Allow</button>
    </div>
  `;
}
