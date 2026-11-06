export type SerialOptions = {
  baudRate: number;
  dataBits?: 7 | 8;
  stopBits?: 1 | 2;
  parity?: "none" | "even" | "odd";
  flowControl?: "none" | "hardware";
};
export type Signals = {
  dataTerminalReady?: boolean;
  requestToSend?: boolean;
  break?: boolean;
};
export type Descriptor = { id: string; name: string; kind: "mock" | "serial" };
export type DeviceEvent =
  { type: "data"; bytes: Uint8Array } | { type: "disconnect"; error?: string };
export type Handler = (event: DeviceEvent) => void;
export interface DeviceAdapter {
  listGranted(): Promise<Descriptor[]>;
  requestDevice(): Promise<Descriptor>;
  open(id: string, options: SerialOptions): Promise<void>;
  close(id: string): Promise<void>;
  write(id: string, bytes: Uint8Array): Promise<void>;
  setSignals(id: string, signals: Signals): Promise<void>;
  subscribe(id: string, handler: Handler): () => void;
}
export const encode = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes));
export const decode = (data: string) =>
  Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
export class MockAdapter implements DeviceAdapter {
  devices = new Map<
    string,
    {
      descriptor: Descriptor;
      open: boolean;
      options: SerialOptions;
      signals: Signals;
      handlers: Set<Handler>;
      timer?: ReturnType<typeof setInterval>;
    }
  >();
  latency = 20;
  failWrites = false;
  async listGranted() {
    return [...this.devices.values()].map((d) => d.descriptor);
  }
  async requestDevice() {
    const d = {
      id: crypto.randomUUID(),
      name: "Loopback lab",
      kind: "mock" as const,
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
  async open(id: string, options: SerialOptions) {
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
  async close(id: string) {
    const d = this.get(id);
    d.open = false;
    clearInterval(d.timer);
  }
  async write(id: string, bytes: Uint8Array) {
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
  async setSignals(id: string, signals: Signals) {
    const d = this.get(id);
    if (!d.open) throw Error("Mock unplugged");
    d.signals = { ...d.signals, ...signals };
  }
  subscribe(id: string, h: Handler) {
    this.get(id).handlers.add(h);
    return () => this.get(id).handlers.delete(h);
  }
  unplug(id: string) {
    void this.close(id);
    this.emit(id, { type: "disconnect", error: "Mock unplugged" });
  }
  private get(id: string) {
    const d = this.devices.get(id);
    if (!d) throw Error("Unknown mock");
    return d;
  }
  private emit(id: string, event: DeviceEvent) {
    for (const h of this.get(id).handlers) h(event);
  }
}
export class WebSerialAdapter implements DeviceAdapter {
  private devices = new Map<
    string,
    {
      descriptor: Descriptor;
      port: SerialPort;
      reader?: ReadableStreamDefaultReader<Uint8Array>;
      reading?: Promise<void>;
      closing: boolean;
      handlers: Set<Handler>;
    }
  >();
  constructor() {
    navigator.serial?.addEventListener("disconnect", (event) => {
      for (const d of this.devices.values())
        if (d.port === event.target) {
          for (const h of d.handlers)
            h({ type: "disconnect", error: "USB device unplugged" });
          void this.close(d.descriptor.id).catch(() => {});
        }
    });
  }
  private register(port: SerialPort) {
    let d = [...this.devices.values()].find((d) => d.port === port);
    if (!d) {
      const info = port.getInfo();
      const descriptor = {
        id: crypto.randomUUID(),
        name: `Serial ${info.usbVendorId?.toString(16) ?? "port"}:${info.usbProductId?.toString(16) ?? "unknown"}`,
        kind: "serial" as const,
      };
      d = { descriptor, port, closing: false, handlers: new Set() };
      this.devices.set(descriptor.id, d);
    }
    return d.descriptor;
  }
  async listGranted() {
    if (!navigator.serial) return [];
    return (await navigator.serial.getPorts()).map((p) => this.register(p));
  }
  async requestDevice() {
    if (!navigator.serial)
      throw Error("WebSerial requires Chrome or Edge on localhost");
    return this.register(await navigator.serial.requestPort());
  }
  private get(id: string) {
    const d = this.devices.get(id);
    if (!d) throw Error("Unknown serial device");
    return d;
  }
  async open(id: string, options: SerialOptions) {
    const d = this.get(id);
    if (d.port.readable) await this.close(id);
    await d.port.open(options);
    d.closing = false;
    d.reading = (async () => {
      try {
        while (d.port.readable && !d.closing) {
          const reader = d.port.readable.getReader();
          d.reader = reader;
          try {
            while (!d.closing) {
              const { value, done } = await reader.read();
              if (done) break;
              if (value)
                for (const h of d.handlers) h({ type: "data", bytes: value });
            }
          } finally {
            reader.releaseLock();
            d.reader = undefined;
          }
        }
      } catch (e) {
        if (!d.closing)
          for (const h of d.handlers)
            h({ type: "disconnect", error: (e as Error).message });
      }
    })();
  }
  async close(id: string) {
    const d = this.get(id);
    d.closing = true;
    await d.reader?.cancel().catch(() => {});
    await d.reading;
    if (d.port.readable || d.port.writable) await d.port.close();
  }
  async write(id: string, bytes: Uint8Array) {
    const d = this.get(id);
    if (!d.port.writable) throw Error("Port is closed");
    const writer = d.port.writable.getWriter();
    try {
      await writer.write(bytes);
    } finally {
      writer.releaseLock();
    }
  }
  async setSignals(id: string, signals: Signals) {
    await this.get(id).port.setSignals(signals);
  }
  subscribe(id: string, h: Handler) {
    this.get(id).handlers.add(h);
    return () => this.get(id).handlers.delete(h);
  }
}
