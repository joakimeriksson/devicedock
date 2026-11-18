import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { connect, type AddressInfo } from "node:net";
import { Broker } from "../fixtures/broker.ts";
import {
  DapFramer, encodeDapFrame, startProbeServers, DAP_REQUEST, DAP_RESPONSE, DAP_SIGNATURE,
} from "../../sandbox/bridge-service/probe.ts";
import { findDapInterface, padReport } from "../../apps/web/src/probe.ts";
import { request, orderDevices, orderProbes, openocdConfig, isPhysical } from "../../packages/protocol/index.ts";

// ---------- framing (OpenOCD cmsis_dap_tcp) ----------
test("DAP frames: header layout matches OpenOCD's cmsis_dap_tcp", () => {
  const f = encodeDapFrame(Buffer.from([0x00, 0xfe]), DAP_REQUEST);
  assert.deepEqual([...f.subarray(0, 8)], [0x44, 0x41, 0x50, 0x00, 2, 0, DAP_REQUEST, 0]);
  assert.equal(f.readUInt32LE(0), DAP_SIGNATURE);
  assert.deepEqual([...encodeDapFrame(Buffer.from([1]))].slice(6, 7), [DAP_RESPONSE]);
});
test("DAP framer reassembles split and merged frames", () => {
  const a = encodeDapFrame(Buffer.from([1, 2, 3]), DAP_REQUEST), b = encodeDapFrame(Buffer.from([9]), DAP_REQUEST);
  const all = Buffer.concat([a, b]);
  const fr = new DapFramer();
  const got: number[][] = [];
  for (let i = 0; i < all.length; i++) got.push(...fr.push(all.subarray(i, i + 1)).map((p) => [...p])); // byte by byte
  assert.deepEqual(got, [[1, 2, 3], [9]]);
  assert.deepEqual(new DapFramer().push(all).map((p) => [...p]), [[1, 2, 3], [9]]); // both in one chunk
});
test("DAP framer rejects a bad signature, a response frame and an oversized length", () => {
  assert.throws(() => new DapFramer().push(Buffer.from("GET / HTTP/1.1\r\n")), /signature/);
  assert.throws(() => new DapFramer().push(encodeDapFrame(Buffer.from([1]), DAP_RESPONSE)), /type/);
  const big = Buffer.alloc(8);
  big.writeUInt32LE(DAP_SIGNATURE, 0);
  big.writeUInt16LE(2000, 4);
  big[6] = DAP_REQUEST;
  assert.throws(() => new DapFramer().push(big), /out of range/);
});

// ---------- protocol ----------
test("probes are physical, take no RFC 2217 port, and get their own OpenOCD port", () => {
  assert.equal(isPhysical("probe"), true);
  const devs = [{ kind: "sim", n: 1 }, { kind: "probe", n: 2 }, { kind: "serial", n: 3 }, { kind: "probe", n: 4 }];
  assert.deepEqual(orderDevices(devs).map((d) => d.n), [3, 1]);
  assert.deepEqual(orderProbes(devs).map((d) => d.n), [2, 4]);
  assert.match(openocdConfig(1), /cmsis-dap backend tcp; cmsis-dap tcp host 127\.0\.0\.1; cmsis-dap tcp port 4442$/);
  const r = (data: string) => request.safeParse({ v: 1, id: randomUUID(), op: "probe.transfer", deadline: Date.now() + 1000, args: { data } });
  assert.equal(r(Buffer.alloc(1024).toString("base64")).success, true);
  assert.equal(r(Buffer.alloc(1025).toString("base64")).success, false);
  assert.equal(r("").success, false);
});

// The broker's probe-session rules are tested in server-rs/src/broker.rs.

// ---------- bridge endpoint, end to end with a fake bridge API ----------
test("OpenOCD endpoint: acquires, opens the session, relays packets in order, releases on close", async () => {
  const calls: string[] = [];
  const probe = { id: randomUUID(), generation: 1, name: "XDS110", kind: "probe", baudRate: 115200 };
  const api = {
    list: async () => [{ ...probe, id: randomUUID(), kind: "serial" }, probe],
    call: async (op: string, _d?: unknown, args?: Record<string, unknown>) => {
      calls.push(op);
      if (op === "serial.acquire") return { lease: randomUUID() };
      if (op === "probe.transfer") {
        const pkt = Buffer.from(args!.data as string, "base64");
        await new Promise((r) => setTimeout(r, pkt[0] === 1 ? 20 : 0)); // the first is slower: order must hold
        return { data: Buffer.from([pkt[0], 0xaa]).toString("base64") };
      }
      return {};
    },
  };
  const [server] = startProbeServers(api, 0, "127.0.0.1", () => {}, 1);
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as AddressInfo).port;
  const sock = connect(port, "127.0.0.1");
  const replies: number[][] = [];
  let buf = Buffer.alloc(0);
  sock.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 8 && buf.length >= 8 + buf.readUInt16LE(4)) {
      assert.equal(buf[6], DAP_RESPONSE);
      const n = buf.readUInt16LE(4);
      replies.push([...buf.subarray(8, 8 + n)]);
      buf = buf.subarray(8 + n);
    }
  });
  await new Promise((r) => sock.once("connect", r));
  sock.write(Buffer.concat([1, 2, 3].map((i) => encodeDapFrame(Buffer.from([i]), DAP_REQUEST))));
  for (let i = 0; i < 100 && replies.length < 3; i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(replies, [[1, 0xaa], [2, 0xaa], [3, 0xaa]]);
  sock.destroy();
  for (let i = 0; i < 100 && !calls.includes("serial.release"); i++) await new Promise((r) => setTimeout(r, 10));
  server.close();
  assert.deepEqual(calls.slice(0, 2), ["serial.acquire", "probe.open"]);
  assert.equal(calls.at(-1), "serial.release");
});

// ---------- browser adapter pure parts ----------
test("findDapInterface prefers the named CMSIS-DAP vendor interface, else the first bulk pair", () => {
  const ep = (direction: "in" | "out", n: number, type = "bulk") => ({ direction, type, endpointNumber: n, packetSize: 64 });
  const iface = (n: number, cls: number, name: string | null, eps: ReturnType<typeof ep>[]) => ({ interfaceNumber: n, alternates: [{ interfaceClass: cls, interfaceName: name, endpoints: eps }] });
  // An XDS110-like device: CDC, a vendor debug interface, HID CMSIS-DAP v1, and the v2 bulk interface (6).
  const xds = [
    iface(0, 2, null, [ep("in", 1, "interrupt")]),
    iface(2, 0xff, "XDS110 debug", [ep("in", 2), ep("out", 2)]),
    iface(5, 3, "XDS110 CMSIS-DAP", [ep("in", 5, "interrupt"), ep("out", 5, "interrupt")]),
    iface(6, 0xff, "XDS110 CMSIS-DAP v2", [ep("out", 6), ep("in", 7)]),
  ];
  assert.deepEqual(findDapInterface(xds), { interfaceNumber: 6, epIn: 7, epOut: 6, packetSize: 64 });
  assert.equal(findDapInterface([xds[0], xds[2]]), undefined);
  assert.equal(findDapInterface([xds[0], xds[1]])?.interfaceNumber, 2);
});
test("HID reports are zero-padded and never truncated", () => {
  assert.deepEqual([...padReport(Uint8Array.from([0, 0xfe]), 4)], [0, 0xfe, 0, 0]);
  assert.throws(() => padReport(new Uint8Array(65), 64), /exceeds/);
});
