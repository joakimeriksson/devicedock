import { html, useState } from "./html.js";
import { postJson, usePoll } from "./access.js";
import { Network } from "./Network.js";
import { Shares } from "./Shares.js";

/**
 * @typedef {{ docker?: boolean, container?: boolean, agent?: boolean, version?: string }} Health
 * @typedef {{ on: boolean, running: boolean | null }} AgentUpdates
 */

/** What the sandbox may reach, set up once in a while: the internet, folders from this computer, agent updates.
 * @param {{
 *   csrf: string,
 *   health: Health | undefined,
 *   firewall: import("./Network.js").FirewallView | null,
 *   setFirewall: (v: import("./Network.js").FirewallView) => void,
 *   shares: import("./Shares.js").SharesView | null,
 *   setShares: (v: import("./Shares.js").SharesView) => void,
 * }} props */
export function Settings(props) {
  const { csrf, health } = props;
  return html`
    <div class="intro">
      <h1>Settings</h1>
      <p>What the sandbox may reach on the internet and on this computer. Boards are shared on the workspace page.</p>
    </div>
    <div class="settings">
      <${Network} csrf=${csrf} view=${props.firewall} setView=${props.setFirewall} />
      <div class="settings-column">
        <${Shares} csrf=${csrf} view=${props.shares} setView=${props.setShares} />
        <${AgentUpdatesPanel} csrf=${csrf} />
        <${About} health=${health} firewall=${props.firewall} />
      </div>
    </div>
  `;
}

function AgentUpdatesPanel({ csrf }) {
  const [view, setView] = usePoll("/api/agent-updates", 5000, true);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!view) return null; // until the first answer
  const choose = (on) =>
    postJson("/api/agent-updates", { on }, csrf).then(
      (v) => (setError(""), setView(v)),
      (e) => setError(e.message),
    );
  async function restart() {
    setBusy(true);
    try {
      await postJson("/api/sandbox/recreate", {}, csrf);
      setView({ ...view, running: view.on });
      setError("");
    } catch (e) {
      setError(e.message);
    }
    setBusy(false);
    setConfirming(false);
  }
  const pending = view.running !== null && view.running !== view.on;
  return html`
    <section class="panel network" id="agents">
      <header>
        <span>
          Agent updates <small>${view.on ? "the agents update themselves" : "pinned to the image's versions"}</small>
        </span>
        ${pending && html`<span class="label warn">RESTART NEEDED</span>`}
      </header>
      <div class="network-modes" role="radiogroup" aria-label="Agent updates">
        <button role="radio" aria-checked=${!view.on} class=${view.on ? "" : "primary"} onClick=${() => void choose(false)}>
          Pinned
        </button>
        <button role="radio" aria-checked=${view.on} class=${view.on ? "primary" : ""} onClick=${() => void choose(true)}>
          Update themselves
        </button>
      </div>
      <p class="network-note">
        ${view.on
          ? "Codex, Claude Code and OpenCode install new versions from npm through the firewall. Those versions arrive unreviewed: a hijacked release would run with the agents' logins, your shared boards and folders."
          : "Codex, Claude Code and OpenCode stay at the versions in the sandbox image, which are the ones CI builds and we test. Upgrading DeviceDock (u in the console) brings new ones."}
      </p>
      ${pending &&
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
                <span>Takes effect when the sandbox restarts.</span>
                <button class="primary" onClick=${() => setConfirming(true)}>Restart sandbox…</button>
              `}
        </div>
      `}
      ${error && html`<p class="network-error">${error}</p>`}
    </section>
  `;
}

/** @param {{ health: Health | undefined, firewall: import("./Network.js").FirewallView | null }} props */
function About({ health, firewall }) {
  const rows = [
    ["DeviceDock", health?.version ?? "unknown"],
    ["Docker", health?.docker ? "available" : "unavailable"],
    ["Sandbox", health?.container ? (firewall?.state === "open" ? "running, older image without the firewall" : "running") : "not running"],
    ["Agents", health?.agent ? "Codex, Claude Code, OpenCode" : "not available"],
    ["USB in this browser", "serial" in navigator ? "supported" : "use Chrome or Edge"],
  ];
  return html`
    <section class="panel network" id="about">
      <header>
        <span>About</span>
      </header>
      <dl class="about">
        ${rows.map(
          ([k, v]) => html`
            <div key=${k}>
              <dt>${k}</dt>
              <dd>${v}</dd>
            </div>
          `,
        )}
      </dl>
      <p class="network-note">To update: <code>./devicedock.sh upgrade</code>, or <code>u</code> in the DeviceDock console.</p>
    </section>
  `;
}
