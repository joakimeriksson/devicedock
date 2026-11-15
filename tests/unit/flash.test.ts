import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Broker } from "../../apps/server/broker.ts";
import { FLASH_IDLE_MS, FLASH_MAX_MS, request } from "../../packages/protocol/index.ts";

// A real serial board, a clock the test moves, and a page that approves (or denies) and answers every operation.
// The page counts the approvals it was asked for: the point of a flash session is that there is one per flash.
function fixture() {
  let t = 1_000_000;
  const b = new Broker(() => t, 3_600_000);
  const sent: any[] = [];
  const d = { id: randomUUID(), name: "CP210x USB-UART (10c4:ea60)", kind: "serial" as const, generation: 1, autoApprove: false, baudRate: 115200 };
  b.expose("browser", (m) => sent.push(m), d);
  const req = (op: string, lease?: string, args: unknown = {}) => ({ v: 1, id: randomUUID(), deviceId: d.id, generation: 1, op, args, lease, deadline: t + 5000 });
  const page = { allow: true, approvals: [] as any[], sessions: [] as any[] };
  const timer = setInterval(() => {
    for (const m of sent.splice(0)) {
      if (m.type === "approval") {
        page.approvals.push(m.request);
        b.approve("browser", m.request.id, page.allow);
      }
      if (m.type === "operation") b.reply("browser", m.request.id, true);
      if (m.type === "flash-session") page.sessions.push(m);
    }
  }, 1);
  const lease = async (client = "esptool") => ((await b.run(client, "agent", req("serial.acquire"))) as any).lease as string;
  const list = async () => ((await b.run("esptool", "agent", req("devices.list"))) as any[])[0];
  return { b, d, req, page, lease, list, advance: (ms: number) => (t += ms), stop: () => clearInterval(timer) };
}
// What esptool does to the port while flashing.
const esptool = [
  ["serial.signals", { dataTerminalReady: false, requestToSend: true }],
  ["serial.signals", { dataTerminalReady: true, requestToSend: false }],
  ["serial.configure", { baudRate: 460800 }],
  ["serial.write", { data: "wAAIJAAA" }],
] as const;

test("flash.open takes an optional purpose of at most 200 characters, and nothing else", () => {
  const r = (args: unknown) => request.safeParse({ v: 1, id: randomUUID(), op: "flash.open", deadline: 5, args });
  assert.equal(r({}).success, true);
  assert.equal(r({ purpose: "esptool write-flash 0x10000 app.bin" }).success, true);
  assert.equal(r({ purpose: "x".repeat(201) }).success, false);
  assert.equal(r({ seconds: 60 }).success, false);
});

test("one approval covers a whole flash, and shows the purpose the agent gave", async () => {
  const f = fixture();
  try {
    // The CLI opens the session under its own lease; esptool then flashes under another one.
    const cli = await f.lease("cli");
    assert.deepEqual(await f.b.run("cli", "agent", f.req("flash.open", cli, { purpose: "esptool write-flash" })), { session: "opened" });
    await f.b.run("cli", "agent", f.req("serial.release", cli));
    assert.equal(f.page.approvals.length, 1);
    assert.equal(f.page.approvals[0].args.purpose, "esptool write-flash");
    assert.equal((await f.list()).flashSession, true);
    const l = await f.lease();
    for (const [op, args] of esptool) await f.b.run("esptool", "agent", f.req(op, l, args));
    assert.equal(f.page.approvals.length, 1, "no further clicks inside the session");
    // Closing the port ends the share, so it is never covered.
    f.page.allow = false;
    await assert.rejects(f.b.run("esptool", "agent", f.req("serial.disconnect", l)), /denied/);
    // A second flash.open keeps it going without asking.
    assert.deepEqual(await f.b.run("esptool", "agent", f.req("flash.open", l)), { session: "active" });
    await f.b.run("esptool", "agent", f.req("flash.close", l));
    await assert.rejects(f.b.run("esptool", "agent", f.req("serial.write", l, { data: "AA==" })), /denied/);
    assert.deepEqual(f.page.sessions.map((s) => s.active), [true, false]);
  } finally {
    f.stop();
  }
});

test("a session ends after two idle minutes, after fifteen busy ones, and when the owner cuts it off", async () => {
  const f = fixture();
  try {
    const l = await f.lease();
    await f.b.run("esptool", "agent", f.req("flash.open", l));
    f.advance(FLASH_IDLE_MS + 1);
    f.page.allow = false;
    await assert.rejects(f.b.run("esptool", "agent", f.req("serial.write", l, { data: "AA==" })), /denied/);
    assert.equal((await f.list()).flashSession, false);

    f.page.allow = true;
    await f.b.run("esptool", "agent", f.req("flash.open", l));
    const asked = f.page.approvals.length;
    for (let busy = 60_000; busy < FLASH_MAX_MS; busy += 60_000) {
      f.advance(60_000);
      await f.b.run("esptool", "agent", f.req("serial.write", l, { data: "AA==" }));
    }
    assert.equal(f.page.approvals.length, asked);
    f.advance(60_000);
    await f.b.run("esptool", "agent", f.req("serial.write", l, { data: "AA==" }));
    assert.equal(f.page.approvals.length, asked + 1, "asks again at the hard end");

    await f.b.run("esptool", "agent", f.req("flash.open", l));
    f.b.endFlash("someone-else", f.d.id);
    assert.equal((await f.list()).flashSession, true);
    f.b.endFlash("browser", f.d.id);
    assert.equal((await f.list()).flashSession, false);
    await new Promise((r) => setTimeout(r, 5)); // let the page see the message
    assert.equal(f.page.sessions.at(-1)?.active, false);
  } finally {
    f.stop();
  }
});

test("autonomous mode needs no session; a debug probe has none", async () => {
  const f = fixture();
  try {
    f.b.setAutonomy("browser", f.d.id, 1_000_000 + 60_000);
    const l = await f.lease();
    assert.deepEqual(await f.b.run("esptool", "agent", f.req("flash.open", l)), { session: "not needed" });
    assert.equal(f.page.approvals.length, 0);
  } finally {
    f.stop();
  }
  const b = new Broker();
  const p = { id: randomUUID(), name: "XDS110", kind: "probe" as const, generation: 1, autoApprove: false, baudRate: 115200 };
  b.expose("browser", () => {}, p);
  const r = (op: string, lease?: string) => ({ v: 1, id: randomUUID(), deviceId: p.id, generation: 1, op, args: {}, lease, deadline: Date.now() + 5000 });
  const { lease } = (await b.run("bridge", "agent", r("serial.acquire"))) as any;
  await assert.rejects(b.run("bridge", "agent", r("flash.open", lease)), /no serial port/);
  assert.equal((((await b.run("bridge", "agent", r("devices.list"))) as any[])[0]).flashSession, undefined);
});
