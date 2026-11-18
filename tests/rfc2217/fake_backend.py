"""A stand-in for the DeviceDock backend, for the RFC 2217 tests (run.sh): it dials the bridge service's WebSocket
like the real backend does and answers its requests for two in-memory devices. So the tests drive the whole sandbox
side (`devicedock bridge`, its RFC 2217 servers and device client) with real pyserial.

The two devices are listed with the SIMULATOR FIRST, to prove port order is physical-first, not share order.
Operations other than acquire/release/read/write are logged as `OP <device> <op> <args>` (run.sh checks them).
FAIL_FIRST_RELEASE=1 makes the first release on the serial device fail ("busy"), leaving a stale lease like a session
killed while an approval was pending. Standard library only.
"""
import base64
import json
import os
import socket
import struct
import sys
import time
import uuid

PORT = int(os.environ.get("DEVICEDOCK_BRIDGE_PORT", "47832"))
TOKEN_FILE = os.environ.get("DEVICEDOCK_BRIDGE_TOKEN_FILE", "/home/node/.bridge-token")


def device(id, name, kind, reply):
    return {"dev": {"id": id, "generation": 1, "name": name, "kind": kind, "baudRate": 115200},
            "reply": reply, "rx": b"", "lease": None, "ping": ""}


sim = device("22222222-2222-4222-8222-222222222222", "fake-sim", "sim", b"SIM-PONG\n")
serial = device("11111111-1111-4111-8111-111111111111", "fake-serial", "serial", b"PONG\n")
states = {sim["dev"]["id"]: sim, serial["dev"]["id"]: serial}
fail_release = os.environ.get("FAIL_FIRST_RELEASE") == "1"


def answer(req):
    global fail_release
    op, args = req["op"], req.get("args", {})
    if op == "devices.list":
        return [sim["dev"], serial["dev"]]
    st = states[req["deviceId"]]
    if op == "serial.acquire":
        if st["lease"]:
            raise RuntimeError("Device already leased")
        st["lease"] = str(uuid.uuid4())
        return {"lease": st["lease"]}
    if op == "serial.release":
        if fail_release and st is serial:
            fail_release = False
            raise RuntimeError("Device operation in progress")
        st["lease"] = None
        return {}
    if op == "serial.read":
        out, st["rx"] = st["rx"], b""
        return {"data": base64.b64encode(out).decode()}
    if op == "serial.write":
        b = base64.b64decode(args["data"])
        st["ping"] += b.decode("latin1")
        if "PING\n" in st["ping"]:
            st["ping"] = ""
            st["rx"] += st["reply"]
        if len(b) > 1 and b[0] == 0:
            st["rx"] += b  # binary echo (exercises IAC escaping)
        return {}
    print("OP", st["dev"]["name"], op, json.dumps(args, separators=(",", ":")), flush=True)
    return {}


# ---- a minimal WebSocket client (RFC 6455): text frames, ping/pong, close ----

def recv_exact(s, n):
    b = b""
    while len(b) < n:
        chunk = s.recv(n - len(b))
        if not chunk:
            raise EOFError
        b += chunk
    return b


def recv_frame(s):
    b0, b1 = recv_exact(s, 2)
    n = b1 & 0x7F
    if n == 126:
        n = struct.unpack(">H", recv_exact(s, 2))[0]
    elif n == 127:
        n = struct.unpack(">Q", recv_exact(s, 8))[0]
    mask = recv_exact(s, 4) if b1 & 0x80 else None
    data = recv_exact(s, n)
    if mask:
        data = bytes(c ^ mask[i % 4] for i, c in enumerate(data))
    return b0 & 0x0F, data


def send_frame(s, opcode, data):
    mask = os.urandom(4)
    n = len(data)
    head = bytes([0x80 | opcode])
    if n < 126:
        head += bytes([0x80 | n])
    elif n < 65536:
        head += bytes([0x80 | 126]) + struct.pack(">H", n)
    else:
        head += bytes([0x80 | 127]) + struct.pack(">Q", n)
    s.sendall(head + mask + bytes(c ^ mask[i % 4] for i, c in enumerate(data)))


def connect():
    token = open(TOKEN_FILE).read().strip()
    for _ in range(100):
        try:
            s = socket.create_connection(("127.0.0.1", PORT))
            break
        except OSError:
            time.sleep(0.1)
    else:
        sys.exit("bridge not reachable")
    key = base64.b64encode(os.urandom(16)).decode()
    s.sendall((f"GET /bridge HTTP/1.1\r\nHost: 127.0.0.1:{PORT}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
               f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\nAuthorization: Bearer {token}\r\n\r\n").encode())
    head = b""
    while not head.endswith(b"\r\n\r\n"):
        head += recv_exact(s, 1)
    if not head.startswith(b"HTTP/1.1 101"):
        sys.exit(f"bridge refused the connection: {head!r}")
    return s


def main():
    s = connect()
    print("READY", flush=True)
    while True:
        opcode, data = recv_frame(s)
        if opcode == 8:
            return
        if opcode == 9:
            send_frame(s, 10, data)
            continue
        if opcode != 1:
            continue
        req = json.loads(data)["request"]
        try:
            reply = {"id": req["id"], "ok": True, "result": answer(req)}
        except Exception as e:
            reply = {"id": req["id"], "ok": False, "error": str(e)}
        send_frame(s, 1, json.dumps(reply).encode())


if __name__ == "__main__":
    main()
