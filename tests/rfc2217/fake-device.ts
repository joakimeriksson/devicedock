// Runs the real RFC 2217 server against in-memory devices (used by tests/rfc2217/run.sh).
// Two devices are listed with the SIMULATOR FIRST, to prove port order is physical-first, not share order.
import { startRfc2217, type Api, type Dev } from "../../sandbox/bridge-service/rfc2217.ts";

type State = { dev: Dev; reply: string; rx: Buffer; leased: boolean; pingBuf: string };
const mk = (id: string, name: string, kind: string, reply: string): State => ({
  dev: { id, generation: 1, name, kind, baudRate: 115200 }, reply, rx: Buffer.alloc(0), leased: false, pingBuf: "",
});
const sim = mk("22222222-2222-4222-8222-222222222222", "fake-sim", "sim", "SIM-PONG\n");
const serial = mk("11111111-1111-4111-8111-111111111111", "fake-serial", "serial", "PONG\n");
const states = new Map([[sim.dev.id, sim], [serial.dev.id, serial]]);
// FAIL_FIRST_RELEASE=1 makes the first release on the serial device fail ("busy"), leaving a stale lease like a
// session killed while an approval was pending.
let failRelease = process.env.FAIL_FIRST_RELEASE === "1";

const api: Api = {
  async list() { return [sim.dev, serial.dev]; },
  async call(op, d, args = {}) {
    const st = states.get(d!.id)!;
    if (op === "serial.acquire") {
      if (st.leased) throw new Error("Device already leased");
      st.leased = true;
      return { lease: "lease" };
    }
    if (op === "serial.release") {
      if (failRelease && st === serial) { failRelease = false; throw new Error("Device operation in progress"); }
      st.leased = false;
      return {};
    }
    if (op === "serial.read") { const out = st.rx; st.rx = Buffer.alloc(0); return { data: out.toString("base64") }; }
    if (op === "serial.write") {
      const b = Buffer.from(String(args.data), "base64");
      st.pingBuf += b.toString("latin1");
      if (st.pingBuf.includes("PING\n")) { st.pingBuf = ""; st.rx = Buffer.concat([st.rx, Buffer.from(st.reply)]); }
      if (b[0] === 0x00 && b.length > 1) st.rx = Buffer.concat([st.rx, b]); // binary echo (exercises IAC escaping)
      return {};
    }
    console.log("OP", st.dev.name, op, JSON.stringify(args));
    return {};
  },
};
startRfc2217(api, 2217, "127.0.0.1", () => {});
console.log("READY");
