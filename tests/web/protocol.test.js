// The page's checks of what the backend asks it to do (apps/web/src/protocol.js; the full protocol is
// server-rs/src/protocol.rs).
import assert from "node:assert/strict";
import { isPhysical, isVirtual, parseOptions, parseRequest } from "../../apps/web/src/protocol.js";

const req = (op, args, extra = {}) => ({ v: 1, id: crypto.randomUUID(), op, deviceId: crypto.randomUUID(), generation: 2, deadline: Date.now() + 1000, args, ...extra });
const b64 = (n) => btoa(String.fromCharCode(...new Uint8Array(n)));

Deno.test("real hardware is physical, software devices are not", () => {
  assert.deepEqual(["serial", "probe", "mock", "sim"].map(isPhysical), [true, true, false, false]);
  assert.deepEqual(["serial", "probe", "mock", "sim"].map(isVirtual), [false, false, true, true]);
});

Deno.test("serial options get their defaults and stay in range", () => {
  assert.deepEqual(parseOptions({ baudRate: 115200 }), { baudRate: 115200, dataBits: 8, stopBits: 1, parity: "none", flowControl: "none" });
  assert.deepEqual(parseOptions({ baudRate: 9600, dataBits: 7, parity: "even" }).dataBits, 7);
  for (const bad of [{}, { baudRate: 299 }, { baudRate: 4000001 }, { baudRate: 1.5 }, { baudRate: 9600, dataBits: 6 }, { baudRate: 9600, extra: 1 }])
    assert.throws(() => parseOptions(bad), /Invalid/, JSON.stringify(bad));
});

Deno.test("operations from the backend are checked before the page runs them", () => {
  for (const ok of [
    req("serial.write", { data: b64(16384) }),
    req("serial.signals", { dataTerminalReady: true, requestToSend: false }),
    req("serial.configure", { baudRate: 460800, dataBits: 8, stopBits: 1, parity: "none", flowControl: "none" }),
    req("serial.disconnect", {}),
    req("probe.transfer", { data: b64(1024) }),
    req("probe.open", {}, { lease: crypto.randomUUID() }),
    req("flash.open", { purpose: "esptool write-flash 0x10000 app.bin" }),
    req("flash.open", {}),
  ])
    assert.equal(parseRequest(ok), ok, ok.op);
  for (const bad of [
    req("serial.write", { data: b64(16385) }),
    req("serial.write", { data: "not base64!" }),
    req("serial.write", {}),
    req("serial.write", { data: "AA==", extra: 1 }),
    req("serial.signals", { dtr: true }),
    req("serial.configure", {}),
    req("probe.transfer", { data: "" }),
    req("probe.transfer", { data: b64(1025) }),
    req("flash.open", { purpose: "x".repeat(201) }),
    req("shell.exec", {}),
    req("serial.write", { data: "AA==" }, { v: 2 }),
    req("serial.write", { data: "AA==" }, { id: "not-a-uuid" }),
    req("serial.write", { data: "AA==" }, { generation: 0 }),
    req("serial.write", { data: "AA==" }, { extra: true }),
    { ...req("serial.write", { data: "AA==" }), deadline: undefined },
  ])
    assert.throws(() => parseRequest(bad), /Invalid/, JSON.stringify(bad).slice(0, 120));
});
