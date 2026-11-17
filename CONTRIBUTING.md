# Contributing to DeviceDock

Thanks for helping. DeviceDock lets coding agents in a locked-down Docker sandbox work with real boards through the
browser. Issues, docs fixes, new board recipes and code are all welcome. Issues labelled
[good first issue](https://github.com/joakimeriksson/devicedock/labels/good%20first%20issue) are small and
self-contained.

## Set up

You need Docker, Chrome or Edge and [Rust](https://rustup.rs) (stable). For the tests: [Deno](https://deno.com) (the
web UI's tests) and Node.js 22.12+ (the TypeScript that runs in the sandbox).

```sh
git clone https://github.com/joakimeriksson/devicedock && cd devicedock
./devicedock.sh        # builds the Rust backend, downloads a sandbox image, starts everything
```

The web UI (`apps/web`) has no build step: edit a file and reload the page (the backend serves `./apps/web` from
disk). `rb` in the console restarts the backend after a Rust change, and `i` builds the sandbox image from
`sandbox/Dockerfile` (`DEVICEDOCK_VARIANT=base` is the quickest).

## Where things are

| Path | What |
| --- | --- |
| `server-rs/` | DeviceDock in Rust. On the host: web server, device broker, terminals, sandbox lifecycle, firewall, shared folders. In the sandbox: the bridge service (RFC 2217 and OpenOCD endpoints), the `device` CLI, the MCP server, the tunnel |
| `apps/web/` | The page (plain JavaScript modules: Preact + htm, xterm.js, vendored): device sharing, terminals, Network and Shared folders panels |
| `sandbox/` | The sandbox image (`Dockerfile`, variants base/contiki/esp32/full), helper scripts, `AGENTS.md` for agents |
| `tests/` | Deno tests of the page (`tests/web`) and browser tests (`tests/browser`), the pyserial RFC 2217 suite (`tests/rfc2217/run.sh`). The Rust tests, including black-box tests of the binary, are in `server-rs/` |
| `docs/` | The project web page (GitHub Pages) |

[ARCHITECTURE.md](ARCHITECTURE.md) explains the layers and how to add a new kind of device or simulator.

## Test before you send

```sh
./devicedock.sh test        # cargo test (with the black-box tests of the binary) and deno test
deno test --allow-all tests/browser/   # the page in headless Chrome, against a backend of its own
IMAGE=devicedock-sandbox:local tests/rfc2217/run.sh   # real pyserial against the bridge, after changing it
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
- Keep the style of the code around you (Rust lines run to about 120 columns; the crate is not `cargo fmt` clean, so do not reformat whole files). `cargo clippy` must stay clean.
- By contributing you agree that your work is released under the [BSD-3-Clause license](LICENSE).
