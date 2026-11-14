# Security model

DeviceDock trusts the user, the Mac backend, and the browser application code. Container programs are allowed to request device operations, but are not trusted to choose whether a physical-device operation is approved. Other local OS processes with access to the user's files or Docker daemon are outside this isolation boundary.

## Authentication

The Mac HTTP server binds only to 127.0.0.1, checks an exact Host header, and does not enable CORS. Browser WebSockets require the exact Origin, an authenticated session cookie, and a CSRF subprotocol token. State-changing HTTP requests require the exact Origin and CSRF header. Bootstrap is single use; its fragment is removed before the exchange. Session cookies are HttpOnly and SameSite=Strict, expire after 12 hours, and are intentionally not Secure on plain loopback HTTP.

Container bridge authentication is separate from browser authentication. Its random token is written to a mode-0600 file through Docker exec stdin and stored in the non-root container home. The service validates protocol messages, body limits, deadlines, Host, and bearer authentication. It does not accept browser Origins. Neither URLs nor ordinary logs contain this token. Container clients can read the container token; it conveys device request capability, never browser approval capability.

## Ownership, authorization, and approval

Browser permission, opening a port, and exposing it are separate actions. A connection has an opaque UUID and generation, and one browser owner. Exposed physical devices cannot enable automatic approval. An agent request for writes, configuration, control/reset signals, connect, or disconnect enters a single-use approval state. Approval is bound to the exact request, device, generation, lease, owner, and deadline. Expired, denied, stale, or replayed approvals cannot dispatch operations.

UI operations also need an exclusive lease. They are direct user actions, so they do not produce a second approval dialog. Automatic mock approval requires an explicit checked control when sharing the mock. No flashing tool exists: arbitrary serial streams cannot reliably be classified as flashing or non-destructive.

Only one client lease may control a device at a time. A lease is an unguessable token, bound to the client ID and connection generation. The container is one trust domain; its processes share the same bridge token and can cooperate or impersonate client IDs if they also know the corresponding lease token. This is not per-process authentication inside the container.

Revocation, browser loss, and unplug reject outstanding operations and invalidate leases. Backend bridge loss invalidates associated client leases. Reconnect requires explicit sharing and a fresh lease. Pending operations that have already reached the OS/device cannot be rolled back. No write is replayed automatically.

## Resource limits and isolation

The protocol validates operations and arguments with Zod, restricts bytes to base64, caps payloads and pending operations, and bounds per-lease receive buffers. Overflow is reported as data loss. Terminal and monitor histories are bounded. Unknown operations, including flashing, are rejected.

Docker has no host device, home, credential, or Docker socket mounts. It runs non-root with dropped capabilities, no-new-privileges, resource limits, and a read-only root filesystem. The container has no network of its own (`--network none`); internet access goes only through the backend's firewall (the tunnel), to host names the human allowed, never to private or local addresses. Writable home/workspace volumes are intentionally available. A compromised Docker engine or a malicious process running as the Mac user is not contained by this application.

The Mac PTY layer uses fixed argument arrays. Browser input is never interpolated into host shell commands. The authenticated container bridge implements device RPC only, never host shell execution.

## Remaining assurance work

This initial implementation has not completed a clean install, full typecheck, HTTP/WebSocket runtime checks, Docker execution, browser QA, or physical-device QA in the restricted task environment. Do not treat unit-test success as a production security audit. Finish the checks in VERIFICATION.md before using real hardware. Credential backups, multi-user support, TLS beyond loopback, and adversarial resource-exhaustion testing are outside this MVP.

## Autonomous mode and the RFC 2217 port (deliberate deviation from the MVP rules)

The MVP plan required human approval for every agent-originated physical write and rejected firmware
flashing as ordinary serial access (PLAN.md rule 10, section 10). For the hardware-in-the-loop hackathon
workflow the owner chose to relax this, explicitly and with limits:

- **Opt-in per device, per session.** Sharing a device never enables it. The browser owner turns on
  *Autonomous* for 15 or 60 minutes (hard cap 2 hours, enforced by the broker). While it is on, agent
  operations on that device skip the approval dialog. It ends at expiry, on *Turn off*, on *Revoke access*,
  on unplug/reconnect, or when the browser tab closes. Only the browser that owns the device can change it.
- **Same bridge, same limits.** Leases, generations, payload and rate limits, and the exclusive lease are
  unchanged. The container still has no device node and no host access.
- **RFC 2217 server (`127.0.0.1:2217` inside the container only).** It is not published to the Mac.
  esptool, pyserial and PlatformIO use it, which makes automatic bootloader entry and flashing possible.
  Because arbitrary serial bytes cannot be classified, the bridge cannot tell flashing from other writes;
  autonomous mode therefore means the agent may flash the shared board. Do not enable it for a board with
  hardware attached that must not be disturbed.
- Approval is still the default and is still required whenever autonomous mode is off or expired.

## Renewing the browser login without a restart
`./devicedock.sh open` asks the running backend for a fresh one-time login link (`POST /admin/session-link`), so an
expired or used login never needs a restart. The endpoint is for the command line only: it refuses any request that
carries an `Origin` header, requires a bearer token from `.runtime/admin-token` (mode 0600, generated at startup,
**never given to the container**, unlike the bridge token), mints links valid for 5 minutes, and allows at most
5 unused links at once. Without the token file the endpoint is disabled.


## Reporting a security problem

Please report security problems privately through GitHub:
[Report a vulnerability](https://github.com/joakimeriksson/devicedock/security/advisories/new) (Security tab →
Report a vulnerability), not in a public issue. Describe what an attacker can do and how; a proof of concept helps.
You will get an answer within a week. Fixes are released as soon as they are ready, with credit if you want it.
