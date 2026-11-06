# DeviceDock

A local browser workspace that connects an isolated Linux coding sandbox to browser-owned serial ports. React and xterm.js provide two real Docker terminals; WebSerial and a browser mock share one device protocol, lease manager, and human approval path.

**Status: implementation under verification.** The user has installed dependencies and successfully built the Docker image. Strict typechecking, the production frontend build, and 14 unit/in-process tests pass with the installed dependencies. The first-container startup bug is fixed. This task's execution sandbox still blocks Docker access and localhost listeners, so container startup and the browser-to-container demonstration need verification from the normal Mac terminal. See [VERIFICATION.md](VERIFICATION.md).

## Setup on the Mac

Prerequisites: Node 22.12+ (Node 24 LTS recommended), npm, Python and Xcode Command Line Tools for node-pty, a working Docker engine (including Colima), and Chrome or Edge for physical serial devices. No global npm installs are required. The current Mac has Node 26 and Codex 0.167.0; the Mac login is not copied into the container.

Run from this directory in a terminal with network, loopback, and Docker permissions:

```sh
npm install
npm run typecheck
npm run build
npm test
npm run sandbox:build
npm run sandbox:start
npm start
```

`package-lock.json` is now present following installation. Retain it in version control and use `npm ci` for repeatable installs. The Docker build uses that lockfile.

In a second terminal, from the same directory:

```sh
npm run open
```

This opens a one-time session URL on `http://127.0.0.1:47831`. Its fragment is removed immediately, exchanged for an HttpOnly SameSite=Strict session cookie, and never logged. Use this exact host, not `localhost`. The URL is stored locally in `.runtime/session-link` with mode 0600. An already authenticated browser can reload normally. Restart the backend to create a new bootstrap link if needed.

`npm run dev` restarts the backend when its source changes. Run `npm run build` after frontend changes; the backend serves the production frontend from the same origin. Set `PORT` to change the browser port; the container bridge uses fixed loopback port 47832.

## Verify the real container path

1. Add a mock in the browser. It starts **Private**. Leave “Automatic test approval” selected, then click **Open & share**.
2. In the Linux workspace terminal run:

   ```sh
   uname -a
   id
   echo 'created inside Linux' > /workspace/proof.txt
   device list
   /opt/devicedock/node_modules/.bin/tsx /opt/devicedock/sandbox/examples/ping.ts
   ```

3. The example must print `PONG` and confirm binary bytes `00 ff 80 01 0d 0a`. The browser monitor should show TX and RX.
4. Click **Revoke access**. `device list` should no longer show the device. Commands using its old descriptor/lease must fail.
5. Share again, simulate unplug, and share once more. Each sharing creates a new generation and requires a new lease.
6. The agent terminal launches the actual Linux `codex` binary. Until login succeeds it may display authentication/setup prompts; this is not an authenticated agent response.

A UI-only mock test is available with `npm run test:browser` (installed Chrome required). This test does **not** demonstrate the Docker path; perform the steps above separately.

## Agent login callback relay status

Codex web login on the Mac successfully opened a local OAuth callback at `http://127.0.0.1:1455/auth/callback`. That proves the host Codex flow works. It does not route that callback into the isolated container. The container callback relay is **planned, not implemented or verified**. Starting a relay must be explicit, and it must refuse to bind when the Mac Codex login already owns port 1455. See the current objective in [PLAN.md](PLAN.md).

Claude Code and OpenCode login discovery/compatibility are also pending. Their callbacks and credential storage must be checked separately; do not assume they can use the Codex relay.

## Agent authentication and MCP

From the Linux workspace terminal:

```sh
codex login status
codex mcp add devicedock -- /opt/devicedock/node_modules/.bin/tsx /opt/devicedock/packages/mcp-server/index.ts
```

Codex web login callback forwarding into this container is not implemented yet. Do not treat a Mac login as a container login. Restart the agent terminal after configuration. Credentials stay inside the dedicated `devicedock-home` Docker volume. Host authentication files and the Docker socket are never mounted into the sandbox.

The stdio MCP server exposes discovery, acquisition/release, connect/disconnect, read/write, configure, and signal tools. MCP and CLI requests use the same SDK and backend authorization path. There is no HTTP MCP listener. MCP tools return explicit errors for missing leases and denied approvals.

## Device use

**Add serial port** invokes the browser's chooser only on your click. **Granted ports** discovers previously authorized ports without opening them. Opening and sharing a physical port asks you to acknowledge that serial bytes may change hardware state. Every agent-originated physical operation—including writes, configuration, signals, and disconnect—then requires a separate human approval.

Only use known safe commands for an identified board. The bridge does not classify arbitrary serial bytes as safe or detect firmware flashing. Unsupported flashing protocol operations are rejected.

The UI offers baud changes, text/hex input, a text/hex monitor, DTR/RTS high and low controls, revocation, and explicit close. The SDK/MCP also accept parity, data/stop bits, hardware flow control, and break signals. Device support for settings and signal changes varies. The mock supports deterministic echo, `PING` → `PONG`, five-second telemetry, latency, injected errors, unplug, baud configuration, and signal state.

```sh
# Inside the container:
device list
device connect DEVICE_ID --baud 115200
device send DEVICE_ID --text 'PING'
device send DEVICE_ID --hex '50 49 4e 47 0a'
device signals DEVICE_ID --dtr false --rts false
device monitor DEVICE_ID
device disconnect DEVICE_ID
```

Each CLI command acquires and releases its own exclusive lease. A monitor currently holds that lease; another command cannot write concurrently. Use `DeviceClient.using()` for programs that need to send and receive in one lease. Reads consume only the active lease's bounded queue; the independent browser monitor never steals program bytes. Empty reads return immediately; clients may poll. A lease expires after 30 seconds idle, and accepted operations renew it. There is no automatic retry of writes.

## Architecture and boundaries

```text
Browser adapter ↔ authenticated browser WebSocket ↔ Mac broker
                                                      ↕ outbound WebSocket
                              Docker loopback :47832 bridge service
                                                      ↕ authenticated HTTP
                                    container SDK / CLI / stdio MCP
```

The Docker bridge listens inside the container and is published only to Mac loopback. The Mac connects outward, so this works without depending on `host.docker.internal`. The bridge exposes only the fixed device protocol, never host command execution. Terminals launch fixed `docker exec -it` commands using node-pty; keyboard input is written only into those PTYs.

Docker uses UID 1000, dropped capabilities, no-new-privileges, a read-only root, a limited `/tmp`, 2 CPUs, 2 GiB memory, a 256-process limit, and separate workspace/home volumes. Network access remains available inside the container for coding and agent services. No host USB device access or privileged mode is used.

The device broker caps messages at 64 KiB, serial chunks at 16 KiB, the receive queue at 64 KiB per lease, devices at 32, pending operations at 64, browser WebSockets at eight, and monitor history at 150 entries. PTY scrollback is bounded, with a 30-second process retention window after disconnect. Device sharing is revoked immediately when the owning browser WebSocket disconnects and is never silently restored.

## Shutdown and credential removal

Stop the Node backend with Ctrl-C, then:

```sh
npm run sandbox:stop
```

Workspace and credentials persist. `npm run sandbox:clean` removes only the managed container, preserving both volumes. To log out:

```sh
docker exec -it devicedock-sandbox codex logout
```

To deliberately erase stored agent credentials and the container home, first remove the container, then run `docker volume rm devicedock-home`. To deliberately erase project files, separately remove `devicedock-workspace`. These are destructive commands; startup and ordinary cleanup never execute them.

## Troubleshooting and limitations

- **Colima socket permission denied:** access is blocked for the calling process. This does not prove Colima is stopped. Check `docker info` in your normal terminal before changing runtime configuration.
- **Registry DNS failure:** `npm install` requires registry access; an incomplete local cache cannot provide a clean installation.
- **Loopback EPERM:** the calling execution sandbox does not allow listening. Run from an environment permitted to bind localhost.
- **Agent unavailable:** build/start the image, inspect `docker logs devicedock-sandbox`, and run `codex --version` inside it. CLI installation is separate from authentication.
- **Port already open:** close other serial monitors/tabs. Browser/OS port ownership prevents simultaneous opens. USB vendor/product IDs are labels, never physical identity keys.
- **Timeout:** do not retry a write automatically. Hardware may already have received it; inspect its state first.
- **Revocation:** stops new operations and rejects pending replies; it cannot undo bytes already handed to the browser/OS or device.
- **Browser reload:** devices become private; grant/expose again. Terminals reconnect automatically, preserving processes for up to 30 seconds. Use Restart for exited sessions.
- **WebUSB/WebHID:** future transport-specific adapters. Raw USB transfers and HID reports require separate schemas and are not treated as serial.

See [SECURITY.md](SECURITY.md) for threat boundaries and [PLAN.md](PLAN.md) for the original acceptance criteria.
