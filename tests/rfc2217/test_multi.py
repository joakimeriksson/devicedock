# One port per device, physical first: 2217 = the real board even though the simulator was shared first,
# 2218 = the simulator, 2219 = nothing. Both can be used at the same time.
import serial, time
real = serial.serial_for_url("rfc2217://127.0.0.1:2217", baudrate=115200, timeout=3)
sim = serial.serial_for_url("rfc2217://127.0.0.1:2218", baudrate=115200, timeout=3)
real.write(b"PING\n"); sim.write(b"PING\n")
assert real.readline() == b"PONG\n", "2217 must be the physical device"
assert sim.readline() == b"SIM-PONG\n", "2218 must be the simulator"
real.close(); sim.close()
try:
    serial.serial_for_url("rfc2217://127.0.0.1:2219", baudrate=115200, timeout=3)
    raise SystemExit("port 2219 must not serve a device")
except serial.SerialException:
    pass
print("MULTI OK")
