import serial, time, sys
s = serial.serial_for_url("rfc2217://127.0.0.1:2217", baudrate=115200, timeout=2)
s.write(b"PING\n"); got = s.readline()
assert got == b"PONG\n", got
blob = bytes([0, 255, 128, 1, 13, 10, 255, 255])
s.write(blob); time.sleep(0.3)
assert s.read(len(blob)) == blob, "binary/IAC escaping broken"
s.baudrate = 460800
s.dtr = False; s.rts = True; time.sleep(0.05); s.dtr = True; s.rts = False; time.sleep(0.05); s.dtr = False
s.close()
print("PYSERIAL OK")
