// esp32sim (github.com/mikroverk/esp32sim) in its Web Worker. Protocol: docs/web-ui.md and web/wasm/worker.js
// of that repository. This file is the ONLY place in DeviceDock that knows it; swap or add a simulator by
// writing another engine next to it.
//
// Profile engineConfig: { base: "/sim/esp32sim/", manifest: "tdisplay-prices.json" } where the manifest is
// esp32sim's own firmware bundle (board, flash_mb, files, flash_at) under <base>wasm/fw/.

const KINDS = {
  rom: 0, bootloader: 1, ptable: 2, app: 3, elf: 4, flash: 5, script: 6, picture: 7,
};

/**
 * esp32sim's firmware bundle. `stubs`: functions the emulator replaces ("name=value"); names resolve through
 * `symbols` (address strings).
 * @typedef {{ board: string, flash_mb?: number, psram_mb?: number, files?: Record<string, string | string[]>,
 *   flash_at?: Record<string, string>, app_direct?: boolean, stubs?: string[], symbols?: Record<string, string> }} Manifest
 * @typedef {{ kind?: number, at?: number, data: ArrayBuffer }} Loadable
 * @typedef {{ manifest: Manifest, loads: Loadable[], wasm: ArrayBuffer }} Bundle
 */

async function fetchBuffer(url) {
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}${r.status === 404 ? " (run tools/sim/install-esp32sim.sh)" : ""}`);
  return r.arrayBuffer();
}

export const toHex = (/** @type {Uint8Array} */ b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export function fromHex(/** @type {string} */ h) {
  const out = new Uint8Array(h.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

/** RGB565 little-endian pixels to RGBA, the engine-neutral frame format.
 * @param {Uint8Array} pixels
 * @param {number} width
 * @param {number} height */
export function rgb565ToRgba(pixels, width, height) {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, j = 0; i + 1 < pixels.length && j < out.length; i += 2, j += 4) {
    const v = pixels[i] | (pixels[i + 1] << 8);
    const r = (v >> 11) & 31, g = (v >> 5) & 63, b = v & 31;
    out[j] = (r << 3) | (r >> 2);
    out[j + 1] = (g << 2) | (g >> 4);
    out[j + 2] = (b << 3) | (b >> 2);
    out[j + 3] = 255;
  }
  return out;
}

/** As esp32sim's own page: replace the name by its address from `symbols`, keep the "=value" text as written.
 * @param {string} spec
 * @param {Record<string, string>} [symbols] */
export function stubSpec(spec, symbols = {}) {
  const split = spec.indexOf("="), name = split < 0 ? spec : spec.slice(0, split);
  return (symbols[name] || name) + (split < 0 ? "" : spec.slice(split));
}

/** @returns {import("../types.js").SimEngine} */
export function createEsp32SimEngine() {
  /** @type {Set<(e: import("../types.js").SimEvent) => void>} */
  const handlers = new Set();
  const emit = (e) => handlers.forEach((h) => h(e));
  /** @type {Worker | undefined} */
  let worker;
  /** @type {import("../types.js").SimProfile | undefined} */
  let profile;
  /** @type {Bundle | undefined} */
  let bundle;
  /** @type {{ key: string, resolve: (m: any) => void, reject: (e: Error) => void } | undefined} */
  let waiter;

  const enc = new TextEncoder();

  function onMessage(ev) {
    const m = ev.data ?? {};
    if (waiter && waiter.key in m) {
      const w = waiter;
      waiter = undefined;
      w.resolve(m);
    }
    if (typeof m.text === "string") {
      let j;
      try { j = JSON.parse(m.text); } catch { return; }
      // `hex` carries the exact bytes whenever they are not valid UTF-8 (binary protocols such as esptool's SLIP).
      if (j.t === "serial" && typeof j.data === "string")
        emit({ type: "console", console: String(j.src ?? "usb"), bytes: typeof j.hex === "string" ? fromHex(j.hex) : enc.encode(j.data) });
      else if (j.t === "emu") emit({ type: "status", message: String(j.msg ?? "") });
    } else if (m.bin instanceof ArrayBuffer) {
      const b = new Uint8Array(m.bin);
      if (b[0] === 1 && b.length >= 5) {
        const w = b[1] | (b[2] << 8), h = b[3] | (b[4] << 8);
        emit({ type: "frame", width: w, height: h, rgba: rgb565ToRgba(b.subarray(5), w, h) });
      }
      worker?.postMessage({ op: "frame-ack" }); // the worker stops sending after two unacknowledged frames
    } else if (typeof m.log === "string") {
      emit({ type: "status", message: m.log, level: m.log.startsWith("[worker]") ? "error" : "info" });
    } else if ("stopped" in m) {
      emit({ type: "stopped", error: m.stopped ? `emulator stopped (${m.stopped})` : undefined });
    }
  }

  function ask(key, message, transfer = []) {
    return new Promise((resolve, reject) => {
      waiter = { key, resolve, reject };
      worker.postMessage(message, transfer);
    });
  }

  /** @returns {Promise<Bundle>} */
  async function loadBundle(p) {
    const cfg = p.engineConfig;
    if (!cfg.base || !cfg.manifest) throw new Error("esp32sim profile needs engineConfig.base and .manifest");
    const fw = `${cfg.base}wasm/fw/`;
    /** @type {Manifest} */
    const manifest = await (await fetch(`${fw}${cfg.manifest}`, { cache: "no-cache" })).json();
    /** @type {Loadable[]} */
    const loads = [];
    for (const [kind, urls] of Object.entries(manifest.files ?? {}))
      for (const u of [].concat(urls)) loads.push({ kind: KINDS[kind], data: await fetchBuffer(fw + u) });
    for (const [off, u] of Object.entries(manifest.flash_at ?? {}))
      loads.push({ at: Number(off), data: await fetchBuffer(fw + u) });
    return { manifest, loads, wasm: await fetchBuffer(`${cfg.base}wasm/esp32sim.wasm`) };
  }

  async function boot() {
    if (!profile || !bundle) throw new Error("no profile loaded");
    const cfg = profile.engineConfig;
    worker = new Worker(`${cfg.base}wasm/worker.js`, { type: "module" });
    worker.onmessage = onMessage;
    worker.onerror = (e) => emit({ type: "stopped", error: e.message || "emulator worker failed" });
    // The wasm bytes are copied per boot: a transferred buffer would be gone for the next reset.
    await ask("ready", { op: "init", wasm: bundle.wasm.slice(0), frameAck: true });
    const created = await ask("created", {
      op: "create", board: bundle.manifest.board, flash_mb: bundle.manifest.flash_mb || 8,
      psram_mb: bundle.manifest.psram_mb ?? 2, jit: true,
    });
    if (!created.created) throw new Error(`esp32sim cannot create board "${bundle.manifest.board}" (build too old?)`);
    for (const l of bundle.loads) {
      const data = l.data.slice(0);
      const r = await ask("loaded", l.at !== undefined ? { op: "load", at: l.at, data } : { op: "load", kind: l.kind, data }, [data]);
      if (r.ok === false) throw new Error(`esp32sim rejected a firmware image (${String(r.loaded)})`);
    }
    for (const st of bundle.manifest.stubs ?? []) worker.postMessage({ op: "stub", spec: stubSpec(st, bundle.manifest.symbols) });
    const started = await ask("started", { op: "start", appDirect: !!bundle.manifest.app_direct });
    if (started.started === false) throw new Error(started.error || "esp32sim failed to start");
  }

  return {
    async start(p) {
      profile = p;
      bundle = await loadBundle(p);
      await boot();
    },
    stop() {
      waiter?.reject(new Error("stopped"));
      waiter = undefined;
      worker?.terminate();
      worker = undefined;
    },
    async reset(opts) {
      if (!worker || !profile) return;
      // A live reset: set the boot-mode pins the ROM samples (download mode for esptool), then reset the chip in
      // place. It reboots through the ROM and keeps the flash, so firmware written by esptool boots afterwards.
      /** @type {{ normal?: string, download?: string }} */
      const strap = profile.engineConfig.strap ?? {};
      const v = opts?.download ? strap.download : strap.normal;
      if (opts?.download && !v) emit({ type: "status", message: "This board's profile names no download-mode strap; resetting normally." });
      if (v) worker.postMessage({ op: "text", data: JSON.stringify({ t: "strap", v }) });
      worker.postMessage({ op: "text", data: JSON.stringify({ t: "reset" }) });
    },
    write(bytes, console) {
      // `bytes` (hex) is binary-safe; `key` carries a JSON string and would mangle bytes >= 0x80. Chunks stay well
      // under the simulator's 64 KiB per message; the UART releases them to the firmware at the baud rate.
      for (let i = 0; i < bytes.length; i += 16384)
        worker?.postMessage({ op: "text", data: JSON.stringify({ t: "bytes", src: console, hex: toHex(bytes.subarray(i, i + 16384)) }) });
    },
    setButton(pin, down) {
      worker?.postMessage({ op: "text", data: JSON.stringify({ t: "btn", pin, v: down ? 1 : 0 }) });
    },
    onEvent(h) {
      handlers.add(h);
      return () => handlers.delete(h);
    },
  };
}
