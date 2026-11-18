#!/bin/sh
# Real-pyserial checks of the RFC 2217 server in `devicedock bridge`, each in a throwaway container from the sandbox
# image (no network; only this folder is mounted, read-only). fake_backend.py stands in for the backend: it dials the
# bridge like the real one and answers for two in-memory devices.
# Scenario 1: normal use. Scenario 2: one port per device, physical first. Scenario 3: a second client replaces a live
# one. Scenario 4: same, but the first session's lease release fails (stale lease), as after a session stuck on
# approvals. Scenario 5: DTR/RTS pairs are applied atomically.
# IMAGE=devicedock-sandbox:<tag> tests another image (default devicedock-sandbox:local).
set -e
cd "$(dirname "$0")"
IMAGE="${IMAGE:-devicedock-sandbox:local}"
START='umask 077; head -c 32 /dev/urandom | od -An -tx1 | tr -d " \n" > /home/node/.bridge-token
  /opt/devicedock/bin/devicedock bridge > /tmp/bridge.log 2>&1 &
  python3 /tests/fake_backend.py > /tmp/dev.log 2>&1 &
  for i in $(seq 1 50); do grep -q READY /tmp/dev.log 2>/dev/null && break; sleep 0.2; done
  fail() { echo "--- bridge log"; cat /tmp/bridge.log; echo "--- backend log"; cat /tmp/dev.log; exit 1; }'
run() {
  docker run --rm --network none --entrypoint sh -e FAIL_FIRST_RELEASE="$2" -v "$PWD:/tests:ro" "$IMAGE" -c "$START
  python /tests/$1 || fail"
}
run test.py 0
run test_multi.py 0
run test_replace.py 0
run test_replace.py 1
# esptool's bootloader entry changes DTR and RTS back to back; after the session started, every DTR/RTS change must
# reach the port as one serial.signals operation carrying both lines.
docker run --rm --network none --entrypoint sh -v "$PWD:/tests:ro" "$IMAGE" -c "$START"'
  python /tests/test_atomic.py >/dev/null || fail
  sleep 0.5
  ops=$(grep "^OP [a-z-]* serial.signals" /tmp/dev.log || true)
  both=$(echo "$ops" | grep -c "dataTerminalReady.*requestToSend" || true)
  if [ "$both" -gt 0 ]; then
    echo "ATOMIC OK: $both combined signal ops, $(echo "$ops" | grep -vc "dataTerminalReady.*requestToSend" || true) single-line ops"
  else echo "ATOMIC FAIL: DTR and RTS applied separately"; echo "$ops"; fail; fi
'
