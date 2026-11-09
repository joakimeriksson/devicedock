# DeviceDock quick start

DeviceDock lets a coding agent (Claude Code, Codex, OpenCode) in a locked-down Linux container build, flash and
talk to **real boards plugged into your laptop**, without giving the container your USB ports. Your browser
holds the boards. You decide what is shared, and you approve what the agent does.

```text
 board ──USB── Chrome (DeviceDock page) ──► DeviceDock backend ──► Linux sandbox (agents, OpenOCD, esptool, gcc)
               you share + approve here      runs on your laptop     no USB access of its own
```

This page covers macOS and Linux. Allow **~30 minutes the first time**: most of it is the sandbox image build.

---

## 1. Install once

| You need | macOS | Linux |
| --- | --- | --- |
| Node.js 22.12 or newer | `brew install node` | your package manager or [nodejs.org](https://nodejs.org) |
| Build tools (for the terminal component) | `xcode-select --install` | `sudo apt install build-essential python3` |
| Docker | Docker Desktop, **or** `brew install colima docker && colima start --cpu 4 --memory 6` | Docker Engine (`docker info` must work **without sudo**) |
| A browser with WebUSB / Web Serial | **Chrome** or **Edge** (not Safari, not Firefox) | **Chrome** or **Chromium** or **Edge** |

### Linux only: let the browser open the board
Chrome runs as you, not as root, so give your user access to the boards. For a TI LaunchPad (XDS110):

```sh
sudo tee /etc/udev/rules.d/71-devicedock.rules >/dev/null <<'EOF'
# TI XDS110 debug probe (LaunchPads)
SUBSYSTEM=="usb", ATTR{idVendor}=="0451", ATTR{idProduct}=="bef3", MODE="0660", TAG+="uaccess"
EOF
sudo udevadm control --reload && sudo udevadm trigger
sudo usermod -aG dialout "$USER"     # serial ports; log out and back in once
```
Then **unplug and replug** the board. Other probes need their own line (`lsusb` shows the `idVendor:idProduct`).

---

## 2. Start everything

```sh
git clone <this repository> && cd usb-agent-bridge
./devicedock.sh
```

That single command installs dependencies, builds the web page and the sandbox image if they are missing,
starts the sandbox and the backend, and leaves you at the **console**:

```text
── DeviceDock 18:56:39 ──
backend  : running pid 11248  http://127.0.0.1:47831
web build: up to date
sandbox  : running  image ok
devices  :
  []

devicedock>
```

| Type | It does |
| --- | --- |
| *Enter* or `s` | refresh the status |
| `o` | print a **login link** for the DeviceDock page (use it whenever the page says you are logged out) |
| `sh` | open a shell **inside the sandbox** (`exit` brings you back) |
| `d` | list the shared devices |
| `l` | last 30 lines of the backend log |
| `rb` | restart the backend (then reload the page and share again) |
| `rs` | recreate the sandbox from the current image (asks first; your files and logins are kept) |
| `w` / `i` | rebuild the web page / the sandbox image |
| `login claude` / `login codex` | log an agent in **inside the sandbox** |
| `q` | leave the console, keep everything running |
| `x` | stop everything and leave |

Stopped the console? `./devicedock.sh` gets you back. Stop everything: `./devicedock.sh stop`.

---

## 3. Open the page and share a board

1. In the console type **`o`** and open the link it prints **in Chrome**. Always use `127.0.0.1`, not `localhost`.
2. Plug in the board.
3. Share it:
   - **Serial console** (any board: ESP32, LaunchPad UART, …): **Add serial port** → pick it → **Open & share**.
   - **Debug probe** (TI LaunchPad XDS110, other CMSIS-DAP probes): **＋ Add debug probe** → pick it →
     **Connect** → **Open & share** → **OK**.
4. Check it arrived: type `d` in the console. The device is listed with an `id`.

> **The device picker vanishes immediately?** An extension that automates or debugs Chrome closes browser
> pop-ups automatically. Open DeviceDock in an **Incognito window** (⇧⌘N / Ctrl+Shift+N), or a Chrome profile
> without extensions, and try again.

Sharing stays until you click **Revoke access**, close the tab, or reload. **After a reload, share again.**

---

## 4. First test: TI LaunchPad with Contiki-NG

Verified on a CC1352R1 LaunchPad on 2026-11-09. Share **both** the serial port and the debug probe (step 3).
In the console type `sh`, then:

```sh
# 1. Build (first time: clone Contiki-NG with its submodules)
cd /workspace
git clone --recursive https://github.com/contiki-ng/contiki-ng.git
cd contiki-ng/examples/hello-world
make TARGET=simplelink BOARD=launchpad/cc1352r1

# 2. Find the ids
device list        # note the "probe" id and the "serial" id

# 3. Open a debug session: click Approve in the DeviceDock page within ~25 s
device probe-open <probe-id>

# 4. Flash (about a minute)
openocd -c "adapter driver cmsis-dap; cmsis-dap backend tcp; cmsis-dap tcp host 127.0.0.1; cmsis-dap tcp port 4441" \
        -c "transport select jtag; adapter speed 2000" -f target/ti/cc13x2.cfg \
        -c "program build/simplelink/launchpad/cc1352r1/hello-world.simplelink verify reset; shutdown"

# 5. Watch it run
device monitor <serial-id> --seconds 20      # prints "Hello, world" every 10 s
```

Your board is a different LaunchPad? Use its name in `BOARD=` (`launchpad/cc1312r1`, `launchpad/cc2652r1`, …).
The CC13x2 and CC26x2 chips share `target/ti/cc13x2.cfg` (`cc26x2.cfg` also exists).

**Want to keep the factory firmware?** Back it up before step 4 (352 KB takes ~2 minutes):
```sh
openocd -c "adapter driver cmsis-dap; cmsis-dap backend tcp; cmsis-dap tcp host 127.0.0.1; cmsis-dap tcp port 4441" \
        -c "transport select jtag; adapter speed 2000" -f target/ti/cc13x2.cfg \
        -c "init; halt; dump_image /workspace/factory.bin 0 0x58000; resume; shutdown"
```

---

## 5. Let an agent do it

In the console: `login claude` (or `login codex`) once. Then `sh` and start the agent in `/workspace`:

```sh
cd /workspace && claude
```

The agent reads `/workspace/AGENTS.md`, which explains `device list`, flashing, serial monitoring and the rules.
Ask it something concrete, e.g. *"Make hello-world print a counter, flash it to the LaunchPad and show me the output."*

**Approvals.** Every write to real hardware waits for a click in the page, and a debug session needs one
approval. To let the agent work alone for a while, turn on **Autonomous (15 / 60 min)** for that device; it switches
itself off afterwards. **Cut off** in the page stops a debug session at once.

---

## 6. When something goes wrong

| You see | Do this |
| --- | --- |
| `device list` prints `[]` | Nothing is shared. Share in the page (step 3). After a page reload or backend restart, share again. |
| The device picker closes by itself | Use an Incognito window (step 3). |
| Page shows "logged out" / 401 | Console: `o`, open the new link. |
| **Open & share** fails, red banner "Unable to claim interface" / "Access denied" | Another program has the probe: close other DeviceDock tabs, OpenOCD, Code Composer Studio, UniFlash; replug the board. On Linux: the udev rule (section 1). |
| `device probe-open` waits, then fails | Nobody clicked Approve in the page within 25 s. Run it again and click. |
| OpenOCD: `CMSIS-DAP: TCP read timed out` or `No approved probe session` | The debug session ended (10 min without use, or **Cut off**). Run `device probe-open <id>` again. |
| OpenOCD: `Error connecting DP` / no JTAG tap found | Wrong target config, or the board's debug jumpers are open. Check `-f target/ti/...`. |
| `Device already leased` | Another command holds the device (a running `monitor`?). Wait for it, or stop it; a killed one frees itself after 30 s. |
| Docker errors on start | `docker info` must work in your terminal. macOS: start Docker Desktop or `colima start`. |
| Anything else | Console: `l` for the backend log, `s` for status. `rb` restarts the backend, `rs` the sandbox. |

**Speed.** Flashing through the browser runs at about 3 KiB/s today: a typical Contiki image takes about a minute.
Serial is not affected.

---

## 7. Before a lab or hackathon

- Run `./devicedock.sh` once on every laptop **the day before**: the first image build downloads and compiles a lot.
- No time to build everywhere? Build once per CPU type and copy it:
  ```sh
  docker save devicedock-sandbox:local | gzip > devicedock-sandbox.tar.gz     # on the built machine
  gunzip -c devicedock-sandbox.tar.gz | docker load                            # on the others
  ```
  An Apple-silicon image (arm64) does not run on an Intel/AMD Linux laptop (amd64), and the other way round.
- Test one complete round trip per laptop: share the probe, `device probe-open`, `openocd … -c "init; shutdown"`.
- Windows is not covered by this guide (WebUSB there needs a WinUSB driver for the probe, e.g. via Zadig).

---

## What is safe, and what is not

- The sandbox never sees your USB ports, your home folder, your Mac/Linux logins or the Docker socket.
- It reaches **only** what you share, and only while you share it.
- A **shared debug probe is powerful**: it can erase the chip and change its protection settings, which can lock some
  chips permanently. Share a probe only for boards you are willing to reflash.
- Agent logins (Claude, Codex) live only in the sandbox's own volume. Anything running in the sandbox can use them.

More detail: [README.md](README.md) (full reference), [SECURITY.md](SECURITY.md), [ARCHITECTURE.md](ARCHITECTURE.md).
