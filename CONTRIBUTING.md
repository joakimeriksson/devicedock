# Contributing to DeviceDock

Thanks for helping. DeviceDock lets coding agents in a locked-down Docker sandbox work with real boards through the
browser. Issues, docs fixes, new board recipes and code are all welcome. Issues labelled
[good first issue](https://github.com/joakimeriksson/devicedock/labels/good%20first%20issue) are small and
self-contained.

## Set up

You need Docker, Chrome or Edge, [Rust](https://rustup.rs) (stable) and Node.js 22.12+ (only for the web UI and tests).

```sh
git clone https://github.com/joakimeriksson/devicedock && cd devicedock
npm ci                 # web UI, Node tests, the original Node backend
./devicedock.sh        # builds the Rust backend, downloads a sandbox image, starts everything
```

`w` in the console rebuilds the web UI (the backend serves `./dist` when it exists), `rb` restarts the backend after
a Rust change, and `i` builds the sandbox image from `sandbox/Dockerfile` (`DEVICEDOCK_VARIANT=base` is the quickest).

## Where things are

| Path | What |
| --- | --- |
| `server-rs/` | The host backend in Rust: web server, device broker, terminals, sandbox lifecycle, firewall, tunnel, shared folders |
| `apps/web/` | The page (React, xterm.js): device sharing, terminals, Network and Shared folders panels |
| `apps/server/` | The original Node backend, kept for web UI work and as the protocol reference |
| `packages/` | Protocol types, the `device` CLI and SDK, the MCP server (these run inside the sandbox) |
| `sandbox/` | The sandbox image (`Dockerfile`, variants base/contiki/esp32/full), the bridge service, `AGENTS.md` for agents |
| `tests/` | Node unit and integration tests, Rust parity tests, browser tests |
| `docs/` | The project web page (GitHub Pages) |

[ARCHITECTURE.md](ARCHITECTURE.md) explains the layers and how to add a new kind of device or simulator.

## Test before you send

```sh
./devicedock.sh test        # cargo test, typecheck, Node tests, and the Rust parity tests
cargo clippy --manifest-path server-rs/Cargo.toml --all-targets
```

CI runs the same on macOS and Linux and builds the sandbox images for amd64 and arm64. For a change in the page, say
in the pull request how you checked it in Chrome. For hardware, say which board you tried; if you could not try one,
say that too.

## Security rules for changes

DeviceDock gives agents real hardware and a network path, so a few rules are fixed. A change that relaxes one needs
an issue first.

- **No host access from the sandbox.** No host device, home folder, credential or Docker socket mounts, no privileged
  mode, no published ports. The only host folders are the ones the human shares in the page (`server-rs/src/shares.rs`).
- **The human decides.** Real hardware writes, debug sessions, new network hosts and shared folders are approved in
  the page. Nothing inside the sandbox can approve on the human's behalf.
- **Treat the sandbox as hostile.** Anything that comes from it (bridge messages, tunnel frames, proxy requests) is
  validated and size-limited, and a protocol error closes the connection.
- **Secrets stay in `.runtime/`** (mode 0600) and never go into command lines, URLs, environment metadata or logs.

Report security problems privately as described in [SECURITY.md](SECURITY.md), not in a public issue.

## Pull requests

- One topic per pull request, with a description of what changed, why, and how you tested it.
- Keep the style of the code around you; `cargo fmt` for Rust.
- By contributing you agree that your work is released under the [BSD-3-Clause license](LICENSE).
