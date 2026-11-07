import { test } from "node:test";
import assert from "node:assert/strict";
import { SimAdapter } from "../../apps/web/src/sim/SimAdapter.ts";
import { registerEngine, loadProfiles } from "../../apps/web/src/sim/registry.ts";
import { rgb565ToRgba } from "../../apps/web/src/sim/engines/esp32sim.ts";
import type { SimEngine, SimEvent, SimProfile } from "../../apps/web/src/sim/types.ts";

// A fake engine: proves SimAdapter works for ANY engine, with none of esp32sim's code involved.
class Fake implements SimEngine {
  static last: Fake;
  handlers = new Set<(e: SimEvent) => void>();
  written: [string, string][] = [];
  resets: { download?: boolean }[] = [];
  stopped = 0;
  buttons: [number, boolean][] = [];
  constructor() { Fake.last = this; }
  async start() {}
  stop() { this.stopped++; }
  async reset(o?: { download?: boolean }) { this.resets.push(o ?? {}); }
  write(b: Uint8Array, c: string) { this.written.push([c, new TextDecoder().decode(b)]); }
  setButton(pin: number, down: boolean) { this.buttons.push([pin, down]); }
  onEvent(h: (e: SimEvent) => void) { this.handlers.add(h); return () => this.handlers.delete(h); }
  emit(e: SimEvent) { this.handlers.forEach((h) => h(e)); }
}
registerEngine("fake", () => new Fake());
const profile: SimProfile = { id: "fake-board", label: "Fake board", engine: "fake", board: "fake-1", console: "uart0", engineConfig: {} };
const setup = async () => {
  const a = new SimAdapter();
  const d = a.create(profile);
  const got: string[] = [];
  const events: string[] = [];
  a.subscribe(d.id, (e) => (e.type === "data" ? got.push(new TextDecoder().decode(e.bytes)) : events.push(e.type + (e.error ? ":" + e.error : ""))));
  await a.open(d.id, { baudRate: 115200 });
  return { a, d, got, events, eng: Fake.last };
};

test("a simulated device is a 'sim' kind with engine/board labels", () => {
  const d = new SimAdapter().create(profile);
  assert.equal(d.kind, "sim");
  assert.equal(d.engine, "fake");
  assert.equal(d.board, "fake-1");
});

test("only the profile's console is the serial port; input goes to it", async () => {
  const { a, d, got, eng } = await setup();
  eng.emit({ type: "console", console: "uart0", bytes: new TextEncoder().encode("hello") });
  eng.emit({ type: "console", console: "usb", bytes: new TextEncoder().encode("diagnostics") });
  assert.deepEqual(got, ["hello"]);
  await a.write(d.id, new TextEncoder().encode("ls\r"));
  assert.deepEqual(eng.written, [["uart0", "ls\r"]]);
});

test("RTS is reset and DTR is the download strap: reset fires when RTS is released, with the strap DTR holds", async () => {
  const { a, d, eng } = await setup();
  await a.setSignals(d.id, { dataTerminalReady: false, requestToSend: true }); // hold in reset, normal boot
  assert.equal(eng.resets.length, 0, "holding reset does not boot");
  await a.setSignals(d.id, { dataTerminalReady: true, requestToSend: false }); // esptool's bootloader entry
  assert.deepEqual(eng.resets, [{ download: true }]);
  await a.setSignals(d.id, { dataTerminalReady: false });
  await a.setSignals(d.id, { requestToSend: true });
  await a.setSignals(d.id, { requestToSend: false }); // a plain hard reset
  assert.deepEqual(eng.resets, [{ download: true }, { download: false }]);
  await a.setSignals(d.id, { dataTerminalReady: true }); // changing DTR alone never resets
  assert.equal(eng.resets.length, 2);
});

test("an explicit close is not a disconnect; an unexpected stop is", async () => {
  const { a, d, events, eng } = await setup();
  eng.emit({ type: "stopped", error: "emulator crashed" });
  assert.deepEqual(events, ["disconnect:emulator crashed"]);
  const second = await setup();
  await second.a.close(second.d.id);
  second.eng.emit({ type: "stopped" });
  assert.deepEqual(second.events, [], "closing on purpose stays silent");
  assert.equal(second.eng.stopped, 1);
  await assert.rejects(second.a.write(second.d.id, new Uint8Array([1])), /not running/);
});

test("frames, status and buttons reach the page without touching the serial stream", async () => {
  const { a, d, got, eng } = await setup();
  const frames: number[] = [], notes: string[] = [];
  a.onFrame(d.id, (f) => frames.push(f.width * f.height));
  a.onStatus(d.id, (s) => notes.push(s.message));
  eng.emit({ type: "frame", width: 2, height: 3, rgba: new Uint8ClampedArray(24) });
  eng.emit({ type: "status", message: "booted" });
  a.button(d.id, 35, true);
  assert.deepEqual(frames, [6]);
  assert.deepEqual(notes, ["booted"]);
  assert.deepEqual(eng.buttons, [[35, true]]);
  assert.deepEqual(got, []);
});

test("profiles are loaded only for registered engines; a missing list is simply empty", async () => {
  const ok = await loadProfiles((async () => ({ ok: true, json: async () => [profile, { ...profile, id: "x", engine: "not-installed" }] })) as any);
  assert.deepEqual(ok.map((p) => p.id), ["fake-board"]);
  assert.deepEqual(await loadProfiles((async () => ({ ok: false })) as any), []);
  assert.deepEqual(await loadProfiles((async () => { throw new Error("offline"); }) as any), []);
});

test("esp32sim RGB565 frames convert to RGBA", () => {
  // 0xF800 = red, 0x07E0 = green, 0x001F = blue, little-endian
  const px = new Uint8Array([0x00, 0xf8, 0xe0, 0x07, 0x1f, 0x00, 0xff, 0xff]);
  assert.deepEqual([...rgb565ToRgba(px, 4, 1)], [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
});

test("esp32sim engine: hex round-trips every byte (esptool's SLIP is binary)", async () => {
  const { toHex, fromHex } = await import("../../apps/web/src/sim/engines/esp32sim.ts");
  const all = Uint8Array.from({ length: 256 }, (_, i) => i);
  assert.equal(toHex(Uint8Array.from([0xc0, 0x00, 0xdb, 0xff])), "c000dbff");
  assert.deepEqual([...fromHex(toHex(all))], [...all]);
});
