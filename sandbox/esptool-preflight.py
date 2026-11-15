#!/opt/venv/bin/python3
"""`esptool` with DeviceDock's approval step first, installed over the venv's esptool entry points, and
`devicedock-flash <command...>`, the same step around any flashing command (profile-idf.sh routes `idf.py ... flash`
through it, since idf.py runs its own esptool).

esptool resets an ESP32 into download mode by toggling DTR/RTS several times within a fraction of a second. On a real
board shared through DeviceDock every toggle is a hardware write that waits for the human's approval click. Clicking
each one is impossible, and esptool would fail after ~30 s with a misleading "connection failed (reader thread died)".
So before esptool starts on a real board, this asks the human ONCE for a flash session (`device flash-open`), shows
them the esptool command, runs esptool inside it, and closes the session afterwards. Nothing is asked in autonomous
mode, for simulators, or when a session is already open (then it is left open for whoever opened it).
Set DEVICEDOCK_SKIP_CHECK=1 to run esptool directly.
"""
import json
import os
import re
import subprocess
import sys


def port_from(argv):
    for i, a in enumerate(argv):
        if a in ("-p", "--port", "--upload-port") and i + 1 < len(argv):
            return argv[i + 1]
        if a.startswith(("--port=", "--upload-port=")):
            return a.split("=", 1)[1]
    return os.environ.get("ESPTOOL_PORT") or os.environ.get("ESPPORT")


def stop(msg):
    print(msg, file=sys.stderr)
    sys.exit(2)


def device_for(url):
    """The shared real board on this RFC 2217 URL that needs a flash session, or None."""
    m = re.match(r"rfc2217://(?:127\.0\.0\.1|localhost):(\d+)", url or "")
    if not m or os.environ.get("DEVICEDOCK_SKIP_CHECK") == "1":
        return None
    try:
        out = subprocess.run(["device", "list"], capture_output=True, text=True, timeout=20)
        devices = json.loads(out.stdout)
    except Exception:
        return None  # the check is a convenience; never block esptool because it failed
    port = m.group(1)
    dev = next((d for d in devices if re.fullmatch(rf"rfc2217://127\.0\.0\.1:{port}", d.get("rfc2217", ""))), None)
    if dev is None:
        stop(
            f"DeviceDock: no device is shared on port {port}.\n"
            "Ask the human to click 'Add serial port' and then 'Open & share' in the DeviceDock page, and take the\n"
            "rfc2217 URL from `device list`."
        )
    if dev.get("kind") != "serial" or dev.get("autonomous") or dev.get("flashSession"):
        return None
    return dev


def open_session(dev, words):
    purpose = " ".join(words)
    if len(purpose) > 200:
        purpose = purpose[:199] + "…"
    print(f"DeviceDock: asking the human to allow this flash of '{dev.get('name')}' in the page...", file=sys.stderr)
    r = subprocess.run(["device", "flash-open", dev["id"], "--purpose", purpose], capture_output=True, text=True)
    if r.returncode != 0:
        why = (r.stderr or r.stdout).strip().splitlines()
        stop(
            f"DeviceDock: the flash was not allowed ({why[-1] if why else 'no answer'}).\n"
            f"{words[0]} resets the board with DTR/RTS, and on real hardware that needs the human's OK. Tell the human,\n"
            "and ask them to click Allow when the request appears (or 'Autonomous 15 min' on the device); then run the\n"
            "same command again once. Do not retry in a loop. (DEVICEDOCK_SKIP_CHECK=1 skips this step.)"
        )


if os.path.basename(sys.argv[0]) == "devicedock-flash":
    cmd = sys.argv[1:]
    if not cmd:
        stop("Usage: devicedock-flash <command> [args...]: runs a flashing command inside one approved flash session.")
    words = cmd
else:
    cmd = [sys.executable, "-m", "esptool", *sys.argv[1:]]
    words = ["esptool", *sys.argv[1:]]
url = port_from(words[1:])
if words is cmd and not (url or "").startswith("rfc2217://") and os.environ.get("DEVICEDOCK_SKIP_CHECK") != "1":
    stop(
        "devicedock-flash: give the board's rfc2217 URL from `device list` (-p/--port, --upload-port, or ESPPORT),\n"
        "so it knows which board to ask the human about."
    )
dev = device_for(url)
if dev is None:
    os.execvp(cmd[0], cmd)
open_session(dev, words)
try:
    code = subprocess.call(cmd)
except KeyboardInterrupt:
    code = 130
except FileNotFoundError:
    print(f"{cmd[0]}: command not found" + (" (run get_idf first)" if cmd[0] == "idf.py" else ""), file=sys.stderr)
    code = 127
finally:
    # The session covered this one command.
    subprocess.run(["device", "flash-close", dev["id"]], capture_output=True)
sys.exit(code)
