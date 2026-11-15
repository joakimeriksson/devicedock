import {
  request as protocolRequest,
  options as serialOptions, isPhysical, isVirtual, FLASH_IDLE_MS, FLASH_MAX_MS, FLASH_OPS } from "../../../packages/protocol/index.ts";
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  MockAdapter,
  WebSerialAdapter,
  encode,
  decode,
  type Descriptor,
  type DeviceAdapter,
} from "./adapters";
import { Terminal, type TerminalKind } from "./Terminal";
import { FirewallAsks, type FirewallView } from "./Network";
import type { SharesView } from "./Shares";
import { Settings } from "./Settings";
import { Summary } from "./Summary";
import { usePoll } from "./access";
import { describe } from "./approval";
import { migrateRememberKey, usbKey } from "./usb";
import { useTheme, type ThemePref } from "./theme";
import "./sim/engines";
import { SimAdapter } from "./sim/SimAdapter";
import { ProbeAdapter } from "./probe";
import { SimDisplay } from "./sim/SimDisplay";
import { loadProfiles } from "./sim/registry";
import type { SimProfile } from "./sim/types";
import "./style.css";
type Row = Descriptor & {
  adapter: DeviceAdapter;
  generation: number;
  open: boolean;
  exposed: boolean;
  baudRate: number;
  autoApprove: boolean;
  autonomousUntil?: number;
  /** Debug probe: an approved session is active (agents' OpenOCD can drive the chip without further clicks). */
  probeSession?: boolean;
  /** The port is gone (unplugged, or the board reset and dropped off USB). */
  unplugged?: boolean;
  /** A shared board that went away stays shared, under the same id, if it comes back before this time. */
  waitingUntil?: number;
  /** An approved flash session: its hard end and its idle deadline (the broker's, moved on by each write in it). */
  flashUntil?: number;
  flashIdle?: number;
};
/** How long a shared board may be gone and still come back shared: an ESP32-S3 or RP2040 reset takes a second or two. */
const RECONNECT_GRACE_MS = 15000;
const flashing = (r: Row, now: number) => !!r.flashUntil && r.flashUntil > now && (r.flashIdle ?? 0) > now;
type Rpc = {
  v: 1;
  id: string;
  op: string;
  deviceId?: string;
  generation?: number;
  lease?: string;
  deadline: number;
  args: Record<string, unknown>;
};
// Serial ports the owner chose to keep sharing across restarts (USB id -> baud). Autonomous mode is
// never remembered. Per-browser convenience only, so failures to read/write storage are ignored.
const REMEMBER_KEY = "devicedock.autoshare";
function loadRemembered(): Record<string, number> {
  try {
    const v = JSON.parse(localStorage.getItem(REMEMBER_KEY) ?? "{}");
    if (!v || typeof v !== "object") return {};
    return Object.fromEntries(Object.entries(v).map(([k, baud]) => [migrateRememberKey(k), baud as number]));
  } catch {
    return {};
  }
}
/** What auto-share remembers a board by: its USB id ("10c4:ea60"), else its name. */
const rememberKey = (r: Pick<Descriptor, "usb" | "name">) => (r.usb ? usbKey(r.usb) : r.name);
function saveRemembered(m: Record<string, number>) {
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
  type Confirm = { message: string; title?: string; yes?: string; no?: string };
  const [pendingConfirm, setPendingConfirm] = useState<Confirm & { resolve: (ok: boolean) => void }>();
  const confirmInPage = (message: string, words: Omit<Confirm, "message"> = {}) =>
    new Promise<boolean>((resolve) => setPendingConfirm({ message, ...words, resolve }));
  const answerConfirm = (ok: boolean) => {
    pendingConfirm?.resolve(ok);
    setPendingConfirm(undefined);
  };
  const [csrf, setCsrf] = useState(""),
    [error, setError] = useState(""),
    [health, setHealth] = useState<any>(),
    [connected, setConnected] = useState(false),
    [rows, setRows] = useState<Row[]>([]),
    [logs, setLogs] = useState<
      { bytes: Uint8Array; text: string; hex: string; direction: string; deviceId: string; deviceName: string }[]
    >([]),
    [monitorDevice, setMonitorDevice] = useState<string>("all"),
    [monitorMode, setMonitorMode] = useState<"text" | "chunks">("text"),
    [copied, setCopied] = useState<"" | "ok" | "failed">(""),
    [approvals, setApprovals] = useState<Rpc[]>([]),
    // Flips the approval dialog's byte view: binary shows as hex by default, text as text.
    [approvalFlip, setApprovalFlip] = useState(false),
    [text, setText] = useState("PING\n"),
    [hex, setHex] = useState(false),
    [baud, setBaud] = useState(115200),
    [latency, setLatency] = useState(20),
    [fail, setFail] = useState(false),
    [agent, setAgent] = useState<Exclude<TerminalKind, "shell">>("codex"),
    [now, setNow] = useState(Date.now()),
    [remembered, setRememberedState] = useState(loadRemembered),
    [simProfiles, setSimProfiles] = useState<SimProfile[]>([]);
  const themeCtl = useTheme();
  // Two pages in one: the workspace (terminals, boards) and settings (internet, folders, agent updates). The workspace
  // stays mounted while settings are open, so terminals and shared boards keep running.
  const pageOf = () => (location.hash.startsWith("#settings") ? "settings" : "work");
  const [page, setPage] = useState<"work" | "settings">(pageOf);
  useEffect(() => {
    const onHash = () => setPage(pageOf());
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);
  function go(where: string) {
    const settings = where !== "devices";
    location.hash = settings ? `#settings-${where}` : "#workspace";
    setPage(settings ? "settings" : "work");
    setTimeout(() => document.getElementById(where)?.scrollIntoView({ block: "start" }), 50);
  }
  // Polled here, not in the panels: the summary and the firewall's questions need them on both pages.
  const [firewall, setFirewall] = usePoll<FirewallView>("/api/firewall", 1500, !!csrf);
  const [shares, setShares] = usePoll<SharesView>("/api/shares", 5000, !!csrf);
  const rememberedRef = useRef(remembered),
    autoShareRef = useRef<() => Promise<void>>(async () => {}),
    autoSharing = useRef(false);
  function setRemembered(next: Record<string, number>) {
    rememberedRef.current = next;
    setRememberedState(next);
    saveRemembered(next);
  }
  const monitorEnd = useRef<HTMLDivElement>(null);
  const reconnectTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  // One data/disconnect handler per device, however often it is added (a re-added row must not double the data).
  const unsubscribers = useRef(new Map<string, () => void>());
  const socket = useRef<WebSocket | null>(null),
    rowsRef = useRef<Row[]>([]),
    pending = useRef(
      new Map<
        string,
        {
          resolve: (v: any) => void;
          reject: (e: Error) => void;
          timer: ReturnType<typeof setTimeout>;
        }
      >(),
    );
  const update = (fn: (old: Row[]) => Row[]) => {
    const next = fn(rowsRef.current);
    rowsRef.current = next;
    setRows(next);
  };
  function send(m: unknown) {
    if (socket.current?.readyState !== 1)
      throw Error("Browser bridge disconnected");
    socket.current.send(JSON.stringify(m));
  }
  const run = (fn: () => Promise<unknown>) => {
    setError("");
    void fn().catch((e) => setError(e.message));
  };
  // Text mode joins consecutive chunks of one direction into a continuous stream (decoded once, so a
  // multi-byte character split across chunks stays intact); chunk mode keeps one row per received piece.
  // Unique, readable device names (two boards with the same name get a short id suffix).
  function deviceLabel(id: string, name: string) {
    const same = rows.filter((r) => r.name === name).length > 1;
    return same ? `${name} (${id.slice(0, 4)})` : name;
  }
  function monitorBlocks() {
    const shown = monitorDevice === "all" ? logs : logs.filter((l) => l.deviceId === monitorDevice);
    // Name a block's device only when several devices are mixed in this view.
    const mixed = new Set(shown.map((l) => l.deviceId)).size > 1;
    const tag = (l: { deviceId: string; deviceName: string }) => (mixed ? deviceLabel(l.deviceId, l.deviceName) : "");
    if (monitorMode === "chunks")
      return shown.map((l) => ({ direction: l.direction, tag: tag(l), text: hex ? l.hex : l.text }));
    const blocks: { direction: string; deviceId: string; tag: string; bytes: number[] }[] = [];
    for (const l of shown) {
      const last = blocks.at(-1);
      // Text is merged only within one device and direction: never across devices.
      if (last && last.direction === l.direction && last.deviceId === l.deviceId) last.bytes.push(...l.bytes);
      else blocks.push({ direction: l.direction, deviceId: l.deviceId, tag: tag(l), bytes: [...l.bytes] });
    }
    return blocks.map((b) => ({
      direction: b.direction,
      tag: b.tag,
      text: hex
        ? b.bytes.map((x) => x.toString(16).padStart(2, "0")).join(" ")
        : new TextDecoder().decode(Uint8Array.from(b.bytes)),
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
        await Promise.race([
          navigator.clipboard.writeText(out).then(() => (ok = true)),
          new Promise((r) => setTimeout(r, 1000)),
        ]);
      } catch {}
    }
    setCopied(ok ? "ok" : "failed");
    setTimeout(() => setCopied(""), 2000);
  }
  function log(bytes: Uint8Array, direction: string, device: { id: string; name: string }) {
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
  async function rpc(
    op: string,
    row?: Row,
    args: Record<string, unknown> = {},
    lease?: string,
  ) {
    const request: Rpc = {
      v: 1,
      id: crypto.randomUUID(),
      op,
      deviceId: row?.id,
      generation: row?.generation,
      deadline: Date.now() + 25000,
      args,
      lease,
    };
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.current.delete(request.id);
        reject(
          Error("Request timed out. Writes are never retried automatically."),
        );
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
  async function leased(row: Row, op: string, args: Record<string, unknown>) {
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
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80)
      el.scrollTop = el.scrollHeight;
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
      ws: WebSocket;
    let retry: ReturnType<typeof setTimeout>;
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
        } else if (m.type === "approval")
          setApprovals((old) =>
            [...old.filter((x) => x.deadline > Date.now()), m.request].slice(
              -64,
            ),
          );
        else if (m.type === "operation") void execute(m.request);
        else if (m.type === "probe-session")
          update((old) => old.map((r) => (r.id === m.deviceId ? { ...r, probeSession: !!m.active } : r)));
        else if (m.type === "flash-session")
          update((old) =>
            old.map((r) =>
              r.id === m.deviceId
                ? { ...r, flashUntil: m.active ? m.until : undefined, flashIdle: m.active ? m.idle : undefined }
                : r,
            ),
          );
      };
    }
    async function execute(r: Rpc) {
      let ok = false,
        err = "",
        data: string | undefined;
      try {
        protocolRequest.parse(r);
        const row = rowsRef.current.find(
          (d) =>
            d.id === r.deviceId && d.generation === r.generation && d.exposed,
        );
        if (!row || r.deadline <= Date.now())
          throw Error("Device revoked, stale, or deadline expired");
        if (row.waitingUntil)
          throw Error("The board dropped off USB (unplugged, or it reset) and has not come back yet; try again in a few seconds");
        // Mirrors the broker: each covered operation in a flash session moves its idle deadline on.
        if (row.flashUntil && FLASH_OPS.includes(r.op))
          update((old) => old.map((d) => (d.id === row.id ? { ...d, flashIdle: Date.now() + FLASH_IDLE_MS } : d)));
        if (r.op === "probe.transfer") {
          // DAP packets are not logged to the serial monitor: there are hundreds per second while flashing.
          if (!(row.adapter instanceof ProbeAdapter)) throw Error("Not a debug probe");
          data = encode(await row.adapter.transfer(row.id, decode(r.args.data as string)));
        } else if (r.op === "flash.open") {
          // Nothing to do on the hardware: the backend starts the session when this succeeds.
          log(new TextEncoder().encode("flash session approved"), "FLASH", row);
        } else if (r.op === "probe.open") {
          await row.adapter.open(row.id, { baudRate: 115200 });
          log(new TextEncoder().encode("debug session approved and opened"), "PROBE", row);
        } else if (r.op === "serial.write") {
          const bytes = decode(r.args.data as string);
          log(bytes, "TX", row);
          await row.adapter.write(row.id, bytes);
        } else if (r.op === "serial.signals") {
          await row.adapter.setSignals(row.id, r.args);
          log(new TextEncoder().encode(JSON.stringify(r.args)), "SIGNALS", row);
        } else if (r.op === "serial.disconnect") {
          await row.adapter.close(row.id);
          update((old) =>
            old.map((d) =>
              d.id === row.id ? { ...d, open: false, exposed: false } : d,
            ),
          );
        } else if (r.op === "serial.connect" || r.op === "serial.configure") {
          await row.adapter.open(row.id, r.args as { baudRate: number });
          update((old) =>
            old.map((d) =>
              d.id === row.id
                ? { ...d, open: true, baudRate: r.args.baudRate as number }
                : d,
            ),
          );
        } else throw Error("Unsupported operation");
        ok = true;
      } catch (e) {
        err = (e as Error).message;
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
    const t = setInterval(
      () => setApprovals((old) => old.filter((r) => r.deadline > Date.now())),
      1000,
    );
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
        const same = rowsRef.current.filter(
          (r) => r.kind === "serial" && rememberKey(r) === key && (!r.unplugged || !!r.waitingUntil),
        );
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
          setError(`Auto-share of ${same[0].name} failed: ${(e as Error).message}`);
        }
      }
    } finally {
      autoSharing.current = false;
    }
  }
  autoShareRef.current = autoShare;
  async function add(adapter: DeviceAdapter, descriptor?: Descriptor) {
    const d = descriptor ?? (await adapter.requestDevice());
    if (rowsRef.current.some((r) => r.id === d.id)) return;
    const row: Row = {
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
          reconnectTimers.current.set(d.id, setTimeout(() => giveUp(d.id, event.error), RECONNECT_GRACE_MS));
          return;
        }
        giveUp(d.id, event.error);
      }
    });
    unsubscribers.current.set(d.id, unsubscribe);
    update((old) => [...old, row]);
  }
  /** The board did not come back in time (or was not shared): stop sharing it, as on any disconnect. */
  function giveUp(id: string, error?: string) {
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
  async function reattach(id: string) {
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
          await row.adapter.open(id, serialOptions.parse({ baudRate: row.baudRate }));
          break;
        } catch (e) {
          if (attempt >= 4) throw e;
          await new Promise((r) => setTimeout(r, 300));
        }
      }
      update((old) => old.map((r) => (r.id === id ? { ...r, open: true } : r)));
      log(new TextEncoder().encode("back on USB; still shared under the same id"), "USB", row);
    } catch (e) {
      giveUp(id, `came back but could not be reopened: ${(e as Error).message}`);
    }
  }
  /** A board picked in the browser's chooser is one the human means to use: ask straight away whether to share it. */
  async function addAndShare(adapter: DeviceAdapter, descriptor: Descriptor) {
    await add(adapter, descriptor);
    const row = rowsRef.current.find((r) => r.id === descriptor.id);
    if (row && !row.exposed && !row.unplugged) await expose(row);
  }
  async function expose(row: Row, auto?: { baudRate: number }) {
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
    if (!row.open)
      await row.adapter.open(row.id, serialOptions.parse({ baudRate: useBaud }));
    if (row.kind === "serial" && !auto)
      setRemembered({ ...rememberedRef.current, [rememberKey(row)]: useBaud });
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
  async function setAutonomy(row: Row, minutes: number | null): Promise<boolean> {
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
    update((old) =>
      old.map((r) =>
        r.id === row.id ? { ...r, autonomousUntil: until ?? undefined } : r,
      ),
    );
    return true;
  }
  function revoke(row: Row) {
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
    if (!/^(?:[0-9a-fA-F]{2})*$/.test(s))
      throw Error("Hex input must contain complete byte pairs");
    return Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));
  }
  const ask = approvals.length ? describe(approvals[0].op, approvals[0].args) : undefined!;
  const askId = approvals[0]?.id;
  useEffect(() => setApprovalFlip(false), [askId]);
  const askRow = approvals.length ? rows.find((r) => r.id === approvals[0].deviceId) : undefined;
  return (
    <div className="app">
      {pendingConfirm && (
        <div className="confirm-backdrop" role="dialog" aria-modal="true">
          <div className="confirm-box">
            {pendingConfirm.title && <h3>{pendingConfirm.title}</h3>}
            <p>{pendingConfirm.message}</p>
            <div className="confirm-actions">
              <button onClick={() => answerConfirm(false)}>{pendingConfirm.no ?? "Cancel"}</button>
              <button className="primary" autoFocus onClick={() => answerConfirm(true)}>
                {pendingConfirm.yes ?? "OK"}
              </button>
            </div>
          </div>
        </div>
      )}
      <header className="topbar">
        <div className="brand">
          <span className="logo">↔</span>
          <b>DeviceDock</b>
          <nav className="pages" aria-label="Pages">
            <a href="#workspace" aria-current={page === "work" ? "page" : undefined}>
              Workspace
            </a>
            <a href="#settings" aria-current={page === "settings" ? "page" : undefined}>
              Settings
              {(shares?.pending || firewall?.state === "open") && <i className="dot muted" aria-label="needs a look" />}
            </a>
          </nav>
        </div>
        <div className="topbar-right">
          <div className="theme-switch" role="group" aria-label="Colour theme">
            {(["system", "light", "dark"] as ThemePref[]).map((p) => (
              <button
                key={p}
                aria-pressed={themeCtl.pref === p}
                title={
                  p === "system"
                    ? "Follow the system setting"
                    : p === "light"
                      ? "Light theme"
                      : "Dark theme"
                }
                onClick={() => themeCtl.choose(p)}
              >
                {p === "system" ? "Auto" : p === "light" ? "Light" : "Dark"}
              </button>
            ))}
          </div>
          <span className={connected ? "status online" : "status"} title={connected ? "Browser bridge online" : "Bridge offline"}>
            <i className="dot" />
            <span className="status-text">{connected ? "Browser bridge online" : "Bridge offline"}</span>
          </span>
        </div>
      </header>
      <main>
        {error && (
          <div className="error" role="alert">
            {error}
            <button onClick={() => setError("")}>Dismiss</button>
          </div>
        )}
        {page === "settings" && csrf && (
          <Settings
            csrf={csrf}
            health={health}
            firewall={firewall}
            setFirewall={setFirewall}
            shares={shares}
            setShares={setShares}
          />
        )}
        <div hidden={page === "settings" && !!csrf}>
        <div className="intro">
          <h1>Your AI agent, sandboxed, on your real hardware.</h1>
          <p>
            It never sees your home folder, passwords, keys or local network: only the boards, folders and sites you
            allow. Every write to a board waits for your OK.
          </p>
        </div>
        <Summary
          health={health}
          boards={{
            shared: rows.filter((r) => r.exposed).length,
            autonomous: rows.filter((r) => r.exposed && r.autonomousUntil && r.autonomousUntil > now).length,
            flashing: rows.filter((r) => r.exposed && flashing(r, now)).length,
          }}
          firewall={firewall}
          shares={shares}
          go={go}
        />
        {health?.error && (
          <details className="notice">
            <summary>Sandbox needs attention</summary>
            <pre>{health.error}</pre>
            <p>
              If the sandbox was just recreated, this clears in a few seconds. Otherwise, in the DeviceDock console:{" "}
              <code>rs</code> recreates the sandbox and <code>u</code> upgrades it (<code>./devicedock.sh status</code>{" "}
              shows what is wrong).
            </p>
          </details>
        )}
        <div className="workspace">
          <div className="terminals">
            {csrf ? (
              <>
                <Terminal kind="shell" csrf={csrf} />
                <Terminal kind={agent} onKind={setAgent} csrf={csrf} />
              </>
            ) : (
              <div className="panel empty">
                Logged out. Run <code>./devicedock.sh</code> and type <code>o</code> for a
                fresh login link.
              </div>
            )}
          </div>
          <aside>
            <section className="panel devices" id="devices">
              <header>
                <span>
                  Devices <small>{rows.length} attached</small>
                </span>
                <span className="label">BROWSER OWNED</span>
              </header>
              <div className="device-actions">
                <button
                  className="primary"
                  disabled={!connected || !("serial" in navigator)}
                  onClick={() => run(async () => addAndShare(serial, await serial.requestDevice()))}
                >
                  ＋ Add serial port
                </button>
                <button
                  disabled={!connected || !probes.supported.usb}
                  title="CMSIS-DAP v2 debug probe over WebUSB (e.g. a TI LaunchPad's XDS110)"
                  onClick={() => run(async () => addAndShare(probes, await probes.requestUsb()))}
                >
                  ＋ Add debug probe
                </button>
                <button
                  disabled={!connected || !probes.supported.hid}
                  title="CMSIS-DAP v1 debug probe over WebHID (e.g. the SAMD11 on a XIAO nRF54L15)"
                  onClick={() => run(async () => addAndShare(probes, await probes.requestHid()))}
                >
                  Probe (HID)
                </button>
                <button
                  disabled={!connected}
                  onClick={() => run(() => add(mock))}
                >
                  Add mock
                </button>
                <button
                  disabled={!connected}
                  onClick={() =>
                    run(async () => {
                      for (const d of await serial.listGranted())
                        await add(serial, d);
                    })
                  }
                >
                  Granted ports
                </button>
                {simProfiles.map((p) => (
                  <button
                    key={p.id}
                    title={p.description}
                    onClick={() =>
                      run(async () => {
                        await add(simAdapter, simAdapter.create(p));
                      })
                    }
                  >
                    ＋ Simulated {p.board}
                  </button>
                ))}
              </div>
              <label className="baud">
                Baud rate{" "}
                <input
                  type="number"
                  min="300"
                  max="4000000"
                  value={baud}
                  onChange={(e) => setBaud(Number(e.target.value))}
                />
              </label>
              {!rows.length && (
                <div className="empty">
                  <span className="empty-icon">⌁</span>
                  <h3>No devices shared</h3>
                  <p>
                    Add a mock to explore the bridge, or choose a serial port.
                  </p>
                  <small>
                    Nothing is exposed to the container until you share it.
                  </small>
                </div>
              )}
              {rows.map((row) => (
                <article className="device" key={row.id}>
                  <div className="device-heading">
                    <b>{row.name}</b>
                    <span
                      className={
                        row.waitingUntil ? "badge waiting" : row.exposed ? "badge shared" : row.unplugged ? "badge gone" : "badge"
                      }
                    >
                      {row.waitingUntil
                        ? `Reconnecting… ${Math.min(RECONNECT_GRACE_MS / 1000, Math.max(0, Math.ceil((row.waitingUntil - now) / 1000)))}s`
                        : row.exposed
                          ? "Shared"
                          : row.unplugged
                            ? "Unplugged"
                            : "Private"}
                    </span>
                  </div>
                  <small>
                    {row.kind === "mock"
                      ? "Browser mock"
                      : row.kind === "sim"
                        ? `Simulated · ${row.engine ?? "emulator"}${row.board ? ` · ${row.board}` : ""}`
                        : row.kind === "probe"
                          ? "Debug probe"
                          : "WebSerial"}
                    {row.kind !== "probe" && ` · ${row.baudRate} baud`} · generation {row.generation}
                  </small>
                  <code className="device-id">{row.id}</code>
                  <div className="row-actions">
                    {row.exposed ? (
                      <button
                        className="danger"
                        onClick={() => run(async () => revoke(row))}
                      >
                        Revoke access
                      </button>
                    ) : row.unplugged ? (
                      row.adapter === serial && (
                        <button
                          title="Plug it back in and it reappears here"
                          onClick={() => {
                            unsubscribers.current.get(row.id)?.();
                            unsubscribers.current.delete(row.id);
                            serial.forget(row.id);
                            update((old) => old.filter((r) => r.id !== row.id));
                          }}
                        >
                          Remove
                        </button>
                      )
                    ) : (
                      <button
                        disabled={!connected}
                        onClick={() => run(() => expose(row))}
                      >
                        Open & share
                      </button>
                    )}
                    {row.kind === "probe" && row.usb && "serial" in navigator && (
                      <button
                        disabled={!connected}
                        title="The same board's serial ports: the console of the chip this probe debugs"
                        onClick={() =>
                          run(async () =>
                            addAndShare(
                              serial,
                              await serial.requestDevice([
                                { usbVendorId: row.usb!.vendorId, usbProductId: row.usb!.productId },
                              ]),
                            ),
                          )
                        }
                      >
                        ＋ Its serial port
                      </button>
                    )}
                    {row.open && !row.exposed && (
                      <button
                        onClick={() =>
                          run(async () => {
                            await row.adapter.close(row.id);
                            update((old) =>
                              old.map((r) =>
                                r.id === row.id ? { ...r, open: false } : r,
                              ),
                            );
                          })
                        }
                      >
                        Close
                      </button>
                    )}
                    {row.kind === "mock" && row.open && (
                      <button onClick={() => mock.unplug(row.id)}>
                        Simulate unplug
                      </button>
                    )}
                  </div>
                  {row.kind === "sim" && row.open && row.adapter instanceof SimAdapter && (
                    <SimDisplay adapter={row.adapter} id={row.id} />
                  )}
                  {row.kind === "serial" && (
                    <label>
                      <input
                        type="checkbox"
                        checked={rememberKey(row) in remembered}
                        onChange={(e) => {
                          const { [rememberKey(row)]: _drop, ...rest } = remembered;
                          setRemembered(
                            e.target.checked
                              ? { ...rest, [rememberKey(row)]: row.baudRate }
                              : rest,
                          );
                        }}
                      />{" "}
                      Auto-share next time
                    </label>
                  )}
                  {row.exposed && (
                    <div className="autonomy">
                      {row.autonomousUntil && row.autonomousUntil > now ? (
                        <>
                          <span className="badge auto">
                            AUTONOMOUS ·{" "}
                            {Math.max(0, Math.ceil((row.autonomousUntil - now) / 1000))}s
                          </span>
                          <button
                            className="danger"
                            onClick={() => setAutonomy(row, null)}
                          >
                            Turn off
                          </button>
                        </>
                      ) : (
                        <>
                          <small>Agent autonomy: off (each write asks you)</small>
                          <button onClick={() => setAutonomy(row, 15)}>
                            Autonomous 15 min
                          </button>
                          <button onClick={() => setAutonomy(row, 60)}>
                            60 min
                          </button>
                        </>
                      )}
                    </div>
                  )}
                  {isVirtual(row.kind) && !row.exposed && (
                    <label>
                      <input
                        type="checkbox"
                        checked={row.autoApprove}
                        onChange={(e) =>
                          update((old) =>
                            old.map((r) =>
                              r.id === row.id
                                ? { ...r, autoApprove: e.target.checked }
                                : r,
                            ),
                          )
                        }
                      />{" "}
                      Automatic test approval
                    </label>
                  )}
                  {row.exposed && (
                    <div className="row-actions">
                      <button
                        onClick={() =>
                          run(() =>
                            leased(row, "serial.write", {
                              data: encode(bytes()),
                            }),
                          )
                        }
                      >
                        Send input
                      </button>
                      <button
                        onClick={() =>
                          run(() =>
                            leased(row, "serial.configure", { baudRate: baud }),
                          )
                        }
                      >
                        Apply baud
                      </button>
                      <button
                        title="May reset hardware"
                        onClick={() =>
                          run(() =>
                            leased(row, "serial.signals", {
                              dataTerminalReady: false,
                              requestToSend: false,
                            }),
                          )
                        }
                      >
                        DTR / RTS low
                      </button>
                      <button
                        title="May reset hardware"
                        onClick={() =>
                          run(() =>
                            leased(row, "serial.signals", {
                              dataTerminalReady: true,
                              requestToSend: true,
                            }),
                          )
                        }
                      >
                        DTR / RTS high
                      </button>
                    </div>
                  )}
                </article>
              ))}
              <details className="mock-settings">
                <summary>Mock controls</summary>
                <label>
                  Latency (ms)
                  <input
                    type="number"
                    min="0"
                    max="10000"
                    value={latency}
                    onChange={(e) => {
                      const n = Math.max(
                        0,
                        Math.min(10000, Number(e.target.value)),
                      );
                      setLatency(n);
                      mock.latency = n;
                    }}
                  />
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={fail}
                    onChange={(e) => {
                      setFail(e.target.checked);
                      mock.failWrites = e.target.checked;
                    }}
                  />{" "}
                  Simulate write errors
                </label>
              </details>
            </section>
            <section className="panel monitor">
              <header>
                <span>Serial monitor</span>
                <span className="monitor-actions">
                  <select
                    aria-label="Monitor device"
                    value={monitorDevice === "all" || rows.some((r) => r.id === monitorDevice) ? monitorDevice : "all"}
                    onChange={(e) => setMonitorDevice(e.target.value)}
                  >
                    <option value="all">All devices</option>
                    {rows.map((r) => (
                      <option key={r.id} value={r.id}>
                        {deviceLabel(r.id, r.name)}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label="Monitor mode"
                    value={monitorMode}
                    onChange={(e) =>
                      setMonitorMode(e.target.value as "text" | "chunks")
                    }
                  >
                    <option value="text">Text</option>
                    <option value="chunks">Chunks</option>
                  </select>
                  <button onClick={() => void copyMonitor()}>
                    {copied === "ok" ? "Copied" : copied === "failed" ? "Copy failed" : "Copy"}
                  </button>
                  <button
                    onClick={() =>
                      setLogs((old) => (monitorDevice === "all" ? [] : old.filter((l) => l.deviceId !== monitorDevice)))
                    }
                  >
                    Clear
                  </button>
                </span>
              </header>
              <div
                className="monitor-log"
                aria-label="Serial monitor"
                ref={monitorEnd}
              >
                {logs.length ? (
                  monitorBlocks().map((b, i) => (
                    <div key={i}>
                      <span
                        className={b.direction === "TX" ? "tx" : "rx"}
                        aria-hidden="true"
                      >
                        {b.direction}
                      </span>
                      {b.tag && <span className="dev-chip">{b.tag}</span>}
                      <pre>{b.text}</pre>
                    </div>
                  ))
                ) : (
                  <p>{monitorDevice === "all" ? "Waiting for bytes…" : "Nothing from this device yet…"}</p>
                )}
              </div>
              <div className="composer">
                <label>
                  <input
                    type="checkbox"
                    checked={hex}
                    onChange={(e) => setHex(e.target.checked)}
                  />{" "}
                  Hexadecimal
                </label>
                <textarea
                  aria-label="Serial input"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  maxLength={32768}
                />
                <small>
                  Use “Send input” on a shared device. UI sends acquire the same
                  exclusive lease as container clients.
                </small>
              </div>
            </section>
          </aside>
        </div>
        <footer>
          Loopback only · Browser permission + explicit sharing · No host device
          mounts
        </footer>
        </div>
      </main>
      {csrf && <FirewallAsks csrf={csrf} view={firewall} setView={setFirewall} />}
      {rows.some((r) => r.exposed && (r.probeSession || flashing(r, now))) && (
        <div className="probe-banner" role="status">
          {rows
            .filter((r) => r.exposed && flashing(r, now))
            .map((r) => (
              <div key={r.id}>
                <span>
                  <i className="dot" /> FLASH SESSION · {deviceLabel(r.id, r.name)}: writes and resets run without asking,
                  for {Math.min(FLASH_MAX_MS / 60000, Math.max(0, Math.ceil((r.flashUntil! - now) / 60000)))} min at most
                </span>
                <button
                  className="danger"
                  onClick={() => {
                    try {
                      send({ type: "flash-end", deviceId: r.id });
                    } catch {}
                    update((old) => old.map((x) => (x.id === r.id ? { ...x, flashUntil: undefined } : x)));
                  }}
                >
                  Cut off
                </button>
              </div>
            ))}
          {rows
            .filter((r) => r.probeSession && r.exposed)
            .map((r) => (
              <div key={r.id}>
                <span>
                  <i className="dot" /> DEBUG SESSION ACTIVE · {deviceLabel(r.id, r.name)}: agents can halt, read and
                  flash this chip without further approval
                </span>
                <button
                  className="danger"
                  onClick={() => {
                    try {
                      send({ type: "probe-end", deviceId: r.id });
                    } catch {}
                    update((old) => old.map((x) => (x.id === r.id ? { ...x, probeSession: false } : x)));
                  }}
                >
                  Cut off
                </button>
              </div>
            ))}
        </div>
      )}
      {approvals.length > 0 && (
        <div className="approval-backdrop">
          <section
            className="approval panel"
            role="dialog"
            aria-label="Device operation approval"
          >
            <div className="eyebrow">
              HUMAN APPROVAL REQUIRED · {approvals.length} waiting
            </div>
            <h2>{ask.title}</h2>
            <p className="approval-device">
              {askRow ? deviceLabel(askRow.id, askRow.name) : "Unknown device"} · answer within{" "}
              {Math.max(0, Math.ceil((approvals[0].deadline - now) / 1000))} s
            </p>
            <p>{ask.detail}</p>
            {ask.purpose && (
              <>
                <p className="approval-says">The agent says it will run (its own words, not checked):</p>
                <pre className="approval-data">{ask.purpose}</pre>
              </>
            )}
            {ask.data && (
              <>
                <div className="approval-data-head">
                  <span>
                    {ask.data.shown < ask.data.size
                      ? `First ${ask.data.shown} of ${ask.data.size} bytes`
                      : `${ask.data.size} byte${ask.data.size === 1 ? "" : "s"}`}
                  </span>
                  <button onClick={() => setApprovalFlip(!approvalFlip)}>
                    {ask.data.binary !== approvalFlip ? "As text" : "As hex"}
                  </button>
                </div>
                <pre className="approval-data">{ask.data.binary !== approvalFlip ? ask.data.hex : ask.data.text}</pre>
              </>
            )}
            <details className="approval-raw">
              <summary>Request as sent</summary>
              <pre>{JSON.stringify(approvals[0], null, 2)}</pre>
            </details>
            <button
              className="danger"
              onClick={() => {
                for (const a of approvals)
                  send({ type: "approve", id: a.id, allow: false });
                setApprovals([]);
              }}
            >
              Deny all ({approvals.length})
            </button>
            <button
              className="danger"
              onClick={() => {
                send({ type: "approve", id: approvals[0].id, allow: false });
                setApprovals((old) => old.slice(1));
              }}
            >
              Deny
            </button>
            <button
              className={ask.session ? "primary" : ""}
              onClick={() => {
                send({ type: "approve", id: approvals[0].id, allow: true });
                setApprovals((old) => old.slice(1));
              }}
            >
              {ask.session ? "Allow" : "Allow once"}
            </button>
            {!ask.session && (
            <button
              className="primary"
              onClick={async () => {
                const dev = approvals[0].deviceId;
                const row = rowsRef.current.find((r) => r.id === dev);
                if (!row || !(await setAutonomy(row, 15))) return;
                for (const a of approvals.filter((x) => x.deviceId === dev))
                  send({ type: "approve", id: a.id, allow: true });
                setApprovals((old) => old.filter((x) => x.deviceId !== dev));
              }}
            >
              Allow all for 15 min
            </button>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
