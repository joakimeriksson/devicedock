// Opt-in OAuth callback relay for `codex login` inside the DeviceDock sandbox.
// Run via `npm run login:codex`. It binds Mac 127.0.0.1:1455 only while the
// container login runs, forwards ONLY `GET /auth/callback`, and never logs
// request contents (the query string contains the authorization code).
import { createServer, type Socket } from "node:net";
import { spawn } from "node:child_process";
import { container, verifyManaged } from "../apps/server/sandbox.ts";

const PORT = 1455;
const TIMEOUT_MS = 10 * 60 * 1000;
const PIPE =
  "const s=require('net').connect(" + PORT + ",'localhost');" +
  "process.stdin.pipe(s);s.pipe(process.stdout);" +
  "s.on('error',()=>process.exit(1));s.on('close',()=>process.exit(0))";

await verifyManaged();

const server = createServer((client: Socket) => {
  client.setTimeout(15000, () => client.destroy());
  client.once("data", (first) => {
    const line = first.toString("latin1", 0, 256).split("\r\n")[0];
    if (!/^GET \/auth\/callback(\?|\s)/.test(line)) {
      client.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const relay = spawn("docker", ["exec", "-i", container, "node", "-e", PIPE], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    relay.stdin.write(first);
    client.pipe(relay.stdin);
    relay.stdout.pipe(client);
    relay.on("close", () => client.destroy());
    client.on("close", () => relay.kill());
    relay.stdin.on("error", () => {});
  });
  client.on("error", () => {});
});

server.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EADDRINUSE") {
    console.error(
      `Port ${PORT} is in use (probably a Mac Codex login or another process). ` +
        "Finish or cancel that first; this relay will not touch it.",
    );
  } else console.error(`Relay failed: ${e.message}`);
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  console.error(`Callback relay active on 127.0.0.1:${PORT} (stops when login ends, max 10 min).`);
  const login = spawn("docker", ["exec", "-it", container, "codex", "login"], {
    stdio: "inherit",
  });
  const stop = (code: number) => {
    server.close();
    login.kill();
    console.error("Callback relay stopped.");
    process.exit(code);
  };
  const timer = setTimeout(() => stop(1), TIMEOUT_MS);
  login.on("exit", (code) => {
    clearTimeout(timer);
    stop(code ?? 1);
  });
  process.on("SIGINT", () => stop(130));
});
