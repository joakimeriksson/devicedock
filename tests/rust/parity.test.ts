// Black-box tests for the Rust backend (server-rs). They drive the real binary over HTTP and WebSockets, the same
// way the page and the sandbox bridge do, so the wire protocol stays identical to the Node backend.
// Run: cargo build --manifest-path server-rs/Cargo.toml && npx tsx --test tests/rust/parity.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { WebSocket, WebSocketServer } from "ws";

const BIN = resolve(process.env.DEVICEDOCK_BIN ?? "server-rs/target/debug/devicedock");
const PORT = 47961, BRIDGE = 47962, BOOT = "b".repeat(64), BRIDGE_TOKEN = "t".repeat(64);
const origin = `http://127.0.0.1:${PORT}`;

async function start(): Promise<{ proc: ChildProcess; dir: string }> {
  assert.ok(existsSync(BIN), `build the binary first: ${BIN}`);
  // A scratch working directory: never touch the real .runtime of a running DeviceDock.
  const dir = mkdtempSync(join(tmpdir(), "dd-parity-"));
  mkdirSync(join(dir, ".runtime"));
  writeFileSync(join(dir, ".runtime/bridge-token"), BRIDGE_TOKEN);
  mkdirSync(join(dir, "dist"));
  writeFileSync(join(dir, "dist/index.html"), "<!doctype html><title>dock</title>");
  const proc = spawn(BIN, ["serve"], {
    cwd: dir,
    env: { ...process.env, PORT: String(PORT), DEVICEDOCK_TEST_BOOTSTRAP: BOOT, DEVICEDOCK_BRIDGE_PORT: String(BRIDGE) },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise<void>((ok, fail) => {
    proc.stdout!.on("data", (d) => String(d).includes("listening") && ok());
    proc.on("exit", (c) => fail(Error(`exited ${c}`)));
  });
  return { proc, dir };
}
const statusWithHost = (path: string, host: string) =>
  new Promise<number>((ok, fail) => {
    const r = httpRequest({ host: "127.0.0.1", port: PORT, path, headers: { Host: host } }, (res) => { res.resume(); ok(res.statusCode!); });
    r.on("error", fail);
    r.end();
  });
const login = (token: string) =>
  fetch(origin + "/api/session", { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ token }) });

test("Rust backend: auth, CSRF, admin links, static files, and the full page ⇄ broker ⇄ bridge flow", async (t) => {
  // The fake sandbox bridge must be up before the backend dials it.
  const bridge = new WebSocketServer({ port: BRIDGE, host: "127.0.0.1" });
  const bridgeConn = new Promise<{ ws: WebSocket; auth: string | undefined }>((ok) =>
    bridge.on("connection", (ws, req) => ok({ ws, auth: req.headers.authorization })));
  await new Promise((ok, fail) => { bridge.on("listening", ok); bridge.on("error", fail); });
  const { proc, dir } = await start();
  try {
    await t.test("HTTP auth", async () => {
      assert.equal((await fetch(origin + "/api/health")).status, 401);
      assert.equal(await statusWithHost("/api/health", "evil.example"), 403);
      assert.equal(await statusWithHost("/", "evil.example"), 403);
      const evil = await fetch(origin + "/api/session", { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://evil.example" }, body: JSON.stringify({ token: BOOT }) });
      assert.equal(evil.status, 403);
      const page = await fetch(origin + "/");
      assert.equal(page.status, 200);
      assert.match(await page.text(), /<title>dock/);
      assert.equal(page.headers.get("cache-control"), "no-store");
      assert.match(page.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
      assert.equal((await fetch(origin + "/nope.js")).status, 404);
      assert.equal((await fetch(origin + "/../.runtime/admin-token")).status, 404);
    });
    const admin = readFileSync(join(dir, ".runtime/admin-token"), "utf8").trim();
    assert.equal(admin.length, 64);
    assert.equal(readFileSync(join(dir, ".runtime/session-link"), "utf8"), `${origin}/#token=${BOOT}`);

    let cookie = "", csrf = "";
    await t.test("one-time login links", async () => {
      const r = await login(BOOT);
      assert.equal(r.status, 200);
      cookie = r.headers.get("set-cookie")!.split(";")[0];
      assert.match(r.headers.get("set-cookie")!, /HttpOnly; SameSite=Strict/);
      csrf = ((await r.json()) as any).csrf;
      assert.equal((await login(BOOT)).status, 403, "startup link works once");
      assert.equal((await fetch(origin + "/api/anything", { method: "POST", headers: { Cookie: cookie, Origin: origin } })).status, 403, "CSRF");
      const s = await fetch(origin + "/api/session", { headers: { Cookie: cookie } });
      assert.equal(((await s.json()) as any).csrf, csrf);
      const mint = (h: Record<string, string>) => fetch(origin + "/admin/session-link", { method: "POST", headers: h });
      assert.equal((await mint({})).status, 403);
      assert.equal((await mint({ Authorization: `Bearer ${admin}`, Origin: origin })).status, 403, "never from a browser");
      const ok = await mint({ Authorization: `Bearer ${admin}` });
      assert.equal(ok.status, 200);
      const url = ((await ok.json()) as any).url as string;
      assert.ok(url.startsWith(origin + "/#token="));
      assert.equal((await login(url.split("#token=")[1])).status, 200);
      const codes = [];
      for (let i = 0; i < 6; i++) codes.push((await mint({ Authorization: `Bearer ${admin}` })).status);
      assert.deepEqual(codes, [200, 200, 200, 200, 200, 429], "at most 5 unused links");
    });

    await t.test("WebSocket guard", async () => {
      const refused = await new Promise<number>((ok) => {
        const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/devices`, ["dock", csrf], { headers: { Cookie: cookie, Origin: "http://evil.example" } });
        ws.on("unexpected-response", (_q, res) => { res.resume(); ws.terminate(); ok(res.statusCode!); });
        ws.on("error", () => {});
      });
      assert.equal(refused, 403);
      const noCsrf = await new Promise<number>((ok) => {
        const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/devices`, ["dock"], { headers: { Cookie: cookie, Origin: origin } });
        ws.on("unexpected-response", (_q, res) => { res.resume(); ws.terminate(); ok(res.statusCode!); });
        ws.on("error", () => {});
      });
      assert.equal(noCsrf, 403);
    });

    await t.test("page shares a device; agent request via the bridge needs approval; reply flows back", async () => {
      const page = new WebSocket(`ws://127.0.0.1:${PORT}/ws/devices`, ["dock", csrf], { headers: { Cookie: cookie, Origin: origin } });
      await new Promise((ok, fail) => { page.on("open", ok); page.on("error", fail); });
      assert.equal(page.protocol, "dock");
      const inbox: any[] = [];
      page.on("message", (d) => inbox.push(JSON.parse(String(d))));
      const next = async (pred: (m: any) => boolean) => {
        for (let i = 0; i < 200; i++) {
          const k = inbox.findIndex(pred);
          if (k >= 0) return inbox.splice(k, 1)[0];
          await new Promise((r) => setTimeout(r, 10));
        }
        throw Error("no message");
      };
      const dev = { id: randomUUID(), name: "LaunchPad", kind: "serial", generation: 1, autoApprove: false, baudRate: 115200 };
      page.send(JSON.stringify({ type: "expose", device: { ...dev, autoApprove: true } }));
      assert.match((await next((m) => m.type === "error")).error, /require approval/);
      page.send(JSON.stringify({ type: "expose", device: dev }));
      page.send(JSON.stringify({ type: "bogus" }));
      await next((m) => m.type === "error");

      const { ws: br, auth } = await bridgeConn;
      assert.equal(auth, `Bearer ${BRIDGE_TOKEN}`);
      const replies: any[] = [];
      br.on("message", (d) => replies.push(JSON.parse(String(d))));
      const client = randomUUID();
      const ask = async (op: string, args: unknown = {}, extra: object = {}) => {
        const id = randomUUID();
        br.send(JSON.stringify({ client, request: { v: 1, id, op, args, deadline: Date.now() + 10000, deviceId: dev.id, generation: 1, ...extra } }));
        for (let i = 0; i < 300; i++) {
          const k = replies.findIndex((r) => r.id === id);
          if (k >= 0) return replies.splice(k, 1)[0];
          if (op === "serial.write") {
            const a = inbox.findIndex((m) => m.type === "approval" && m.request.id === id);
            if (a >= 0) {
              const m = inbox.splice(a, 1)[0];
              assert.deepEqual(m.request.args, args);
              page.send(JSON.stringify({ type: "approve", id, allow: true }));
            }
            const o = inbox.findIndex((m) => m.type === "operation" && m.request.id === id);
            if (o >= 0) { inbox.splice(o, 1); page.send(JSON.stringify({ type: "reply", id, ok: true })); }
          }
          await new Promise((r) => setTimeout(r, 10));
        }
        throw Error("no reply for " + op);
      };
      const list = await ask("devices.list");
      assert.equal(list.ok, true);
      assert.deepEqual(list.result, [{ id: dev.id, name: "LaunchPad", kind: "serial", simulated: false, generation: 1, baudRate: 115200, autonomous: false }]);
      const acq = await ask("serial.acquire");
      assert.equal(acq.ok, true);
      const lease = acq.result.lease;
      page.send(JSON.stringify({ type: "data", deviceId: dev.id, generation: 1, data: Buffer.from("hello\n").toString("base64") }));
      await new Promise((r) => setTimeout(r, 50));
      const rd = await ask("serial.read", {}, { lease });
      assert.equal(Buffer.from(rd.result.data, "base64").toString(), "hello\n");
      const wr = await ask("serial.write", { data: "UElORw==" }, { lease });
      assert.deepEqual(wr, { id: wr.id, ok: true, result: {} });
      const bad = await ask("serial.read", {}, { lease: randomUUID() });
      assert.equal(bad.ok, false);
      assert.match(bad.error, /lease required/);
      // The page's own RPC path.
      const rid = randomUUID();
      page.send(JSON.stringify({ type: "rpc", request: { v: 1, id: rid, op: "devices.list", args: {}, deadline: Date.now() + 5000 } }));
      const rr = await next((m) => m.type === "rpc-result");
      assert.equal(rr.id, rid);
      assert.equal(rr.result.length, 1);
      // Closing the page revokes its devices.
      page.close();
      await new Promise((r) => setTimeout(r, 100));
      const after = await ask("devices.list");
      assert.deepEqual(after.result, []);
    });
  } finally {
    proc.kill("SIGTERM");
    bridge.close();
  }
});
