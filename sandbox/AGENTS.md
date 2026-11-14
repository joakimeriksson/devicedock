# DeviceDock sandbox: hardware-in-the-loop instructions

You run in an isolated Linux sandbox. There is **no `/dev/tty*` for the hardware**: the human shares a USB serial
device (or starts a simulated board) from their browser, and you reach it over a bridge. Only shared devices are
reachable.

## 0. What is installed
`cat /etc/devicedock-variant` says which image this is: `base`, `contiki`, `esp32` or `full`.
- Every image: `arm-none-eabi-gcc`, `openocd`, `cngsim` (Cooja-NG), `esptool`, `pyserial`, `mpremote`, `device`.
- `contiki`/`full`: a pinned, read-only Contiki-NG at `/opt/contiki-ng` with submodules. Copy it before building:
  `cp -r /opt/contiki-ng /workspace/contiki-ng`. MSP430 GCC (Sky/Z1) only on amd64: if
  `/usr/local/share/NO-MSP430-GCC` exists, Sky/Z1 cannot be built here (say so; ARM boards are fine).
- `esp32`/`full`: ESP-IDF v5.5 at `/opt/esp-idf` for esp32, esp32s3, esp32c3, esp32c6. Run `get_idf` (or
  `. /opt/esp-idf/export.sh`) once per shell, then `idf.py set-target <chip> build`.
  Flash a shared board with `idf.py -p <rfc2217 URL from device list> flash`.
- A tool that is not installed: say which image has it instead of installing large toolchains yourself.

## 1. What is shared: `device list`

```sh
device list
```
Prints JSON, one entry per device, **real hardware first**:

| field | meaning |
| --- | --- |
| `id` | use it with `device send/monitor/...` |
| `kind` | `serial` = real hardware, `probe` = real debug probe (section 7), `sim` = simulator, `mock` = built-in loopback |
| `simulated` | `true` for `sim`/`mock`. **Say so in every report**: "on the simulator" is not "on the board". |
| `engine`, `board` | what the simulator is (e.g. `esp32sim`, `ttgo-tdisplay`) |
| `autonomous` | the human enabled unattended writes for this real device (see section 6) |
| `rfc2217` | the URL standard serial tools use for **this** device (section 2) |
| `openocd` | debug probes only: the OpenOCD commands for **this** probe's endpoint (section 7) |

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

**esptool and `idf.py flash` on a real board need `"autonomous": true`** in `device list`. They reset the chip by
toggling DTR/RTS many times in under a second, and without autonomous mode each toggle waits for a human click, so
the flash fails after ~30 s with a misleading *connection failed (reader thread died)*. Check first; if it is `false`,
ask the human to click **Autonomous 15 min** on that device, then run the command. `esptool` here refuses to start
with an explanation in that case; `idf.py` uses its own esptool and does not, so check yourself before `idf.py flash`.

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
- **Flashing with esptool works** (the reset into the ROM's download mode is automatic). This was verified directly
  against the emulator; **through DeviceDock it is not yet verified**, so if it fails, report the error instead of
  retrying in a loop.
- **A reset reboots from the original images.** Files you wrote to the simulated filesystem are gone afterwards.
- **No network.** Wi-Fi apps run on their built-in demo data.
- **Input is exact for ASCII text**, not for arbitrary binary.

## 6. Real hardware: approvals and autonomous mode
Unless the human enabled **autonomous mode** (15 or 60 minutes) for a real device, every write, reset and
configuration change waits for their click in the browser and can time out. If operations time out or report
"Human denied operation", tell the human instead of retrying in a loop, and never retry a write that timed out
without first checking the device state. Autonomous mode ends by itself; then you are back to per-operation approval.
Opening the port can reset the board (normal for ESP32); a boot log afterwards is expected.

## 7. Debug probes (OpenOCD)
A shared debug probe (`kind: "probe"`, e.g. the XDS110 on a TI LaunchPad) gives OpenOCD/GDB full control of a real
chip: halt, read and erase flash, change protection settings. It has **no serial port**: the board's console is a
separate `serial` device that the human shares separately. If you need the console and it is not listed, ask for it.

**The sequence, every time** (verified end to end on a CC1352R1 LaunchPad, 2026-11-09):
```sh
device list                                   # 1. take the probe id and its `openocd` line; take the serial id
device probe-open <probe-id>                  # 2. ONE human approval opens a debug session (prints "Probe session opened")
openocd -c "<the probe's openocd line from device list>" \
        -c "transport select jtag; adapter speed 2000" -f target/ti/cc13x2.cfg \
        -c "program <firmware.elf> verify reset; shutdown"      # 3. flash + verify + run
device monitor <serial-id> --seconds 20       # 4. read what the firmware prints
```
- Run `probe-open` **before** OpenOCD: OpenOCD gives up after a few seconds, far less than a human needs to click.
  If `probe-open` fails after ~25 s, nobody approved: tell the human, then retry once.
- One session covers many OpenOCD runs. It ends after **10 minutes without probe traffic**, with
  `device probe-close <id>`, or when the human clicks **Cut off**. OpenOCD then fails with
  `CMSIS-DAP: TCP read timed out` or *No approved probe session*: run `device probe-open` again, do not loop.
- End every OpenOCD command line with `shutdown` (not `exit`), so the probe is free for the next run.
- Port 4441 is the first probe, 4442 the next: always copy the `openocd` line from `device list`.

**Target configs** (under OpenOCD's `target/ti/`): `cc13x2.cfg` for CC13x2/CC26x2 LaunchPads (CC1352R1, CC1312R1,
CC2652R1, ...), `cc26x2x7.cfg` for the 704 KB parts, `cc13x0.cfg`/`cc26x0.cfg` for older ones, `cc2538.cfg` for
CC2538 (Zoul). The transport is JTAG for TI parts.

**Contiki-NG on a LaunchPad:**
```sh
cd /workspace && git clone --recursive https://github.com/contiki-ng/contiki-ng.git   # once
cd contiki-ng/examples/hello-world && make TARGET=simplelink BOARD=launchpad/cc1352r1
# firmware: build/simplelink/launchpad/cc1352r1/hello-world.simplelink  (an ELF; give it to `program`)
```
Use the human's board name in `BOARD=`. If the tree has no submodules, add
`CORE_SDK=<contiki-ng>/arch/cpu/simplelink-cc13xx-cc26xx/lib/coresdk_cc13xx_cc26xx` after cloning that SDK.
LaunchPads are flashed with OpenOCD as above, not with Contiki's serial-bootloader `upload` target.

**Other useful OpenOCD actions** (same first two `-c` arguments as above):
- Reset and run: `-c "init; reset run; shutdown"`
- Back up the whole flash first (CC13x2 352 KB, ~2 minutes): `-c "init; halt; dump_image /workspace/backup.bin 0 0x58000; resume; shutdown"`
- Debug: leave OpenOCD running without `shutdown` (`-c "init; halt"`), then in another shell
  `arm-none-eabi-gdb <firmware.elf> -ex "target extended-remote :3333"`.

**Speed and safety.**
- Expect about **3 KiB/s**: each DAP command makes a round trip through the browser. A 70 KB image takes ~1 minute
  including verify, so do not treat a slow flash as a hang; wait at least 3 minutes before calling it stuck.
- **Never** erase-and-lock, mass-erase, or touch protection or CCFG settings (the last flash page on CC13x2/CC26x2)
  unless the human asked for exactly that. A wrong CCFG can disable debug access permanently.
- Before overwriting firmware the human may want back, suggest a backup (above).

## 8. Simulating Contiki-NG boards and networks: Cooja-NG (`cngsim`)
`cngsim` runs the **same firmware ELF you would flash**, instruction by instruction, on an emulated board, alone or
as a radio network. Use it to try firmware before touching hardware, and for anything with more than one node.
Results are simulator results: say so in reports.

```sh
cngsim boards                                   # boards + the Contiki-NG TARGET/BOARD to build for each
cp build/simplelink/launchpad/cc1352r1/hello-world.simplelink /tmp/hello.cc1352r1-launchpad
cngsim run /tmp/hello.cc1352r1-launchpad -t 25s # one node, 25 s simulated; prints its console and a verdict
cngsim run app.nrf52840-dk -n 5 -t 2m           # five nodes of one image on one radio medium
cngsim examples && cngsim run mixed-platforms   # bundled multi-node setups
cngsim new rpl-udp --board cc1352r1-launchpad -n 6 -o net.yaml   # write a setup file to edit, then: cngsim run net.yaml
```
- The board comes from the file name `<app>.<board>` (or `--board <board>`); `.simplelink`/`.elf` names need one of them.
- Durations need a unit (`25s`, `500ms`, `2m`). Runs are headless and deterministic: the same `--seed` gives the same run.
- Verified: the Contiki-NG hello-world ELF for the CC1352R1 LaunchPad prints the same output as the real board,
  at ~700x real time.
- Exit codes: 0 pass, 1 a check failed, 2 bad input, 6 wall-clock timeout. Setup files can hold checks
  (`cngsim help`; `/opt/cooja-ng/share/cooja-ng` has the guides and examples).
- `--ui` serves its web view on port 8080 **inside the sandbox only**; the human's browser cannot reach it. Use the
  console output, `--pcap`, or `--ui-record`.
- `--gdb PORT` gives a GDB server on a simulated node (`arm-none-eabi-gdb <elf> -ex "target remote :PORT"`).
- Not a DeviceDock device yet: a simulated node does not appear in `device list`.

## 9. When your own shell commands fail
You may be inside a container that cannot create the user namespaces some agents use for their private sandbox
(Codex reports *bwrap … cannot create a namespace*). Do not try to work around it. Tell the human: this container
is already the sandbox, and Codex can be started from the shell with `--sandbox danger-full-access` (or, only if
they want no prompts at all, `--dangerously-bypass-approvals-and-sandbox`).

## 9a. Internet access goes through the DeviceDock firewall
This container has no network of its own. Everything goes through the proxy in `HTTPS_PROXY`
(`http://127.0.0.1:3128`, served by `devicedock tunnel`), which curl, git (https), pip, npm and the agent tools use
automatically. The human decides in the DeviceDock page which hosts are allowed:
- An allowed host works as usual. A host that is not on the list makes the connection **wait up to 30 s** while the
  page asks the human; if they click Block or do not answer, you get `403 Forbidden` with a "DeviceDock firewall"
  message.
- When something fails with that message, or with a DNS error (`EAI_AGAIN`, "Could not resolve host"), do not
  retry in a loop or look for another way out: tell the human which host you need and why, and ask them to allow it
  (Network panel). Tools that ignore `HTTPS_PROXY` (plain Node `fetch`, raw sockets, `git@` SSH URLs) cannot reach
  the internet at all; use the HTTPS URL or a proxy-aware tool.
- IP addresses are never allowed, and neither are names that point to private or local addresses.
- Do not stop or replace `devicedock tunnel`: it is also how the human's boards reach you.

## 9b. Folders shared from the human's computer: `/shares`
The human can share project folders from their computer in the DeviceDock page. Each one is at
`/shares/<folder name>` (`ls /shares`; empty or missing means none are shared). Work in them as in any project:
- A read-only share fails writes with "Read-only file system". Copy what you need to `/workspace`, or ask the human
  to make it read-write.
- Your changes there land directly on the human's computer. Keep them to what the task needs, do not touch
  `.git/hooks`, CI files or build scripts unless asked, and say which files you changed.
- You cannot add or remove shares; ask the human (Shared folders panel). Adding one restarts this sandbox.

## 10. The loop
1. Write or change code in `/workspace`; build it (PlatformIO, arduino-cli, or MicroPython files).
2. Flash or upload through the device's RFC 2217 URL (the reset into the bootloader is automatic).
3. Read the output (`device send --read`, `device monitor --seconds`, or pyserial) and compare with what you expect.
4. Fix and repeat. Stop and report if the same failure happens three times.

## 11. Rules of the road
- Operate only the shared devices. Do not try to reach the Mac, the Docker socket, or other hardware.
- Confirm the baud rate from `device list` instead of hard-coding one the board may not use.
- Credentials for your own login live in this container's home volume; never print them.
- Report honestly: what ran on a simulator, what ran on hardware, and what you could not verify.
