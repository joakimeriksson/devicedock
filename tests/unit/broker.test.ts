import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Broker } from "../../apps/server/broker.ts";
import { request, base64, MAX_BUFFER } from "../../packages/protocol/index.ts";
function fixture(autoApprove = true, kind: "mock" | "serial" = "mock") {
  const b = new Broker();
  const sent: any[] = [];
  const d = {
    id: randomUUID(),
    name: "Test device",
    kind,
    generation: 1,
    autoApprove,
    baudRate: 115200,
  };
  b.expose("browser", (m) => sent.push(m), d);
  const req = (op: string, lease?: string, args: unknown = {}) => ({
    v: 1,
    id: randomUUID(),
    deviceId: d.id,
    generation: d.generation,
    op,
    args,
    lease,
    deadline: Date.now() + 5000,
  });
  return { b, d, sent, req };
}
test("protocol rejects invalid bytes, oversized payloads, and unsupported flashing", () => {
  assert.equal(base64.safeParse("%%%").success, false);
  assert.equal(
    base64.safeParse(Buffer.alloc(16385).toString("base64")).success,
    false,
  );
  assert.equal(
    request.safeParse({
      v: 1,
      id: randomUUID(),
      op: "flash",
      args: {},
      deadline: Date.now() + 1000,
    }).success,
    false,
  );
});
test("binary data is preserved; reads consume lease queue", async () => {
  const { b, d, req } = fixture();
  const { lease } = (await b.run(
    "client",
    "agent",
    req("serial.acquire"),
  )) as any;
  const bytes = Buffer.from([0, 255, 128, 13, 10]);
  b.data("browser", d.id, 1, bytes.toString("base64"));
  const r = (await b.run(
    "client",
    "agent",
    req("serial.read", lease, { maxBytes: 2 }),
  )) as any;
  assert.deepEqual(Buffer.from(r.data, "base64"), bytes.subarray(0, 2));
  const tail = (await b.run(
    "client",
    "agent",
    req("serial.read", lease, {}),
  )) as any;
  assert.deepEqual(Buffer.from(tail.data, "base64"), bytes.subarray(2));
  b.close();
});
test("exclusive leases reject competing clients and expire", async () => {
  let now = Date.now();
  const b = new Broker(() => now, 100);
  const d = {
    id: randomUUID(),
    name: "test",
    kind: "mock" as const,
    generation: 1,
    autoApprove: true,
    baudRate: 115200,
  };
  b.expose("browser", () => {}, d);
  const r = (op: string, lease?: string) => ({
    v: 1,
    id: randomUUID(),
    op,
    args: {},
    deviceId: d.id,
    generation: 1,
    deadline: now + 5000,
    lease,
  });
  const { lease } = (await b.run("a", "agent", r("serial.acquire"))) as any;
  await assert.rejects(b.run("b", "ui", r("serial.acquire")), /already leased/);
  await assert.rejects(
    b.run("b", "ui", r("serial.read", lease)),
    /lease required/,
  );
  now += 101;
  await assert.rejects(
    b.run("a", "agent", r("serial.read", lease)),
    /lease required/,
  );
  await b.run("b", "agent", r("serial.acquire"));
  b.close();
});
test("physical writes require single-use owner approval; denial fails request", async () => {
  const { b, req, sent } = fixture(false, "serial");
  const { lease } = (await b.run(
    "agent",
    "agent",
    req("serial.acquire"),
  )) as any;
  const r = req("serial.write", lease, { data: "UElORw==" });
  const p = b.run("agent", "agent", r);
  assert.equal(sent[0].type, "approval");
  b.approve("wrong-owner", r.id, true);
  assert.equal(sent.length, 1);
  b.approve("browser", r.id, true);
  assert.equal(sent[1].type, "operation");
  b.approve("browser", r.id, true);
  assert.equal(sent.length, 2);
  b.reply("browser", r.id, true);
  await p;
  await assert.rejects(b.run("agent", "agent", r), /replay/);
  const denied = req("serial.signals", lease, { dataTerminalReady: false });
  const p2 = b.run("agent", "agent", denied);
  b.approve("browser", denied.id, false);
  await assert.rejects(p2, /denied/);
  b.close();
});
test("revocation rejects pending operations and stale generations", async () => {
  const { b, d, req } = fixture(false);
  const { lease } = (await b.run("a", "agent", req("serial.acquire"))) as any;
  const r = req("serial.write", lease, { data: "AA==" });
  const pending = b.run("a", "agent", r);
  b.revoke("browser", d.id);
  await assert.rejects(pending, /revoked/);
  b.expose("browser", () => {}, { ...d, generation: 2 });
  await assert.rejects(
    b.run("a", "agent", req("serial.read", lease)),
    /stale generation/,
  );
  b.approve("browser", r.id, true);
  assert.equal(b.pending.size, 0);
  b.close();
});
test("timeout expires approvals without replaying writes", async () => {
  const { b, req, sent } = fixture(false);
  const { lease } = (await b.run("a", "agent", req("serial.acquire"))) as any;
  const r = {
    ...req("serial.write", lease, { data: "AA==" }),
    deadline: Date.now() + 20,
  };
  const p = b.run("a", "agent", r);
  await assert.rejects(p, /timed out/);
  b.approve("browser", r.id, true);
  assert.equal(sent.length, 1);
  b.close();
});
test("overflow is explicit and monitor data does not enter stale leases", async () => {
  const { b, d, req } = fixture();
  const { lease } = (await b.run("a", "agent", req("serial.acquire"))) as any;
  for (let n = 0; n < 5; n++)
    b.data("browser", d.id, 1, Buffer.alloc(MAX_BUFFER / 4).toString("base64"));
  await assert.rejects(
    b.run("a", "agent", req("serial.read", lease)),
    /overflow/,
  );
  b.data("browser", d.id, 2, "AA==");
  assert.deepEqual(await b.run("a", "agent", req("serial.read", lease)), {
    data: "",
  });
  b.close();
});
test("physical device auto-approval is forbidden", () => {
  assert.throws(() => fixture(true, "serial"), /require approval/);
});
test("autonomous mode: skips approval for physical devices only while the window is open", async () => {
  const { b, d, sent, req } = fixture(false, "serial");
  const { lease } = (await b.run("c", "agent", req("serial.acquire"))) as any;
  // Without autonomy a physical write waits for approval.
  const waiting = b.run("c", "agent", req("serial.write", lease, { data: "AA==" }));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(sent.at(-1).type, "approval");
  b.approve("browser", sent.at(-1).request.id, false);
  await assert.rejects(waiting, /denied/);
  // With autonomy the operation goes straight to the device.
  b.setAutonomy("browser", d.id, Date.now() + 60_000);
  const r = req("serial.write", lease, { data: "AA==" });
  const done = b.run("c", "agent", r);
  await new Promise((x) => setTimeout(x, 10));
  assert.equal(sent.at(-1).type, "operation");
  b.reply("browser", r.id, true);
  await done;
  // Expiry restores approval.
  b.setAutonomy("browser", d.id, Date.now() + 20);
  await new Promise((x) => setTimeout(x, 40));
  const p = b.run("c", "agent", req("serial.write", lease, { data: "AA==" })).catch(() => {});
  await new Promise((x) => setTimeout(x, 10));
  assert.equal(sent.at(-1).type, "approval");
  b.revoke("browser", d.id);
  await p;
});
test("autonomous mode is owner-only, time-boxed, and cleared on revoke", () => {
  const { b, d } = fixture(false, "serial");
  b.setAutonomy("someone-else", d.id, Date.now() + 60_000);
  assert.equal(b.devices.get(d.id)!.autonomousUntil, undefined);
  assert.throws(() => b.setAutonomy("browser", d.id, Date.now() + 3 * 60 * 60 * 1000), /2 hours/);
  assert.throws(() => b.setAutonomy("browser", d.id, Date.now() - 1), /2 hours/);
  b.setAutonomy("browser", d.id, Date.now() + 60_000);
  assert.ok(b.devices.get(d.id)!.autonomousUntil);
  b.setAutonomy("browser", d.id, null);
  assert.equal(b.devices.get(d.id)!.autonomousUntil, undefined);
});
