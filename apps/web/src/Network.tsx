import { useState } from "react";
import { postJson } from "./access";

// The sandbox's network firewall: which internet hosts the sandbox may reach (through the tunnel to the backend's firewall).
type Mode = "offline" | "allowlist" | "open";
type Policy = { mode: Mode; allow: string[] };
type Ask = { id: string; host: string; port: number; t: number };
type Entry = { t: number; host: string; port: number; result: string };
type Preset = { id: string; label: string; hosts: string[] };
export type FirewallView = {
  active: boolean;
  /** Why it is (not) active: "open" is an older sandbox with open internet, the only state that needs the human. */
  state?: "on" | "connecting" | "open" | "absent";
  reason?: string;
  policy: Policy;
  presets: Preset[];
  pending?: Ask[];
  log?: Entry[];
};

const MODES: { id: Mode; label: string; hint: string }[] = [
  { id: "offline", label: "Offline", hint: "The sandbox reaches nothing on the internet." },
  { id: "allowlist", label: "Allow list", hint: "Only the hosts below. Anything else waits for your Allow or Block." },
  { id: "open", label: "Open", hint: "Any host. The log still shows every connection." },
];

const RESULT: Record<string, string> = {
  allowed: "allowed",
  approved: "you allowed",
  blocked: "blocked",
  denied: "you blocked",
  timeout: "blocked, no answer",
  failed: "unreachable",
};

const hostLabel = (h: string, port: number) => (port === 443 || port === 80 ? h : `${h}:${port}`);

type Props = { csrf: string; view: FirewallView | null; setView: (v: FirewallView) => void };

/** The firewall's settings: mode, allow list, waiting questions and the connection log (on the settings page). */
export function Network({ csrf, view, setView }: Props) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [showLog, setShowLog] = useState(false);

  async function post(path: string, body: unknown) {
    setError("");
    try {
      setView(await postJson<FirewallView>(path, body, csrf));
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  }
  const save = (p: Policy) => post("/api/firewall", p);

  if (!view) return null;
  const { policy, presets } = view;
  const pending = view.pending ?? [];
  const log = (view.log ?? []).slice().reverse();
  const has = (h: string) => policy.allow.includes(h);

  function togglePreset(p: Preset) {
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

  return (
    <section className="panel network" id="internet">
        <header>
          <span>
            Internet <small>{view.active ? MODES.find((m) => m.id === policy.mode)?.label : "firewall off"}</small>
          </span>
          <span className={view.active ? "label" : "label warn"}>{view.active ? "FIREWALL ON" : "NOT ACTIVE"}</span>
        </header>
        {!view.active && view.reason && <p className="network-note">{view.reason}</p>}
        <div className="network-modes" role="radiogroup" aria-label="Internet access for the sandbox">
          {MODES.map((m) => (
            <button
              key={m.id}
              role="radio"
              aria-checked={policy.mode === m.id}
              className={policy.mode === m.id ? "primary" : ""}
              onClick={() => void save({ ...policy, mode: m.id })}
            >
              {m.label}
            </button>
          ))}
        </div>
        <p className="network-note">{MODES.find((m) => m.id === policy.mode)?.hint}</p>

        {pending.length > 0 && (
          <div className="network-asks">
            {pending.map((a) => (
              <div key={a.id} className="network-ask">
                <span>
                  The sandbox wants to reach <b>{hostLabel(a.host, a.port)}</b>
                </span>
                <button className="danger" onClick={() => void post("/api/firewall/decide", { id: a.id, allow: false })}>
                  Block
                </button>
                <button className="primary" onClick={() => void post("/api/firewall/decide", { id: a.id, allow: true })}>
                  Allow
                </button>
              </div>
            ))}
          </div>
        )}

        {policy.mode === "allowlist" && (
          <>
            <div className="network-presets">
              {presets.map((p) => (
                <label key={p.id} title={p.hosts.join("\n")}>
                  <input type="checkbox" checked={p.hosts.every(has)} onChange={() => togglePreset(p)} /> {p.label}
                </label>
              ))}
            </div>
            <div className="network-hosts">
              {own.map((h) => (
                <span key={h} className="chip">
                  {h}
                  <button
                    aria-label={`Remove ${h}`}
                    onClick={() => void save({ ...policy, allow: policy.allow.filter((x) => x !== h) })}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
            <form
              className="network-add"
              onSubmit={(e) => {
                e.preventDefault();
                void addHost();
              }}
            >
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="example.com or *.example.com"
                aria-label="Host to allow"
              />
              <button type="submit" disabled={!draft.trim()}>
                Allow host
              </button>
            </form>
          </>
        )}
        {error && <p className="network-error">{error}</p>}

        <button className="network-logtoggle" onClick={() => setShowLog((s) => !s)} aria-expanded={showLog}>
          {showLog ? "Hide" : "Show"} recent connections ({log.length})
        </button>
        {showLog && (
          <ul className="network-log">
            {log.length === 0 && <li>No connections yet.</li>}
            {log.slice(0, 40).map((e, i) => (
              <li key={i} className={`r-${e.result}`}>
                <time>{new Date(e.t).toLocaleTimeString()}</time>
                <span>{hostLabel(e.host, e.port)}</span>
                <em>{RESULT[e.result] ?? e.result}</em>
              </li>
            ))}
          </ul>
        )}
      </section>
  );
}

/** A host the sandbox is waiting to reach, shown over every page: the firewall holds the connection until the human
 * answers or the question times out. */
export function FirewallAsks({ csrf, view, setView }: Props) {
  const pending = view?.pending ?? [];
  if (!pending.length) return null;
  const decide = (allow: boolean) =>
    postJson<FirewallView>("/api/firewall/decide", { id: pending[0].id, allow }, csrf).then(setView, () => {});
  return (
    <div className="network-toast" role="alert">
      <span>
        The sandbox wants to reach <b>{hostLabel(pending[0].host, pending[0].port)}</b>
        {pending.length > 1 && ` (+${pending.length - 1} more)`}
      </span>
      <button className="danger" onClick={() => void decide(false)}>
        Block
      </button>
      <button className="primary" onClick={() => void decide(true)}>
        Allow
      </button>
    </div>
  );
}
