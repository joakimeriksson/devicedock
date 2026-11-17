// The page's loopback mock and the base64 helpers that carry device bytes over the WebSocket.
import assert from "node:assert/strict";
import { MockAdapter, encode, decode } from "../../apps/web/src/adapters.js";

Deno.test("base64 carries every byte value", () => {
  const all = Uint8Array.from({ length: 256 }, (_, i) => i);
  assert.deepEqual([...decode(encode(all))], [...all]);
  assert.equal(encode(new TextEncoder().encode("PING\n")), "UElORwo=");
});

Deno.test("the mock answers PING with PONG, echoes anything else, and fails once unplugged", async () => {
  const mock = new MockAdapter();
  mock.latency = 0;
  const d = await mock.requestDevice();
  assert.equal(d.kind, "mock");
  const got = [];
  const events = [];
  mock.subscribe(d.id, (e) => (e.type === "data" ? got.push([...e.bytes]) : events.push(e)));
  await assert.rejects(mock.write(d.id, new Uint8Array([1])), /unplugged/, "closed until opened");
  await mock.open(d.id, { baudRate: 115200 });
  try {
    await mock.write(d.id, new TextEncoder().encode("PING\n"));
    await mock.write(d.id, Uint8Array.from([0, 255, 128, 1]));
    assert.deepEqual(got, [[...new TextEncoder().encode("PONG\n")], [0, 255, 128, 1]]);
    await mock.setSignals(d.id, { dataTerminalReady: true });
    mock.failWrites = true;
    await assert.rejects(mock.write(d.id, new Uint8Array([1])), /Simulated write error/);
  } finally {
    mock.unplug(d.id);
  }
  assert.deepEqual(events, [{ type: "disconnect", error: "Mock unplugged" }]);
  await assert.rejects(mock.write(d.id, new Uint8Array([1])), /unplugged/);
  assert.deepEqual((await mock.listGranted()).map((x) => x.id), [d.id]);
});
