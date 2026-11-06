# A second client must replace a first one that never disconnected, and a stale lease must not block it.
import serial, time
a = serial.serial_for_url("rfc2217://127.0.0.1:2217", baudrate=115200, timeout=3)
a.write(b"PING\n"); assert a.readline() == b"PONG\n"
t = time.time()
b = serial.serial_for_url("rfc2217://127.0.0.1:2217", baudrate=115200, timeout=15)  # handshake must not fail
b.write(b"PING\n"); got = b.readline()
assert got == b"PONG\n", got
print("REPLACE OK in %.1fs" % (time.time() - t))
b.close()
