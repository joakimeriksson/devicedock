// The page's side of debug probes: finding the CMSIS-DAP interface (WebUSB) and padding HID reports (WebHID).
import assert from "../assert.js";
import { findDapInterface, padReport } from "../../apps/web/src/probe.js";

Deno.test("findDapInterface prefers the named CMSIS-DAP vendor interface, else the first bulk pair", () => {
  const ep = (direction, n, type = "bulk") => ({ direction, type, endpointNumber: n, packetSize: 64 });
  const iface = (n, cls, name, eps) => ({ interfaceNumber: n, alternates: [{ interfaceClass: cls, interfaceName: name, endpoints: eps }] });
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

Deno.test("HID reports are zero-padded and never truncated", () => {
  assert.deepEqual([...padReport(Uint8Array.from([0, 0xfe]), 4)], [0, 0xfe, 0, 0]);
  assert.throws(() => padReport(new Uint8Array(65), 64), /exceeds/);
});
