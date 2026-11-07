# DeviceDock architecture, and where things can be replaced

This document answers one question: **what would it take to swap `esp32sim` for another simulator, or add a
different kind of device, without touching the rest?** It describes the code as it is (2026-11-07), says which
parts are verified, and marks proposals as proposals.

## 1. The layers

```
 Linux sandbox (Docker)                 Mac backend (Node, 127.0.0.1)            Browser (Chrome/Edge)
 ──────────────────────                 ───────────────────────────             ─────────────────────
 agents: Codex / Claude / OpenCode      Broker: leases, generations,             DeviceAdapter  ◄── the seam
   │  esptool, pyserial, PlatformIO       approvals, "autonomous" windows          ├─ WebSerialAdapter  (real port)
   │  `device` CLI, MCP tools            device registry, request routing         ├─ MockAdapter       (loopback)
   ▼                                              ▲                               └─ SimAdapter ◄── generic
 bridge service (in container)  ──TCP──► bridge client ◄──WebSocket──►  page            │
   ├ HTTP /rpc  (device CLI / SDK / MCP)                                                 ▼
   └ RFC 2217 server 127.0.0.1:2217                                                  SimEngine  ◄── the second seam
     (what esptool/pyserial connect to)                                              └─ esp32sim engine (WebAssembly)
```

Data path for any device: *device ⇄ adapter (browser) ⇄ WebSocket ⇄ broker ⇄ bridge ⇄ `device`/RFC 2217 ⇄ tool*.
Nothing in the broker, bridge, CLI, MCP server or RFC 2217 server knows how a device is implemented.

## 2. The seams (what to implement to replace or add something)

| You want to… | Implement | Touches |
| --- | --- | --- |
| add a **simulator/emulator that runs in the browser** | `SimEngine` (`apps/web/src/sim/types.ts`) + a profile | one engine file, one registration line, one profile |
| add a **new real transport** (WebUSB, WebHID, Bluetooth serial) | `DeviceAdapter` (`apps/web/src/adapters.ts`) | one adapter; kind stays `serial` (physical) |
| add a **simulator that cannot run in the browser** (QEMU, Renode, a native emulator) | a *device provider* (section 6, **not built**) | bridge service / backend |
| change what agents can do | `packages/protocol` operations, `apps/server/broker.ts` | protocol, broker, SDK |

### 2.1 `DeviceAdapter` (browser): a byte stream plus modem lines
`listGranted`, `requestDevice`, `open`, `close`, `write`, `setSignals`, `subscribe`. The page drives every
device through it (`execute()` in `main.tsx` is generic). Real hardware, the loopback mock and every simulator
look identical from here up.

### 2.2 `SimEngine` (browser): one emulated board
`start(profile)`, `stop()`, `reset({download})`, `write(bytes, console)`, optional `setButton`, and events:
`console` (bytes from a named console), `frame` (engine-neutral RGBA), `status`, `stopped`.
An engine knows nothing about DeviceDock: no leases, approvals, bridge or protocol.
`SimAdapter` turns any engine into a `DeviceAdapter` and is the **only** place that decides what the modem
lines mean for a simulated board (RTS = reset line, DTR = boot-select strap sampled when reset is released:
the standard ESP auto-reset wiring). `tests/unit/sim.test.ts` proves the adapter against a *fake* engine, so the
layer is verified independently of `esp32sim`.

### 2.3 Profiles: boards, not code
`apps/web/public/sim/profiles.json` lists installed boards (`engine`, `board`, `console`, `display`, `buttons`,
and an opaque `engineConfig` that only the engine reads). No profile file means no simulator is offered. An engine
that is not registered is ignored, so a stale profile cannot break the page.

### 2.4 Device kinds are trust classes, not implementations
`packages/protocol`: `kind` is `serial` | `mock` | `sim`; `isPhysical(kind)` is true only for `serial`.
**All safety policy keys off that predicate**: whether a hardware warning is shown, whether approvals may be
waived (`autoApprove`), whether a port is remembered and auto-shared. `engine` and `board` are display-only labels.
`device list` reports `simulated: true` (plus `engine`, `board`) for software devices, so an agent can never mistake
a simulation for hardware. A new simulator therefore needs **no new kind** and no policy change.

## 3. What is `esp32sim`-specific (exhaustive)

- `apps/web/src/sim/engines/esp32sim.ts`: its worker protocol (`init`, `create`, `load`, `start`, `text`, frames).
- `tools/sim/install-esp32sim.sh`: copies a built esp32sim into `apps/web/public/sim/esp32sim/` and writes the
  profile (git-ignored, about 7 MB).
- One registration line in `apps/web/src/sim/engines/index.ts`.

Everything else (adapter, UI display panel, broker, bridge, CLI, MCP, RFC 2217) is engine-neutral.

## 4. Policy by device class

| | `serial` (hardware) | `mock` / `sim` (software) |
| --- | --- | --- |
| hardware warning on share | yes | no |
| agent writes need approval | yes, unless time-boxed *autonomous* mode | may be waived (`autoApprove`) |
| `autoApprove` flag allowed | **never** (broker rejects it) | yes |
| remembered and auto-shared after restart | yes (opt-out) | no |
| `device list` | `simulated` absent | `simulated: true`, `engine`, `board` |

## 5. Adding another browser simulator (checklist)

1. Write `apps/web/src/sim/engines/<name>.ts` implementing `SimEngine`; convert its frames to RGBA, name its
   consoles, honour `stop()` fully (terminate workers, free memory).
2. Register it in `engines/index.ts`.
3. Add its board(s) to a profile and an installer under `tools/sim/` (keep binaries out of git).
4. Test the engine's pure parts (frame conversion, protocol parsing) like `rgb565ToRgba`; the adapter needs no
   new tests.
5. Check the CSP (`apps/server/app.ts`): WebAssembly needs `'wasm-unsafe-eval'` (already allowed, together with
   `worker-src 'self'`); an engine needing more (network, `eval`) is a security decision, not a detail.

## 6. Simulators that do not run in the browser (proposal, not built)

QEMU, Renode or a native emulator would run in the sandbox or on the Mac and expose a serial endpoint (pty or TCP).
Today the broker only knows **browser-owned** devices, so these need a second kind of device source.
Proposal: a *device provider* interface next to `startRfc2217`'s `Api` (`list`, `call`): a provider registers
devices with the bridge service, and the existing lease/approval path applies unchanged. The RFC 2217 server and
`device` CLI already work against a list of devices and would not change. This is the one place the current design
would need real work for non-browser engines.

## 7. Limits of the esp32sim engine today (observed 2026-11-07)

Verified in Chrome against a test instance (browser side only; **not yet exercised through the bridge**):
the simulated T-Display boots stock MicroPython, shows the price screen, answers at the REPL (`print(6*7)` gives
`42` after Ctrl-C), and resets when RTS is released.

- **Reset is a reboot from the original images.** The wasm build has no live reset operation, so the simulated
  flash is not kept across resets. The engine says so in a status line.
- **No download-mode strap.** `esptool` cannot flash the simulated chip. Whether the mask ROM's UART download mode
  can be reached through this build is untested.
- **Console input is a JSON text string.** Exact for ASCII and UTF-8 (REPL use), not for arbitrary binary.
- **No network in the browser.** The simulated board shows demo data. esp32sim's NAT uses `std::net`; a browser
  host-network trait (and a `/ws/net` proxy with an allowlist) is a separate piece of work, not started.
- **One emulator instance per device**; pacing and JIT are the worker's.

## 8. Other engines worth evaluating (ideas only; none has been checked)

Browser-hosted JavaScript/WASM emulators for other MCUs would fit `SimEngine` directly. Process-based ones
(QEMU, Renode) need the section 6 provider. None of these has been evaluated here.
