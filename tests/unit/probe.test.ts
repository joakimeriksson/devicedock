import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { connect, type AddressInfo } from "node:net";
import { Broker, PROBE_IDLE_MS } from "../../apps/server/broker.ts";
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

// ---------- broker: session approval ----------
function probeFixture(autonomousUntil?: number) {
  let t = 1_000_000;
  const b = new Broker(() => t);
  const sent: any[] = [];
  const d = { id: randomUUID(), name: "XDS110", kind: "probe" as const, generation: 1, autoApprove: false, baudRate: 115200, ...(autonomousUntil ? { autonomousUntil: t + autonomousUntil } : {}) };
  b.expose("browser", (m) => sent.push(m), d);
  const req = (op: string, lease?: string, args: unknown = {}) => ({ v: 1, id: randomUUID(), deviceId: d.id, generation: 1, op, args, lease, deadline: t + 5000 });
  // The page: answer operations, approve when asked (if `allow`), echo DAP packets with 0x80 in front.
  const page = (allow: boolean) => {
    const handle = () => {
      for (const m of sent.splice(0)) {
        if (m.type === "approval") b.approve("browser", m.request.id, allow);
        if (m.type === "operation") {
          const data = m.request.op === "probe.transfer"
            ? Buffer.concat([Buffer.from([0x80]), Buffer.from(m.request.args.data, "base64")]).toString("base64") : undefined;
          b.reply("browser", m.request.id, true, undefined, data);
        }
      }
    };
    const timer = setInterval(handle, 1);
    return () => clearInterval(timer);
  };
  return { b, d, sent, req, page, advance: (ms: number) => (t += ms) };
}
test("probe transfers need an approved session; one approval covers many packets", async () => {
  const { b, sent, req, page } = probeFixture();
  const stop = page(true);
  try {
    const { lease } = (await b.run("bridge", "agent", req("serial.acquire"))) as any;
    await assert.rejects(b.run("bridge", "agent", req("probe.transfer", lease, { data: "AA==" })), /No approved probe session/);
    assert.deepEqual(await b.run("bridge", "agent", req("probe.open", lease)), { session: "opened" });
    for (let i = 0; i < 20; i++) {
      const r = (await b.run("bridge", "agent", req("probe.transfer", lease, { data: Buffer.from([i]).toString("base64") }))) as any;
      assert.deepEqual([...Buffer.from(r.data, "base64")], [0x80, i]);
    }
    assert.deepEqual(await b.run("bridge", "agent", req("probe.open", lease)), { session: "active" });
  } finally {
    stop();
  }
  void sent;
});
test("a denied session lets nothing through", async () => {
  const { b, req, page } = probeFixture();
  const stop = page(false);
  try {
    const { lease } = (await b.run("bridge", "agent", req("serial.acquire"))) as any;
    await assert.rejects(b.run("bridge", "agent", req("probe.open", lease)), /denied/);
    await assert.rejects(b.run("bridge", "agent", req("probe.transfer", lease, { data: "AA==" })), /No approved probe session/);
  } finally {
    stop();
  }
});
test("the session outlives a lease (CLI opens, OpenOCD uses) but ends on cut-off, close and idle time", async () => {
  const { b, d, req, page, advance } = probeFixture();
  const stop = page(true);
  try {
    let { lease } = (await b.run("cli", "agent", req("serial.acquire"))) as any;
    await b.run("cli", "agent", req("probe.open", lease));
    await b.run("cli", "agent", req("serial.release", lease));
    ({ lease } = (await b.run("bridge", "agent", req("serial.acquire"))) as any);
    await b.run("bridge", "agent", req("probe.transfer", lease, { data: "AQ==" }));
    b.endProbe("browser", d.id); // the owner's "Cut off"
    await assert.rejects(b.run("bridge", "agent", req("probe.transfer", lease, { data: "AQ==" })), /No approved probe session/);
    await b.run("bridge", "agent", req("probe.open", lease));
    await b.run("bridge", "agent", req("probe.close", lease));
    await assert.rejects(b.run("bridge", "agent", req("probe.transfer", lease, { data: "AQ==" })), /No approved probe session/);
    await b.run("bridge", "agent", req("probe.open", lease));
    // The bridge's keepalive reads hold the lease across a long idle stretch, but they do not extend the session.
    for (let idle = 0; idle < PROBE_IDLE_MS + 1000; idle += 20000) {
      advance(20000);
      await b.run("bridge", "agent", req("serial.read", lease, { maxBytes: 1 }));
    }
    await assert.rejects(b.run("bridge", "agent", req("probe.transfer", lease, { data: "AQ==" })), /No approved probe session/);
  } finally {
    stop();
  }
});
test("autonomous mode opens a probe session without asking; serial ops on a probe are refused", async () => {
  const { b, sent, req } = probeFixture(15 * 60000);
  const { lease } = (await b.run("bridge", "agent", req("serial.acquire"))) as any;
  const p = b.run("bridge", "agent", req("probe.transfer", lease, { data: "AA==" }));
  const msgs = sent.splice(0);
  assert.deepEqual(msgs.map((m) => m.type), ["probe-session", "operation"]);
  b.reply("browser", msgs[1].request.id, true, undefined, "gA==");
  assert.deepEqual(await p, { data: "gA==" });
  await assert.rejects(b.run("bridge", "agent", req("serial.write", lease, { data: "AA==" })), /no serial port/);
});
test("a probe can never be exposed with autoApprove", () => {
  const b = new Broker();
  assert.throws(() => b.expose("o", () => {}, { id: randomUUID(), name: "p", kind: "probe", generation: 1, autoApprove: true, baudRate: 115200 }), /approval/);
});

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
