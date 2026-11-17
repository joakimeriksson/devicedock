// The page's loopback mock (apps/web). The device client side of this round trip (agent -> bridge -> broker -> page)
// is tested in Rust: server-rs/src/device.rs and server-rs/tests/sandbox.rs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MockAdapter, encode, decode } from "../../apps/web/src/adapters.ts";

test("browser mock answers PING with PONG, echoes binary bytes exactly, and fails when unplugged", async () => {
  const mock = new MockAdapter();
  mock.latency = 0;
  const d = await mock.requestDevice();
  await mock.open(d.id, { baudRate: 115200 });
  const got: Uint8Array[] = [];
  mock.subscribe(d.id, (e) => {
    if (e.type === "data") got.push(e.bytes);
  });
  try {
    await mock.write(d.id, new TextEncoder().encode("PING\n"));
    assert.equal(new TextDecoder().decode(got.shift()), "PONG\n");
    const bytes = Uint8Array.from([0, 255, 128, 10]);
    await mock.write(d.id, bytes);
    assert.deepEqual([...got.shift()!], [...bytes]);
    assert.deepEqual([...decode(encode(bytes))], [...bytes], "the page's base64 helpers keep every byte");
    await mock.close(d.id);
    await assert.rejects(mock.write(d.id, bytes), /unplugged/);
  } finally {
    await mock.close(d.id);
  }
});
