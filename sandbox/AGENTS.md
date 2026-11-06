# DeviceDock sandbox — hardware-in-the-loop instructions

You run in an isolated Linux sandbox. There is **no `/dev/tty*` for the hardware**: the human shares a
USB serial device from their browser, and you reach it over a bridge. Only that shared device is reachable.

## Check what is shared
```sh
device list            # id, name, generation, baud rate, and whether autonomous mode is on
```
If nothing is listed, ask the human to click **Add serial port** then **Open & share** in the DeviceDock page.

## Standard serial tools: use the RFC 2217 port
`esptool`, `pyserial`, `mpremote` and PlatformIO work unmodified against **`rfc2217://127.0.0.1:2217`**
(baud rate and DTR/RTS reset signals are forwarded to the real board).

```sh
esptool --port rfc2217://127.0.0.1:2217 --chip esp32 chip-id
esptool --port rfc2217://127.0.0.1:2217 --chip esp32 --baud 460800 write-flash 0x10000 build/firmware.bin
python -c "import serial; s=serial.serial_for_url('rfc2217://127.0.0.1:2217', 115200, timeout=2); print(s.readline())"
# PlatformIO: upload_port = rfc2217://127.0.0.1:2217 and monitor_port = rfc2217://127.0.0.1:2217
```

## The loop
1. Write or modify code in `/workspace`; build it (PlatformIO, arduino-cli, or MicroPython files).
2. Flash or upload through the RFC 2217 port (the reset into the bootloader is automatic).
3. Read the board's output (pyserial, or `device monitor <id>`), compare with what you expect.
4. Fix the code and repeat. Stop and report if the same failure repeats three times.

## Rules of the road
- **One client at a time.** The device lease is exclusive: close `esptool`/pyserial before using
  `device monitor` or `device send`, and vice versa. "Device already leased" means another client holds it.
- **Approvals.** Unless the human enabled **autonomous mode** for the device, every write, reset and
  configuration change waits for their click in the browser and may time out. If operations time out or
  report "Human denied operation", tell the human instead of retrying in a loop. Never retry a write that
  timed out without checking the device state first.
- Autonomous mode is time-boxed (15/60 minutes). When it ends, you are back to per-operation approval.
- Only operate the shared device. Do not try to reach the Mac, the Docker socket, or other hardware.
- Opening the port can reset the board (normal for ESP32). Boot logs after a reset are expected.
- Do not hard-code serial settings the board does not use; confirm the baud rate from `device list`.
- Credentials for your own login live in this container's home volume; never print them.
