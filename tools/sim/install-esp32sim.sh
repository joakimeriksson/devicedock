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
