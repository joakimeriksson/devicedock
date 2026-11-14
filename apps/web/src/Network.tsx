import { useEffect, useState } from "react";

// The sandbox's network firewall: which internet hosts the sandbox may reach (through the tunnel to the backend's firewall).
type Mode = "offline" | "allowlist" | "open";
type Policy = { mode: Mode; allow: string[] };
type Ask = { id: string; host: string; port: number; t: number };
type Entry = { t: number; host: string; port: number; result: string };
type Preset = { id: string; label: string; hosts: string[] };
type View = {
  active: boolean;
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

export function Network({ csrf }: { csrf: string }) {
  const [view, setView] = useState<View | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [showLog, setShowLog] = useState(false);

  useEffect(() => {
    let alive = true;
    const poll = () =>
      fetch("/api/firewall")
        .then((r) => (r.ok ? r.json() : null))
        .then((v) => alive && v && setView(v))
        .catch(() => {});
    void poll();
    const t = setInterval(poll, 1500);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  async function post(path: string, body: unknown) {
    setError("");
    const r = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify(body),
    });
    const v = await r.json().catch(() => ({}));
    if (!r.ok) {
      setError(v.error ?? `Failed (${r.status})`);
      return false;
    }
    setView(v);
    return true;
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
    <>
      <section className="panel network">
        <header>
          <span>
            Network <small>{view.active ? MODES.find((m) => m.id === policy.mode)?.label : "firewall off"}</small>
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
      {pending.length > 0 && (
        <div className="network-toast" role="alert">
          <span>
            Network: the sandbox wants to reach <b>{hostLabel(pending[0].host, pending[0].port)}</b>
            {pending.length > 1 && ` (+${pending.length - 1} more)`}
          </span>
          <button className="danger" onClick={() => void post("/api/firewall/decide", { id: pending[0].id, allow: false })}>
            Block
          </button>
          <button className="primary" onClick={() => void post("/api/firewall/decide", { id: pending[0].id, allow: true })}>
            Allow
          </button>
        </div>
      )}
    </>
  );
}
