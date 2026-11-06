// RFC 2217 (Telnet COM-PORT-OPTION) server exposing the shared browser device inside the container.
// Tools connect with `rfc2217://127.0.0.1:2217` (esptool, pyserial, PlatformIO, mpremote-via-pyserial).
// It translates baud/DTR/RTS/data into the same lease + bridge operations every other client uses, so
// approvals and "autonomous mode" are enforced by the Mac-side broker, not here.
import { createServer, type Socket, type Server } from "node:net";

export type Dev = { id: string; generation: number; name: string; kind: string; baudRate: number };
export interface Api {
  list(): Promise<Dev[]>;
  call(op: string, device?: Dev, args?: Record<string, unknown>, lease?: string): Promise<unknown>;
}

const IAC = 255, DONT = 254, DO = 253, WONT = 252, WILL = 251, SB = 250, SE = 240;
const BINARY = 0, SGA = 3, COMPORT = 44;
// COM-PORT-OPTION sub-commands (client -> server); replies add 100.
const SET_BAUDRATE = 1, SET_DATASIZE = 2, SET_PARITY = 3, SET_STOPSIZE = 4, SET_CONTROL = 5,
  NOTIFY_LINESTATE = 6, NOTIFY_MODEMSTATE = 7, FLOWCONTROL_SUSPEND = 8, FLOWCONTROL_RESUME = 9,
  SET_LINESTATE_MASK = 10, SET_MODEMSTATE_MASK = 11, PURGE_DATA = 12;
const WRITE_CHUNK = 4096;

/** Escape 0xFF as IAC IAC for the telnet data stream. */
export function escapeIac(data: Buffer): Buffer {
  if (!data.includes(IAC)) return data;
  const out: number[] = [];
  for (const b of data) out.push(b, ...(b === IAC ? [IAC] : []));
  return Buffer.from(out);
}

type Event =
  | { t: "data"; bytes: Buffer }
  | { t: "cmd"; cmd: number; opt: number }
  | { t: "sub"; payload: Buffer };

/** Incremental telnet parser: data (IAC-unescaped), option negotiations and subnegotiations. */
export class TelnetParser {
  private state: "data" | "iac" | "neg" | "sb" | "sbiac" = "data";
  private cmd = 0;
  private sub: number[] = [];
  push(chunk: Buffer): Event[] {
    const events: Event[] = [];
    let data: number[] = [];
    const flush = () => {
      if (data.length) events.push({ t: "data", bytes: Buffer.from(data) });
      data = [];
    };
    for (const b of chunk) {
      switch (this.state) {
        case "data":
          if (b === IAC) this.state = "iac";
          else data.push(b);
          break;
        case "iac":
          if (b === IAC) {
            data.push(IAC);
            this.state = "data";
          } else if (b === SB) {
            flush();
            this.sub = [];
            this.state = "sb";
          } else if (b >= WILL && b <= DONT) {
            flush();
            this.cmd = b;
            this.state = "neg";
          } else this.state = "data"; // NOP and friends
          break;
        case "neg":
          events.push({ t: "cmd", cmd: this.cmd, opt: b });
          this.state = "data";
          break;
        case "sb":
          if (b === IAC) this.state = "sbiac";
          else this.sub.push(b);
          break;
        case "sbiac":
          if (b === SE) {
            events.push({ t: "sub", payload: Buffer.from(this.sub) });
            this.state = "data";
          } else {
            this.sub.push(b); // IAC IAC inside subnegotiation = literal 255
            this.state = "sb";
          }
          break;
      }
    }
    flush();
    return events;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function startRfc2217(api: Api, port = 2217, host = "127.0.0.1", log = console.error): Server {
  let active = false;
  const server = createServer((socket: Socket) => {
    if (active) {
      log("rfc2217: rejecting second concurrent connection");
      socket.destroy();
      return;
    }
    active = true;
    void session(socket).finally(() => (active = false));
  });

  async function session(socket: Socket) {
    socket.setNoDelay(true);
    let open = true;
    const end = () => {
      open = false;
      socket.destroy();
    };
    socket.on("error", end);
    socket.on("close", () => (open = false));

    let dev: Dev | undefined;
    let lease: string | undefined;
    try {
      const devices = await api.list();
      dev = devices.find((d) => d.kind === "serial") ?? devices[0];
      if (!dev) {
        log("rfc2217: no shared device (share one in the browser, then check `device list`)");
        socket.destroy();
        return;
      }
      lease = ((await api.call("serial.acquire", dev)) as { lease: string }).lease;
    } catch (e) {
      log(`rfc2217: cannot attach: ${(e as Error).message}`);
      socket.destroy();
      return;
    }
    const device = dev;

    // Serialise bridge operations: the broker rejects overlapping ops on one lease.
    let chain: Promise<unknown> = Promise.resolve();
    const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
      const p = chain.then(fn, fn);
      chain = p.catch(() => {});
      return p;
    };
    // Line settings. SET_* requests only update `cfg`; the port is reconfigured lazily, right before
    // the next real operation, and only if the final value differs from what is applied. Clients like
    // esptool flip the baud rate several times at connect (115200 -> 9600 -> 115200); in the browser a
    // reconfigure closes and reopens the port, which can reset the attached board, so collapse them.
    const cfg = { baudRate: device.baudRate || 115200, dataBits: 8, stopBits: 1, parity: "none", flowControl: "none" };
    let applied = { ...cfg };
    let signals = { dtr: false, rts: false };
    const sync = async () => {
      if (JSON.stringify(cfg) === JSON.stringify(applied)) return;
      const next = { ...cfg };
      await api.call("serial.configure", device, { ...next }, lease);
      applied = next;
    };
    const op = (name: string, args: Record<string, unknown> = {}) =>
      enqueue(async () => {
        // Modem-control lines do not depend on the baud rate, so they never force a reconfigure.
        // Reads wait until the settings have been stable briefly, so a client's transient baud flips
        // (esptool opens at 9600 then sets 115200) never cause a port reopen.
        if (name === "serial.read" ? Date.now() - cfgChangedAt > 1000 : name !== "serial.signals")
          await sync();
        return api.call(name, device, args, lease);
      });
    let cfgChangedAt = 0;
    const applyConfig = (next: Partial<typeof cfg>) => {
      if (Object.entries(next).some(([k, v]) => (cfg as Record<string, unknown>)[k] !== v)) cfgChangedAt = Date.now();
      Object.assign(cfg, next);
      return Promise.resolve();
    };

    const send = (b: Buffer) => open && socket.write(b);
    const sendCmd = (c: number, o: number) => send(Buffer.from([IAC, c, o]));
    const reply = (code: number, ...payload: number[]) =>
      send(Buffer.from([IAC, SB, COMPORT, code + 100, ...payload.flatMap((b) => (b === IAC ? [IAC, IAC] : [b])), IAC, SE]));
    const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

    // Offer the options RFC 2217 clients expect.
    sendCmd(WILL, COMPORT);
    sendCmd(WILL, BINARY);
    sendCmd(DO, BINARY);
    sendCmd(WILL, SGA);
    sendCmd(DO, SGA);

    const handleSub = async (p: Buffer) => {
      if (p[0] !== COMPORT) return;
      const code = p[1];
      const v = p.subarray(2);
      switch (code) {
        case SET_BAUDRATE: {
          const baud = v.readUInt32BE(0);
          if (baud > 0) await applyConfig({ baudRate: baud });
          reply(code, ...u32(cfg.baudRate));
          break;
        }
        case SET_DATASIZE:
          if (v[0] === 7 || v[0] === 8) await applyConfig({ dataBits: v[0] });
          reply(code, cfg.dataBits);
          break;
        case SET_PARITY: {
          const names: Record<number, string> = { 1: "none", 2: "odd", 3: "even" };
          if (names[v[0]]) await applyConfig({ parity: names[v[0]] });
          reply(code, cfg.parity === "odd" ? 2 : cfg.parity === "even" ? 3 : 1);
          break;
        }
        case SET_STOPSIZE:
          if (v[0] === 1 || v[0] === 2) await applyConfig({ stopBits: v[0] });
          reply(code, cfg.stopBits);
          break;
        case SET_CONTROL: {
          const c = v[0];
          if (c === 8 || c === 9) {
            signals.dtr = c === 8;
            await op("serial.signals", { dataTerminalReady: signals.dtr });
            reply(code, c);
          } else if (c === 11 || c === 12) {
            signals.rts = c === 11;
            await op("serial.signals", { requestToSend: signals.rts });
            reply(code, c);
          } else if (c === 5 || c === 6) {
            await op("serial.signals", { break: c === 5 });
            reply(code, c);
          } else if (c === 1 || c === 2 || c === 3) {
            await applyConfig({ flowControl: c === 3 ? "hardware" : "none" });
            reply(code, c);
          } else if (c === 7) reply(code, signals.dtr ? 8 : 9);
          else if (c === 10) reply(code, signals.rts ? 11 : 12);
          else reply(code, 1); // flow-control / break state queries
          break;
        }
        case SET_LINESTATE_MASK:
          reply(code, v[0] ?? 0);
          break;
        case SET_MODEMSTATE_MASK:
          reply(code, v[0] ?? 0);
          // Report a benign modem state (CTS+DSR+CD on) so clients that poll it do not stall.
          send(Buffer.from([IAC, SB, COMPORT, NOTIFY_MODEMSTATE + 100, 0xb0, IAC, SE]));
          break;
        case PURGE_DATA:
          reply(code, v[0] ?? 0);
          break;
        case FLOWCONTROL_SUSPEND:
        case FLOWCONTROL_RESUME:
        case NOTIFY_LINESTATE:
        case NOTIFY_MODEMSTATE:
          break;
      }
    };

    const parser = new TelnetParser();
    let lastActivity = Date.now();
    const writeOut = (bytes: Buffer) => {
      for (let i = 0; i < bytes.length; i += WRITE_CHUNK)
        void op("serial.write", { data: bytes.subarray(i, i + WRITE_CHUNK).toString("base64") }).catch((e) => {
          log(`rfc2217: write failed: ${(e as Error).message}`);
          end();
        });
    };
    socket.on("data", (chunk) => {
      lastActivity = Date.now();
      for (const ev of parser.push(chunk)) {
        if (ev.t === "data") writeOut(ev.bytes);
        else if (ev.t === "sub")
          void handleSub(ev.payload).catch((e) => {
            log(`rfc2217: ${(e as Error).message}`);
            end();
          });
        else if (ev.cmd === DO) {
          // Accept the options we support; the initial WILLs may already have been sent.
          if (![BINARY, SGA, COMPORT].includes(ev.opt)) sendCmd(WONT, ev.opt);
        } else if (ev.cmd === WILL) {
          sendCmd([BINARY, SGA, COMPORT].includes(ev.opt) ? DO : DONT, ev.opt);
        }
      }
    });

    // Reader: poll the lease queue; poll fast while active, slowly when idle.
    try {
      while (open) {
        const r = (await op("serial.read", { maxBytes: 16384 })) as { data: string };
        if (r.data) {
          lastActivity = Date.now();
          send(escapeIac(Buffer.from(r.data, "base64")));
        }
        const idleFor = Date.now() - lastActivity;
        await sleep(r.data ? 0 : idleFor < 2000 ? 15 : 80);
      }
    } catch (e) {
      log(`rfc2217: read loop ended: ${(e as Error).message}`);
    } finally {
      socket.destroy();
      await api.call("serial.release", device, {}, lease).catch(() => {});
    }
  }

  server.listen(port, host, () => log(`RFC 2217 serial server on ${host}:${port}`));
  return server;
}
