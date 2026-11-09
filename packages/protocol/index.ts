import { z } from "zod";
// Autonomous mode is time-boxed so it cannot be left on indefinitely.
export const MAX_AUTONOMY_MS = 2 * 60 * 60 * 1000;
export const MAX_BYTES = 16384,
  MAX_BUFFER = 65536,
  MAX_PENDING = 64;
export const id = z.string().uuid();
export const base64 = z
  .string()
  .max(Math.ceil(MAX_BYTES / 3) * 4)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
  .refine(
    (s) =>
      (s.length * 3) / 4 - (s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0) <=
      MAX_BYTES,
    "Payload too large",
  );
export const options = z
  .object({
    baudRate: z.number().int().min(300).max(4000000),
    dataBits: z.union([z.literal(7), z.literal(8)]).default(8),
    stopBits: z.union([z.literal(1), z.literal(2)]).default(1),
    parity: z.enum(["none", "even", "odd"]).default("none"),
    flowControl: z.enum(["none", "hardware"]).default("none"),
  })
  .strict();
export const signals = z
  .object({
    dataTerminalReady: z.boolean().optional(),
    requestToSend: z.boolean().optional(),
    break: z.boolean().optional(),
  })
  .strict();
/** Largest CMSIS-DAP packet carried (OpenOCD's TCP backend uses 1024-byte payloads; USB probes use 64 or 512). */
export const MAX_DAP_PACKET = 1024;
export const dapPacket = base64.refine(
  (s) => s.length > 0 && (s.length * 3) / 4 - (s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0) <= MAX_DAP_PACKET,
  "DAP packet empty or larger than 1024 bytes",
);
const common = {
  v: z.literal(1),
  id,
  deviceId: id.optional(),
  generation: z.number().int().positive().optional(),
  deadline: z.number().int().positive(),
  lease: id.optional(),
};
export const request = z.discriminatedUnion("op", [
  z.object({
    ...common,
    op: z.literal("devices.list"),
    args: z.object({}).strict(),
  }),
  z.object({
    ...common,
    op: z.literal("serial.acquire"),
    args: z.object({}).strict(),
  }),
  z.object({
    ...common,
    op: z.literal("serial.release"),
    args: z.object({}).strict(),
  }),
  z.object({ ...common, op: z.literal("serial.connect"), args: options }),
  z.object({
    ...common,
    op: z.literal("serial.disconnect"),
    args: z.object({}).strict(),
  }),
  z.object({ ...common, op: z.literal("serial.configure"), args: options }),
  z.object({ ...common, op: z.literal("serial.signals"), args: signals }),
  z.object({
    ...common,
    op: z.literal("serial.write"),
    args: z.object({ data: base64 }).strict(),
  }),
  // Debug probes (kind "probe"): one CMSIS-DAP command packet in, its response out. See ARCHITECTURE.md §4.1 for the
  // approval model: `probe.open` is approved once and starts a session; transfers inside it need no further approval.
  z.object({ ...common, op: z.literal("probe.open"), args: z.object({}).strict() }),
  z.object({ ...common, op: z.literal("probe.close"), args: z.object({}).strict() }),
  z.object({
    ...common,
    op: z.literal("probe.transfer"),
    args: z.object({ data: dapPacket }).strict(),
  }),
  z.object({
    ...common,
    op: z.literal("serial.read"),
    args: z
      .object({
        maxBytes: z.number().int().min(1).max(MAX_BYTES).default(MAX_BYTES),
      })
      .strict(),
  }),
]);
export type Request = z.infer<typeof request>;
/**
 * What a device IS decides the safety policy; how it is implemented does not.
 *  - "serial": real hardware behind a browser-granted port (approvals, hardware warning, auto-share memory).
 *  - "mock" / "sim": software devices (the built-in loopback mock; an emulator behind a SimEngine). Nothing
 *    physical can be affected, so approvals may be waived and the hardware warning is not shown.
 * Add a new simulator by writing a SimEngine, not a new kind: give it kind "sim" and set `engine`/`board`.
 */
export const RFC2217_PORT_BASE = 2217;
export const RFC2217_SLOTS = 8;
/**
 * The order that decides which device answers on which RFC 2217 port: real hardware first, then software devices,
 * each group in the order they were shared. Port 2217 is therefore the first physical device whenever there is one
 * (existing tool invocations keep working); port 2217+N is the Nth device in this order. `device list` prints the
 * same order and each device's URL, so tools never have to guess.
 */
export function orderDevices<T extends { kind: string }>(devices: T[]): T[] {
  // Debug probes carry no serial stream, so they never take an RFC 2217 port (see orderProbes).
  const streams = devices.filter((d) => d.kind !== "probe");
  return [...streams.filter((d) => d.kind === "serial"), ...streams.filter((d) => d.kind !== "serial")];
}
/** Debug probes in the order they were shared: the Nth one answers OpenOCD on port PROBE_PORT_BASE+N. */
export const PROBE_PORT_BASE = 4441;
export const PROBE_SLOTS = 4;
export function orderProbes<T extends { kind: string }>(devices: T[]): T[] {
  return devices.filter((d) => d.kind === "probe");
}
/** Ready-to-paste OpenOCD commands for the Nth probe (OpenOCD master's cmsis-dap TCP backend). */
export const openocdConfig = (index: number) =>
  `adapter driver cmsis-dap; cmsis-dap backend tcp; cmsis-dap tcp host 127.0.0.1; cmsis-dap tcp port ${PROBE_PORT_BASE + index}`;
export const rfc2217Url = (index: number) => `rfc2217://127.0.0.1:${RFC2217_PORT_BASE + index}`;

// "probe": a real debug probe (CMSIS-DAP over WebUSB/WebHID). Physical, so every hardware rule applies to it.
export const DEVICE_KINDS = ["serial", "mock", "sim", "probe"] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];
export const isPhysical = (kind: DeviceKind) => kind === "serial" || kind === "probe";
export const isVirtual = (kind: DeviceKind) => !isPhysical(kind);

export const descriptor = z
  .object({
    id,
    name: z.string().min(1).max(100),
    kind: z.enum(DEVICE_KINDS),
    // Display-only labels for software devices (e.g. engine "esp32sim", board "ttgo-tdisplay"); never policy.
    engine: z.string().max(40).optional(),
    board: z.string().max(60).optional(),
    generation: z.number().int().positive(),
    autoApprove: z.boolean(),
    // Epoch ms until which agent operations on this device skip approval ("autonomous mode").
    autonomousUntil: z.number().int().positive().optional(),
    baudRate: z.number().int().min(300).max(4000000),
  })
  .strict();
export type DeviceDescriptor = z.infer<typeof descriptor>;
export const browserMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("expose"), device: descriptor }),
  z.object({ type: z.literal("revoke"), deviceId: id }),
  z.object({
    type: z.literal("autonomy"),
    deviceId: id,
    until: z.number().int().positive().nullable(),
  }),
  z.object({
    type: z.literal("data"),
    deviceId: id,
    generation: z.number().int().positive(),
    data: base64,
  }),
  z.object({
    type: z.literal("reply"),
    id,
    ok: z.boolean(),
    error: z.string().max(300).optional(),
    // The probe's response packet for probe.transfer.
    data: base64.optional(),
  }),
  // The owner cuts off an active debug-probe session from the page.
  z.object({ type: z.literal("probe-end"), deviceId: id }),
  z.object({ type: z.literal("approve"), id, allow: z.boolean() }),
  z.object({ type: z.literal("rpc"), request }),
]);
export const response = z.discriminatedUnion("ok", [
  z.object({ id, ok: z.literal(true), result: z.unknown() }),
  z.object({ id, ok: z.literal(false), error: z.string().max(500) }),
]);
export function hexBytes(input: string): Uint8Array {
  const s = input.replace(/\s/g, "");
  if (!/^(?:[a-fA-F0-9]{2})*$/.test(s) || s.length > MAX_BYTES * 2)
    throw Error("Enter complete hexadecimal byte pairs (maximum 16 KiB)");
  return Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));
}
