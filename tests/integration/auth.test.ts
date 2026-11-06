import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { createApp } from "../../apps/server/app.ts";
test("HTTP and WebSockets reject unauthenticated, hostile origin, CSRF, and reused bootstrap", async () => {
  const port = 47951;
  const runtime = createApp({ port, test: true });
  try {
    await new Promise<void>((resolve, reject) => {
      runtime.server.once("error", reject);
      runtime.server.listen(port, "127.0.0.1", resolve);
    });
    const origin = runtime.origin;
    assert.equal((await fetch(origin + "/api/health")).status, 401);
    assert.equal(
      (
        await fetch(origin + "/api/health", {
          headers: { Host: "evil.example" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(origin + "/api/session", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "http://evil.example",
          },
          body: JSON.stringify({ token: runtime.bootstrap }),
        })
      ).status,
      403,
    );
    const login = () =>
      fetch(origin + "/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify({ token: runtime.bootstrap }),
      });
    const r = await login();
    assert.equal(r.status, 200);
    const cookie = r.headers.get("set-cookie")!.split(";")[0];
    const { csrf } = (await r.json()) as any;
    assert.equal((await login()).status, 403);
    assert.equal(
      (
        await fetch(origin + "/api/anything", {
          method: "POST",
          headers: { Cookie: cookie, Origin: origin },
        })
      ).status,
      403,
    );
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${port}/ws/devices`,
        ["dock", csrf],
        { headers: { Cookie: cookie, Origin: "http://evil.example" } },
      );
      ws.on("open", () => reject(Error("Hostile origin accepted")));
      ws.on("unexpected-response", (_req, res) => {
        assert.equal(res.statusCode, 403);
        res.resume();
        ws.terminate();
        resolve();
      });
      ws.on("error", () => {});
    });
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${port}/ws/devices`,
        ["dock", csrf],
        { headers: { Cookie: cookie, Origin: origin } },
      );
      ws.on("open", () => {
        ws.close();
        resolve();
      });
      ws.on("error", reject);
    });
  } finally {
    await runtime.close();
  }
});
