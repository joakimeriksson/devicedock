#!/opt/venv/bin/python3
"""`esptool` with a DeviceDock check first, installed over the venv's esptool entry points.

esptool resets an ESP32 into download mode by toggling DTR/RTS several times within a fraction of a second. On a real
board shared through DeviceDock every toggle is a hardware write that waits for the human's approval click, unless
the device is in autonomous mode. Then the reset never happens in time and esptool fails after ~30 s with a misleading
"connection failed (reader thread died)". This check says what is wrong and what to do, before esptool starts.
Set DEVICEDOCK_SKIP_CHECK=1 to run esptool directly.
"""
import json
import os
import re
import subprocess
import sys


def port_from(argv):
    for i, a in enumerate(argv):
        if a in ("-p", "--port") and i + 1 < len(argv):
            return argv[i + 1]
        if a.startswith("--port="):
            return a.split("=", 1)[1]
    return os.environ.get("ESPTOOL_PORT")


def stop(msg):
    print(msg, file=sys.stderr)
    sys.exit(2)


def check(url):
    m = re.match(r"rfc2217://(?:127\.0\.0\.1|localhost):(\d+)", url or "")
    if not m or os.environ.get("DEVICEDOCK_SKIP_CHECK") == "1":
        return
    try:
        out = subprocess.run(["device", "list"], capture_output=True, text=True, timeout=20)
        devices = json.loads(out.stdout)
    except Exception:
        return  # the check is a convenience; never block esptool because it failed
    port = m.group(1)
    dev = next((d for d in devices if re.fullmatch(rf"rfc2217://127\.0\.0\.1:{port}", d.get("rfc2217", ""))), None)
    if dev is None:
        stop(
            f"DeviceDock: no device is shared on port {port}.\n"
            "Ask the human to click 'Add serial port' and then 'Open & share' in the DeviceDock page, and take the\n"
            "rfc2217 URL from `device list`."
        )
    if dev.get("kind") == "serial" and not dev.get("autonomous"):
        stop(
            f"DeviceDock: '{dev.get('name')}' is a real board without autonomous mode, so esptool cannot reset it.\n"
            "esptool enters the bootloader by toggling DTR/RTS many times in under a second; each toggle on real\n"
            "hardware waits for an approval click, so the reset never happens and esptool would fail after ~30 s\n"
            "with 'connection failed (reader thread died)'.\n"
            "Ask the human to click 'Autonomous 15 min' on this device in the DeviceDock page, then run the same\n"
            "command again. (DEVICEDOCK_SKIP_CHECK=1 skips this check.)"
        )


check(port_from(sys.argv[1:]))
os.execv(sys.executable, [sys.executable, "-m", "esptool", *sys.argv[1:]])
