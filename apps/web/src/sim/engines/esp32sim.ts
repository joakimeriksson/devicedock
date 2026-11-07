import type { SimConsole, SimEngine, SimEvent, SimProfile } from "../types";

// esp32sim (github.com/mikroverk/esp32sim) in its Web Worker. Protocol: docs/web-ui.md and web/wasm/worker.js
// of that repository. This file is the ONLY place in DeviceDock that knows it; swap or add a simulator by
// writing another engine next to it.
//
// Profile engineConfig: { base: "/sim/esp32sim/", manifest: "tdisplay-prices.json" } where the manifest is
// esp32sim's own firmware bundle (board, flash_mb, files, flash_at) under <base>wasm/fw/.

const KINDS: Record<string, number> = {
  rom: 0, bootloader: 1, ptable: 2, app: 3, elf: 4, flash: 5, script: 6, picture: 7,
};

type Manifest = {
  board: string;
  flash_mb?: number;
  psram_mb?: number;
  files?: Record<string, string | string[]>;
  flash_at?: Record<string, string>;
  app_direct?: boolean;
};
type Loadable = { kind?: number; at?: number; data: ArrayBuffer };
type Bundle = { manifest: Manifest; loads: Loadable[]; wasm: ArrayBuffer };

async function fetchBuffer(url: string): Promise<ArrayBuffer> {
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}${r.status === 404 ? " (run tools/sim/install-esp32sim.sh)" : ""}`);
  return r.arrayBuffer();
}

/** RGB565 little-endian pixels to RGBA, the engine-neutral frame format. */
export function rgb565ToRgba(pixels: Uint8Array, width: number, height: number): Uint8ClampedArray {
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

export function createEsp32SimEngine(): SimEngine {
  const handlers = new Set<(e: SimEvent) => void>();
  const emit = (e: SimEvent) => handlers.forEach((h) => h(e));
  let worker: Worker | undefined;
  let profile: SimProfile | undefined;
  let bundle: Bundle | undefined;
  let waiter: { key: string; resolve: (m: any) => void; reject: (e: Error) => void } | undefined;

  const dec = new TextDecoder();
  const enc = new TextEncoder();

  function onMessage(ev: MessageEvent) {
    const m = ev.data ?? {};
    if (waiter && waiter.key in m) {
      const w = waiter;
      waiter = undefined;
      w.resolve(m);
    }
    if (typeof m.text === "string") {
      let j: any;
      try { j = JSON.parse(m.text); } catch { return; }
      if (j.t === "serial" && typeof j.data === "string")
        emit({ type: "console", console: String(j.src ?? "usb"), bytes: enc.encode(j.data) });
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

  function ask(key: string, message: object, transfer: Transferable[] = []): Promise<any> {
    return new Promise((resolve, reject) => {
      waiter = { key, resolve, reject };
      worker!.postMessage(message, transfer);
    });
  }

  async function loadBundle(p: SimProfile): Promise<Bundle> {
    const cfg = p.engineConfig as { base?: string; manifest?: string };
    if (!cfg.base || !cfg.manifest) throw new Error("esp32sim profile needs engineConfig.base and .manifest");
    const fw = `${cfg.base}wasm/fw/`;
    const manifest = (await (await fetch(`${fw}${cfg.manifest}`, { cache: "no-cache" })).json()) as Manifest;
    const loads: Loadable[] = [];
    for (const [kind, urls] of Object.entries(manifest.files ?? {}))
      for (const u of ([] as string[]).concat(urls)) loads.push({ kind: KINDS[kind], data: await fetchBuffer(fw + u) });
    for (const [off, u] of Object.entries(manifest.flash_at ?? {}))
      loads.push({ at: Number(off), data: await fetchBuffer(fw + u) });
    return { manifest, loads, wasm: await fetchBuffer(`${cfg.base}wasm/esp32sim.wasm`) };
  }

  async function boot() {
    if (!profile || !bundle) throw new Error("no profile loaded");
    const cfg = profile.engineConfig as { base: string };
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
      if (!bundle || !profile) return;
      this.stop();
      // esp32sim's wasm build has no live reset op: a reset is a fresh boot from the same images, so
      // anything written to the simulated flash since the last boot is gone.
      emit({
        type: "status",
        message:
          "Simulator reset: rebooted from the original images; the simulated flash is not kept." +
          (opts?.download ? " The download-mode strap is not supported by this engine." : ""),
      });
      await boot();
    },
    write(bytes: Uint8Array, console: SimConsole) {
      // `key` delivers bytes exactly as typed. The text protocol carries a string, so this is exact for
      // ASCII and UTF-8 text (REPL use) but not for arbitrary binary.
      worker?.postMessage({ op: "text", data: JSON.stringify({ t: "key", src: console, data: dec.decode(bytes) }) });
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
