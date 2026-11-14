import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";
import { useThemeName } from "./theme";
import { chunkInput } from "./terminalInput";

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
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
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
  const searchRef = useRef<SearchAddon | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const [revision, setRevision] = useState(0),
    [status, setStatus] = useState("Connecting"),
    // The program reads the mouse (agent TUIs do): a plain drag goes to it, so tell the human how to select.
    [mouseMode, setMouseMode] = useState(false),
    [searching, setSearching] = useState(false),
    [notice, setNotice] = useState("");
  const noticeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const flash = (text: string) => {
    setNotice(text);
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(""), 2500);
  };
  useEffect(() => {
    const term = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: '"SF Mono", SFMono-Regular, Menlo, "JetBrains Mono", "DejaVu Sans Mono", Consolas, monospace',
      scrollback: 10000,
      theme: { ...TERM_THEMES[themeRef.current] },
      // Light theme: lift pale program colours (dim grey, yellow) to readable contrast on white.
      minimumContrastRatio: themeRef.current === "light" ? 4.5 : 1,
      // Needed by the Unicode 11 width tables below.
      allowProposedApi: true,
      // Agent TUIs may turn on mouse reporting, which sends drags to the program instead of selecting.
      // Option+drag (macOS) / Shift+drag (others) then still selects text for copying.
      macOptionClickForcesSelection: true,
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    // Emoji and other wide characters take two cells, as the agents' TUIs expect; otherwise their boxes and
    // status lines are misaligned.
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    // Web links open in a new tab on click (http and https only).
    term.loadAddon(
      new WebLinksAddon((event, uri) => {
        if (!/^https?:\/\//i.test(uri)) return;
        event.preventDefault();
        window.open(uri, "_blank", "noopener,noreferrer");
      }),
    );
    const search = new SearchAddon();
    term.loadAddon(search);
    searchRef.current = search;
    term.open(element.current!);
    // GPU rendering: sharper text and smooth output from busy TUIs. Falls back to the DOM renderer.
    try {
      const gl = new WebglAddon();
      gl.onContextLoss(() => gl.dispose());
      term.loadAddon(gl);
    } catch {
      /* no WebGL2: keep the DOM renderer */
    }
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
    // The backend takes at most 8192 UTF-16 units per input message and drops the session on more,
    // so a long paste is sent in pieces (never splitting a surrogate pair).
    const input = term.onData((data) => {
      if (ws.readyState !== 1) return;
      for (const piece of chunkInput(data)) ws.send(JSON.stringify({ type: "input", data: piece }));
    });
    const parsed = term.onWriteParsed(() => setMouseMode(term.modes.mouseTrackingMode !== "none"));
    // Linux/Windows: Ctrl+C and Ctrl+V belong to the program (interrupt, Claude Code's image paste),
    // so Ctrl+Shift+C copies the selection and Ctrl+Shift+V pastes, like desktop terminals.
    // Cmd+F (macOS) / Ctrl+Shift+F searches the scrollback.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const key = e.key.toLowerCase();
      if (key === "f" && (isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && e.shiftKey) && !e.altKey) {
        e.preventDefault();
        setSearching(true);
        setTimeout(() => searchInput.current?.select(), 0);
        return false;
      }
      if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return true;
      if (key === "c") {
        e.preventDefault();
        const text = term.getSelection();
        if (text) void navigator.clipboard?.writeText(text).catch(() => {});
        return false;
      }
      // Let the browser run its own paste; xterm picks it up from the paste event.
      if (key === "v") return false;
      return true;
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
      parsed.dispose();
      searchRef.current = null;
      ws.close();
      term.dispose();
    };
  }, [kind, csrf, revision]);
  // Switch the live terminal's colours when the theme changes (no restart, scrollback is kept).
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = { ...TERM_THEMES[themeName] };
    term.options.minimumContrastRatio = themeName === "light" ? 4.5 : 1;
  }, [themeName]);
  const copy = () => {
    const term = termRef.current;
    const text = term?.getSelection();
    if (!text) return flash(isMac ? "Select text first (⌥-drag in agents)" : "Select text first (Shift-drag in agents)");
    navigator.clipboard
      ?.writeText(text)
      .then(() => flash("Copied"))
      .catch(() => flash("The browser blocked the clipboard"));
    term!.focus();
  };
  const paste = async () => {
    const term = termRef.current;
    if (!term) return;
    try {
      const text = await navigator.clipboard.readText();
      // term.paste adds bracketed-paste markers when the program asks for them; long text goes out in pieces.
      if (text) term.paste(text);
    } catch {
      flash(isMac ? "Allow clipboard access, or use ⌘V" : "Allow clipboard access, or use Ctrl+Shift+V");
    }
    term.focus();
  };
  const find = (backwards = false) => {
    const q = searchInput.current?.value ?? "";
    if (!q || !searchRef.current) return;
    const found = backwards ? searchRef.current.findPrevious(q) : searchRef.current.findNext(q);
    if (!found) flash("Not found");
  };
  const closeSearch = () => {
    setSearching(false);
    searchRef.current?.clearDecorations();
    termRef.current?.focus();
  };
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
        <span className="terminal-tools">
          {notice ? (
            <small role="status">{notice}</small>
          ) : (
            mouseMode && (
              <small title="This program reads the mouse, so a plain drag goes to it">
                {isMac ? "⌥-drag" : "Shift-drag"} to select
              </small>
            )
          )}
          <button onClick={copy} title={isMac ? "Copy the selection (⌘C)" : "Copy the selection (Ctrl+Shift+C)"}>
            Copy
          </button>
          <button onClick={() => void paste()} title={isMac ? "Paste (⌘V)" : "Paste (Ctrl+Shift+V)"}>
            Paste
          </button>
          <button
            onClick={() => (searching ? closeSearch() : (setSearching(true), setTimeout(() => searchInput.current?.focus(), 0)))}
            aria-pressed={searching}
            title={isMac ? "Search the scrollback (⌘F)" : "Search the scrollback (Ctrl+Shift+F)"}
          >
            Find
          </button>
          <button onClick={() => setRevision((x) => x + 1)}>Restart</button>
        </span>
      </header>
      <div className="terminal-frame">
        {searching && (
          <div className="terminal-search">
            <input
              ref={searchInput}
              aria-label="Search the terminal"
              placeholder="Search"
              onChange={(e) => e.target.value && searchRef.current?.findNext(e.target.value, { incremental: true })}
              onKeyDown={(e) => {
                if (e.key === "Enter") find(e.shiftKey);
                else if (e.key === "Escape") closeSearch();
              }}
            />
            <button onClick={() => find(true)} aria-label="Previous match">↑</button>
            <button onClick={() => find()} aria-label="Next match">↓</button>
            <button onClick={closeSearch} aria-label="Close search">✕</button>
          </div>
        )}
        <div ref={element} className="terminal-body" />
      </div>
    </section>
  );
}
