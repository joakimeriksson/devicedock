import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { findDapInterface, padReport } from "../../apps/web/src/probe.ts";
import { request, orderDevices, orderProbes, openocdConfig, isPhysical } from "../../packages/protocol/index.ts";

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

// The broker's probe-session rules are tested in server-rs/src/broker.rs; the OpenOCD endpoint and its framing in
// server-rs/src/dap.rs.

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
