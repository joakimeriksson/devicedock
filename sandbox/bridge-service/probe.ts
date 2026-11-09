// OpenOCD endpoint for shared debug probes: speaks the framing of OpenOCD's `cmsis-dap backend tcp`
// (src/jtag/drivers/cmsis_dap_tcp.c) and turns every CMSIS-DAP packet into one `probe.transfer` bridge operation.
// The broker enforces leases and the session approval (ARCHITECTURE.md §4.1); this file holds no policy.
//   OpenOCD: adapter driver cmsis-dap; cmsis-dap backend tcp; cmsis-dap tcp host 127.0.0.1; cmsis-dap tcp port 4441
import { createServer, type Server, type Socket } from "node:net";
import { orderProbes, PROBE_PORT_BASE, PROBE_SLOTS, MAX_DAP_PACKET } from "../../packages/protocol/index.ts";
import type { Api, Dev } from "./rfc2217.ts";

// Header: u32 signature "DAP\0", u16 payload length, u8 type, u8 reserved; little endian.
export const DAP_SIGNATURE = 0x00504144;
export const DAP_REQUEST = 1;
export const DAP_RESPONSE = 2;
export const DAP_HEADER = 8;

export function encodeDapFrame(payload: Buffer, type = DAP_RESPONSE): Buffer {
  const h = Buffer.alloc(DAP_HEADER);
  h.writeUInt32LE(DAP_SIGNATURE, 0);
  h.writeUInt16LE(payload.length, 4);
  h[6] = type;
  return Buffer.concat([h, payload]);
}

/** Incremental decoder for request frames; TCP may split or merge them arbitrarily. Throws on a malformed header. */
export class DapFramer {
  private buf: Buffer = Buffer.alloc(0);
  push(chunk: Buffer): Buffer[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: Buffer[] = [];
    while (this.buf.length >= DAP_HEADER) {
      if (this.buf.readUInt32LE(0) !== DAP_SIGNATURE) throw Error("bad DAP frame signature");
      if (this.buf[6] !== DAP_REQUEST) throw Error(`unexpected DAP frame type ${this.buf[6]}`);
      const n = this.buf.readUInt16LE(4);
      if (n === 0 || n > MAX_DAP_PACKET) throw Error(`DAP packet length ${n} out of range`);
      if (this.buf.length < DAP_HEADER + n) break;
      out.push(Buffer.from(this.buf.subarray(DAP_HEADER, DAP_HEADER + n)));
      this.buf = this.buf.subarray(DAP_HEADER + n);
    }
    return out;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Each transfer is short; a small deadline keeps the broker's replay window small at hundreds of packets/s. */
const TRANSFER_TIMEOUT_MS = 5000;

export function startProbeServers(api: Api, port = PROBE_PORT_BASE, host = "127.0.0.1", log = console.error, slots = PROBE_SLOTS): Server[] {
  const servers = Array.from({ length: slots }, (_, slot) => {
    const server = createServer((socket) => void session(socket, slot).catch((e) => log(`probe: ${(e as Error).message}`)));
    server.on("error", (e) => log(`probe: port ${port + slot}: ${(e as Error).message}`));
    return server;
  });

  async function session(socket: Socket, slot: number) {
    socket.setNoDelay(true);
    let open = true;
    let wake: (() => void) | undefined;
    socket.on("close", () => {
      open = false;
      wake?.();
    });
    socket.on("error", () => socket.destroy());
    const framer = new DapFramer();
    const queue: Buffer[] = [];
    socket.on("data", (chunk) => {
      try {
        queue.push(...framer.push(chunk));
        wake?.();
      } catch (e) {
        log(`probe: ${(e as Error).message}; closing`);
        socket.destroy();
      }
    });
    let device: Dev | undefined, lease: string | undefined;
    let keepalive: ReturnType<typeof setInterval> | undefined;
    let chain: Promise<unknown> = Promise.resolve();
    const serial = <T>(fn: () => Promise<T>) => {
      const p = chain.then(fn, fn);
      chain = p.catch(() => {});
      return p;
    };
    try {
      const devices = await api.list();
      device = orderProbes(devices)[slot];
      if (!device) throw Error(`port ${port + slot} has no debug probe (share one with "Add debug probe", then check \`device list\`)`);
      for (let i = 0; ; i++) {
        try {
          lease = ((await api.call("serial.acquire", device)) as { lease: string }).lease;
          break;
        } catch (e) {
          if (!/already leased/i.test((e as Error).message) || i >= 60 || !open) throw e;
          await sleep(500);
        }
      }
      // Opening is instant when a session is already approved (or autonomous mode is on). Otherwise the human must
      // approve in the page; OpenOCD gives up on its first packet after 6 s, so agents run `device probe-open` first.
      await serial(() => api.call("probe.open", device, {}, lease));
      // Hold the lease while OpenOCD idles between commands (a GDB session can sit for minutes).
      keepalive = setInterval(() => void serial(() => api.call("serial.read", device, { maxBytes: 1 }, lease)).catch(() => {}), 10000);
      while (open) {
        const pkt = queue.shift();
        if (!pkt) {
          await new Promise<void>((r) => (wake = r));
          wake = undefined;
          continue;
        }
        const r = (await serial(() =>
          api.call("probe.transfer", device, { data: pkt.toString("base64") }, lease, TRANSFER_TIMEOUT_MS),
        )) as { data: string };
        if (open) socket.write(encodeDapFrame(Buffer.from(r.data, "base64")));
      }
    } catch (e) {
      log(`probe: session on port ${port + slot} ended: ${(e as Error).message}`);
    } finally {
      clearInterval(keepalive);
      socket.destroy();
      if (device && lease) await api.call("serial.release", device, {}, lease).catch(() => {});
    }
  }

  servers.forEach((server, slot) => server.listen(port + slot, host));
  log(`OpenOCD (cmsis-dap tcp) probe endpoints on ${host}:${port}-${port + slots - 1} (probe N is on port ${port}+N, see \`device list\`)`);
  return servers;
}
