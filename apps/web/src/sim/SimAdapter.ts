import type { Descriptor, DeviceAdapter, Handler, SerialOptions, Signals } from "../adapters";
import { createEngine } from "./registry";
import type { SimEngine, SimEvent, SimProfile } from "./types";

type Entry = {
  descriptor: Descriptor;
  profile: SimProfile;
  engine?: SimEngine;
  stopEvents?: () => void;
  handlers: Set<Handler>;
  frameHandlers: Set<(e: Extract<SimEvent, { type: "frame" }>) => void>;
  statusHandlers: Set<(e: Extract<SimEvent, { type: "status" }>) => void>;
  closing: boolean;
  dtr: boolean;
  rts: boolean;
};

/**
 * Any SimEngine as a DeviceAdapter. Everything downstream (broker, `device`, RFC 2217, esptool, MCP, the serial
 * monitor) therefore treats a simulator exactly like a real port. Engine specifics stay in the engine; the one
 * piece of policy that lives here is what the modem lines mean for a board:
 *
 *   RTS = the reset line (asserted holds the chip in reset, released lets it boot);
 *   DTR = the boot-select strap (asserted = download mode), sampled when reset is released.
 *
 * That is the standard ESP auto-reset wiring, so esptool's reset sequences and a plain `rts` pulse both do what
 * they do on hardware, subject to what the engine can honour (see SimEngine.reset).
 */
export class SimAdapter implements DeviceAdapter {
  private devices = new Map<string, Entry>();

  /** Register a new simulated board of this profile. The machine only boots on open(). */
  create(profile: SimProfile): Descriptor {
    const descriptor: Descriptor = {
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

  private get(id: string) {
    const d = this.devices.get(id);
    if (!d) throw new Error("Unknown simulated device");
    return d;
  }
  profile(id: string) {
    return this.get(id).profile;
  }

  async listGranted() {
    return []; // nothing is "granted" for software; devices are created explicitly
  }
  async requestDevice(): Promise<Descriptor> {
    throw new Error("Add a simulated device from its profile instead");
  }

  async open(id: string, _options: SerialOptions) {
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

  private dispatch(d: Entry, e: SimEvent) {
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

  private teardown(d: Entry) {
    d.stopEvents?.();
    d.stopEvents = undefined;
    d.engine?.stop();
    d.engine = undefined;
  }

  async close(id: string) {
    const d = this.get(id);
    d.closing = true; // an explicit close is not a disconnect
    this.teardown(d);
  }

  async write(id: string, bytes: Uint8Array) {
    const d = this.get(id);
    if (!d.engine) throw new Error("Simulator is not running");
    d.engine.write(bytes, d.profile.console);
  }

  async setSignals(id: string, signals: Signals) {
    const d = this.get(id);
    const wasHeld = d.rts;
    if (signals.dataTerminalReady !== undefined) d.dtr = signals.dataTerminalReady;
    if (signals.requestToSend !== undefined) d.rts = signals.requestToSend;
    // Reset is released (RTS asserted -> deasserted): the chip boots now, with the strap DTR holds.
    if (wasHeld && !d.rts && d.engine) await d.engine.reset({ download: d.dtr });
  }

  subscribe(id: string, handler: Handler) {
    const d = this.get(id);
    d.handlers.add(handler);
    return () => d.handlers.delete(handler);
  }

  // Beyond the DeviceAdapter contract: what only simulated boards have.
  onFrame(id: string, handler: (e: Extract<SimEvent, { type: "frame" }>) => void) {
    const d = this.get(id);
    d.frameHandlers.add(handler);
    return () => d.frameHandlers.delete(handler);
  }
  onStatus(id: string, handler: (e: Extract<SimEvent, { type: "status" }>) => void) {
    const d = this.get(id);
    d.statusHandlers.add(handler);
    return () => d.statusHandlers.delete(handler);
  }
  button(id: string, pin: number, down: boolean) {
    this.get(id).engine?.setButton?.(pin, down);
  }
  async reset(id: string) {
    await this.get(id).engine?.reset({ download: false });
  }
}
