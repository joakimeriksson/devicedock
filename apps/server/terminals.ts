import type * as pty from "node-pty";
import type WebSocket from "ws";
import { container, verifyManaged } from "./sandbox.ts";
export class Terminals {
  sessions = new Map<
    string,
    {
      process: pty.IPty;
      buffer: string;
      peers: Set<WebSocket>;
      timer?: ReturnType<typeof setTimeout>;
    }
  >();
  async attach(kind: "shell" | "agent", ws: WebSocket, restart = false) {
    const pty = await import("node-pty");
    await verifyManaged();
    if (ws.readyState !== 1) return;
    let s = this.sessions.get(kind);
    if (restart && s) {
      s.process.kill();
      this.sessions.delete(kind);
      s = undefined;
    }
    if (!s) {
      const proc = pty.spawn(
        "docker",
        [
          "exec",
          "-it",
          "-w",
          "/workspace",
          container,
          ...(kind === "agent" ? ["codex"] : ["bash", "-l"]),
        ],
        {
          name: "xterm-256color",
          cols: 100,
          rows: 28,
          env: { ...process.env, TERM: "xterm-256color" },
        },
      );
      s = { process: proc, buffer: "", peers: new Set() };
      const session = s;
      this.sessions.set(kind, s);
      proc.onData((data) => {
        session.buffer = (session.buffer + data).slice(-65536);
        for (const peer of session.peers) {
          if (peer.bufferedAmount > 1048576) peer.terminate();
          else if (peer.readyState === 1)
            peer.send(JSON.stringify({ type: "output", data }));
        }
      });
      proc.onExit(({ exitCode }) => {
        for (const peer of session.peers)
          if (peer.readyState === 1)
            peer.send(JSON.stringify({ type: "exit", exitCode }));
        if (this.sessions.get(kind) === session) this.sessions.delete(kind);
      });
    }
    clearTimeout(s.timer);
    s.peers.add(ws);
    ws.send(JSON.stringify({ type: "output", data: s.buffer }));
    const session = s;
    ws.on("message", (data) => {
      try {
        const m = JSON.parse(data.toString());
        if (
          m.type === "input" &&
          typeof m.data === "string" &&
          m.data.length <= 8192
        )
          session.process.write(m.data);
        else if (
          m.type === "resize" &&
          Number.isInteger(m.cols) &&
          Number.isInteger(m.rows)
        )
          session.process.resize(
            Math.max(20, Math.min(300, m.cols)),
            Math.max(5, Math.min(120, m.rows)),
          );
        else ws.close(1008, "Invalid terminal message");
      } catch {
        ws.close(1008, "Invalid terminal message");
      }
    });
    ws.on("close", () => {
      session.peers.delete(ws);
      if (!session.peers.size)
        session.timer = setTimeout(() => {
          session.process.kill();
          if (this.sessions.get(kind) === session) this.sessions.delete(kind);
        }, 30000);
    });
  }
  close() {
    for (const s of this.sessions.values()) {
      clearTimeout(s.timer);
      s.process.kill();
    }
    this.sessions.clear();
  }
}
