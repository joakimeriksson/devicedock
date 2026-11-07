# DeviceDock sandbox: hardware-in-the-loop instructions

You run in an isolated Linux sandbox. There is **no `/dev/tty*` for the hardware**: the human shares a USB serial
device (or starts a simulated board) from their browser, and you reach it over a bridge. Only shared devices are
reachable.

## 1. What is shared: `device list`

```sh
device list
```
Prints JSON, one entry per device, **real hardware first**:

| field | meaning |
| --- | --- |
| `id` | use it with `device send/monitor/...` |
| `kind` | `serial` = real hardware, `sim` = simulator, `mock` = built-in loopback |
| `simulated` | `true` for `sim`/`mock`. **Say so in every report**: "on the simulator" is not "on the board". |
| `engine`, `board` | what the simulator is (e.g. `esp32sim`, `ttgo-tdisplay`) |
| `autonomous` | the human enabled unattended writes for this real device (see section 6) |
| `rfc2217` | the URL standard serial tools use for **this** device (section 2) |

If nothing is listed, ask the human to click **Add serial port** then **Open & share** (real board), or
**＋ Simulated …** (simulator), in the DeviceDock page. Never guess an id.

## 2. Standard serial tools: one RFC 2217 URL per device
`esptool` and `pyserial` work against the `rfc2217` URL from `device list` (verified). `mpremote` and PlatformIO use the
same pyserial URL support and should work; they have not been tried here. Port 2217 is the
first real device, 2218 the next one, and so on (physical boards first, then simulators). Baud rate and DTR/RTS
(reset into the bootloader) are forwarded to the board.

```sh
esptool --port rfc2217://127.0.0.1:2217 --chip esp32 chip-id
esptool --port rfc2217://127.0.0.1:2217 --chip esp32 --baud 460800 write-flash 0x10000 build/firmware.bin
python -c "import serial; s=serial.serial_for_url('rfc2217://127.0.0.1:2217', 115200, timeout=2); print(s.readline())"
# PlatformIO: upload_port = monitor_port = the device's rfc2217 URL
```
Always take the URL from `device list`; do not assume 2217 is the device you want once a simulator is also shared.

## 3. Talking to a device interactively (REPL, shell)
```sh
device send <id> --text "print(6*7)\r" --read 3     # send, then print the reply for 3 s (same lease)
device send <id> --hex "03 03" --read 2             # Ctrl-C twice: interrupt a running MicroPython app
device monitor <id> --seconds 10                    # watch the output for 10 s, then release the device
```
- `--text` is sent as written: use `\r` for Enter. `--hex` sends raw bytes.
- Without `--read`, `send` returns at once and the reply is **lost** (nobody holds the device to receive it). Use `--read`.
- Prefer `monitor --seconds N` to a bare `monitor`, which runs until interrupted.

## 4. One client at a time (exclusive lease)
Every client (`device send`, `monitor`, esptool, pyserial, the UI) holds the device exclusively while it uses it.
- "Device already leased" means another client holds it: close it (a running `monitor`, a stuck esptool) first.
- A client that was killed leaves the lease for up to 30 s; wait and retry, do not loop in a tight retry.
- Never run `monitor` and `send` at the same time on one device; use `send --read` instead.

## 5. Simulated devices: what works and what does not
A simulator is software. Nothing physical can be damaged, and **writes need no approval**. It is a good place to try
MicroPython code, but results are not hardware results.
- **Works:** the UART console (REPL via `device send --read`), reading its output, a reset by pulsing RTS.
- **Does not work: flashing.** `esptool` reaches it but fails with *Wrong boot mode detected (0x13)*: the simulator
  has no download mode. Do not retry; use the REPL, or ask the human to flash a real board.
- **A reset reboots from the original images.** Files you wrote to the simulated filesystem are gone afterwards.
- **No network.** Wi-Fi apps run on their built-in demo data.
- **Input is exact for ASCII text**, not for arbitrary binary.

## 6. Real hardware: approvals and autonomous mode
Unless the human enabled **autonomous mode** (15 or 60 minutes) for a real device, every write, reset and
configuration change waits for their click in the browser and can time out. If operations time out or report
"Human denied operation", tell the human instead of retrying in a loop, and never retry a write that timed out
without first checking the device state. Autonomous mode ends by itself; then you are back to per-operation approval.
Opening the port can reset the board (normal for ESP32); a boot log afterwards is expected.

## 7. When your own shell commands fail
You may be inside a container that cannot create the user namespaces some agents use for their private sandbox
(Codex reports *bwrap … cannot create a namespace*). Do not try to work around it. Tell the human: this container
is already the sandbox, and Codex can be started from the shell with `--sandbox danger-full-access` (or, only if
they want no prompts at all, `--dangerously-bypass-approvals-and-sandbox`).

## 8. The loop
1. Write or change code in `/workspace`; build it (PlatformIO, arduino-cli, or MicroPython files).
2. Flash or upload through the device's RFC 2217 URL (the reset into the bootloader is automatic).
3. Read the output (`device send --read`, `device monitor --seconds`, or pyserial) and compare with what you expect.
4. Fix and repeat. Stop and report if the same failure happens three times.

## 9. Rules of the road
- Operate only the shared devices. Do not try to reach the Mac, the Docker socket, or other hardware.
- Confirm the baud rate from `device list` instead of hard-coding one the board may not use.
- Credentials for your own login live in this container's home volume; never print them.
- Report honestly: what ran on a simulator, what ran on hardware, and what you could not verify.
