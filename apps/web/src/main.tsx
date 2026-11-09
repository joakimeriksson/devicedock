import {
  request as protocolRequest,
  options as serialOptions, isPhysical, isVirtual } from "../../../packages/protocol/index.ts";
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
};
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
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}
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
  const rememberedRef = useRef(remembered),
    autoShareRef = useRef<() => Promise<void>>(async () => {}),
    autoSharing = useRef(false);
  function setRemembered(next: Record<string, number>) {
    rememberedRef.current = next;
    setRememberedState(next);
    saveRemembered(next);
  }
  const monitorEnd = useRef<HTMLDivElement>(null);
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
        update((old) => old.map((r) => ({ ...r, exposed: false })));
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
        if (r.op === "probe.transfer") {
          // DAP packets are not logged to the serial monitor: there are hundreds per second while flashing.
          if (!(row.adapter instanceof ProbeAdapter)) throw Error("Not a debug probe");
          data = encode(await row.adapter.transfer(row.id, decode(r.args.data as string)));
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
      for (const name of Object.keys(mem)) {
        const same = rowsRef.current.filter(
          (r) => r.kind === "serial" && r.name === name,
        );
        // A re-plugged board leaves a dead earlier row; only the newest one can be opened.
        const row = same.at(-1);
        if (!row || same.some((r) => r.exposed)) continue;
        try {
          await expose(row, { baudRate: mem[name] });
        } catch (e) {
          setError(`Auto-share of ${name} failed: ${(e as Error).message}`);
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
    adapter.subscribe(d.id, (event) => {
      const current = rowsRef.current.find((r) => r.id === d.id);
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
        if (current?.exposed)
          try {
            send({ type: "revoke", deviceId: d.id });
          } catch {}
        update((old) =>
          old.map((r) =>
            r.id === d.id ? { ...r, open: false, exposed: false } : r,
          ),
        );
        setApprovals((old) => old.filter((r) => r.deviceId !== d.id));
        setError(event.error ?? "Device disconnected");
      }
    });
    update((old) => [...old, row]);
  }
  async function expose(row: Row, auto?: { baudRate: number }) {
    if (
      row.kind === "probe" &&
      !window.confirm(
        "Sharing a debug probe gives container programs (OpenOCD, GDB) full control of the attached chip: they can halt it, read and erase its flash, and change protection settings, which can lock a part permanently. Each OpenOCD session will need your approval (or autonomous mode). Debug probes are never shared automatically. Share this probe?",
      )
    )
      return;
    if (
      !auto &&
      row.kind === "serial" &&
      !window.confirm(
        "Sharing lets container programs request arbitrary serial bytes, which may change hardware state. Each agent operation will require your approval. It will be shared again automatically after restarts (untick “Auto-share next time” to stop). Open and share this port?",
      )
    )
      return;
    const useBaud = auto?.baudRate ?? baud;
    // An already-open port is kept open: reopening can reset the attached board.
    if (!row.open)
      await row.adapter.open(row.id, serialOptions.parse({ baudRate: useBaud }));
    if (row.kind === "serial" && !auto)
      setRemembered({ ...rememberedRef.current, [row.name]: useBaud });
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
  function setAutonomy(row: Row, minutes: number | null): boolean {
    if (
      minutes !== null &&
      !window.confirm(
        `Autonomous mode lets agents in the sandbox write to, reset and flash this device WITHOUT asking you, for ${minutes} minutes. Anything wired to the board may be affected. Turn it on?`,
      )
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
    if (row.name in rememberedRef.current) {
      const { [row.name]: _drop, ...rest } = rememberedRef.current;
      setRemembered(rest);
    }
    send({ type: "revoke", deviceId: row.id });
    update((old) =>
      old.map((r) =>
        r.id === row.id ? { ...r, exposed: false, autonomousUntil: undefined, probeSession: false } : r,
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
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">↔</span>
          <b>DeviceDock</b>
          <span className="tag">LOCAL WORKSPACE</span>
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
          <span className={connected ? "status online" : "status"}>
            <i className="dot" />
            {connected ? "Browser bridge online" : "Bridge offline"}
          </span>
        </div>
      </header>
      <main>
        <div className="intro">
          <div className="eyebrow">HARDWARE IN THE LOOP</div>
          <h1>Your code. Real devices.</h1>
          <p>A Linux sandbox connected to the hardware you choose to share.</p>
        </div>
        <div className="summary">
          <span>
            <i className={health?.docker ? "dot" : "dot muted"} />
            Docker <b>{health?.docker ? "available" : "unavailable"}</b>
          </span>
          <span>
            Sandbox <b>{health?.container ? "running" : "not running"}</b>
          </span>
          <span>
            Agents <b>{health?.agent ? "Codex · Claude · OpenCode" : "not available"}</b>
          </span>
          <span>
            WebSerial{" "}
            <b>{"serial" in navigator ? "supported" : "use Chrome / Edge"}</b>
          </span>
        </div>
        {error && (
          <div className="error" role="alert">
            {error}
            <button onClick={() => setError("")}>Dismiss</button>
          </div>
        )}
        {health?.error && (
          <details className="notice">
            <summary>Sandbox needs attention</summary>
            <pre>{health.error}</pre>
            <p>
              Run <code>npm run sandbox:build</code>, then{" "}
              <code>npm run sandbox:start</code> from a terminal with Docker
              access.
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
                Run <code>npm run open</code> to open an authenticated local
                session.
              </div>
            )}
          </div>
          <aside>
            <section className="panel devices">
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
                  onClick={() => run(() => add(serial))}
                >
                  ＋ Add serial port
                </button>
                <button
                  disabled={!connected || !probes.supported.usb}
                  title="CMSIS-DAP v2 debug probe over WebUSB (e.g. a TI LaunchPad's XDS110)"
                  onClick={() => run(async () => add(probes, await probes.requestUsb()))}
                >
                  ＋ Add debug probe
                </button>
                <button
                  disabled={!connected || !probes.supported.hid}
                  title="CMSIS-DAP v1 debug probe over WebHID (e.g. the SAMD11 on a XIAO nRF54L15)"
                  onClick={() => run(async () => add(probes, await probes.requestHid()))}
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
                    <span className={row.exposed ? "badge shared" : "badge"}>
                      {row.exposed ? "Shared" : "Private"}
                    </span>
                  </div>
                  <small>
                    {row.kind === "mock"
                      ? "Browser mock"
                      : row.kind === "sim"
                        ? `Simulated · ${row.engine ?? "emulator"}${row.board ? ` · ${row.board}` : ""}`
                        : "WebSerial"}{" "}
                    ·{" "}
                    {row.baudRate} baud · generation {row.generation}
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
                    ) : (
                      <button
                        disabled={!connected}
                        onClick={() => run(() => expose(row))}
                      >
                        Open & share
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
                        checked={row.name in remembered}
                        onChange={(e) => {
                          const { [row.name]: _drop, ...rest } = remembered;
                          setRemembered(
                            e.target.checked
                              ? { ...rest, [row.name]: row.baudRate }
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
      </main>
      {rows.some((r) => r.probeSession && r.exposed) && (
        <div className="probe-banner" role="status">
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
            <h2>Allow this device operation?</h2>
            <p>
              Arbitrary serial bytes and control signals may change hardware
              state. Tools like esptool send dozens of operations; for a
              flashing session use “Allow all for 15 min” instead of clicking
              each one.
            </p>
            <pre>{JSON.stringify(approvals[0], null, 2)}</pre>
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
              onClick={() => {
                send({ type: "approve", id: approvals[0].id, allow: true });
                setApprovals((old) => old.slice(1));
              }}
            >
              Allow once
            </button>
            <button
              className="primary"
              onClick={() => {
                const dev = approvals[0].deviceId;
                const row = rowsRef.current.find((r) => r.id === dev);
                if (!row || !setAutonomy(row, 15)) return;
                for (const a of approvals.filter((x) => x.deviceId === dev))
                  send({ type: "approve", id: a.id, allow: true });
                setApprovals((old) => old.filter((x) => x.deviceId !== dev));
              }}
            >
              Allow all for 15 min
            </button>
          </section>
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
