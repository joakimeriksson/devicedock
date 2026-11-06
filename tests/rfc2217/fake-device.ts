// Runs the real RFC 2217 server against an in-memory device (used by tests/rfc2217/run.sh).
import { startRfc2217, type Api, type Dev } from "../../sandbox/bridge-service/rfc2217.ts";
const dev: Dev = { id: "11111111-1111-4111-8111-111111111111", generation: 1, name: "fake", kind: "serial", baudRate: 115200 };
let rx = Buffer.alloc(0);
// Exclusive lease like the real broker. FAIL_FIRST_RELEASE=1 makes the first release fail ("busy"),
// which leaves a stale lease behind exactly like a session killed while an approval was pending.
let leased = false;
let failRelease = process.env.FAIL_FIRST_RELEASE === "1";
let pingBuf = "";
const api: Api = {
  async list() { return [dev]; },
  async call(op, _d, args = {}) {
    if (op === "serial.acquire") {
      if (leased) throw new Error("Device already leased");
      leased = true;
      return { lease: "lease" };
    }
    if (op === "serial.release") {
      if (failRelease) { failRelease = false; throw new Error("Device operation in progress"); }
      leased = false;
      return {};
    }
    if (op === "serial.read") { const d = rx; rx = Buffer.alloc(0); return { data: d.toString("base64") }; }
    if (op === "serial.write") {
      const b = Buffer.from(String(args.data), "base64");
      pingBuf += b.toString("latin1");
      if (pingBuf.includes("PING\n")) { pingBuf = ""; rx = Buffer.concat([rx, Buffer.from("PONG\n")]); }
      // Binary echo (includes 0xFF to exercise IAC escaping).
      if (b[0] === 0x00 && b.length > 1) rx = Buffer.concat([rx, b]);
      return {};
    }
    console.log("OP", op, JSON.stringify(args));
    return {};
  },
};
startRfc2217(api, 2217, "127.0.0.1", () => {});
console.log("READY");
