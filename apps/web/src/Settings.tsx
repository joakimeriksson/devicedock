import { useState } from "react";
import { postJson, usePoll } from "./access";
import { Network, type FirewallView } from "./Network";
import { Shares, type SharesView } from "./Shares";

type Health = { docker?: boolean; container?: boolean; agent?: boolean; version?: string };
type AgentUpdates = { on: boolean; running: boolean | null };

/** What the sandbox may reach, set up once in a while: the internet, folders from this computer, agent updates. */
export function Settings(props: {
  csrf: string;
  health: Health | undefined;
  firewall: FirewallView | null;
  setFirewall: (v: FirewallView) => void;
  shares: SharesView | null;
  setShares: (v: SharesView) => void;
}) {
  const { csrf, health } = props;
  return (
    <>
      <div className="intro">
        <h1>Settings</h1>
        <p>What the sandbox may reach on the internet and on this computer. Boards are shared on the workspace page.</p>
      </div>
      <div className="settings">
        <Network csrf={csrf} view={props.firewall} setView={props.setFirewall} />
        <div className="settings-column">
          <Shares csrf={csrf} view={props.shares} setView={props.setShares} />
          <AgentUpdatesPanel csrf={csrf} />
          <About health={health} firewall={props.firewall} />
        </div>
      </div>
    </>
  );
}

function AgentUpdatesPanel({ csrf }: { csrf: string }) {
  const [view, setView] = usePoll<AgentUpdates>("/api/agent-updates", 5000, true);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!view) return null; // the Node backend has no such setting
  const choose = (on: boolean) =>
    postJson<AgentUpdates>("/api/agent-updates", { on }, csrf).then(
      (v) => (setError(""), setView(v)),
      (e: Error) => setError(e.message),
    );
  async function restart() {
    setBusy(true);
    try {
      await postJson("/api/sandbox/recreate", {}, csrf);
      setView({ ...view!, running: view!.on });
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
    setConfirming(false);
  }
  const pending = view.running !== null && view.running !== view.on;
  return (
    <section className="panel network" id="agents">
      <header>
        <span>
          Agent updates <small>{view.on ? "the agents update themselves" : "pinned to the image's versions"}</small>
        </span>
        {pending && <span className="label warn">RESTART NEEDED</span>}
      </header>
      <div className="network-modes" role="radiogroup" aria-label="Agent updates">
        <button role="radio" aria-checked={!view.on} className={view.on ? "" : "primary"} onClick={() => void choose(false)}>
          Pinned
        </button>
        <button role="radio" aria-checked={view.on} className={view.on ? "primary" : ""} onClick={() => void choose(true)}>
          Update themselves
        </button>
      </div>
      <p className="network-note">
        {view.on
          ? "Codex, Claude Code and OpenCode install new versions from npm through the firewall. Those versions arrive unreviewed: a hijacked release would run with the agents' logins, your shared boards and folders."
          : "Codex, Claude Code and OpenCode stay at the versions in the sandbox image, which are the ones CI builds and we test. Upgrading DeviceDock (u in the console) brings new ones."}
      </p>
      {pending && (
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
              <span>Takes effect when the sandbox restarts.</span>
              <button className="primary" onClick={() => setConfirming(true)}>
                Restart sandbox…
              </button>
            </>
          )}
        </div>
      )}
      {error && <p className="network-error">{error}</p>}
    </section>
  );
}

function About({ health, firewall }: { health: Health | undefined; firewall: FirewallView | null }) {
  const rows: [string, string][] = [
    ["DeviceDock", health?.version ? `${health.version}, Rust backend` : "Node backend: no firewall or shared folders"],
    ["Docker", health?.docker ? "available" : "unavailable"],
    ["Sandbox", health?.container ? (firewall?.state === "open" ? "running, older image without the firewall" : "running") : "not running"],
    ["Agents", health?.agent ? "Codex, Claude Code, OpenCode" : "not available"],
    ["USB in this browser", "serial" in navigator ? "supported" : "use Chrome or Edge"],
  ];
  return (
    <section className="panel network" id="about">
      <header>
        <span>About</span>
      </header>
      <dl className="about">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <p className="network-note">
        To update: <code>./devicedock.sh upgrade</code>, or <code>u</code> in the DeviceDock console.
      </p>
    </section>
  );
}
