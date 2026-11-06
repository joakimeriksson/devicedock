import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Broker } from "../../apps/server/broker.ts";
import { DeviceClient } from "../../packages/device-client/index.ts";
import { MockAdapter, encode, decode } from "../../apps/web/src/adapters.ts";
test("SDK and browser mock round-trip through shared broker, then fail after revocation", async () => {
  const original = globalThis.fetch,
    b = new Broker(),
    mock = new MockAdapter();
  const descriptor = await mock.requestDevice(),
    d = { ...descriptor, generation: 1, autoApprove: true, baudRate: 115200 };
  await mock.open(d.id, { baudRate: 115200 });
  mock.subscribe(d.id, (e) => {
    if (e.type === "data") b.data("browser", d.id, 1, encode(e.bytes));
  });
  b.expose(
    "browser",
    (message) => {
      const m = message as any;
      if (m.type === "operation")
        void mock
          .write(d.id, decode(m.request.args.data))
          .then(() => b.reply("browser", m.request.id, true));
    },
    d,
  );
  globalThis.fetch = async (_url, init) => {
    assert.equal((init?.headers as any).Authorization, "Bearer test-token");
    const body = JSON.parse(init!.body as string);
    try {
      return new Response(
        JSON.stringify({
          id: body.request.id,
          ok: true,
          result: await b.run(body.client, "agent", body.request),
        }),
      );
    } catch (e) {
      return new Response(
        JSON.stringify({
          id: body.request.id,
          ok: false,
          error: (e as Error).message,
        }),
      );
    }
  };
  try {
    const client = new DeviceClient("http://test/rpc", "test-token");
    const found = (await client.list())[0];
    await client.using(found, async (lease) => {
      await client.call(
        "serial.write",
        found,
        { data: Buffer.from("PING\n").toString("base64") },
        lease,
      );
      const r = (await client.call("serial.read", found, {}, lease)) as any;
      assert.equal(Buffer.from(r.data, "base64").toString(), "PONG\n");
      const bytes = Buffer.from([0, 255, 128, 10]);
      await client.call(
        "serial.write",
        found,
        { data: bytes.toString("base64") },
        lease,
      );
      const binary = (await client.call(
        "serial.read",
        found,
        {},
        lease,
      )) as any;
      assert.deepEqual(Buffer.from(binary.data, "base64"), bytes);
      b.revoke("browser", found.id);
      await assert.rejects(
        client.call("serial.write", found, { data: "AA==" }, lease),
        /unavailable/,
      );
    });
    assert.deepEqual(await client.list(), []);
  } finally {
    globalThis.fetch = original;
    b.close();
    await mock.close(d.id);
  }
});
test("approval expires with lease and does not dispatch", async () => {
  let now = Date.now();
  const b = new Broker(() => now, 100),
    sent: any[] = [];
  const d = {
    id: randomUUID(),
    name: "Serial",
    kind: "serial" as const,
    generation: 1,
    autoApprove: false,
    baudRate: 115200,
  };
  b.expose("browser", (m) => sent.push(m), d);
  const req = (op: string, lease?: string, args = {}) => ({
    v: 1,
    id: randomUUID(),
    op,
    deviceId: d.id,
    generation: 1,
    lease,
    args,
    deadline: now + 5000,
  });
  const { lease } = (await b.run("a", "agent", req("serial.acquire"))) as any;
  const r = req("serial.write", lease, { data: "AA==" });
  const pending = b.run("a", "agent", r);
  now += 101;
  b.approve("browser", r.id, true);
  await assert.rejects(pending, /expired/);
  assert.equal(sent.length, 1);
  b.close();
});
