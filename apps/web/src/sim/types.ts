// The contract between DeviceDock and any simulator/emulator. An engine knows how to run ONE emulated
// board; it knows nothing about DeviceDock, leases, approvals or the bridge. SimAdapter (SimAdapter.ts)
// turns any engine into a normal DeviceAdapter, so everything downstream (broker, `device`, RFC 2217,
// esptool, MCP, the serial monitor) works for a simulator exactly as for real hardware.
//
// To add a simulator: implement SimEngine, call registerEngine("name", factory) in engines/index.ts, and
// describe boards in a profile (public/sim/profiles.json). Nothing else in the app changes.

/** An engine-defined console name, e.g. "uart0" or "usb". The profile says which one is the serial port. */
export type SimConsole = string;

export interface SimProfile {
  id: string;
  label: string;
  /** Registered engine id, e.g. "esp32sim". */
  engine: string;
  /** Display-only board label (shown in the device card and `device list`). */
  board: string;
  chip?: string;
  description?: string;
  /** Which of the engine's consoles is presented as the serial port. */
  console: SimConsole;
  baudRate?: number;
  /** Interpreted by the engine only (asset locations, manifests, flash images...). */
  engineConfig: Record<string, unknown>;
  /** Optional hints for the page; frames carry their own size. */
  display?: { width: number; height: number; rotate?: 0 | 90 | 180 | 270 };
  buttons?: { label: string; pin: number }[];
}

export type SimEvent =
  /** Bytes the emulated board wrote to a console. */
  | { type: "console"; console: SimConsole; bytes: Uint8Array }
  /** A display frame, already converted to engine-neutral RGBA. */
  | { type: "frame"; width: number; height: number; rgba: Uint8ClampedArray }
  /** A message from the engine itself (load errors, chip resets...). */
  | { type: "status"; message: string; level?: "info" | "error" }
  /** The machine stopped; `error` is set when it was not asked to. */
  | { type: "stopped"; error?: string };

export interface SimEngine {
  /** Load the profile's assets and boot the board. Resolves once it is running. */
  start(profile: SimProfile): Promise<void>;
  /** Stop and release everything (workers, wasm memory, sockets). Must be idempotent. */
  stop(): void;
  /**
   * Power-cycle the board. `download` asks for the ROM download strap (what DTR does on an auto-reset
   * circuit). Engines that cannot honour it must still reset and say so via a "status" event.
   */
  reset(opts?: { download?: boolean }): Promise<void>;
  /** Bytes into a console's receive side. */
  write(bytes: Uint8Array, console: SimConsole): void;
  /** Optional: a GPIO button or a switch. */
  setButton?(pin: number, down: boolean): void;
  onEvent(handler: (event: SimEvent) => void): () => void;
}

/** Engines are created per device, from the URL base their assets were installed under. */
export type SimEngineFactory = () => SimEngine;
