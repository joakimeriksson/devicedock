import type { FirewallView } from "./Network";
import type { SharesView } from "./Shares";

type Item = { key: string; label: string; value: string; note: string; warn?: boolean; go: () => void };

/** What the agent can reach right now, under the headline: each item opens the place where it is changed, and turns
 * amber when it needs a look (no firewall, open internet, autonomous writes, a restart waiting). */
export function Summary(props: {
  health: { docker?: boolean; container?: boolean; agent?: boolean } | undefined;
  boards: { shared: number; autonomous: number };
  firewall: FirewallView | null;
  shares: SharesView | null;
  go: (where: string) => void;
}) {
  const { health, boards, firewall: fw, shares } = props;
  const items: Item[] = [];

  items.push(
    !health
      ? { key: "sandbox", label: "Sandbox", value: "checking", note: "", go: () => props.go("about") }
      : !health.docker
        ? { key: "sandbox", label: "Sandbox", value: "Docker unavailable", note: "start Docker or Colima", warn: true, go: () => props.go("about") }
        : !health.container
          ? { key: "sandbox", label: "Sandbox", value: "not running", note: "rs in the console starts it", warn: true, go: () => props.go("about") }
          : {
              key: "sandbox",
              label: "Sandbox",
              value: "locked down",
              note: health.agent ? "agents ready" : "agents starting",
              go: () => props.go("about"),
            },
  );

  items.push({
    key: "boards",
    label: "Boards",
    value: boards.shared ? `${boards.shared} shared` : "none shared",
    note: !("serial" in navigator)
      ? "use Chrome or Edge for USB"
      : boards.autonomous
        ? `${boards.autonomous} autonomous: writes don't ask`
        : "every write asks you",
    warn: boards.autonomous > 0,
    go: () => props.go("devices"),
  });

  if (shares) {
    const ro = shares.shares.filter((s) => s.readonly).length;
    const n = shares.shares.length;
    items.push({
      key: "folders",
      label: "Folders",
      value: n ? `${n} shared` : "none shared",
      note: shares.pending
        ? "restart the sandbox to apply"
        : n
          ? ro === n
            ? "all read-only"
            : ro
              ? `${ro} read-only, ${n - ro} read-write`
              : "read-write"
          : "only folders you pick",
      warn: shares.pending,
      go: () => props.go("folders"),
    });
  }

  if (fw) {
    const n = fw.policy.allow.length;
    items.push(
      fw.state === "open"
        ? { key: "internet", label: "Internet", value: "no firewall", note: "older sandbox: u upgrades it", warn: true, go: () => props.go("internet") }
        : !fw.active
          ? { key: "internet", label: "Internet", value: "nothing yet", note: fw.state === "absent" ? "the sandbox is not running" : "connecting", go: () => props.go("internet") }
        : fw.policy.mode === "offline"
          ? { key: "internet", label: "Internet", value: "offline", note: "no sites at all", go: () => props.go("internet") }
          : fw.policy.mode === "open"
            ? { key: "internet", label: "Internet", value: "open", note: "any site; each one is logged", warn: true, go: () => props.go("internet") }
            : {
                key: "internet",
                label: "Internet",
                value: `${n} site${n === 1 ? "" : "s"} allowed`,
                note: "asks you for new ones",
                go: () => props.go("internet"),
              },
    );
  }

  return (
    <div className="summary" role="list" aria-label="What the agent can reach">
      {items.map((it) => (
        <button key={it.key} role="listitem" className={it.warn ? "summary-item warn" : "summary-item"} onClick={it.go}>
          <i className={it.warn ? "dot muted" : "dot"} />
          <span className="summary-label">{it.label}</span>
          <b>{it.value}</b>
          {it.note && <small>{it.note}</small>}
        </button>
      ))}
    </div>
  );
}
