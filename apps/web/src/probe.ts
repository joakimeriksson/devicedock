// Debug probes (CMSIS-DAP) owned by the page. Two transports, chosen when the probe is added:
//  - WebUSB: CMSIS-DAP v2, a vendor-class interface with one bulk IN and one bulk OUT endpoint (TI XDS110: interface 6).
//    The OS does not claim vendor interfaces, so the page can.
//  - WebHID: CMSIS-DAP v1 (HID reports), for probes without v2, e.g. the SAMD11 on the XIAO nRF54L15. macOS claims HID
//    interfaces, which WebUSB then cannot open, so v1 needs WebHID.
// The adapter forwards exactly one DAP command packet and returns its response; it knows nothing about the protocol.
import type { Descriptor, DeviceAdapter, Handler, SerialOptions, Signals } from "./adapters";

// Minimal typings: the DOM lib has no WebUSB/WebHID types and the project does not pull in @types for them.
type UsbEndpoint = { direction: "in" | "out"; type: string; endpointNumber: number; packetSize: number };
type UsbAlternate = { interfaceClass: number; interfaceName?: string | null; endpoints: UsbEndpoint[] };
type UsbInterface = { interfaceNumber: number; alternates: UsbAlternate[] };
type UsbDevice = {
  productName?: string; vendorId: number; productId: number; serialNumber?: string; opened: boolean;
  configuration: { interfaces: UsbInterface[] } | null;
  open(): Promise<void>; close(): Promise<void>; selectConfiguration(n: number): Promise<void>;
  claimInterface(n: number): Promise<void>; releaseInterface(n: number): Promise<void>;
  transferOut(ep: number, data: Uint8Array): Promise<{ status: string }>;
  transferIn(ep: number, len: number): Promise<{ status: string; data?: DataView }>;
};
type HidDevice = {
  productName: string; vendorId: number; productId: number; opened: boolean;
  collections: { outputReports?: { reportId?: number; items?: { reportSize: number; reportCount: number }[] }[] }[];
  open(): Promise<void>; close(): Promise<void>; sendReport(id: number, data: Uint8Array): Promise<void>;
  addEventListener(t: "inputreport", f: (e: { reportId: number; data: DataView }) => void): void;
  removeEventListener(t: "inputreport", f: (e: { reportId: number; data: DataView }) => void): void;
};
const nav = navigator as unknown as {
  usb?: { requestDevice(o: { filters: object[] }): Promise<UsbDevice>; addEventListener(t: string, f: (e: { device: UsbDevice }) => void): void };
  hid?: { requestDevice(o: { filters: object[] }): Promise<HidDevice[]>; addEventListener(t: string, f: (e: { device: HidDevice }) => void): void };
};

export type DapInterface = { interfaceNumber: number; epIn: number; epOut: number; packetSize: number };
/**
 * The CMSIS-DAP v2 interface of a USB configuration: a vendor-class (0xff) interface whose name contains "CMSIS-DAP",
 * else the first vendor-class interface with exactly one bulk IN and one bulk OUT endpoint.
 */
export function findDapInterface(interfaces: UsbInterface[]): DapInterface | undefined {
  const candidates = interfaces.flatMap((i) => {
    const alt = i.alternates[0];
    if (!alt || alt.interfaceClass !== 0xff) return [];
    const bulkIn = alt.endpoints.filter((e) => e.type === "bulk" && e.direction === "in");
    const bulkOut = alt.endpoints.filter((e) => e.type === "bulk" && e.direction === "out");
    if (bulkIn.length !== 1 || bulkOut.length !== 1) return [];
    return [{ named: /CMSIS-DAP/i.test(alt.interfaceName ?? ""), dap: {
      interfaceNumber: i.interfaceNumber, epIn: bulkIn[0].endpointNumber, epOut: bulkOut[0].endpointNumber,
      packetSize: bulkIn[0].packetSize } }];
  });
  return (candidates.find((c) => c.named) ?? candidates[0])?.dap;
}
/** HID output reports have a fixed size; a DAP packet is zero-padded to it (CMSIS-DAP v1). */
export function padReport(packet: Uint8Array, size: number): Uint8Array {
  if (packet.length > size) throw Error(`DAP packet of ${packet.length} bytes exceeds the ${size}-byte HID report`);
  const out = new Uint8Array(size);
  out.set(packet);
  return out;
}

type Entry = {
  descriptor: Descriptor;
  transport: "usb" | "hid";
  usb?: UsbDevice;
  hid?: HidDevice;
  dap?: DapInterface;
  reportSize: number;
  handlers: Set<Handler>;
  busy: Promise<unknown>;
};

export class ProbeAdapter implements DeviceAdapter {
  private devices = new Map<string, Entry>();
  constructor() {
    const gone = (match: (e: Entry) => boolean) => {
      for (const e of this.devices.values())
        if (match(e)) for (const h of e.handlers) h({ type: "disconnect", error: "Debug probe unplugged" });
    };
    nav.usb?.addEventListener("disconnect", (ev) => gone((e) => e.usb === ev.device));
    nav.hid?.addEventListener("disconnect", (ev) => gone((e) => e.hid === ev.device));
  }
  get supported() {
    return { usb: !!nav.usb, hid: !!nav.hid };
  }
  async listGranted() {
    return []; // probes are never auto-shared, so earlier grants are not re-listed
  }
  /** Default: WebUSB (CMSIS-DAP v2). */
  async requestDevice() {
    return this.requestUsb();
  }
  async requestUsb(): Promise<Descriptor> {
    if (!nav.usb) throw Error("WebUSB requires Chrome or Edge on localhost");
    const usb = await nav.usb.requestDevice({ filters: [] });
    return this.register({ transport: "usb", usb, name: usb.productName || `USB ${usb.vendorId.toString(16)}:${usb.productId.toString(16)}` });
  }
  async requestHid(): Promise<Descriptor> {
    if (!nav.hid) throw Error("WebHID requires Chrome or Edge on localhost");
    const [hid] = await nav.hid.requestDevice({ filters: [] });
    if (!hid) throw Error("No HID device chosen");
    return this.register({ transport: "hid", hid, name: hid.productName || `HID ${hid.vendorId.toString(16)}:${hid.productId.toString(16)}` });
  }
  private register(p: { transport: "usb" | "hid"; usb?: UsbDevice; hid?: HidDevice; name: string }): Descriptor {
    const descriptor: Descriptor = { id: crypto.randomUUID(), name: `${p.name} (debug probe, ${p.transport === "usb" ? "WebUSB" : "WebHID"})`, kind: "probe" };
    this.devices.set(descriptor.id, { descriptor, transport: p.transport, usb: p.usb, hid: p.hid, reportSize: 64, handlers: new Set(), busy: Promise.resolve() });
    return descriptor;
  }
  private get(id: string) {
    const e = this.devices.get(id);
    if (!e) throw Error("Unknown debug probe");
    return e;
  }
  /** Claims the probe's DAP interface. Serial options are ignored: a probe has no baud rate. */
  async open(id: string, _options?: SerialOptions) {
    const e = this.get(id);
    if (e.usb) {
      if (!e.usb.opened) await e.usb.open();
      if (!e.usb.configuration) await e.usb.selectConfiguration(1);
      const dap = findDapInterface(e.usb.configuration!.interfaces);
      if (!dap) throw Error("No CMSIS-DAP v2 (bulk) interface on this device; try “WebHID” for a CMSIS-DAP v1 probe");
      if (!e.dap) await e.usb.claimInterface(dap.interfaceNumber);
      e.dap = dap;
    } else if (e.hid) {
      if (!e.hid.opened) await e.hid.open();
      const items = e.hid.collections.flatMap((c) => c.outputReports ?? []).flatMap((r) => r.items ?? []);
      if (items[0]) e.reportSize = (items[0].reportSize * items[0].reportCount) / 8;
    }
  }
  async close(id: string) {
    const e = this.get(id);
    try {
      if (e.usb?.opened) {
        if (e.dap) await e.usb.releaseInterface(e.dap.interfaceNumber).catch(() => {});
        await e.usb.close();
      }
      if (e.hid?.opened) await e.hid.close();
    } finally {
      e.dap = undefined;
    }
  }
  /** One CMSIS-DAP command in, its response out. Packets never overlap on one probe. */
  transfer(id: string, packet: Uint8Array): Promise<Uint8Array> {
    const e = this.get(id);
    const run = async () => {
      if (e.usb) {
        if (!e.dap) await this.open(id);
        const out = await e.usb.transferOut(e.dap!.epOut, packet);
        if (out.status !== "ok") throw Error(`USB transfer out: ${out.status}`);
        const r = await e.usb.transferIn(e.dap!.epIn, 1024 + 64);
        if (r.status !== "ok" || !r.data) throw Error(`USB transfer in: ${r.status}`);
        return new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength).slice();
      }
      const hid = e.hid!;
      if (!hid.opened) await this.open(id);
      return new Promise<Uint8Array>((resolve, reject) => {
        const timer = setTimeout(() => {
          hid.removeEventListener("inputreport", onReport);
          reject(Error("HID probe did not answer within 2 s"));
        }, 2000);
        const onReport = (ev: { data: DataView }) => {
          clearTimeout(timer);
          hid.removeEventListener("inputreport", onReport);
          resolve(new Uint8Array(ev.data.buffer, ev.data.byteOffset, ev.data.byteLength).slice());
        };
        hid.addEventListener("inputreport", onReport);
        hid.sendReport(0, padReport(packet, e.reportSize)).catch((err) => {
          clearTimeout(timer);
          hid.removeEventListener("inputreport", onReport);
          reject(err);
        });
      });
    };
    const p = e.busy.then(run, run);
    e.busy = p.catch(() => {});
    return p;
  }
  async write() {
    throw Error("A debug probe has no serial port; use its OpenOCD endpoint");
  }
  async setSignals(_id: string, _s: Signals) {
    throw Error("A debug probe has no modem lines");
  }
  subscribe(id: string, h: Handler) {
    this.get(id).handlers.add(h);
    return () => this.get(id).handlers.delete(h);
  }
}
