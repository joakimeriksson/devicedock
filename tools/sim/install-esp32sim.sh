#!/bin/sh
# Install a built esp32sim (https://github.com/mikroverk/esp32sim) as a DeviceDock simulator engine.
#   tools/sim/install-esp32sim.sh /path/to/esp32sim [bundle ...]       default bundle: tdisplay-prices
# The checkout must contain web/wasm/esp32sim.wasm (tools/wasm-build.sh) and, for each bundle, the files its
# manifest names (tools/fetch-micropython.sh, tools/fetch-rom-elfs.sh web/wasm/fw). Everything is copied to
# apps/web/public/sim/esp32sim/ (git-ignored: ~8 MB of binaries) and registered in apps/web/public/sim/profiles.json.
# Then run `npm run build`; the backend serves the result from dist/.
set -e
SIM=${1:?usage: install-esp32sim.sh /path/to/esp32sim [bundle ...]}; shift || true
[ $# -gt 0 ] || set -- tdisplay-prices
cd "$(dirname "$0")/../.."
DEST=apps/web/public/sim/esp32sim/wasm
SRC="$SIM/web/wasm"
[ -f "$SRC/esp32sim.wasm" ] || { echo "$SRC/esp32sim.wasm missing: build it with tools/wasm-build.sh in the esp32sim checkout" >&2; exit 1; }
mkdir -p "$DEST/fw" apps/web/public/sim
for f in esp32sim.wasm worker.js jit.mjs pacing.mjs experiments.mjs; do cp "$SRC/$f" "$DEST/$f"; done
python3 - "$SRC" "$DEST" "$@" <<'PY'
import json, os, shutil, sys
src, dest, *bundles = sys.argv[1:]
fw, out = os.path.join(src, "fw"), os.path.join(dest, "fw")
PROFILES = {
  "tdisplay-prices": {
    "id": "esp32sim-ttgo-tdisplay-prices",
    "label": "LilyGO TTGO T-Display (simulated)",
    "engine": "esp32sim", "board": "ttgo-tdisplay", "chip": "esp32",
    "description": "Classic ESP32 running stock MicroPython and the spot-price app, in esp32sim (WebAssembly). Console on UART0.",
    "console": "uart0", "baudRate": 115200,
    "engineConfig": {"base": "/sim/esp32sim/", "manifest": "tdisplay-prices.json",
                     "strap": {"normal": "0x13", "download": "0x3"}},
    "display": {"width": 135, "height": 240, "rotate": 270},
    "buttons": [{"label": "left (GPIO 0)", "pin": 0}, {"label": "right (GPIO 35)", "pin": 35}],
  },
  # Download-mode straps verified with stock esptool (flash-id, stub, write-flash with hash check); "normal" is the
  # chip's reset default (0x0f, SPI boot).
  "hello": {
    "id": "esp32sim-esp32s3-hello",
    "label": "ESP32-S3 dev board (simulated)",
    "engine": "esp32sim", "board": "esp32s3", "chip": "esp32s3",
    "description": "Bare ESP32-S3 (dual Xtensa LX7, 8 MB flash, 2 MB PSRAM) running IDF hello_world, in esp32sim. Console on UART0; esptool can flash it.",
    "console": "uart0", "baudRate": 115200,
    "engineConfig": {"base": "/sim/esp32sim/", "manifest": "hello.json",
                     "strap": {"normal": "0x0f", "download": "0x0"}},
  },
  "c3-hello": {
    "id": "esp32sim-esp32c3-hello",
    "label": "ESP32-C3 dev board (simulated)",
    "engine": "esp32sim", "board": "esp32c3", "chip": "esp32c3",
    "description": "Bare ESP32-C3 (RISC-V, 4 MB flash) running IDF hello_world, in esp32sim. Console on UART0; esptool can flash it (slowly: about 7 s per 64 KB).",
    "console": "uart0", "baudRate": 115200,
    "engineConfig": {"base": "/sim/esp32sim/", "manifest": "c3-hello.json",
                     "strap": {"normal": "0x0f", "download": "0x4"}},
  },
  "c6-hello": {
    "id": "esp32sim-esp32c6-hello",
    "label": "ESP32-C6 dev board (simulated)",
    "engine": "esp32sim", "board": "esp32c6", "chip": "esp32c6",
    "description": "Bare ESP32-C6 (RISC-V, 4 MB flash) running IDF hello_world, in esp32sim. Console on UART0; esptool can flash it.",
    "console": "uart0", "baudRate": 115200,
    "engineConfig": {"base": "/sim/esp32sim/", "manifest": "c6-hello.json",
                     "strap": {"normal": "0x0f", "download": "0x4"}},
  },
  "c6-energy-scan": {
    "id": "esp32sim-waveshare-c6-lcd147",
    "label": "Waveshare ESP32-C6-LCD-1.47 (simulated)",
    "engine": "esp32sim", "board": "waveshare-c6-lcd147", "chip": "esp32c6",
    "description": "ESP32-C6 with a 172x320 ST7789 LCD and a WS2812, running an 802.15.4 energy scanner, in esp32sim. Console on UART0; esptool can flash it.",
    "console": "uart0", "baudRate": 115200,
    "engineConfig": {"base": "/sim/esp32sim/", "manifest": "c6-energy-scan.json",
                     "strap": {"normal": "0x0f", "download": "0x4"}},
    "display": {"width": 172, "height": 320, "rotate": 0},
    "buttons": [{"label": "BOOT (GPIO 9)", "pin": 9}],
  },
}
profiles = []
for name in bundles:
    manifest_path = os.path.join(fw, name + ".json")
    m = json.load(open(manifest_path))
    needed = [name + ".json"]
    for v in (m.get("files") or {}).values(): needed += [v] if isinstance(v, str) else list(v)
    needed += list((m.get("flash_at") or {}).values())
    for rel in needed:
        s = os.path.join(fw, rel)
        if not os.path.isfile(s): sys.exit(f"{s} missing (did you run the esp32sim fetch scripts?)")
        d = os.path.join(out, rel); os.makedirs(os.path.dirname(d), exist_ok=True); shutil.copyfile(s, d)
    if name not in PROFILES: sys.exit(f"no DeviceDock profile is defined for bundle {name!r}; add it to this script")
    profiles.append(PROFILES[name])
pf = os.path.join(os.path.dirname(os.path.dirname(dest)), "profiles.json")
existing = json.load(open(pf)) if os.path.exists(pf) else []
keep = [p for p in existing if p["id"] not in {x["id"] for x in profiles}]
json.dump(keep + profiles, open(pf, "w"), indent=2)
print("installed:", ", ".join(x["id"] for x in profiles))
PY
du -sh apps/web/public/sim | cut -f1 | sed 's/^/size: /'
