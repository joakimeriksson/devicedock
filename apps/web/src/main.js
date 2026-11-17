import { parseOptions, parseRequest, isVirtual, FLASH_IDLE_MS, FLASH_MAX_MS, FLASH_OPS } from "./protocol.js";
import { html, render, useEffect, useRef, useState } from "./html.js";
import { MockAdapter, WebSerialAdapter, encode, decode } from "./adapters.js";
import { Terminal } from "./Terminal.js";
import { FirewallAsks } from "./Network.js";
import { Settings } from "./Settings.js";
import { Summary } from "./Summary.js";
import { usePoll } from "./access.js";
import { describe } from "./approval.js";
import { migrateRememberKey, usbKey } from "./usb.js";
import { useTheme } from "./theme.js";
import "./sim/engines/index.js";
import { SimAdapter } from "./sim/SimAdapter.js";
import { ProbeAdapter } from "./probe.js";
import { SimDisplay } from "./sim/SimDisplay.js";
import { loadProfiles } from "./sim/registry.js";

/**
 * A device in the list: its descriptor, the adapter that drives it, and its sharing state.
 * @typedef {import("./adapters.js").Descriptor & {
 *   adapter: any,
 *   generation: number,
 *   open: boolean,
 *   exposed: boolean,
 *   baudRate: number,
 *   autoApprove: boolean,
 *   autonomousUntil?: number,
 *   probeSession?: boolean,
 *   unplugged?: boolean,
 *   waitingUntil?: number,
 *   flashUntil?: number,
 *   flashIdle?: number,
 * }} Row
 * probeSession: a debug probe's approved session is active (agents' OpenOCD can drive the chip without further clicks).
 * unplugged: the port is gone (unplugged, or the board reset and dropped off USB).
 * waitingUntil: a shared board that went away stays shared, under the same id, if it comes back before this time.
 * flashUntil, flashIdle: an approved flash session's hard end and its idle deadline (the broker's, moved on by each
 * write in it).
 */
/** How long a shared board may be gone and still come back shared: an ESP32-S3 or RP2040 reset takes a second or two. */
const RECONNECT_GRACE_MS = 15000;
const flashing = (r, now) => !!r.flashUntil && r.flashUntil > now && (r.flashIdle ?? 0) > now;
/** @typedef {{ v: 1, id: string, op: string, deviceId?: string, generation?: number, lease?: string, deadline: number, args: Record<string, unknown> }} Rpc */
// Serial ports the owner chose to keep sharing across restarts (USB id -> baud). Autonomous mode is
// never remembered. Per-browser convenience only, so failures to read/write storage are ignored.
const REMEMBER_KEY = "devicedock.autoshare";
/** @returns {Record<string, number>} */
function loadRemembered() {
  try {
    const v = JSON.parse(localStorage.getItem(REMEMBER_KEY) ?? "{}");
    if (!v || typeof v !== "object") return {};
    return Object.fromEntries(Object.entries(v).map(([k, baud]) => [migrateRememberKey(k), baud]));
  } catch {
    return {};
  }
}
/** What auto-share remembers a board by: its USB id ("10c4:ea60"), else its name. */
const rememberKey = (r) => (r.usb ? usbKey(r.usb) : r.name);
function saveRemembered(m) {
  try {
    localStorage.setItem(REMEMBER_KEY, JSON.stringify(m));
  } catch {}
}
const simAdapter = new SimAdapter();
const mock = new MockAdapter(),
  serial = new WebSerialAdapter(),
  probes = new ProbeAdapter();
function App() {
  // In-page confirmation. Native window.confirm() can be auto-dismissed by browser extensions (automation tools close
  // dialogs) or suppressed for the page ("prevent additional dialogs"), which silently cancelled every share.
  /** @typedef {{ message: string, title?: string, yes?: string, no?: string }} Confirm */
  const [pendingConfirm, setPendingConfirm] = useState(/** @type {(Confirm & { resolve: (ok: boolean) => void }) | undefined} */ (undefined));
  /** @returns {Promise<boolean>} */
  const confirmInPage = (message, words = {}) => new Promise((resolve) => setPendingConfirm({ message, ...words, resolve }));
  const answerConfirm = (ok) => {
    pendingConfirm?.resolve(ok);
    setPendingConfirm(undefined);
  };
  const confirmYes = useRef(null);
  // Like autoFocus: the confirm button takes the focus when the dialog opens.
  useEffect(() => confirmYes.current?.focus(), [pendingConfirm]);
  const [csrf, setCsrf] = useState(""),
    [error, setError] = useState(""),
    [health, setHealth] = useState(),
    [connected, setConnected] = useState(false),
    [rows, setRows] = useState(/** @type {Row[]} */ ([])),
    [logs, setLogs] = useState(
      /** @type {{ bytes: Uint8Array, text: string, hex: string, direction: string, deviceId: string, deviceName: string }[]} */ ([]),
    ),
    [monitorDevice, setMonitorDevice] = useState("all"),
    [monitorMode, setMonitorMode] = useState(/** @type {"text" | "chunks"} */ ("text")),
    [copied, setCopied] = useState(/** @type {"" | "ok" | "failed"} */ ("")),
    [approvals, setApprovals] = useState(/** @type {Rpc[]} */ ([])),
    // Flips the approval dialog's byte view: binary shows as hex by default, text as text.
    [approvalFlip, setApprovalFlip] = useState(false),
    [text, setText] = useState("PING\n"),
    [hex, setHex] = useState(false),
    [baud, setBaud] = useState(115200),
    [latency, setLatency] = useState(20),
    [fail, setFail] = useState(false),
    [agent, setAgent] = useState("codex"),
    [now, setNow] = useState(Date.now()),
    [remembered, setRememberedState] = useState(loadRemembered),
    [simProfiles, setSimProfiles] = useState(/** @type {import("./sim/types.js").SimProfile[]} */ ([]));
  const themeCtl = useTheme();
  // Two pages in one: the workspace (terminals, boards) and settings (internet, folders, agent updates). The workspace
  // stays mounted while settings are open, so terminals and shared boards keep running.
  const pageOf = () => (location.hash.startsWith("#settings") ? "settings" : "work");
  const [page, setPage] = useState(pageOf);
  useEffect(() => {
    const onHash = () => setPage(pageOf());
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);
  function go(where) {
    const settings = where !== "devices";
    location.hash = settings ? `#settings-${where}` : "#workspace";
    setPage(settings ? "settings" : "work");
    setTimeout(() => document.getElementById(where)?.scrollIntoView({ block: "start" }), 50);
  }
  // Polled here, not in the panels: the summary and the firewall's questions need them on both pages.
  const [firewall, setFirewall] = usePoll("/api/firewall", 1500, !!csrf);
  const [shares, setShares] = usePoll("/api/shares", 5000, !!csrf);
  const rememberedRef = useRef(remembered),
    autoShareRef = useRef(async () => {}),
    autoSharing = useRef(false);
  function setRemembered(next) {
    rememberedRef.current = next;
    setRememberedState(next);
    saveRemembered(next);
  }
  const monitorEnd = useRef(null);
  /** @type {{ current: Map<string, number> }} */
  const reconnectTimers = useRef(new Map());
  // One data/disconnect handler per device, however often it is added (a re-added row must not double the data).
  /** @type {{ current: Map<string, () => void> }} */
  const unsubscribers = useRef(new Map());
  /** @type {{ current: WebSocket | null }} */
  const socket = useRef(null),
    rowsRef = useRef(/** @type {Row[]} */ ([])),
    /** @type {{ current: Map<string, { resolve: (v: any) => void, reject: (e: Error) => void, timer: number }> }} */
    pending = useRef(new Map());
  const update = (/** @type {(old: Row[]) => Row[]} */ fn) => {
    const next = fn(rowsRef.current);
    rowsRef.current = next;
    setRows(next);
  };
  function send(m) {
    if (socket.current?.readyState !== 1) throw Error("Browser bridge disconnected");
    socket.current.send(JSON.stringify(m));
  }
  const run = (fn) => {
    setError("");
    void fn().catch((e) => setError(e.message));
  };
  // Text mode joins consecutive chunks of one direction into a continuous stream (decoded once, so a
  // multi-byte character split across chunks stays intact); chunk mode keeps one row per received piece.
  // Unique, readable device names (two boards with the same name get a short id suffix).
  function deviceLabel(id, name) {
    const same = rows.filter((r) => r.name === name).length > 1;
    return same ? `${name} (${id.slice(0, 4)})` : name;
  }
  function monitorBlocks() {
    const shown = monitorDevice === "all" ? logs : logs.filter((l) => l.deviceId === monitorDevice);
    // Name a block's device only when several devices are mixed in this view.
    const mixed = new Set(shown.map((l) => l.deviceId)).size > 1;
    const tag = (l) => (mixed ? deviceLabel(l.deviceId, l.deviceName) : "");
    if (monitorMode === "chunks") return shown.map((l) => ({ direction: l.direction, tag: tag(l), text: hex ? l.hex : l.text }));
    /** @type {{ direction: string, deviceId: string, tag: string, bytes: number[] }[]} */
    const blocks = [];
    for (const l of shown) {
      const last = blocks.at(-1);
      // Text is merged only within one device and direction: never across devices.
      if (last && last.direction === l.direction && last.deviceId === l.deviceId) last.bytes.push(...l.bytes);
      else blocks.push({ direction: l.direction, deviceId: l.deviceId, tag: tag(l), bytes: [...l.bytes] });
    }
    return blocks.map((b) => ({
      direction: b.direction,
      tag: b.tag,
      text: hex ? b.bytes.map((x) => x.toString(16).padStart(2, "0")).join(" ") : new TextDecoder().decode(Uint8Array.from(b.bytes)),
    }));
  }
  async function copyMonitor() {
    // Exactly what is shown, without the RX/TX badges.
    const out = monitorBlocks()
      .map((b) => (b.tag ? `[${b.tag}] ` : "") + b.text)
      .reduce((acc, t) => acc + (acc && !acc.endsWith("\n") ? "\n" : "") + t, "");
    // execCommand("copy") is synchronous inside the click and does not depend on focus/permission prompts;
    // navigator.clipboard can stay pending in some contexts, so it is the fallback and is time-limited.
    let ok = false;
    const ta = document.createElement("textarea");
    ta.value = out;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      ok = document.execCommand("copy");
    } catch {}
    ta.remove();
    if (!ok) {
      try {
        await Promise.race([navigator.clipboard.writeText(out).then(() => (ok = true)), new Promise((r) => setTimeout(r, 1000))]);
      } catch {}
    }
    setCopied(ok ? "ok" : "failed");
    setTimeout(() => setCopied(""), 2000);
  }
  function log(bytes, direction, device) {
    setLogs((old) => {
      const next = [
        ...old,
        {
          bytes,
          text: new TextDecoder().decode(bytes),
          hex: [...bytes].map((b) => b.toString(16).padStart(2, "0")).join(" "),
          direction,
          deviceId: device.id,
          deviceName: device.name,
        },
      ];
      // Keep the last 1000 chunks PER DEVICE, so a chatty device cannot push another one's history out.
      let mine = 0;
      for (const l of next) if (l.deviceId === device.id) mine++;
      if (mine <= 1000) return next;
      const drop = mine - 1000;
      let dropped = 0;
      return next.filter((l) => !(l.deviceId === device.id && dropped++ < drop));
    });
  }
  /** @param {string} op
   * @param {Row} [row]
   * @param {Record<string, unknown>} [args]
   * @param {string} [lease] */
  async function rpc(op, row, args = {}, lease) {
    /** @type {Rpc} */
    const request = {
      v: 1,
      id: crypto.randomUUID(),
      op,
      deviceId: row?.id,
      generation: row?.generation,
      deadline: Date.now() + 25000,
      args,
      lease,
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.current.delete(request.id);
        reject(Error("Request timed out. Writes are never retried automatically."));
      }, 26000);
      pending.current.set(request.id, { resolve, reject, timer });
      try {
        send({ type: "rpc", request });
      } catch (e) {
        clearTimeout(timer);
        pending.current.delete(request.id);
        reject(e);
      }
    });
  }
  async function leased(row, op, args) {
    const { lease } = await rpc("serial.acquire", row);
    try {
      return await rpc(op, row, args, lease);
    } finally {
      await rpc("serial.release", row, {}, lease).catch(() => {});
    }
  }
  useEffect(() => {
    // A remembered board that is plugged back in is shared again without a click.
    const onConnect = () => void autoShareRef.current();
    navigator.serial?.addEventListener("connect", onConnect);
    return () => navigator.serial?.removeEventListener("connect", onConnect);
  }, []);
  useEffect(() => {
    // Follow new output unless the user scrolled up to read.
    const el = monitorEnd.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight;
  }, [logs]);
  useEffect(() => {
    void loadProfiles().then(setSimProfiles);
  }, []);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    void (async () => {
      const token = new URLSearchParams(location.hash.slice(1)).get("token");
      history.replaceState(null, "", location.pathname);
      const response = await fetch(
        "/api/session",
        token
          ? {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ token }),
            }
          : {},
      );
      const data = await response.json();
      if (!response.ok) throw Error(data.error);
      setCsrf(data.csrf);
    })().catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    if (!csrf) return;
    let cancelled = false,
      /** @type {WebSocket} */
      ws;
    let retry;
    const poll = () =>
      fetch("/api/health")
        .then((r) => r.json())
        .then(setHealth)
        .catch(() => {});
    void poll();
    const poller = setInterval(poll, 15000);
    function connect() {
      ws = new WebSocket(`ws://${location.host}/ws/devices`, ["dock", csrf]);
      socket.current = ws;
      ws.onopen = () => {
        setConnected(true);
        void autoShareRef.current();
      };
      ws.onclose = () => {
        setConnected(false);
        setApprovals([]);
        // The backend dropped every share and session with the connection.
        for (const t of reconnectTimers.current.values()) clearTimeout(t);
        reconnectTimers.current.clear();
        update((old) =>
          old.map((r) => ({
            ...r,
            exposed: false,
            waitingUntil: undefined,
            flashUntil: undefined,
            flashIdle: undefined,
            probeSession: false,
            autonomousUntil: undefined,
          })),
        );
        for (const p of pending.current.values()) {
          clearTimeout(p.timer);
          p.reject(Error("Bridge disconnected"));
        }
        pending.current.clear();
        if (!cancelled) retry = setTimeout(connect, 2000);
      };
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.type === "error") setError(m.error);
        else if (m.type === "rpc-result") {
          const p = pending.current.get(m.id);
          if (p) {
            clearTimeout(p.timer);
            pending.current.delete(m.id);
            m.ok ? p.resolve(m.result) : p.reject(Error(m.error));
          }
        } else if (m.type === "approval") setApprovals((old) => [...old.filter((x) => x.deadline > Date.now()), m.request].slice(-64));
        else if (m.type === "operation") void execute(m.request);
        else if (m.type === "probe-session")
          update((old) => old.map((r) => (r.id === m.deviceId ? { ...r, probeSession: !!m.active } : r)));
        else if (m.type === "flash-session")
          update((old) =>
            old.map((r) =>
              r.id === m.deviceId ? { ...r, flashUntil: m.active ? m.until : undefined, flashIdle: m.active ? m.idle : undefined } : r,
            ),
          );
      };
    }
    /** @param {Rpc} r */
    async function execute(r) {
      let ok = false,
        err = "",
        /** @type {string | undefined} */
        data;
      try {
        parseRequest(r);
        const row = rowsRef.current.find((d) => d.id === r.deviceId && d.generation === r.generation && d.exposed);
        if (!row || r.deadline <= Date.now()) throw Error("Device revoked, stale, or deadline expired");
        if (row.waitingUntil)
          throw Error("The board dropped off USB (unplugged, or it reset) and has not come back yet; try again in a few seconds");
        // Mirrors the broker: each covered operation in a flash session moves its idle deadline on.
        if (row.flashUntil && FLASH_OPS.includes(r.op))
          update((old) => old.map((d) => (d.id === row.id ? { ...d, flashIdle: Date.now() + FLASH_IDLE_MS } : d)));
        if (r.op === "probe.transfer") {
          // DAP packets are not logged to the serial monitor: there are hundreds per second while flashing.
          if (!(row.adapter instanceof ProbeAdapter)) throw Error("Not a debug probe");
          data = encode(await row.adapter.transfer(row.id, decode(String(r.args.data))));
        } else if (r.op === "flash.open") {
          // Nothing to do on the hardware: the backend starts the session when this succeeds.
          log(new TextEncoder().encode("flash session approved"), "FLASH", row);
        } else if (r.op === "probe.open") {
          await row.adapter.open(row.id, { baudRate: 115200 });
          log(new TextEncoder().encode("debug session approved and opened"), "PROBE", row);
        } else if (r.op === "serial.write") {
          const bytes = decode(String(r.args.data));
          log(bytes, "TX", row);
          await row.adapter.write(row.id, bytes);
        } else if (r.op === "serial.signals") {
          await row.adapter.setSignals(row.id, r.args);
          log(new TextEncoder().encode(JSON.stringify(r.args)), "SIGNALS", row);
        } else if (r.op === "serial.disconnect") {
          await row.adapter.close(row.id);
          update((old) => old.map((d) => (d.id === row.id ? { ...d, open: false, exposed: false } : d)));
        } else if (r.op === "serial.connect" || r.op === "serial.configure") {
          await row.adapter.open(row.id, r.args);
          update((old) => old.map((d) => (d.id === row.id ? { ...d, open: true, baudRate: Number(r.args.baudRate) } : d)));
        } else throw Error("Unsupported operation");
        ok = true;
      } catch (e) {
        err = e.message;
      }
      try {
        send({ type: "reply", id: r.id, ok, error: err.slice(0, 300), ...(data !== undefined ? { data } : {}) });
      } catch {}
    }
    connect();
    return () => {
      cancelled = true;
      clearInterval(poller);
      clearTimeout(retry);
      ws?.close();
    };
  }, [csrf]);
  useEffect(() => {
    const t = setInterval(() => setApprovals((old) => old.filter((r) => r.deadline > Date.now())), 1000);
    return () => clearInterval(t);
  }, []);
  async function autoShare() {
    const mem = rememberedRef.current;
    if (!("serial" in navigator) || !Object.keys(mem).length) return;
    if (autoSharing.current) return;
    autoSharing.current = true;
    try {
      for (const d of await serial.listGranted()) await add(serial, d);
      for (const key of Object.keys(mem)) {
        // A board waiting to come back still counts: its identical twin must not be shared in its place.
        const same = rowsRef.current.filter((r) => r.kind === "serial" && rememberKey(r) === key && (!r.unplugged || !!r.waitingUntil));
        if (!same.length || same.some((r) => r.exposed)) continue;
        // Two boards with the same USB id look identical to the browser (WebSerial gives no serial number). Sharing
        // one of them at random could send the agent's writes to the wrong board, so neither is shared.
        if (same.length > 1) {
          setError(
            `${same.length} boards look the same to the browser (${same[0].name}), so none was shared automatically. ` +
              "Share the one you mean with Open & share.",
          );
          continue;
        }
        try {
          await expose(same[0], { baudRate: mem[key] });
        } catch (e) {
          setError(`Auto-share of ${same[0].name} failed: ${e.message}`);
        }
      }
    } finally {
      autoSharing.current = false;
    }
  }
  autoShareRef.current = autoShare;
  /** @param {any} adapter
   * @param {import("./adapters.js").Descriptor} [descriptor] */
  async function add(adapter, descriptor) {
    const d = descriptor ?? (await adapter.requestDevice());
    if (rowsRef.current.some((r) => r.id === d.id)) return;
    /** @type {Row} */
    const row = {
      ...d,
      adapter,
      generation: 1,
      open: false,
      exposed: false,
      baudRate: baud,
      autoApprove: isVirtual(d.kind),
    };
    unsubscribers.current.get(d.id)?.();
    const unsubscribe = adapter.subscribe(d.id, (event) => {
      const current = rowsRef.current.find((r) => r.id === d.id);
      if (event.type === "reconnect") {
        void reattach(d.id);
        return;
      }
      if (event.type === "data") {
        log(event.bytes, "RX", d);
        if (current?.exposed)
          for (let offset = 0; offset < event.bytes.length; offset += 16384) {
            try {
              send({
                type: "data",
                deviceId: d.id,
                generation: current.generation,
                data: encode(event.bytes.slice(offset, offset + 16384)),
              });
            } catch {}
          }
      } else {
        if (current?.waitingUntil) return; // already waiting for it (the read loop and the unplug event both report)
        setApprovals((old) => old.filter((r) => r.deviceId !== d.id));
        // A shared USB serial board stays shared for a moment: if it comes back (a reset that re-enumerates, a
        // wobbly cable) it keeps its id, generation and RFC 2217 port, and the agent's tools can carry on.
        if (current?.exposed && adapter instanceof WebSerialAdapter) {
          // What comes back is only known by its USB id, so it may be a different board of the same kind: it gets the
          // share, but not the extra trust. Autonomous mode and a flash session end now; its writes will ask again.
          const trusted = (current.autonomousUntil ?? 0) > Date.now() || !!current.flashUntil;
          try {
            if (current.flashUntil) send({ type: "flash-end", deviceId: d.id });
            if ((current.autonomousUntil ?? 0) > Date.now()) send({ type: "autonomy", deviceId: d.id, until: null });
          } catch {}
          update((old) =>
            old.map((r) =>
              r.id === d.id
                ? {
                    ...r,
                    open: false,
                    unplugged: true,
                    waitingUntil: Date.now() + RECONNECT_GRACE_MS,
                    autonomousUntil: undefined,
                    flashUntil: undefined,
                    flashIdle: undefined,
                  }
                : r,
            ),
          );
          log(
            new TextEncoder().encode(
              `dropped off USB; still shared if it is back within ${RECONNECT_GRACE_MS / 1000} s` +
                (trusted ? " (autonomous mode / the flash session ended: its writes ask again)" : ""),
            ),
            "USB",
            d,
          );
          reconnectTimers.current.set(
            d.id,
            setTimeout(() => giveUp(d.id, event.error), RECONNECT_GRACE_MS),
          );
          return;
        }
        giveUp(d.id, event.error);
      }
    });
    unsubscribers.current.set(d.id, unsubscribe);
    update((old) => [...old, row]);
  }
  /** The board did not come back in time (or was not shared): stop sharing it, as on any disconnect. */
  function giveUp(id, error) {
    clearTimeout(reconnectTimers.current.get(id));
    reconnectTimers.current.delete(id);
    const row = rowsRef.current.find((r) => r.id === id);
    if (!row) return;
    if (row.exposed)
      try {
        send({ type: "revoke", deviceId: id });
      } catch {}
    update((old) =>
      old.map((r) =>
        r.id === id
          ? {
              ...r,
              open: false,
              exposed: false,
              // Only a port that is really gone: a read error on a present port leaves it shareable again.
              unplugged: r.adapter instanceof WebSerialAdapter && r.adapter.isLost(id),
              waitingUntil: undefined,
              flashUntil: undefined,
              flashIdle: undefined,
              autonomousUntil: undefined,
              probeSession: false,
            }
          : r,
      ),
    );
    setError(`${row.name}: ${error ?? "Device disconnected"}`);
  }
  /** The same board is back (see WebSerialAdapter.register). If it is still within its grace time, reopen it. */
  async function reattach(id) {
    const row = rowsRef.current.find((r) => r.id === id);
    if (!row) return;
    const waiting = !!row.waitingUntil && row.waitingUntil > Date.now() && row.exposed;
    clearTimeout(reconnectTimers.current.get(id));
    reconnectTimers.current.delete(id);
    update((old) => old.map((r) => (r.id === id ? { ...r, unplugged: false, waitingUntil: undefined } : r)));
    if (!waiting) return;
    try {
      // Some boards need a moment after enumerating before the port opens.
      for (let attempt = 0; ; attempt++) {
        try {
          await row.adapter.open(id, parseOptions({ baudRate: row.baudRate }));
          break;
        } catch (e) {
          if (attempt >= 4) throw e;
          await new Promise((r) => setTimeout(r, 300));
        }
      }
      update((old) => old.map((r) => (r.id === id ? { ...r, open: true } : r)));
      log(new TextEncoder().encode("back on USB; still shared under the same id"), "USB", row);
    } catch (e) {
      giveUp(id, `came back but could not be reopened: ${e.message}`);
    }
  }
  /** A board picked in the browser's chooser is one the human means to use: ask straight away whether to share it. */
  async function addAndShare(adapter, descriptor) {
    await add(adapter, descriptor);
    const row = rowsRef.current.find((r) => r.id === descriptor.id);
    if (row && !row.exposed && !row.unplugged) await expose(row);
  }
  /** @param {Row} row
   * @param {{ baudRate: number }} [auto] */
  async function expose(row, auto) {
    if (
      row.kind === "probe" &&
      !(await confirmInPage(
        "Programs in the sandbox (OpenOCD, GDB) get full control of the attached chip: they can halt it, read and erase its flash, and change protection settings, which can lock a part permanently. Each debug session needs your approval (or autonomous mode). Debug probes are never shared automatically.",
        { title: `Share ${row.name} with the sandbox?`, yes: "Share probe", no: "Not now" },
      ))
    )
      return;
    if (
      !auto &&
      row.kind === "serial" &&
      !(await confirmInPage(
        "Programs in the sandbox can then send it any bytes and toggle its reset lines, which may change hardware state. Each write asks for your approval. It is shared again automatically after restarts (untick “Auto-share next time” to stop).",
        { title: `Share ${row.name} with the sandbox?`, yes: "Open & share", no: "Not now" },
      ))
    )
      return;
    const useBaud = auto?.baudRate ?? baud;
    // An already-open port is kept open: reopening can reset the attached board.
    if (!row.open) await row.adapter.open(row.id, parseOptions({ baudRate: useBaud }));
    if (row.kind === "serial" && !auto) setRemembered({ ...rememberedRef.current, [rememberKey(row)]: useBaud });
    const next = {
      ...row,
      open: true,
      exposed: true,
      generation: row.generation + 1,
      baudRate: row.open ? row.baudRate : useBaud,
    };
    update((old) => old.map((r) => (r.id === row.id ? next : r)));
    send({
      type: "expose",
      device: {
        id: next.id,
        name: next.name,
        kind: next.kind,
        generation: next.generation,
        baudRate: next.baudRate,
        autoApprove: next.autoApprove,
        ...(next.engine ? { engine: next.engine } : {}),
        ...(next.board ? { board: next.board } : {}),
      },
    });
  }
  /** @param {Row} row
   * @param {number | null} minutes
   * @returns {Promise<boolean>} */
  async function setAutonomy(row, minutes) {
    if (
      minutes !== null &&
      !(await confirmInPage(
        `Agents in the sandbox can then write to, reset and flash ${row.name} WITHOUT asking you, for ${minutes} minutes. Anything wired to the board may be affected.`,
        { title: `Autonomous mode for ${minutes} minutes?`, yes: "Turn on", no: "Cancel" },
      ))
    )
      return false;
    const until = minutes === null ? null : Date.now() + minutes * 60000;
    send({ type: "autonomy", deviceId: row.id, until });
    update((old) => old.map((r) => (r.id === row.id ? { ...r, autonomousUntil: until ?? undefined } : r)));
    return true;
  }
  function revoke(row) {
    if (rememberKey(row) in rememberedRef.current) {
      const { [rememberKey(row)]: _drop, ...rest } = rememberedRef.current;
      setRemembered(rest);
    }
    clearTimeout(reconnectTimers.current.get(row.id));
    reconnectTimers.current.delete(row.id);
    send({ type: "revoke", deviceId: row.id });
    update((old) =>
      old.map((r) =>
        r.id === row.id
          ? { ...r, exposed: false, autonomousUntil: undefined, probeSession: false, waitingUntil: undefined, flashUntil: undefined }
          : r,
      ),
    );
    setApprovals((old) => old.filter((r) => r.deviceId !== row.id));
  }
  function bytes() {
    if (!hex) return new TextEncoder().encode(text);
    const s = text.replace(/\s/g, "");
    if (!/^(?:[0-9a-fA-F]{2})*$/.test(s)) throw Error("Hex input must contain complete byte pairs");
    return Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));
  }
  const ask = approvals.length ? describe(approvals[0].op, approvals[0].args) : undefined;
  const askId = approvals[0]?.id;
  useEffect(() => setApprovalFlip(false), [askId]);
  const askRow = approvals.length ? rows.find((r) => r.id === approvals[0].deviceId) : undefined;
  /** @param {Row} row */
  function deviceCard(row) {
    return html`
      <article class="device" key=${row.id}>
        <div class="device-heading">
          <b>${row.name}</b>
          <span class=${row.waitingUntil ? "badge waiting" : row.exposed ? "badge shared" : row.unplugged ? "badge gone" : "badge"}>
            ${row.waitingUntil
              ? `Reconnecting… ${Math.min(RECONNECT_GRACE_MS / 1000, Math.max(0, Math.ceil((row.waitingUntil - now) / 1000)))}s`
              : row.exposed
                ? "Shared"
                : row.unplugged
                  ? "Unplugged"
                  : "Private"}
          </span>
        </div>
        <small>
          ${row.kind === "mock"
            ? "Browser mock"
            : row.kind === "sim"
              ? `Simulated · ${row.engine ?? "emulator"}${row.board ? ` · ${row.board}` : ""}`
              : row.kind === "probe"
                ? "Debug probe"
                : "WebSerial"}${row.kind !== "probe" && ` · ${row.baudRate} baud`} · generation ${row.generation}
        </small>
        <code class="device-id">${row.id}</code>
        <div class="row-actions">
          ${row.exposed
            ? html`<button class="danger" onClick=${() => run(async () => revoke(row))}>Revoke access</button>`
            : row.unplugged
              ? row.adapter === serial &&
                html`
                  <button
                    title="Plug it back in and it reappears here"
                    onClick=${() => {
                      unsubscribers.current.get(row.id)?.();
                      unsubscribers.current.delete(row.id);
                      serial.forget(row.id);
                      update((old) => old.filter((r) => r.id !== row.id));
                    }}
                  >
                    Remove
                  </button>
                `
              : html`<button disabled=${!connected} onClick=${() => run(() => expose(row))}>Open & share</button>`}
          ${row.kind === "probe" &&
          row.usb &&
          "serial" in navigator &&
          html`
            <button
              disabled=${!connected}
              title="The same board's serial ports: the console of the chip this probe debugs"
              onClick=${() =>
                run(async () =>
                  addAndShare(serial, await serial.requestDevice([{ usbVendorId: row.usb.vendorId, usbProductId: row.usb.productId }])),
                )}
            >
              ＋ Its serial port
            </button>
          `}
          ${row.open &&
          !row.exposed &&
          html`
            <button
              onClick=${() =>
                run(async () => {
                  await row.adapter.close(row.id);
                  update((old) => old.map((r) => (r.id === row.id ? { ...r, open: false } : r)));
                })}
            >
              Close
            </button>
          `}
          ${row.kind === "mock" && row.open && html`<button onClick=${() => mock.unplug(row.id)}>Simulate unplug</button>`}
        </div>
        ${row.kind === "sim" && row.open && row.adapter instanceof SimAdapter && html`<${SimDisplay} adapter=${row.adapter} id=${row.id} />`}
        ${row.kind === "serial" &&
        html`
          <label>
            <input
              type="checkbox"
              checked=${rememberKey(row) in remembered}
              onChange=${(e) => {
                const { [rememberKey(row)]: _drop, ...rest } = remembered;
                setRemembered(e.currentTarget.checked ? { ...rest, [rememberKey(row)]: row.baudRate } : rest);
              }}
            />${" "}Auto-share next time
          </label>
        `}
        ${row.exposed &&
        html`
          <div class="autonomy">
            ${row.autonomousUntil && row.autonomousUntil > now
              ? html`
                  <span class="badge auto">AUTONOMOUS · ${Math.max(0, Math.ceil((row.autonomousUntil - now) / 1000))}s</span>
                  <button class="danger" onClick=${() => setAutonomy(row, null)}>Turn off</button>
                `
              : html`
                  <small>Agent autonomy: off (each write asks you)</small>
                  <button onClick=${() => setAutonomy(row, 15)}>Autonomous 15 min</button>
                  <button onClick=${() => setAutonomy(row, 60)}>60 min</button>
                `}
          </div>
        `}
        ${isVirtual(row.kind) &&
        !row.exposed &&
        html`
          <label>
            <input
              type="checkbox"
              checked=${row.autoApprove}
              onChange=${(e) => {
                const on = e.currentTarget.checked;
                update((old) => old.map((r) => (r.id === row.id ? { ...r, autoApprove: on } : r)));
              }}
            />${" "}Automatic test approval
          </label>
        `}
        ${row.exposed &&
        html`
          <div class="row-actions">
            <button onClick=${() => run(() => leased(row, "serial.write", { data: encode(bytes()) }))}>Send input</button>
            <button onClick=${() => run(() => leased(row, "serial.configure", { baudRate: baud }))}>Apply baud</button>
            <button
              title="May reset hardware"
              onClick=${() => run(() => leased(row, "serial.signals", { dataTerminalReady: false, requestToSend: false }))}
            >
              DTR / RTS low
            </button>
            <button
              title="May reset hardware"
              onClick=${() => run(() => leased(row, "serial.signals", { dataTerminalReady: true, requestToSend: true }))}
            >
              DTR / RTS high
            </button>
          </div>
        `}
      </article>
    `;
  }

  function approvalDialog() {
    return html`
      <div class="approval-backdrop">
        <section class="approval panel" role="dialog" aria-label="Device operation approval">
          <div class="eyebrow">HUMAN APPROVAL REQUIRED · ${approvals.length} waiting</div>
          <h2>${ask.title}</h2>
          <p class="approval-device">
            ${askRow ? deviceLabel(askRow.id, askRow.name) : "Unknown device"} · answer within${" "}
            ${Math.max(0, Math.ceil((approvals[0].deadline - now) / 1000))} s
          </p>
          <p>${ask.detail}</p>
          ${ask.purpose &&
          html`
            <p class="approval-says">The agent says it will run (its own words, not checked):</p>
            <pre class="approval-data">${ask.purpose}</pre>
          `}
          ${ask.data &&
          html`
            <div class="approval-data-head">
              <span>
                ${ask.data.shown < ask.data.size
                  ? `First ${ask.data.shown} of ${ask.data.size} bytes`
                  : `${ask.data.size} byte${ask.data.size === 1 ? "" : "s"}`}
              </span>
              <button onClick=${() => setApprovalFlip(!approvalFlip)}>${ask.data.binary !== approvalFlip ? "As text" : "As hex"}</button>
            </div>
            <pre class="approval-data">${ask.data.binary !== approvalFlip ? ask.data.hex : ask.data.text}</pre>
          `}
          <details class="approval-raw">
            <summary>Request as sent</summary>
            <pre>${JSON.stringify(approvals[0], null, 2)}</pre>
          </details>
          <button
            class="danger"
            onClick=${() => {
              for (const a of approvals) send({ type: "approve", id: a.id, allow: false });
              setApprovals([]);
            }}
          >
            Deny all (${approvals.length})
          </button>
          <button
            class="danger"
            onClick=${() => {
              send({ type: "approve", id: approvals[0].id, allow: false });
              setApprovals((old) => old.slice(1));
            }}
          >
            Deny
          </button>
          <button
            class=${ask.session ? "primary" : ""}
            onClick=${() => {
              send({ type: "approve", id: approvals[0].id, allow: true });
              setApprovals((old) => old.slice(1));
            }}
          >
            ${ask.session ? "Allow" : "Allow once"}
          </button>
          ${!ask.session &&
          html`
            <button
              class="primary"
              onClick=${async () => {
                const dev = approvals[0].deviceId;
                const row = rowsRef.current.find((r) => r.id === dev);
                if (!row || !(await setAutonomy(row, 15))) return;
                for (const a of approvals.filter((x) => x.deviceId === dev)) send({ type: "approve", id: a.id, allow: true });
                setApprovals((old) => old.filter((x) => x.deviceId !== dev));
              }}
            >
              Allow all for 15 min
            </button>
          `}
        </section>
      </div>
    `;
  }
  return html`
    <div class="app">
      ${pendingConfirm &&
      html`
        <div class="confirm-backdrop" role="dialog" aria-modal="true">
          <div class="confirm-box">
            ${pendingConfirm.title && html`<h3>${pendingConfirm.title}</h3>`}
            <p>${pendingConfirm.message}</p>
            <div class="confirm-actions">
              <button onClick=${() => answerConfirm(false)}>${pendingConfirm.no ?? "Cancel"}</button>
              <button class="primary" ref=${confirmYes} onClick=${() => answerConfirm(true)}>${pendingConfirm.yes ?? "OK"}</button>
            </div>
          </div>
        </div>
      `}
      <header class="topbar">
        <div class="brand">
          <span class="logo">↔</span>
          <b>DeviceDock</b>
          <nav class="pages" aria-label="Pages">
            <a href="#workspace" aria-current=${page === "work" ? "page" : undefined}>Workspace</a>
            <a href="#settings" aria-current=${page === "settings" ? "page" : undefined}>
              Settings
              ${(shares?.pending || firewall?.state === "open") && html`<i class="dot muted" aria-label="needs a look" />`}
            </a>
          </nav>
        </div>
        <div class="topbar-right">
          <div class="theme-switch" role="group" aria-label="Colour theme">
            ${["system", "light", "dark"].map(
              (p) => html`
                <button
                  key=${p}
                  aria-pressed=${themeCtl.pref === p}
                  title=${p === "system" ? "Follow the system setting" : p === "light" ? "Light theme" : "Dark theme"}
                  onClick=${() => themeCtl.choose(p)}
                >
                  ${p === "system" ? "Auto" : p === "light" ? "Light" : "Dark"}
                </button>
              `,
            )}
          </div>
          <span class=${connected ? "status online" : "status"} title=${connected ? "Browser bridge online" : "Bridge offline"}>
            <i class="dot" />
            <span class="status-text">${connected ? "Browser bridge online" : "Bridge offline"}</span>
          </span>
        </div>
      </header>
      <main>
        ${error &&
        html`
          <div class="error" role="alert">
            ${error}
            <button onClick=${() => setError("")}>Dismiss</button>
          </div>
        `}
        ${page === "settings" &&
        csrf &&
        html`<${Settings}
          csrf=${csrf}
          health=${health}
          firewall=${firewall}
          setFirewall=${setFirewall}
          shares=${shares}
          setShares=${setShares}
        />`}
        <div hidden=${page === "settings" && !!csrf}>
          <div class="intro">
            <h1>Your AI agent, sandboxed, on your real hardware.</h1>
            <p>
              It never sees your home folder, passwords, keys or local network: only the boards, folders and sites you
              allow. Every write to a board waits for your OK.
            </p>
          </div>
          <${Summary}
            health=${health}
            boards=${{
              shared: rows.filter((r) => r.exposed).length,
              autonomous: rows.filter((r) => r.exposed && r.autonomousUntil && r.autonomousUntil > now).length,
              flashing: rows.filter((r) => r.exposed && flashing(r, now)).length,
            }}
            firewall=${firewall}
            shares=${shares}
            go=${go}
          />
          ${health?.error &&
          html`
            <details class="notice">
              <summary>Sandbox needs attention</summary>
              <pre>${health.error}</pre>
              <p>
                If the sandbox was just recreated, this clears in a few seconds. Otherwise, in the DeviceDock console:${" "}
                <code>rs</code> recreates the sandbox and <code>u</code> upgrades it (<code>./devicedock.sh status</code>${" "}
                shows what is wrong).
              </p>
            </details>
          `}
          <div class="workspace">
            <div class="terminals">
              ${csrf
                ? html`
                    <${Terminal} kind="shell" csrf=${csrf} />
                    <${Terminal} kind=${agent} onKind=${setAgent} csrf=${csrf} />
                  `
                : html`
                    <div class="panel empty">
                      Logged out. Run <code>./devicedock.sh</code> and type <code>o</code> for a fresh login link.
                    </div>
                  `}
            </div>
            <aside>
              <section class="panel devices" id="devices">
                <header>
                  <span>Devices <small>${rows.length} attached</small></span>
                  <span class="label">BROWSER OWNED</span>
                </header>
                <div class="device-actions">
                  <button
                    class="primary"
                    disabled=${!connected || !("serial" in navigator)}
                    onClick=${() => run(async () => addAndShare(serial, await serial.requestDevice()))}
                  >
                    ＋ Add serial port
                  </button>
                  <button
                    disabled=${!connected || !probes.supported.usb}
                    title="CMSIS-DAP v2 debug probe over WebUSB (e.g. a TI LaunchPad's XDS110)"
                    onClick=${() => run(async () => addAndShare(probes, await probes.requestUsb()))}
                  >
                    ＋ Add debug probe
                  </button>
                  <button
                    disabled=${!connected || !probes.supported.hid}
                    title="CMSIS-DAP v1 debug probe over WebHID (e.g. the SAMD11 on a XIAO nRF54L15)"
                    onClick=${() => run(async () => addAndShare(probes, await probes.requestHid()))}
                  >
                    Probe (HID)
                  </button>
                  <button disabled=${!connected} onClick=${() => run(() => add(mock))}>Add mock</button>
                  <button
                    disabled=${!connected}
                    onClick=${() =>
                      run(async () => {
                        for (const d of await serial.listGranted()) await add(serial, d);
                      })}
                  >
                    Granted ports
                  </button>
                  ${simProfiles.map(
                    (p) => html`
                      <button
                        key=${p.id}
                        title=${p.description}
                        onClick=${() =>
                          run(async () => {
                            await add(simAdapter, simAdapter.create(p));
                          })}
                      >
                        ＋ Simulated ${p.board}
                      </button>
                    `,
                  )}
                </div>
                <label class="baud">
                  Baud rate${" "}
                  <input
                    type="number"
                    min="300"
                    max="4000000"
                    value=${baud}
                    onInput=${(e) => setBaud(Number(e.currentTarget.value))}
                  />
                </label>
                ${!rows.length &&
                html`
                  <div class="empty">
                    <span class="empty-icon">⌁</span>
                    <h3>No devices shared</h3>
                    <p>Add a mock to explore the bridge, or choose a serial port.</p>
                    <small>Nothing is exposed to the container until you share it.</small>
                  </div>
                `}
                ${rows.map((row) => deviceCard(row))}
                <details class="mock-settings">
                  <summary>Mock controls</summary>
                  <label>
                    Latency (ms)
                    <input
                      type="number"
                      min="0"
                      max="10000"
                      value=${latency}
                      onInput=${(e) => {
                        const n = Math.max(0, Math.min(10000, Number(e.currentTarget.value)));
                        setLatency(n);
                        mock.latency = n;
                      }}
                    />
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked=${fail}
                      onChange=${(e) => {
                        setFail(e.currentTarget.checked);
                        mock.failWrites = e.currentTarget.checked;
                      }}
                    />${" "}Simulate write errors
                  </label>
                </details>
              </section>
              <section class="panel monitor">
                <header>
                  <span>Serial monitor</span>
                  <span class="monitor-actions">
                    <select
                      aria-label="Monitor device"
                      value=${monitorDevice === "all" || rows.some((r) => r.id === monitorDevice) ? monitorDevice : "all"}
                      onChange=${(e) => setMonitorDevice(e.currentTarget.value)}
                    >
                      <option value="all">All devices</option>
                      ${rows.map((r) => html`<option key=${r.id} value=${r.id}>${deviceLabel(r.id, r.name)}</option>`)}
                    </select>
                    <select aria-label="Monitor mode" value=${monitorMode} onChange=${(e) => setMonitorMode(e.currentTarget.value)}>
                      <option value="text">Text</option>
                      <option value="chunks">Chunks</option>
                    </select>
                    <button onClick=${() => void copyMonitor()}>
                      ${copied === "ok" ? "Copied" : copied === "failed" ? "Copy failed" : "Copy"}
                    </button>
                    <button
                      onClick=${() => setLogs((old) => (monitorDevice === "all" ? [] : old.filter((l) => l.deviceId !== monitorDevice)))}
                    >
                      Clear
                    </button>
                  </span>
                </header>
                <div class="monitor-log" aria-label="Serial monitor" ref=${monitorEnd}>
                  ${logs.length
                    ? monitorBlocks().map(
                        (b, i) => html`
                          <div key=${i}>
                            <span class=${b.direction === "TX" ? "tx" : "rx"} aria-hidden="true">${b.direction}</span>
                            ${b.tag && html`<span class="dev-chip">${b.tag}</span>`}
                            <pre>${b.text}</pre>
                          </div>
                        `,
                      )
                    : html`<p>${monitorDevice === "all" ? "Waiting for bytes…" : "Nothing from this device yet…"}</p>`}
                </div>
                <div class="composer">
                  <label>
                    <input type="checkbox" checked=${hex} onChange=${(e) => setHex(e.currentTarget.checked)} />${" "}Hexadecimal
                  </label>
                  <textarea
                    aria-label="Serial input"
                    value=${text}
                    onInput=${(e) => setText(e.currentTarget.value)}
                    maxLength=${32768}
                  />
                  <small>Use “Send input” on a shared device. UI sends acquire the same exclusive lease as container clients.</small>
                </div>
              </section>
            </aside>
          </div>
          <footer>Loopback only · Browser permission + explicit sharing · No host device mounts</footer>
        </div>
      </main>
      ${csrf && html`<${FirewallAsks} csrf=${csrf} view=${firewall} setView=${setFirewall} />`}
      ${rows.some((r) => r.exposed && (r.probeSession || flashing(r, now))) &&
      html`
        <div class="probe-banner" role="status">
          ${rows
            .filter((r) => r.exposed && flashing(r, now))
            .map(
              (r) => html`
                <div key=${r.id}>
                  <span>
                    <i class="dot" /> FLASH SESSION · ${deviceLabel(r.id, r.name)}: writes and resets run without asking, for${" "}
                    ${Math.min(FLASH_MAX_MS / 60000, Math.max(0, Math.ceil((r.flashUntil - now) / 60000)))} min at most
                  </span>
                  <button
                    class="danger"
                    onClick=${() => {
                      try {
                        send({ type: "flash-end", deviceId: r.id });
                      } catch {}
                      update((old) => old.map((x) => (x.id === r.id ? { ...x, flashUntil: undefined } : x)));
                    }}
                  >
                    Cut off
                  </button>
                </div>
              `,
            )}
          ${rows
            .filter((r) => r.probeSession && r.exposed)
            .map(
              (r) => html`
                <div key=${r.id}>
                  <span>
                    <i class="dot" /> DEBUG SESSION ACTIVE · ${deviceLabel(r.id, r.name)}: agents can halt, read and flash this
                    chip without further approval
                  </span>
                  <button
                    class="danger"
                    onClick=${() => {
                      try {
                        send({ type: "probe-end", deviceId: r.id });
                      } catch {}
                      update((old) => old.map((x) => (x.id === r.id ? { ...x, probeSession: false } : x)));
                    }}
                  >
                    Cut off
                  </button>
                </div>
              `,
            )}
        </div>
      `}
      ${approvals.length > 0 && approvalDialog()}
    </div>
  `;
}
render(html`<${App} />`, document.getElementById("root"));
