import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useThemeName } from "./theme";

// Dark keeps xterm's default ANSI palette; light needs darker colours or bright yellow/cyan vanish on white.
const TERM_THEMES = {
  dark: { background: "#0c131b", foreground: "#dce8ef", cursor: "#75e6bb" },
  light: {
    background: "#fafbfc",
    foreground: "#1f2933",
    cursor: "#0d7a56",
    cursorAccent: "#fafbfc",
    selectionBackground: "#bfd4e6",
    black: "#1f2933",
    red: "#c0392b",
    green: "#1e7e45",
    yellow: "#8a6100",
    blue: "#1f5fbf",
    magenta: "#9b3fa6",
    cyan: "#0e6f80",
    white: "#5b6b78",
    brightBlack: "#6b7a87",
    brightRed: "#d84a3a",
    brightGreen: "#2a9455",
    brightYellow: "#a06f00",
    brightBlue: "#3573d6",
    brightMagenta: "#b552c0",
    brightCyan: "#1a8fa3",
    brightWhite: "#2d3a45",
  },
} as const;
export type TerminalKind = "shell" | "codex" | "claude" | "opencode";
export const agentLabels: Record<Exclude<TerminalKind, "shell">, string> = {
  codex: "Codex",
  claude: "Claude Code",
  opencode: "OpenCode",
};
export function Terminal({
  kind,
  csrf,
  onKind,
}: {
  kind: TerminalKind;
  csrf: string;
  onKind?: (kind: Exclude<TerminalKind, "shell">) => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const themeName = useThemeName();
  const termRef = useRef<XTerm | null>(null);
  const themeRef = useRef(themeName);
  themeRef.current = themeName;
  const [revision, setRevision] = useState(0),
    [status, setStatus] = useState("Connecting");
  useEffect(() => {
    const term = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "SFMono-Regular, Menlo, monospace",
      scrollback: 2000,
      theme: { ...TERM_THEMES[themeRef.current] },
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element.current!);
    fit.fit();
    // Fonts load after mount; refit once metrics are final so the last rows are not clipped.
    const refit = () => {
      if (disposed) return;
      fit.fit();
      if (ws?.readyState === 1)
        ws.send(
          JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }),
        );
    };
    void document.fonts?.ready.then(refit);
    requestAnimationFrame(refit);
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
  // Switch the live terminal's colours when the theme changes (no restart, scrollback is kept).
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = { ...TERM_THEMES[themeName] };
  }, [themeName]);
  return (
    <section className="terminal panel">
      <header>
        <span>
          <i className="dot" />{" "}
          {kind === "shell" ? (
            "Linux workspace"
          ) : (
            <select
              aria-label="Agent"
              value={kind}
              onChange={(e) =>
                onKind?.(e.target.value as Exclude<TerminalKind, "shell">)
              }
            >
              {Object.entries(agentLabels).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          )}{" "}
          <small>{status}</small>
        </span>
        <button onClick={() => setRevision((x) => x + 1)}>Restart</button>
      </header>
      <div ref={element} className="terminal-body" />
    </section>
  );
}
