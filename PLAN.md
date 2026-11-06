# Implementation plan: Browser USB Bridge for Coding Agents

## Current status — 2026-11-06

Implementation is in progress in this project. The user installed dependencies, built the first Docker image, and started the managed sandbox. The local web app serves HTTP 200. Typecheck and frontend build pass; 14 unit/in-process tests pass. Browser terminal startup has failed and is being debugged. Physical hardware has not been tested.

### Current objective: browser-based agent login

The user can authenticate the Mac Codex CLI with its normal web flow. The successful login displayed a local callback URL at `http://127.0.0.1:1455/auth/callback`. The same callback from a browser on the Mac cannot reach a listener isolated inside Docker without explicit forwarding.

Build an **opt-in local callback relay** for the container's Codex web login:

1. Keep the provider callback URL at `127.0.0.1:1455`; do not rewrite OAuth parameters or intercept a Mac login.
2. Only bind host port 1455 after the user explicitly starts a container Codex login relay. If another process owns the port, exit with a clear message and do not kill or proxy that process.
3. Forward only the OAuth callback request to the active container Codex login listener. Require a live, user-started login session; do not create an open localhost proxy.
4. Stop forwarding when the login finishes, is cancelled, or times out. Do not log callback query strings, authorization codes, tokens, cookies, or response bodies.
5. Do not copy Mac Codex credential files into Docker. Store successful container credentials only in the dedicated container home volume.
6. Rebuild and recreate the managed container only after documenting that container-local writable-layer data is lost; preserve the named workspace and home volumes.
7. Verify no relay versus active Mac login conflict, successful callback completion into Docker, successful `codex login status` inside the container, and relay shutdown. Do not claim support until verified.

Investigate Claude Code and OpenCode separately. Detect installed CLI names/versions and report their supported login methods, but do not assume they share Codex's port, OAuth callback path, token storage, or flow. Add provider-specific relays only after verifying their documented behavior. Device-code login is not available for this user's RISE account.

## 1. Objective

Build and run a functional local MVP on the user’s Mac that lets a coding agent inside an isolated Linux Docker container communicate with USB serial devices authorized by the user’s browser.

The browser page is the complete interactive workspace:

- A real Linux terminal using xterm.js and a WebSocket PTY.
- An interactive coding-agent terminal running a real CLI.
- A device panel for browser-granted WebSerial connections.
- A serial monitor, byte sender, baud-rate controls, and supported reset signals.
- Explicit human approval for potentially destructive device operations.
- Clear connection state, errors, and bounded activity logs.
- A browser-side mock device for verification without hardware.

Deliver runnable code, documentation, automated tests, and a verified end-to-end demonstration. Do not substitute simulated agent responses or a host shell for the requested container environment.

## 2. Findings from initial inspection

The Mac has:

- Node.js `v26.0.0`
- npm `11.12.1`
- Docker CLI
- An installed Codex CLI at `/Users/joakimeriksson/.local/bin/codex`
- An existing Colima Docker socket

Docker daemon access failed from the current restricted execution environment with a permission error. This does **not** establish whether the daemon is stopped. Verify authorized socket access before diagnosing or changing Docker.

The Codex version and login status have not yet been verified. No credential contents have been inspected.

At initial inspection, the task folder contained empty `work/` and `outputs/` directories. No application has been built or started yet.

## 3. Working rules for implementation agents

1. Inspect the environment and applicable `AGENTS.md` instructions first.
2. Create a fresh project directory; never overwrite existing work.
3. Prefer a project under the current writable workspace. If using `~/Projects/usb-agent-bridge`, check existence and obtain any required filesystem approval.
4. Install dependencies locally in the project or inside its Docker image.
5. Ask before global installations, Docker configuration changes, or other security-sensitive system changes.
6. Never mount the Docker socket, host credentials, home directory, or host `/dev` into the sandbox.
7. Never use privileged containers or automatic browser-permission bypasses.
8. Never print secrets or include them in browser storage, URLs, logs, or screenshots.
9. Keep working through implementation and verification; report precise blockers rather than claiming untested functionality.
10. Do not implement firmware flashing as an unrestricted raw command disguised as ordinary serial access.

## 4. Architecture

```text
Browser: localhost
  React application
  ├─ xterm.js: Linux shell
  ├─ xterm.js: coding-agent CLI
  ├─ device permission and approval UI
  └─ transport adapters
       ├─ WebSerial
       └─ mock serial device
             │
       authenticated WebSockets
             │
Local Node.js backend: loopback only
  ├─ browser session and origin validation
  ├─ terminal lifecycle and Docker exec PTYs
  ├─ device registry and exclusive leases
  ├─ device RPC router and approval enforcement
  └─ container bridge connection
             │
       Docker-managed loopback port
             │
Linux sandbox
  ├─ shell and coding-agent CLI
  ├─ device SDK and command-line client
  ├─ stdio MCP server
  └─ writable project workspace
```

Keep the Mac backend bound to `127.0.0.1`.

For container communication, run a small authenticated bridge service **inside the container**, publish its port to Mac loopback only, and have the backend connect outward to that port. Container-side device clients submit operations to this service, which relays them over the established connection.

This avoids depending on whether `host.docker.internal` can reach a loopback-only Mac listener under the user’s Docker runtime.

The container bridge is a fixed device protocol service, not a general host command executor.

## 5. Project structure

```text
usb-agent-bridge/
  apps/
    web/                 React, Vite, xterm.js, device adapters
    server/              Node HTTP, WebSockets, PTYs, Docker lifecycle
  packages/
    protocol/            Shared schemas and message types
    device-client/       TypeScript SDK and CLI
    mcp-server/          stdio MCP device tools
  sandbox/
    Dockerfile
    bridge-service/
    examples/
  tests/
    unit/
    integration/
    browser/
  README.md
  SECURITY.md
  package.json
  package-lock.json
```

Use TypeScript throughout. Validate incoming messages at every trust boundary using a shared schema library. Pin dependencies with a lockfile.

## 6. Phase A — Environment and runnable scaffold

### Tasks

- Check Node compatibility, package manager access, available ports, browser availability, Docker status, architecture, and installed agent CLI.
- Confirm whether Chrome or Edge is available for WebSerial testing.
- Inspect USB/serial device metadata without opening devices.
- Verify Codex version and authentication status without reading or displaying secrets.
- Create the workspace and React/Vite/Node scaffold.
- Add scripts for development, build, type checking, tests, sandbox startup, and cleanup.
- Serve the production frontend from the same backend origin.

### Acceptance

- The page loads on localhost.
- Backend health reports actual Docker and agent availability.
- Unsupported browser capabilities are clearly identified.
- Failed prerequisites produce actionable errors rather than fake success.

## 7. Phase B — Linux sandbox and terminals

### Tasks

Build a Linux image containing:

- A shell, Git, Python, Node.js, and basic development tools.
- A Linux-compatible coding-agent CLI.
- The device bridge service, SDK, and examples.

Run it with:

- A non-root user.
- Dropped Linux capabilities.
- `no-new-privileges`.
- CPU, memory, and process limits.
- No host device access.
- A dedicated workspace volume.
- A writable home limited to the container.

Provide two terminal sessions: shell and agent. Use a host PTY to launch fixed `docker exec -it` commands. Browser input must only reach the selected container process; never interpolate it into host shell commands.

Support terminal resizing, bounded scrollback, disconnection notices, and explicit session restart. Preserve terminal processes across short browser reconnects using a bounded reconnect window.

### Credentials

Use the provider-specific login flow inside the container and keep credentials in a dedicated container volume. For Codex web login, implement and verify the explicit callback relay above. Device-code login is unavailable for this user. Offer a documented logout/removal procedure.

Do not silently copy the Mac’s Codex authentication files. The installed Mac binary also cannot simply be assumed to run inside Linux.

### Acceptance

- `uname -a` in the browser proves Linux execution.
- Files created in the terminal appear in the sandbox workspace.
- The agent terminal starts a real CLI.
- Unauthenticated state is explicit.
- A real authenticated response is verified only if login is available; otherwise record the remaining human login step.

## 8. Phase C — Browser devices and mock adapter

Define a transport-neutral interface:

```ts
interface DeviceAdapter {
  listGranted(): Promise<DeviceDescriptor[]>;
  requestDevice(): Promise<DeviceDescriptor>;
  open(id: string, options: SerialOptions): Promise<void>;
  close(id: string): Promise<void>;
  write(id: string, bytes: Uint8Array): Promise<void>;
  setSignals(id: string, signals: SignalOptions): Promise<void>;
  subscribe(id: string, handler: DeviceEventHandler): () => void;
}
```

### WebSerial implementation

- Invoke `requestPort()` only from a direct human click.
- Discover previously granted ports with `getPorts()`.
- Open and close ports with reliable reader/writer lock cleanup.
- Support configurable baud rate and supported serial settings.
- Show UTF-8 and hexadecimal monitoring.
- Accept text and validated hexadecimal input.
- Expose supported DTR/RTS controls with clear effects.
- Handle unplug, stream failure, tab closure, and browser reconnect.

Use opaque session device IDs. Do not treat vendor/product IDs as unique physical identifiers.

### Mock implementation

Run the mock in the browser through the same adapter interface and relay path as hardware.

Provide:

- Deterministic echo behavior.
- A `PING` → `PONG` response.
- Periodic telemetry.
- Simulated unplug/reconnect.
- Configurable latency and errors.
- Observable baud-rate and signal state.

### Acceptance

The container cannot access a mock or physical device unless the browser owner explicitly exposes it.

## 9. Phase D — Device protocol and exclusive access

Every request carries:

- Protocol version.
- Request ID.
- Device ID and connection generation.
- Operation and validated arguments.
- Deadline.
- Lease identifier where required.

Initial operations:

```text
devices.list
serial.connect
serial.disconnect
serial.acquire
serial.release
serial.read
serial.write
serial.configure
serial.signals
```

Encode bytes as validated base64 in JSON for the MVP. Apply payload limits, bounded buffers, operation timeouts, and explicit overflow errors.

### Ownership

- One browser tab owns a physical port.
- One active client lease controls writes and configuration.
- Monitor subscribers may observe the stream.
- UI writes and container writes use the same lease enforcement.
- Revocation immediately blocks new operations.
- Disconnect invalidates leases and outstanding approvals.
- Reconnection creates a new connection generation.
- Never replay writes automatically after a timeout or reconnect.

Define whether `read` consumes a per-lease queue; keep monitor broadcasting separate so monitoring does not steal bytes from programs.

### Acceptance

Two competing clients cannot interleave writes. Stale leases and replies are rejected, and unplugged devices fail pending requests promptly.

## 10. Phase E — Security and destructive operations

Protect localhost services with:

- Exact Host and browser Origin validation.
- Authenticated browser sessions.
- WebSocket authentication and origin checks.
- CSRF protection for state changes.
- Separate browser and container credentials.
- No permissive CORS.
- Limits on connections, message sizes, pending requests, and logs.

Bootstrap browser access using a one-time local session link or equivalent mechanism. Remove bootstrap secrets from browser history immediately and exchange them for a protected session cookie.

### Device approval policy

Browser permission to access a serial port is separate from permission to let an agent operate it.

Before sharing a physical device, explain that arbitrary serial bytes may change hardware state. For the MVP, require human approval for agent-originated physical-device writes and reset/configuration operations. The mock may be explicitly placed in automatic test mode.

Do not claim that the bridge can reliably identify flashing from arbitrary byte streams.

A future flashing tool must request a separate, single-use approval bound to:

- Device and connection generation.
- Firmware digest.
- Exact operation parameters.
- Expiration time.

The MVP should reject unsupported flashing operations instead of presenting a nonfunctional approval button.

## 11. Phase F — SDK, CLI, and MCP tools

Provide a TypeScript client and a CLI with commands such as:

```text
device list
device connect <id> --baud 115200
device monitor <id>
device send <id> --text "PING\n"
device send <id> --hex "50 49 4e 47 0a"
device signals <id> --dtr false --rts false
device disconnect <id>
```

Add a runnable container example that discovers the mock device, acquires a lease, sends `PING`, reads `PONG`, and releases the lease.

Implement an MVP **stdio MCP server inside the container** with tools for discovery, connection, reading, writing, configuration, and signals. Use the same SDK, leases, approvals, and validation as every other client.

An HTTP MCP endpoint is optional. Do not add another exposed service unless required.

Document WebUSB and WebHID as future adapters with explicit capability schemas. Raw USB transfers and HID reports need transport-specific operations; do not imply that every device can be modeled as serial.

## 12. Phase G — Verification

### Automated tests

Cover:

- Invalid protocol messages and oversized payloads.
- Authentication and Origin rejection.
- Exclusive leases and lease expiry.
- Approval denial, expiry, and replay prevention.
- Revocation during pending operations.
- Device unplug and reconnect generation changes.
- Request timeout and buffer overflow.
- Binary byte preservation.
- MCP tools using the shared authorization path.

### End-to-end mock demonstration

1. Start the backend and real Docker container.
2. Open the actual browser app.
3. Add and expose the browser mock device.
4. Verify Linux execution in the terminal.
5. Run the container example.
6. Observe `PING` in the browser monitor and `PONG` in the container.
7. Test binary data.
8. Revoke access and verify that subsequent writes fail.
9. Simulate reconnect and require a fresh lease.
10. Verify that the agent terminal launches the actual CLI.

Browser test automation may exercise the mock. It must not bypass real hardware permission prompts.

### Physical-device demonstration

If a compatible board is connected, ask the human to click the browser selector and choose it. Use a known safe interaction appropriate to that board. Do not send arbitrary test bytes or reset signals to unidentified hardware.

Record separately what was verified with real hardware, with the mock, and what remains unverified.

## 13. Deliverables and completion criteria

Deliver:

- The complete local project and dependency lockfile.
- Working startup and shutdown commands.
- Docker image definition and constrained container configuration.
- Browser shell, real agent terminal, and serial device panel.
- Browser-to-container mock demonstration.
- Device SDK, CLI, examples, and MCP server.
- README with setup, architecture, credentials, troubleshooting, and limitations.
- Security documentation describing permission and approval boundaries.
- Automated test results and concise verification evidence.

The MVP is complete when a user can launch the app, interact with a real Linux shell, start a real coding-agent CLI, explicitly expose a browser device, exchange bytes from container code, revoke access, and see failures clearly.

Physical-board support and authenticated agent responses must be reported according to what was actually tested. A mock demonstration proves the application’s bridge path; it does not prove compatibility with every USB board or firmware tool.
