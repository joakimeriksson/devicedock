// What an agent's device operation does, in words, for the approval dialog. The human approves what they can read:
// "Send 12 bytes: print(6*7)\r" rather than a JSON request with base64 in it.
import { decode } from "./adapters";

export type Description = {
  title: string;
  detail: string;
  /** Bytes to be sent: as visible text (control characters escaped) and as hex. */
  data?: { text: string; hex: string; binary: boolean; size: number; shown: number };
  /** What the agent says it will do (flash.open). The agent's words, not checked by anyone. */
  purpose?: string;
  /** Approving opens a session: offer a single Allow, not "Allow all for 15 min". */
  session?: boolean;
};

const PREVIEW = 600;

// Characters that change how text looks without being seen: C1 controls, and format characters (bidi overrides such as
// U+202E, zero-width spaces and joiners). An agent could use them to make the dialog misstate what it approves.
const HIDDEN = /[\u0080-\u009f\p{Cf}]/u;
const codepoint = (ch: string) => `\\u{${ch.codePointAt(0)!.toString(16)}}`;

/** The agent's purpose as shown: hidden characters and line breaks made visible, so it reads as one plain line. */
export function plain(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    out += ch === "\n" ? "\\n" : ch === "\r" ? "\\r" : ch === "\t" ? "\\t" : c < 0x20 || c === 0x7f || HIDDEN.test(ch) ? codepoint(ch) : ch;
  }
  return out;
}

/** Text with control characters made visible (\r, \n, \t, \xNN, \u{...}); line breaks are kept after \n. */
export function visible(bytes: Uint8Array): { text: string; binary: boolean } {
  const s = new TextDecoder().decode(bytes);
  let odd = 0;
  let text = "";
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === "\n") text += "\\n\n";
    else if (ch === "\r") text += "\\r";
    else if (ch === "\t") text += "\\t";
    else if (c < 0x20 || c === 0x7f) {
      odd++;
      text += `\\x${c.toString(16).padStart(2, "0")}`;
    } else if (c === 0xfffd) {
      odd++;
      text += "\\x??";
    } else if (HIDDEN.test(ch)) {
      odd++;
      text += codepoint(ch);
    } else text += ch;
  }
  return { text, binary: odd > Math.max(2, s.length / 4) };
}

const onOff = (v: unknown) => (v ? "on" : "off");

export function describe(op: string, args: Record<string, unknown>): Description {
  switch (op) {
    case "serial.write": {
      const all = decode(String(args.data ?? ""));
      const part = all.slice(0, PREVIEW);
      const v = visible(part);
      const n = all.length;
      return {
        title: v.binary ? `Send ${n} bytes of binary data` : `Send ${n} byte${n === 1 ? "" : "s"}`,
        detail: "The board receives exactly these bytes.",
        data: {
          text: v.text,
          hex: [...part].map((b) => b.toString(16).padStart(2, "0")).join(" "),
          binary: v.binary,
          size: n,
          shown: part.length,
        },
      };
    }
    case "serial.signals": {
      const parts = [
        "dataTerminalReady" in args && `DTR ${onOff(args.dataTerminalReady)}`,
        "requestToSend" in args && `RTS ${onOff(args.requestToSend)}`,
        "break" in args && `break ${onOff(args.break)}`,
      ].filter(Boolean);
      return {
        title: `Set control lines: ${parts.join(", ") || "no change"}`,
        detail: "On most ESP32 and Arduino boards these lines reset the chip or select its boot mode.",
      };
    }
    case "serial.connect":
    case "serial.configure": {
      const parity = args.parity === "even" ? "E" : args.parity === "odd" ? "O" : "N";
      const frame = `${args.dataBits ?? 8}${parity}${args.stopBits ?? 1}`;
      const flow = args.flowControl === "hardware" ? ", hardware flow control" : "";
      return {
        title: `${op === "serial.connect" ? "Open the port" : "Change the port"} to ${args.baudRate} baud`,
        detail: `Line settings ${frame}${flow}. Reopening the port can reset the board.`,
      };
    }
    case "serial.disconnect":
      return { title: "Close the port", detail: "The board stops being shared until you share it again." };
    case "probe.open":
      return {
        title: "Open a debug session",
        detail:
          "OpenOCD and GDB get full control of the chip: halt it, read and erase its flash, change protection settings. " +
          "The session ends after 10 minutes without probe traffic, or when you cut it off.",
        session: true,
      };
    case "flash.open":
      return {
        title: "Allow one flash of this board",
        detail:
          "Writes, resets (DTR/RTS) and speed changes on this board run without asking until the flash is done. The " +
          "session waits up to 10 minutes for the tool to start (it may build first), ends when the tool finishes or " +
          "after 2 idle minutes, and lasts 20 minutes at most. You can cut it off.",
        purpose: typeof args.purpose === "string" && args.purpose ? plain(args.purpose) : undefined,
        session: true,
      };
    default:
      return { title: op, detail: "An operation on this device." };
  }
}
