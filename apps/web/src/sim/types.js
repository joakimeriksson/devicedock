// The contract between DeviceDock and any simulator/emulator. An engine knows how to run ONE emulated
// board; it knows nothing about DeviceDock, leases, approvals or the bridge. SimAdapter (SimAdapter.js)
// turns any engine into a normal device adapter, so everything downstream (broker, `device`, RFC 2217,
// esptool, MCP, the serial monitor) works for a simulator exactly as for real hardware.
//
// To add a simulator: implement SimEngine, call registerEngine("name", factory) in engines/index.js, and
// describe boards in a profile (public/sim/profiles.json). Nothing else in the app changes.
//
// This file only describes the shapes (JSDoc types); it has no code.

/**
 * An engine-defined console name, e.g. "uart0" or "usb". The profile says which one is the serial port.
 * @typedef {string} SimConsole
 */

/**
 * @typedef {object} SimProfile
 * @property {string} id
 * @property {string} label
 * @property {string} engine Registered engine id, e.g. "esp32sim".
 * @property {string} board Display-only board label (shown in the device card and `device list`).
 * @property {string} [chip]
 * @property {string} [description]
 * @property {SimConsole} console Which of the engine's consoles is presented as the serial port.
 * @property {number} [baudRate]
 * @property {Record<string, unknown>} engineConfig Interpreted by the engine only (asset locations, manifests, flash
 *   images...).
 * @property {{ width: number, height: number, rotate?: 0 | 90 | 180 | 270 }} [display] Optional hints for the page;
 *   frames carry their own size.
 * @property {{ label: string, pin: number }[]} [buttons]
 */

/**
 * What an engine reports:
 *  - "console": bytes the emulated board wrote to a console;
 *  - "frame": a display frame, already converted to engine-neutral RGBA;
 *  - "status": a message from the engine itself (load errors, chip resets...);
 *  - "stopped": the machine stopped; `error` is set when it was not asked to.
 * @typedef {{ type: "console", console: SimConsole, bytes: Uint8Array }
 *   | { type: "frame", width: number, height: number, rgba: Uint8ClampedArray }
 *   | { type: "status", message: string, level?: "info" | "error" }
 *   | { type: "stopped", error?: string }} SimEvent
 */

/**
 * @typedef {object} SimEngine
 * @property {(profile: SimProfile) => Promise<void>} start Load the profile's assets and boot the board. Resolves once
 *   it is running.
 * @property {() => void} stop Stop and release everything (workers, wasm memory, sockets). Must be idempotent.
 * @property {(opts?: { download?: boolean }) => Promise<void>} reset Power-cycle the board. `download` asks for the ROM
 *   download strap (what DTR does on an auto-reset circuit). Engines that cannot honour it must still reset and say
 *   so via a "status" event.
 * @property {(bytes: Uint8Array, console: SimConsole) => void} write Bytes into a console's receive side.
 * @property {(pin: number, down: boolean) => void} [setButton] Optional: a GPIO button or a switch.
 * @property {(handler: (event: SimEvent) => void) => () => void} onEvent
 */

/**
 * Engines are created per device.
 * @typedef {() => SimEngine} SimEngineFactory
 */

export {};
