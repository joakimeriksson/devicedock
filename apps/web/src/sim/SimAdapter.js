import { createEngine } from "./registry.js";

/**
 * @typedef {import("./types.js").SimEvent} SimEvent
 * @typedef {object} Entry
 * @property {import("../adapters.js").Descriptor} descriptor
 * @property {import("./types.js").SimProfile} profile
 * @property {import("./types.js").SimEngine} [engine]
 * @property {() => void} [stopEvents]
 * @property {Set<import("../adapters.js").Handler>} handlers
 * @property {Set<(e: Extract<SimEvent, { type: "frame" }>) => void>} frameHandlers
 * @property {Set<(e: Extract<SimEvent, { type: "status" }>) => void>} statusHandlers
 * @property {boolean} closing
 * @property {boolean} dtr
 * @property {boolean} rts
 */

/**
 * Any SimEngine as a device adapter. Everything downstream (broker, `device`, RFC 2217, esptool, MCP, the serial
 * monitor) therefore treats a simulator exactly like a real port. Engine specifics stay in the engine; the one
 * piece of policy that lives here is what the modem lines mean for a board:
 *
 *   RTS = the reset line (asserted holds the chip in reset, released lets it boot);
 *   DTR = the boot-select strap (asserted = download mode), sampled when reset is released.
 *
 * That is the standard ESP auto-reset wiring, so esptool's reset sequences and a plain `rts` pulse both do what
 * they do on hardware, subject to what the engine can honour (see SimEngine.reset).
 */
export class SimAdapter {
  /** @type {Map<string, Entry>} */
  devices = new Map();

  /** Register a new simulated board of this profile. The machine only boots on open(). */
  /** @param {import("./types.js").SimProfile} profile */
  create(profile) {
    /** @type {import("../adapters.js").Descriptor} */
    const descriptor = {
      id: crypto.randomUUID(),
      name: profile.label,
      kind: "sim",
      engine: profile.engine,
      board: profile.board,
    };
    this.devices.set(descriptor.id, {
      descriptor,
      profile,
      handlers: new Set(),
      frameHandlers: new Set(),
      statusHandlers: new Set(),
      closing: false,
      dtr: false,
      rts: false,
    });
    return descriptor;
  }

  get(id) {
    const d = this.devices.get(id);
    if (!d) throw new Error("Unknown simulated device");
    return d;
  }
  profile(id) {
    return this.get(id).profile;
  }

  async listGranted() {
    return []; // nothing is "granted" for software; devices are created explicitly
  }
  async requestDevice() {
    throw new Error("Add a simulated device from its profile instead");
  }

  async open(id, _options) {
    const d = this.get(id);
    if (d.engine) await this.close(id);
    d.closing = false;
    const engine = createEngine(d.profile.engine);
    d.engine = engine;
    d.stopEvents = engine.onEvent((e) => this.dispatch(d, e));
    try {
      await engine.start(d.profile);
    } catch (e) {
      this.teardown(d);
      throw e;
    }
  }

  /** @param {Entry} d
   * @param {SimEvent} e */
  dispatch(d, e) {
    if (e.type === "console") {
      // Only the profile's console is the serial port; the others are diagnostics.
      if (e.console === d.profile.console) for (const h of d.handlers) h({ type: "data", bytes: e.bytes });
    } else if (e.type === "frame") {
      for (const h of d.frameHandlers) h(e);
    } else if (e.type === "status") {
      for (const h of d.statusHandlers) h(e);
    } else if (e.type === "stopped") {
      if (!d.closing) for (const h of d.handlers) h({ type: "disconnect", error: e.error ?? "Simulator stopped" });
    }
  }

  /** @param {Entry} d */
  teardown(d) {
    d.stopEvents?.();
    d.stopEvents = undefined;
    d.engine?.stop();
    d.engine = undefined;
  }

  async close(id) {
    const d = this.get(id);
    d.closing = true; // an explicit close is not a disconnect
    this.teardown(d);
  }

  async write(id, bytes) {
    const d = this.get(id);
    if (!d.engine) throw new Error("Simulator is not running");
    d.engine.write(bytes, d.profile.console);
  }

  async setSignals(id, signals) {
    const d = this.get(id);
    const wasHeld = d.rts;
    if (signals.dataTerminalReady !== undefined) d.dtr = signals.dataTerminalReady;
    if (signals.requestToSend !== undefined) d.rts = signals.requestToSend;
    // Reset is released (RTS asserted -> deasserted): the chip boots now, with the strap DTR holds.
    if (wasHeld && !d.rts && d.engine) await d.engine.reset({ download: d.dtr });
  }

  subscribe(id, handler) {
    const d = this.get(id);
    d.handlers.add(handler);
    return () => d.handlers.delete(handler);
  }

  // Beyond the device adapter contract: what only simulated boards have.
  onFrame(id, handler) {
    const d = this.get(id);
    d.frameHandlers.add(handler);
    return () => d.frameHandlers.delete(handler);
  }
  onStatus(id, handler) {
    const d = this.get(id);
    d.statusHandlers.add(handler);
    return () => d.statusHandlers.delete(handler);
  }
  button(id, pin, down) {
    this.get(id).engine?.setButton?.(pin, down);
  }
  async reset(id) {
    await this.get(id).engine?.reset({ download: false });
  }
}
