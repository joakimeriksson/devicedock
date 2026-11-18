// Device adapters: the seam between the page and a device (ARCHITECTURE.md 2.1). Real hardware (WebSerial), the
// loopback mock and every simulator look identical from here up.
import { usbName } from "./usb.js";

/**
 * @typedef {{ baudRate: number, dataBits?: 7 | 8, stopBits?: 1 | 2, parity?: "none" | "even" | "odd", flowControl?: "none" | "hardware" }} SerialOptions
 * @typedef {{ dataTerminalReady?: boolean, requestToSend?: boolean, break?: boolean }} Signals
 * @typedef {object} Descriptor
 * @property {string} id
 * @property {string} name
 * @property {import("./protocol.js").DeviceKind} kind
 * @property {string} [engine] Display-only labels for software devices; never used for policy.
 * @property {string} [board]
 * @property {import("./usb.js").UsbId} [usb] USB devices: the vendor and product id (names it, remembers it, finds its
 *   other interfaces).
 * @typedef {{ type: "data", bytes: Uint8Array } | { type: "disconnect", error?: string } | { type: "reconnect" }} DeviceEvent
 *   "reconnect": the same board is back under the same id (it was unplugged, or reset and re-enumerated); the port is
 *   closed.
 * @typedef {(event: DeviceEvent) => void} Handler
 *
 * Every adapter has: listGranted(), requestDevice(), open(id, options), close(id), write(id, bytes),
 * setSignals(id, signals), subscribe(id, handler) -> unsubscribe.
 */
export const encode = (/** @type {Uint8Array} */ bytes) =>
  btoa(String.fromCharCode(...bytes));
export const decode = (/** @type {string} */ data) =>
  Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
export class MockAdapter {
  /** @type {Map<string, { descriptor: Descriptor, open: boolean, options: SerialOptions, signals: Signals, handlers: Set<Handler>, timer?: number }>} */
  devices = new Map();
  latency = 20;
  failWrites = false;
  async listGranted() {
    return [...this.devices.values()].map((d) => d.descriptor);
  }
  async requestDevice() {
    const d = {
      id: crypto.randomUUID(),
      name: "Loopback lab",
      kind: "mock",
    };
    this.devices.set(d.id, {
      descriptor: d,
      open: false,
      options: { baudRate: 115200 },
      signals: {},
      handlers: new Set(),
    });
    return d;
  }
  async open(id, options) {
    const d = this.get(id);
    await this.close(id);
    d.open = true;
    d.options = options;
    d.timer = setInterval(() => {
      if (d.open)
        this.emit(id, {
          type: "data",
          bytes: new TextEncoder().encode("telemetry temperature=23.5\n"),
        });
    }, 5000);
  }
  async close(id) {
    const d = this.get(id);
    d.open = false;
    clearInterval(d.timer);
  }
  async write(id, bytes) {
    const d = this.get(id);
    if (!d.open) throw Error("Mock unplugged");
    await new Promise((r) => setTimeout(r, this.latency));
    if (!d.open) throw Error("Mock unplugged");
    if (this.failWrites) throw Error("Simulated write error");
    const reply =
      new TextDecoder().decode(bytes).trim() === "PING"
        ? new TextEncoder().encode("PONG\n")
        : bytes;
    this.emit(id, { type: "data", bytes: reply });
  }
  async setSignals(id, signals) {
    const d = this.get(id);
    if (!d.open) throw Error("Mock unplugged");
    d.signals = { ...d.signals, ...signals };
  }
  subscribe(id, h) {
    this.get(id).handlers.add(h);
    return () => this.get(id).handlers.delete(h);
  }
  unplug(id) {
    void this.close(id);
    this.emit(id, { type: "disconnect", error: "Mock unplugged" });
  }
  get(id) {
    const d = this.devices.get(id);
    if (!d) throw Error("Unknown mock");
    return d;
  }
  /** @param {DeviceEvent} event */
  emit(id, event) {
    for (const h of this.get(id).handlers) h(event);
  }
}
export class WebSerialAdapter {
  /**
   * `lost`: the port went away (unplugged, or the board reset and dropped off USB).
   * @type {Map<string, { descriptor: Descriptor, port: SerialPort, reader?: ReadableStreamDefaultReader<Uint8Array>, reading?: Promise<void>, closing: boolean, handlers: Set<Handler>, lost?: boolean }>}
   */
  devices = new Map();
  constructor() {
    navigator.serial?.addEventListener("disconnect", (event) => {
      for (const d of this.devices.values())
        if (d.port === event.target && !d.lost) {
          d.lost = true;
          for (const h of d.handlers)
            h({ type: "disconnect", error: "USB device unplugged" });
          void this.close(d.descriptor.id).catch(() => {});
        }
    });
    // A board that comes back is the same device again (see register).
    navigator.serial?.addEventListener("connect", (event) => {
      this.register(event.target);
    });
  }
  /**
   * The device for a port. A new port that has the USB id of exactly one lost device is taken to be that board coming
   * back: ESP32-S3/C3 and RP2040 boards drop off USB when they reset, and the agent's device id and RFC 2217 port must
   * survive that. With two lost boards of the same id it cannot tell them apart, so the new port becomes a new device.
   */
  register(port) {
    let d = [...this.devices.values()].find((d) => d.port === port);
    if (!d) {
      const info = port.getInfo();
      const usb =
        info.usbVendorId !== undefined && info.usbProductId !== undefined
          ? { vendorId: info.usbVendorId, productId: info.usbProductId }
          : undefined;
      const lost = usb
        ? [...this.devices.values()].filter(
            (e) => e.lost && e.descriptor.usb?.vendorId === usb.vendorId && e.descriptor.usb?.productId === usb.productId,
          )
        : [];
      if (lost.length === 1) {
        d = lost[0];
        Object.assign(d, { port, lost: false, closing: false, reader: undefined, reading: undefined });
        for (const h of d.handlers) h({ type: "reconnect" });
      } else {
        const descriptor = {
          id: crypto.randomUUID(),
          name: usbName(info.usbVendorId, info.usbProductId),
          kind: "serial",
          ...(usb ? { usb } : {}),
        };
        d = { descriptor, port, closing: false, handlers: new Set() };
        this.devices.set(descriptor.id, d);
      }
    }
    return d.descriptor;
  }
  async listGranted() {
    if (!navigator.serial) return [];
    return (await navigator.serial.getPorts()).map((p) => this.register(p));
  }
  /** `filters` narrows the browser's chooser, e.g. to the serial ports of a debug probe's board.
   * @param {{ usbVendorId: number, usbProductId: number }[]} [filters] */
  async requestDevice(filters) {
    if (!navigator.serial)
      throw Error("WebSerial requires Chrome or Edge on localhost");
    return this.register(await navigator.serial.requestPort(filters ? { filters } : undefined));
  }
  /** Whether the device's port is gone (unplugged, and not back). */
  isLost(id) {
    return !!this.devices.get(id)?.lost;
  }
  /** Drops a device whose port is gone, so its row can be removed. */
  forget(id) {
    if (this.devices.get(id)?.lost) this.devices.delete(id);
  }
  get(id) {
    const d = this.devices.get(id);
    if (!d) throw Error("Unknown serial device");
    return d;
  }
  async open(id, options) {
    const d = this.get(id);
    if (d.port.readable) await this.close(id);
    await d.port.open(options);
    d.closing = false;
    // The loop belongs to this port: once the board is back on a new port, the old loop never reports anything.
    const port = d.port;
    const mine = () => d.port === port && !d.closing;
    d.reading = (async () => {
      try {
        while (port.readable && mine()) {
          const reader = port.readable.getReader();
          d.reader = reader;
          try {
            while (mine()) {
              const { value, done } = await reader.read();
              if (done) break;
              if (value)
                for (const h of d.handlers) h({ type: "data", bytes: value });
            }
          } finally {
            reader.releaseLock();
            if (d.reader === reader) d.reader = undefined;
          }
        }
      } catch (e) {
        if (mine())
          for (const h of d.handlers)
            h({ type: "disconnect", error: e.message });
      }
    })();
  }
  async close(id) {
    const d = this.get(id);
    // The port this close is for: a board that comes back meanwhile gets a new port object (register), never closed here.
    const port = d.port;
    d.closing = true;
    await d.reader?.cancel().catch(() => {});
    await d.reading;
    if (port.readable || port.writable) await port.close();
  }
  async write(id, bytes) {
    const d = this.get(id);
    if (!d.port.writable) throw Error("Port is closed");
    const writer = d.port.writable.getWriter();
    try {
      await writer.write(bytes);
    } finally {
      writer.releaseLock();
    }
  }
  async setSignals(id, signals) {
    await this.get(id).port.setSignals(signals);
  }
  subscribe(id, h) {
    this.get(id).handlers.add(h);
    // Safe after forget(): the device may be gone by the time its row unsubscribes.
    return () => void this.devices.get(id)?.handlers.delete(h);
  }
}
