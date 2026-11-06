import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
export function Terminal({
  kind,
  csrf,
}: {
  kind: "shell" | "agent";
  csrf: string;
}) {
  const element = useRef<HTMLDivElement>(null);
  const [revision, setRevision] = useState(0),
    [status, setStatus] = useState("Connecting");
  useEffect(() => {
    const term = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "SFMono-Regular, Menlo, monospace",
      scrollback: 2000,
      theme: {
        background: "#0c131b",
        foreground: "#dce8ef",
        cursor: "#75e6bb",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element.current!);
    fit.fit();
    let ws: WebSocket,
      disposed = false,
      exited = false,
      first = true;
    let retry: ReturnType<typeof setTimeout>;
    function connect() {
      ws = new WebSocket(
        `ws://${location.host}/ws/terminal/${kind}${revision && first ? "?restart=1" : ""}`,
        ["dock", csrf],
      );
      first = false;
      ws.onopen = () => {
        term.reset();
        setStatus("Connected");
        ws.send(
          JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }),
        );
      };
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.type === "output") term.write(m.data);
        else if (m.type === "error") {
          exited = true;
          setStatus("Could not start · see error below");
          term.write(`\r\n${m.error}\r\n[Use Restart after resolving the error.]\r\n`);
        } else if (m.type === "exit") {
          exited = true;
          setStatus(`Exited (${m.exitCode})`);
          term.write(
            "\r\n[Process exited. Use Restart to launch it again.]\r\n",
          );
        }
      };
      ws.onclose = (event) => {
        if (disposed || exited) return;
        // A deliberate server close (including older startup failures) is final.
        // Only an interrupted network connection should reattach automatically.
        if (event.code !== 1006) {
          setStatus("Disconnected · use Restart");
          return;
        }
        setStatus("Disconnected · reconnecting");
        retry = setTimeout(connect, 2000);
      };
    }
    connect();
    const input = term.onData((data) => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: "input", data }));
    });
    const observer = new ResizeObserver(() => {
      fit.fit();
      if (ws.readyState === 1)
        ws.send(
          JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }),
        );
    });
    observer.observe(element.current!);
    return () => {
      disposed = true;
      clearTimeout(retry);
      observer.disconnect();
      input.dispose();
      ws.close();
      term.dispose();
    };
  }, [kind, csrf, revision]);
  return (
    <section className="terminal panel">
      <header>
        <span>
          <i className="dot" />{" "}
          {kind === "shell" ? "Linux workspace" : "Codex agent"}{" "}
          <small>{status}</small>
        </span>
        <button onClick={() => setRevision((x) => x + 1)}>Restart</button>
      </header>
      <div ref={element} className="terminal-body" />
    </section>
  );
}
