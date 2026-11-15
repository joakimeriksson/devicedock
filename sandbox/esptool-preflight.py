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
import shutil
import signal
import subprocess
import sys
import time


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


def utf16_len(s):
    return len(s.encode("utf-16-le")) // 2


def open_session(dev, words):
    """Asks the human for a flash session. True if this call opened it (and must close it), False if one was open."""
    purpose = " ".join(words)
    if utf16_len(purpose) > 200:  # the protocol counts UTF-16 units
        while utf16_len(purpose) > 199:
            purpose = purpose[:-1]
        purpose += "…"
    print(f"DeviceDock: asking the human to allow this flash of '{dev.get('name')}' in the page...", file=sys.stderr)
    for attempt in range(4):
        r = subprocess.run(["device", "flash-open", dev["id"], "--purpose", purpose], capture_output=True, text=True)
        why = (r.stderr or r.stdout).strip().splitlines()
        # The previous tool's connection can hold the board for a few seconds after it exits.
        if r.returncode != 0 and why and "already leased" in why[-1] and attempt < 3:
            time.sleep(3)
            continue
        break
    if r.returncode != 0:
        reason = why[-1] if why else "no answer"
        if "already leased" in reason:
            stop(
                f"DeviceDock: '{dev.get('name')}' is in use by another client (a running `device monitor`, esptool or\n"
                "pyserial). Stop it, then run the same command again."
            )
        stop(
            f"DeviceDock: the flash was not allowed ({reason}).\n"
            f"{words[0]} resets the board with DTR/RTS, and on real hardware that needs the human's OK. Tell the human,\n"
            "and ask them to click Allow when the request appears (or 'Autonomous 15 min' on the device); then run the\n"
            "same command again once. Do not retry in a loop. (DEVICEDOCK_SKIP_CHECK=1 skips this step.)"
        )
    return "opened" in r.stdout


def close_session(dev):
    for attempt in range(3):
        if subprocess.run(["device", "flash-close", dev["id"]], capture_output=True).returncode == 0:
            return
        time.sleep(1)
    print(
        "DeviceDock: could not close the flash session; it ends by itself after 2 idle minutes, or the human can\n"
        "click Cut off in the page.",
        file=sys.stderr,
    )


class Terminated(Exception):
    pass


def stop_on_sigterm(*_):
    # An agent's tool timeout sends SIGTERM: leave through `finally`, so the session is closed.
    raise Terminated()


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
if words is cmd and shutil.which(cmd[0]) is None:
    # Before asking the human anything.
    stop(f"{cmd[0]}: command not found" + (" (run get_idf first)" if cmd[0] == "idf.py" else ""))
dev = device_for(url)
if dev is None:
    os.execvp(cmd[0], cmd)
signal.signal(signal.SIGTERM, stop_on_sigterm)
opened = asking = False
child = None
code = 1
try:
    asking = True
    opened = open_session(dev, words)
    asking = False
    child = subprocess.Popen(cmd)
    code = child.wait()
    if code < 0:  # killed by a signal: report it the way a shell does
        code = 128 - code
except (KeyboardInterrupt, Terminated) as e:
    code = 143 if isinstance(e, Terminated) else 130
    # Interrupted while the human was still being asked: close too, in case they click Allow late.
    if asking:
        close_session(dev)
finally:
    if child is not None and child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
    # The session covered this one command; one that was already open belongs to whoever opened it.
    if opened:
        close_session(dev)
sys.exit(code)
