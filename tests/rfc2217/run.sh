#!/bin/sh
# Real-pyserial checks of the RFC 2217 server, using a throwaway container from the sandbox image.
# Scenario 1: normal use. Scenario 2: a second client replaces a live one. Scenario 3: same, but the
# first session's lease release fails (stale lease), as after a session stuck on approvals.
set -e
cd "$(dirname "$0")/../.."
run() {
docker run --rm --entrypoint sh -e FAIL_FIRST_RELEASE="$2" -v "$PWD:/src:ro" devicedock-sandbox:local -c '
  /opt/devicedock/node_modules/.bin/tsx /src/tests/rfc2217/fake-device.ts > /tmp/dev.log 2>&1 &
  for i in 1 2 3 4 5 6 7 8 9 10; do [ -f /tmp/dev.log ] && grep -q READY /tmp/dev.log && break; sleep 1; done
  python /src/tests/rfc2217/'"$1"'
'
}
run test.py 0
run test_replace.py 0
run test_replace.py 1
