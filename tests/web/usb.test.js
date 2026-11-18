// The page's USB names and the approval dialog's wording.  deno test
import assert from "../assert.js";
import { migrateRememberKey, usbKey, usbName } from "../../apps/web/src/usb.js";
import { describe, plain, visible } from "../../apps/web/src/approval.js";
import { encode } from "../../apps/web/src/adapters.js";

const b64 = (s) => encode(typeof s === "string" ? new TextEncoder().encode(s) : Uint8Array.from(s));

Deno.test("USB serial ports get readable names that keep the USB id", () => {
  assert.equal(usbName(0x10c4, 0xea60), "CP210x USB-UART (10c4:ea60)");
  assert.equal(usbName(0x303a, 0x1001), "ESP32 USB-Serial/JTAG (303a:1001)");
  assert.equal(usbName(0x303a, 0x4001), "Espressif USB serial (303a:4001)");
  assert.equal(usbName(0x0403, 0x6001), "FTDI FT232R USB-UART (0403:6001)");
  assert.equal(usbName(0xabcd, 0x0001), "USB serial (abcd:0001)");
  assert.equal(usbName(undefined, undefined), "Serial port");
  assert.ok(usbName(0x0451, 0xbef3).length <= 100, "fits the protocol's name limit");
});

Deno.test("auto-share memory moves from the old names to USB ids", () => {
  assert.equal(usbKey({ vendorId: 0x403, productId: 0x6001 }), "0403:6001");
  assert.equal(migrateRememberKey("Serial 403:6001"), "0403:6001");
  assert.equal(migrateRememberKey("Serial 10c4:ea60"), "10c4:ea60");
  assert.equal(migrateRememberKey("10c4:ea60"), "10c4:ea60");
  assert.equal(migrateRememberKey("Serial port:unknown"), "Serial port:unknown");
});

Deno.test("writes are shown as readable text with control characters made visible", () => {
  const d = describe("serial.write", { data: b64("print(6*7)\r") });
  assert.equal(d.title, "Send 11 bytes");
  assert.equal(d.data?.text, "print(6*7)\\r");
  assert.equal(d.data?.binary, false);
  assert.equal(describe("serial.write", { data: b64("A") }).title, "Send 1 byte");
  assert.equal(visible(new TextEncoder().encode("a\nb\x03")).text, "a\\n\nb\\x03");
  assert.equal(visible(new TextEncoder().encode("hej då ✓")).text, "hej då ✓");
});

Deno.test("hidden characters cannot make the dialog misstate a write or a purpose", () => {
  // U+202E (right-to-left override) would show "esptool chip-id" while the bytes say otherwise; U+200B is invisible.
  assert.equal(plain("esptool ‮di-pihc​\nrm -rf /"), "esptool \\u{202e}di-pihc\\u{200b}\\nrm -rf /");
  assert.equal(visible(new TextEncoder().encode("ok‮\u0085")).text, "ok\\u{202e}\\u{85}");
  assert.equal(describe("flash.open", { purpose: "a⁦b" }).purpose, "a\\u{2066}b");
  assert.equal(plain("hej då ✓ 0x10000"), "hej då ✓ 0x10000");
});

Deno.test("binary writes say so, show hex, and long ones are cut", () => {
  const bin = describe("serial.write", { data: b64([0xc0, 0x00, 0x08, 0x24, 0x00, 0x00, 0x00, 0x00, 0x07, 0x07, 0x12, 0x20, 0xc0]) });
  assert.equal(bin.title, "Send 13 bytes of binary data");
  assert.equal(bin.data?.binary, true);
  assert.equal(bin.data?.hex.slice(0, 11), "c0 00 08 24");
  const long = describe("serial.write", { data: b64("x".repeat(5000)) });
  assert.equal(long.data?.size, 5000);
  assert.equal(long.data?.shown, 600);
});

Deno.test("control lines, line settings and sessions are described", () => {
  assert.equal(describe("serial.signals", { dataTerminalReady: false, requestToSend: true }).title, "Set control lines: DTR off, RTS on");
  assert.match(describe("serial.signals", { requestToSend: true }).detail, /reset the chip/);
  assert.equal(
    describe("serial.configure", { baudRate: 460800, dataBits: 8, stopBits: 1, parity: "none", flowControl: "none" }).title,
    "Change the port to 460800 baud",
  );
  assert.match(describe("serial.connect", { baudRate: 9600, dataBits: 7, stopBits: 2, parity: "even", flowControl: "hardware" }).detail, /7E2, hardware flow control/);
  const flash = describe("flash.open", { purpose: "esptool write-flash 0x10000 app.bin" });
  assert.equal(flash.session, true);
  assert.equal(flash.purpose, "esptool write-flash 0x10000 app.bin");
  assert.equal(describe("flash.open", {}).purpose, undefined);
  assert.equal(describe("probe.open", {}).session, true);
  assert.equal(describe("serial.write", { data: "" }).session, undefined);
});
