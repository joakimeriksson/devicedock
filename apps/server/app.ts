import express from "express";
import { createServer } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { resolve } from "node:path";
import { Broker } from "./broker.ts";
import { browserMessage, request } from "../../packages/protocol/index.ts";
import { health, getBridgeToken, bridgePort } from "./sandbox.ts";
import { Terminals, terminalKinds, type TerminalKind } from "./terminals.ts";

// "/ws/terminal/agent" is kept as an alias for Codex.
const terminalKind = (url = ""): TerminalKind | undefined => {
  const m = /^\/ws\/terminal\/([a-z]+)(\?|$)/.exec(url);
  const name = m?.[1] === "agent" ? "codex" : m?.[1];
  return terminalKinds.find((k) => k === name);
};
export function equal(a: string, b: string) {
  return (
    Buffer.byteLength(a) === Buffer.byteLength(b) &&
    timingSafeEqual(Buffer.from(a), Buffer.from(b))
  );
}
export function createApp({
  port = 47831,
  bootstrap = randomBytes(32).toString("hex"),
  test = false,
} = {}) {
  // Cookies are not isolated by port, so another local instance would overwrite a shared name.
  const cookieName = `dock_${port}`;
  const origin = `http://127.0.0.1:${port}`,
    host = `127.0.0.1:${port}`;
  const app = express(),
    server = createServer(app),
    broker = new Broker(),
    terminals = new Terminals();
  let unused = true;
  const sessions = new Map<string, { csrf: string; expires: number }>();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.set({
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://" +
        host +
        "; frame-ancestors 'none'; base-uri 'none'",
    });
    if (req.headers.host !== host) return res.status(403).end();
    next();
  });
  app.use(express.json({ limit: "64kb" }));
  const session = (cookie?: string) => {
    const key = cookie
      ?.split("; ")
      .find((v) => v.startsWith(cookieName + "="))
      ?.slice(cookieName.length + 1);
    const s = sessions.get(key ?? "");
    return s && s.expires > Date.now() ? s : undefined;
  };
  app.post("/api/session", (req, res) => {
    if (
      req.headers.origin !== origin ||
      !unused ||
      typeof req.body?.token !== "string" ||
      !equal(req.body.token, bootstrap)
    )
      return res.status(403).json({
        error:
          "Invalid or used session link. Restart the backend for a new link.",
      });
    unused = false;
    const key = randomBytes(32).toString("hex"),
      csrf = randomBytes(32).toString("hex");
    sessions.set(key, { csrf, expires: Date.now() + 12 * 60 * 60 * 1000 });
    res.setHeader(
      "Set-Cookie",
      `${cookieName}=${key}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`,
    );
    res.json({ csrf });
  });
  app.use("/api", (req, res, next) => {
    const s = session(req.headers.cookie);
    if (!s)
      return res
        .status(401)
        .json({ error: "Open the local session link using npm run open." });
    if (
      req.method !== "GET" &&
      (req.headers.origin !== origin || req.headers["x-csrf-token"] !== s.csrf)
    )
      return res.status(403).end();
    next();
  });
  app.get("/api/session", (req, res) =>
    res.json({ csrf: session(req.headers.cookie)!.csrf }),
  );
  app.get("/api/health", async (_req, res) => res.json(await health()));
  app.use(express.static(resolve("dist")));
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65536 });
  server.on("upgrade", (req, socket, head) => {
    const s = session(req.headers.cookie);
    const protocols = req.headers["sec-websocket-protocol"]
      ?.split(",")
      .map((x) => x.trim());
    if (
      req.headers.host !== host ||
      req.headers.origin !== origin ||
      !s ||
      !protocols?.includes(s.csrf) ||
      wss.clients.size >= 8
    ) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    if (req.url?.split("?")[0] !== "/ws/devices" && !terminalKind(req.url)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });
  wss.on("connection", async (ws, req) => {
    if (req.url?.startsWith("/ws/terminal/")) {
      try {
        await terminals.attach(
          terminalKind(req.url)!,
          ws,
          req.url.endsWith("?restart=1"),
        );
      } catch (error) {
        const detail = (error as Error).message.slice(0, 500);
        console.error(`Docker terminal failed: ${detail}`);
        ws.send(
          JSON.stringify({
            type: "error",
            error: `Unable to start Docker PTY: ${detail}`,
          }),
        );
        ws.close(1011, "Terminal startup failed");
      }
      return;
    }
    const owner = randomUUID(),
      send = (m: unknown) => {
        if (ws.bufferedAmount > 1048576) {
          ws.terminate();
          return;
        }
        if (ws.readyState === 1) ws.send(JSON.stringify(m));
      };
    let inFlight = 0;
    ws.on("message", async (data) => {
      try {
        const m = browserMessage.parse(JSON.parse(data.toString()));
        if (m.type === "expose") broker.expose(owner, send, m.device);
        else if (m.type === "revoke") broker.revoke(owner, m.deviceId);
        else if (m.type === "autonomy")
          broker.setAutonomy(owner, m.deviceId, m.until);
        else if (m.type === "data")
          broker.data(owner, m.deviceId, m.generation, m.data);
        else if (m.type === "approve") broker.approve(owner, m.id, m.allow);
        else if (m.type === "reply") broker.reply(owner, m.id, m.ok, m.error);
        else if (m.type === "rpc") {
          if (inFlight >= 32) throw Error("Too many requests");
          inFlight++;
          try {
            send({
              type: "rpc-result",
              id: m.request.id,
              ok: true,
              result: await broker.run(owner, "ui", m.request),
            });
          } catch (e) {
            send({
              type: "rpc-result",
              id: m.request.id,
              ok: false,
              error: (e as Error).message,
            });
          } finally {
            inFlight--;
          }
        }
      } catch (e) {
        send({ type: "error", error: (e as Error).message.slice(0, 400) });
      }
    });
    ws.on("close", () => {
      broker.disconnectOwner(owner);
      broker.disconnectClient(owner);
    });
  });
  let bridge: WebSocket | undefined,
    connecting = false;
  const clients = new Set<string>();
  async function connectBridge() {
    if (
      test ||
      connecting ||
      bridge?.readyState === 1 ||
      bridge?.readyState === 0
    )
      return;
    connecting = true;
    try {
      const token = await getBridgeToken();
      bridge = new WebSocket(`ws://127.0.0.1:${bridgePort}/bridge`, {
        headers: { Authorization: `Bearer ${token}` },
        maxPayload: 65536,
        handshakeTimeout: 5000,
      });
      bridge.on("error", () => {});
      bridge.on("close", () => {
        for (const c of clients) broker.disconnectClient(c);
        clients.clear();
      });
      bridge.on("message", async (raw) => {
        let rid = "";
        try {
          const m = JSON.parse(raw.toString());
          if (typeof m.client !== "string" || !/^[a-f0-9-]{36}$/.test(m.client))
            throw Error("Invalid client");
          const r = request.parse(m.request);
          rid = r.id;
          if (clients.size >= 128 && !clients.has(m.client))
            throw Error(
              "Client limit; restart the backend to begin a new client session",
            );
          clients.add(m.client);
          const result = await broker.run(m.client, "agent", r);
          if (bridge?.readyState === 1)
            bridge.send(JSON.stringify({ id: r.id, ok: true, result }));
        } catch (e) {
          if (rid && bridge?.readyState === 1)
            bridge.send(
              JSON.stringify({
                id: rid,
                ok: false,
                error: (e as Error).message.slice(0, 400),
              }),
            );
        }
      });
    } catch {
    } finally {
      connecting = false;
    }
  }
  const poll = setInterval(connectBridge, 3000);
  void connectBridge();
  return {
    app,
    server,
    broker,
    bootstrap,
    origin,
    async close() {
      clearInterval(poll);
      bridge?.close();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      broker.close();
      terminals.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
