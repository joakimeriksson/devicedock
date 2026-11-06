#!/bin/sh
# Real-pyserial check of the RFC 2217 server, using a throwaway container from the sandbox image.
set -e
cd "$(dirname "$0")/../.."
docker run --rm --entrypoint sh -v "$PWD:/src:ro" devicedock-sandbox:local -c '
  /opt/devicedock/node_modules/.bin/tsx /src/tests/rfc2217/fake-device.ts > /tmp/dev.log 2>&1 &
  for i in 1 2 3 4 5 6 7 8 9 10; do grep -q READY /tmp/dev.log && break; sleep 1; done
  python /src/tests/rfc2217/test.py && echo "--- device saw:" && grep ^OP /tmp/dev.log
'
