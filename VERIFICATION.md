# Verification record — 2026-11-06

## Follow-up after user installation

- User reports successful dependency installation and Docker image build.
- `package-lock.json` is present.
- `npm run typecheck`: passed with installed dependencies.
- `npm run build`: passed with installed Vite 7.3.7; non-fatal bundle-size warning.
- `node --import tsx --test tests/unit/*.test.ts`: 14 passed, 0 failed.
- Fixed first startup by querying Docker's exact-name container listing instead of parsing case-sensitive `docker inspect` errors. Regression tests cover missing/existing containers and permission-error propagation.
- Container startup and browser integration remain unverified here because execution permissions still restrict sockets. The older record below describes the initial implementation pass.

---

## Historical initial-environment findings

The initial task sandbox could not access Colima, while the user later successfully installed dependencies and built and started the sandbox from Mac Terminal. Do not use the initial blocked results below as current user-machine status.


- Mac arm64; Node v26.0.0; npm 11.12.1.
- Chrome and Edge installed.
- Docker CLI 29.6.1, active context `colima`.
- Docker daemon query failed with permission denied on `~/.colima/default/docker.sock`. Daemon running/stopped status is **unknown**.
- Mac Codex CLI 0.167.0 reports logged in with ChatGPT. No authentication file contents were read or copied.
- Serial metadata listed Bluetooth/JBL/debug console endpoints. No identified development board was opened or written to.

## Initial implementation checks (historical)

Eleven Node test cases passed:

1. Invalid base64, oversized payloads, and unsupported flashing rejection.
2. Binary preservation and consumptive lease reads.
3. Exclusive client leases, foreign-client rejection, and lease expiry.
4. Physical-operation approval, owner binding, denial, and replay prevention.
5. Revocation while pending, stale generation rejection, and invalidated approval.
6. Operation timeout and expired approval rejection without write replay.
7. Explicit receive overflow and stale-generation input rejection.
8. Rejection of physical-device automatic approval.
9. MCP discovery and write requests use SDK leases and human approval enforcement.
10. In-process SDK → broker → browser MockAdapter PING/PONG, binary exchange, and post-revocation failure.
11. Approval expiration when its lease expires.

The tests ran with Node's test runner and a pre-existing local tsx loader because registry installation was unavailable. Root dependencies were temporarily linked read-only to existing local installations. The SDK/mock test substitutes fetch with an in-process broker dispatch; the MCP test uses the actual MCP SDK's linked in-memory transports. These tests do not prove network or Docker transport.

The React frontend production build also passed with cached Vite. Build output is in `dist/`. Vite reported a non-fatal bundle-size warning (approximately 553 kB minified main JavaScript, 150 kB gzip). No browser screenshot or rendered interaction was verified.

Cached validation package versions: Zod 3.24.2, React/React DOM 18.3.1, Vite 8.2.2, MCP SDK 1.29.0, Express 4.21.2, ws 8.18.1, xterm 6.0.0, fit addon 0.11.0. Some differ from the intended package.json ranges. Repeat all checks after the clean install; this is **not** verification of a pinned release dependency set. Temporary validation symlinks were removed after the checks.

## Still pending after the user started the sandbox

| Check | Actual result |
| --- | --- |
| Clean npm installation / lockfile | Registry DNS failed; offline install failed because required packages were not cached. No lockfile generated. |
| Full strict typecheck | Blocked by missing node-pty, Express/ws/WebSerial type packages, and Playwright. A partial check found and corrected code issues but is not a passing full check. |
| HTTP/WebSocket integration test | Failed to start with `listen EPERM` on 127.0.0.1:47951. Authentication assertions did not execute. |
| Production localhost server | Independent bind probe failed with `listen EPERM` on 127.0.0.1:47831. |
| Docker image / Linux terminals | Socket denied; escalation request rejected by the permission policy. No image built or container started. |
| Browser mock test | Not run; server could not listen and Playwright dependency was unavailable. |
| Real browser → container demonstration | Not run. |
| Linux Codex launch / login / response | Not run. Mac login does not establish container login. |
| Physical WebSerial board | Not run; no board was selected or touched. |

## Next verification pass

Use a terminal/task environment with npm registry, loopback listener, and Colima socket access:

```sh
npm install
npm run typecheck
npm run build
npm test
npm run test:browser
npm run sandbox:build
npm run sandbox:start
npm start
# In another terminal:
npm run open
```

Retain the generated lockfile, resolve any clean-install/typecheck failures, and perform the real container walkthrough in README.md. Record Linux `uname`, PING/PONG, binary preservation, post-revocation failure, reconnect/fresh lease, and actual Codex CLI startup separately. Physical-board tests require the human's chooser selection and a known safe board-specific interaction.

## Login callback work in progress

The user completed Mac Codex web login. Its observed callback is `http://127.0.0.1:1455/auth/callback`. The Docker callback relay is not implemented; Mac localhost does not automatically route to container localhost. Explicit opt-in, port ownership checks, request filtering, redacted logs, completion timeout, and container-only credential storage are requirements in PLAN.md. Claude Code and OpenCode authentication flows are not yet discovered or tested.
