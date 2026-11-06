import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { request, response } from "../../packages/protocol/index.ts";
const pending = new Map<
  string,
  { done: (value: unknown) => void; timer: ReturnType<typeof setTimeout> }
>();
let bridge: WebSocket | undefined;
function authenticated(value?: string) {
  try {
    const expected =
      "Bearer " + readFileSync("/home/node/.bridge-token", "utf8").trim();
    return (
      !!value &&
      Buffer.byteLength(value) === Buffer.byteLength(expected) &&
      timingSafeEqual(Buffer.from(value), Buffer.from(expected))
    );
  } catch {
    return false;
  }
}
const server = createServer((req, res) => {
  if (
    req.headers.host !== "127.0.0.1:47832" ||
    req.headers.origin ||
    req.url !== "/rpc" ||
    req.method !== "POST" ||
    !authenticated(req.headers.authorization)
  ) {
    res.writeHead(403).end();
    return;
  }
  if (!bridge || bridge.readyState !== 1) {
    res
      .writeHead(503)
      .end(JSON.stringify({ error: "Mac bridge is disconnected" }));
    return;
  }
  if (pending.size >= 64) {
    res.writeHead(429).end();
    return;
  }
  let size = 0,
    chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > 65536) {
      res.writeHead(413).end();
      req.destroy();
    } else chunks.push(chunk);
  });
  req.on("end", () => {
    try {
      const m = JSON.parse(Buffer.concat(chunks).toString());
      const r = request.parse(m.request);
      if (typeof m.client !== "string" || !/^[a-f0-9-]{36}$/.test(m.client))
        throw Error("Invalid client");
      if (pending.has(r.id)) throw Error("Duplicate request");
      const ms = r.deadline - Date.now();
      if (ms <= 0 || ms > 60000) throw Error("Invalid deadline");
      const done = (v: unknown) => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(v));
      };
      const timer = setTimeout(() => {
        pending.delete(r.id);
        done({
          id: r.id,
          ok: false,
          error: "Bridge timeout; writes must not be automatically retried",
        });
      }, ms);
      pending.set(r.id, { done, timer });
      bridge!.send(JSON.stringify({ client: m.client, request: r }));
      res.on("close", () => {
        const p = pending.get(r.id);
        if (p) {
          clearTimeout(p.timer);
          pending.delete(r.id);
        }
      });
    } catch {
      res
        .writeHead(400)
        .end(JSON.stringify({ error: "Invalid device request" }));
    }
  });
});
const wss = new WebSocketServer({ noServer: true, maxPayload: 65536 });
server.on("upgrade", (req, socket, head) => {
  if (
    req.headers.host !== "127.0.0.1:47832" ||
    req.headers.origin ||
    req.url !== "/bridge" ||
    !authenticated(req.headers.authorization) ||
    bridge?.readyState === 1
  ) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
});
wss.on("connection", (ws: WebSocket) => {
  bridge = ws;
  ws.on("message", (raw) => {
    try {
      const m = response.parse(JSON.parse(raw.toString()));
      const p = pending.get(m.id);
      if (p) {
        clearTimeout(p.timer);
        pending.delete(m.id);
        p.done(m);
      }
    } catch {
      ws.close(1008);
    }
  });
  ws.on("close", () => {
    if (bridge === ws) bridge = undefined;
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      p.done({ id, ok: false, error: "Mac bridge disconnected" });
    }
    pending.clear();
  });
});
server.listen(47832, "0.0.0.0", () =>
  console.log("Container device bridge ready"),
);
