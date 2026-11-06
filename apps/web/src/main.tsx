import {
  request as protocolRequest,
  options as serialOptions,
} from "../../../packages/protocol/index.ts";
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
import "./style.css";
type Row = Descriptor & {
  adapter: DeviceAdapter;
  generation: number;
  open: boolean;
  exposed: boolean;
  baudRate: number;
  autoApprove: boolean;
  autonomousUntil?: number;
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
const mock = new MockAdapter(),
  serial = new WebSerialAdapter();
function App() {
  const [csrf, setCsrf] = useState(""),
    [error, setError] = useState(""),
    [health, setHealth] = useState<any>(),
    [connected, setConnected] = useState(false),
    [rows, setRows] = useState<Row[]>([]),
    [logs, setLogs] = useState<
      { text: string; hex: string; direction: string }[]
    >([]),
    [approvals, setApprovals] = useState<Rpc[]>([]),
    [text, setText] = useState("PING\n"),
    [hex, setHex] = useState(false),
    [baud, setBaud] = useState(115200),
    [latency, setLatency] = useState(20),
    [fail, setFail] = useState(false),
    [agent, setAgent] = useState<Exclude<TerminalKind, "shell">>("codex"),
    [now, setNow] = useState(Date.now());
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
  function log(bytes: Uint8Array, direction: string) {
    setLogs((old) =>
      [
        ...old,
        {
          text: new TextDecoder().decode(bytes),
          hex: [...bytes].map((b) => b.toString(16).padStart(2, "0")).join(" "),
          direction,
        },
      ].slice(-150),
    );
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
      ws.onopen = () => setConnected(true);
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
      };
    }
    async function execute(r: Rpc) {
      let ok = false,
        err = "";
      try {
        protocolRequest.parse(r);
        const row = rowsRef.current.find(
          (d) =>
            d.id === r.deviceId && d.generation === r.generation && d.exposed,
        );
        if (!row || r.deadline <= Date.now())
          throw Error("Device revoked, stale, or deadline expired");
        if (r.op === "serial.write") {
          const bytes = decode(r.args.data as string);
          log(bytes, "TX");
          await row.adapter.write(row.id, bytes);
        } else if (r.op === "serial.signals") {
          await row.adapter.setSignals(row.id, r.args);
          log(new TextEncoder().encode(JSON.stringify(r.args)), "SIGNALS");
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
        send({ type: "reply", id: r.id, ok, error: err.slice(0, 300) });
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
      autoApprove: d.kind === "mock",
    };
    adapter.subscribe(d.id, (event) => {
      const current = rowsRef.current.find((r) => r.id === d.id);
      if (event.type === "data") {
        log(event.bytes, "RX");
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
  async function expose(row: Row) {
    if (
      row.kind === "serial" &&
      !window.confirm(
        "Sharing lets container programs request arbitrary serial bytes, which may change hardware state. Each agent operation will require your approval. Open and share this port?",
      )
    )
      return;
    await row.adapter.open(row.id, serialOptions.parse({ baudRate: baud }));
    const next = {
      ...row,
      open: true,
      exposed: true,
      generation: row.generation + 1,
      baudRate: baud,
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
      },
    });
  }
  function setAutonomy(row: Row, minutes: number | null) {
    if (
      minutes !== null &&
      !window.confirm(
        `Autonomous mode lets agents in the sandbox write to, reset and flash this device WITHOUT asking you, for ${minutes} minutes. Anything wired to the board may be affected. Turn it on?`,
      )
    )
      return;
    const until = minutes === null ? null : Date.now() + minutes * 60000;
    send({ type: "autonomy", deviceId: row.id, until });
    update((old) =>
      old.map((r) =>
        r.id === row.id ? { ...r, autonomousUntil: until ?? undefined } : r,
      ),
    );
  }
  function revoke(row: Row) {
    send({ type: "revoke", deviceId: row.id });
    update((old) =>
      old.map((r) =>
        r.id === row.id ? { ...r, exposed: false, autonomousUntil: undefined } : r,
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
        <span className={connected ? "status online" : "status"}>
          <i className="dot" />
          {connected ? "Browser bridge online" : "Bridge offline"}
        </span>
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
                    {row.kind === "mock" ? "Browser mock" : "WebSerial"} ·{" "}
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
                  {row.kind === "mock" && !row.exposed && (
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
                <button onClick={() => setLogs([])}>Clear</button>
              </header>
              <div className="monitor-log" aria-label="Serial monitor">
                {logs.length ? (
                  logs.map((l, i) => (
                    <div key={i}>
                      <span className={l.direction === "TX" ? "tx" : "rx"}>
                        {l.direction}
                      </span>
                      <pre>{hex ? l.hex : l.text}</pre>
                    </div>
                  ))
                ) : (
                  <p>Waiting for bytes…</p>
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
      {approvals.length > 0 && (
        <div className="approval-backdrop">
          <section
            className="approval panel"
            role="dialog"
            aria-label="Device operation approval"
          >
            <div className="eyebrow">HUMAN APPROVAL REQUIRED</div>
            <h2>Allow this device operation?</h2>
            <p>
              Arbitrary serial bytes and control signals may change hardware
              state.
            </p>
            <pre>{JSON.stringify(approvals[0], null, 2)}</pre>
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
              className="primary"
              onClick={() => {
                send({ type: "approve", id: approvals[0].id, allow: true });
                setApprovals((old) => old.slice(1));
              }}
            >
              Allow once
            </button>
          </section>
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
