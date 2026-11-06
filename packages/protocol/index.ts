import { z } from "zod";
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
export const descriptor = z
  .object({
    id,
    name: z.string().min(1).max(100),
    kind: z.enum(["mock", "serial"]),
    generation: z.number().int().positive(),
    autoApprove: z.boolean(),
    baudRate: z.number().int().min(300).max(4000000),
  })
  .strict();
export type DeviceDescriptor = z.infer<typeof descriptor>;
export const browserMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("expose"), device: descriptor }),
  z.object({ type: z.literal("revoke"), deviceId: id }),
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
  }),
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
