import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../../apps/server/app.ts";

const listen = (rt: ReturnType<typeof createApp>, port: number) =>
  new Promise<void>((resolve, reject) => {
    rt.server.once("error", reject);
    rt.server.listen(port, "127.0.0.1", resolve);
  });

test("a running backend mints fresh one-time login links, only for the holder of the admin token", async () => {
  const port = 47952, admin = "a".repeat(64);
  const rt = createApp({ port, test: true, adminToken: admin });
  try {
    await listen(rt, port);
    const mint = (headers: Record<string, string>) =>
      fetch(`${rt.origin}/admin/session-link`, { method: "POST", headers });
    assert.equal((await mint({})).status, 403, "no token");
    assert.equal((await mint({ Authorization: "Bearer " + "b".repeat(64) })).status, 403, "wrong token");
    assert.equal((await mint({ Authorization: `Bearer ${admin}`, Origin: "http://evil.example" })).status, 403, "a browser origin is never accepted");
    assert.equal((await mint({ Authorization: `Bearer ${admin}`, Origin: rt.origin })).status, 403, "not even our own origin: this is not a browser endpoint");

    const ok = await mint({ Authorization: `Bearer ${admin}` });
    assert.equal(ok.status, 200);
    const { url } = (await ok.json()) as { url: string };
    const token = new URL(url).hash.replace("#token=", "");
    assert.equal(token.length, 64);
    assert.ok(url.startsWith(rt.origin + "/#token="));

    const login = (t: string) =>
      fetch(`${rt.origin}/api/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: rt.origin },
        body: JSON.stringify({ token: t }),
      });
    assert.equal((await login(token)).status, 200, "the minted link logs in");
    assert.equal((await login(token)).status, 403, "and only once");
    // The startup link is independent and still works once, even after a renewal was used.
    assert.equal((await login(rt.bootstrap)).status, 200);
    assert.equal((await login(rt.bootstrap)).status, 403);
  } finally {
    await rt.close();
  }
});

test("the admin endpoint is off unless an admin token is configured, and unused links are capped", async () => {
  const port = 47953;
  const off = createApp({ port, test: true });
  try {
    await listen(off, port);
    const r = await fetch(`${off.origin}/admin/session-link`, { method: "POST", headers: { Authorization: "Bearer " } });
    assert.equal(r.status, 403);
  } finally {
    await off.close();
  }
  const admin = "c".repeat(64), port2 = 47954;
  const on = createApp({ port: port2, test: true, adminToken: admin });
  try {
    await listen(on, port2);
    const codes: number[] = [];
    for (let i = 0; i < 6; i++)
      codes.push((await fetch(`${on.origin}/admin/session-link`, { method: "POST", headers: { Authorization: `Bearer ${admin}` } })).status);
    assert.deepEqual(codes.slice(0, 4), [200, 200, 200, 200], "startup token + 4 renewals fill the cap of 5");
    assert.deepEqual(codes.slice(4), [429, 429]);
  } finally {
    await on.close();
  }
});
