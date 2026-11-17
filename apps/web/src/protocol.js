// What the page needs of the device protocol (server-rs/src/protocol.rs is the backend's side): device kinds, the flash
// session limits, and checks of the serial options and of the operations the backend asks the page to run.

/** @typedef {"serial" | "mock" | "sim" | "probe"} DeviceKind */

/**
 * What a device IS decides the safety policy; how it is implemented does not.
 *  - "serial" / "probe": real hardware behind a browser-granted port (approvals, hardware warning, auto-share memory).
 *  - "mock" / "sim": software devices. Nothing physical can be affected, so approvals may be waived.
 * @param {DeviceKind} kind
 */
export const isPhysical = (kind) => kind === "serial" || kind === "probe";
/** @param {DeviceKind} kind */
export const isVirtual = (kind) => !isPhysical(kind);

/** A flash session ends after this long without a write, signal or line change... */
export const FLASH_IDLE_MS = 2 * 60 * 1000;
/** ...and this long after it opened at the latest, however busy it is. */
export const FLASH_MAX_MS = 20 * 60 * 1000;
/** Operations a flash session covers: everything esptool does to a port, except closing it (that ends the share). */
export const FLASH_OPS = ["serial.write", "serial.signals", "serial.configure", "serial.connect"];

export const MAX_BYTES = 16384;
/** Largest CMSIS-DAP packet carried. */
export const MAX_DAP_PACKET = 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const fail = (what) => {
  throw Error(`Invalid request: ${what}`);
};
const isInt = (v, min, max = Number.MAX_SAFE_INTEGER) => Number.isInteger(v) && v >= min && v <= max;
const decodedSize = (s) => (s.length * 3) / 4 - (s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0);
/** Base64 of at most `max` bytes. */
const isBase64 = (v, max) => typeof v === "string" && BASE64.test(v) && decodedSize(v) <= max;
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
/** Only the named keys, each passing its check when present. */
function strict(v, checks, what) {
  if (!isObject(v)) fail(what);
  for (const [k, x] of Object.entries(v)) if (!(k in checks) || (x !== undefined && !checks[k](x))) fail(`${what}.${k}`);
}

const optionChecks = {
  baudRate: (v) => isInt(v, 300, 4000000),
  dataBits: (v) => v === 7 || v === 8,
  stopBits: (v) => v === 1 || v === 2,
  parity: (v) => ["none", "even", "odd"].includes(v),
  flowControl: (v) => ["none", "hardware"].includes(v),
};

/**
 * Serial line settings, checked, with the defaults filled in (8N1, no flow control).
 * @param {{ baudRate: number, dataBits?: 7 | 8, stopBits?: 1 | 2, parity?: "none" | "even" | "odd", flowControl?: "none" | "hardware" }} o
 */
export function parseOptions(o) {
  strict(o, optionChecks, "options");
  if (o.baudRate === undefined) fail("options.baudRate");
  return { dataBits: 8, stopBits: 1, parity: "none", flowControl: "none", ...o };
}

const none = {};
const ARGS = {
  "devices.list": none,
  "serial.acquire": none,
  "serial.release": none,
  "serial.connect": optionChecks,
  "serial.disconnect": none,
  "serial.configure": optionChecks,
  "serial.signals": {
    dataTerminalReady: (v) => typeof v === "boolean",
    requestToSend: (v) => typeof v === "boolean",
    break: (v) => typeof v === "boolean",
  },
  "serial.write": { data: (v) => isBase64(v, MAX_BYTES) },
  "probe.open": none,
  "probe.close": none,
  "probe.transfer": { data: (v) => isBase64(v, MAX_DAP_PACKET) && v.length > 0 },
  "flash.open": { purpose: (v) => typeof v === "string" && v.length <= 200 },
  "flash.close": none,
  "serial.read": { maxBytes: (v) => isInt(v, 1, MAX_BYTES) },
};
const REQUIRED = { "serial.connect": ["baudRate"], "serial.configure": ["baudRate"], "serial.write": ["data"], "probe.transfer": ["data"] };

/**
 * Checks a device operation from the backend before the page runs it; throws if it is malformed.
 * @param {any} r
 */
export function parseRequest(r) {
  strict(
    r,
    {
      v: (v) => v === 1,
      id: (v) => typeof v === "string" && UUID.test(v),
      op: (v) => typeof v === "string" && Object.hasOwn(ARGS, v),
      deviceId: (v) => typeof v === "string" && UUID.test(v),
      generation: (v) => isInt(v, 1),
      deadline: (v) => isInt(v, 1),
      lease: (v) => typeof v === "string" && UUID.test(v),
      args: isObject,
    },
    "request",
  );
  for (const k of ["v", "id", "op", "deadline", "args"]) if (r[k] === undefined) fail(k);
  strict(r.args, ARGS[r.op], "args");
  for (const k of REQUIRED[r.op] ?? []) if (r.args[k] === undefined) fail(`args.${k}`);
  return r;
}
