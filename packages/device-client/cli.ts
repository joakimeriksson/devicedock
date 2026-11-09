import { DeviceClient } from "./index.ts";
import { hexBytes, orderDevices, orderProbes, rfc2217Url, openocdConfig } from "../protocol/index.ts";
const [cmd, id, ...flags] = process.argv.slice(2);
const value = (key: string) => flags[flags.indexOf(key) + 1];
// Stop cleanly on Ctrl-C / SIGTERM so the lease is released (a killed client otherwise leaves it held for 30 s,
// and the next command fails with "Device already leased").
let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => (stopping = true));
const seconds = (key: string) => {
  const v = value(key);
  const n = Number(v);
  if (!(n > 0) || n > 3600) throw Error(`${key} needs a number of seconds between 0 and 3600`);
  return n;
};
/** Print what the board sends for `ms` milliseconds (or until Ctrl-C), inside the caller's lease. */
async function readFor(client: DeviceClient, d: Parameters<DeviceClient["call"]>[1], lease: string, ms: number) {
  const end = Date.now() + ms;
  while (!stopping && Date.now() < end) {
    const r = (await client.call("serial.read", d, { maxBytes: 16384 }, lease)) as { data: string };
    if (r.data) process.stdout.write(Buffer.from(r.data, "base64"));
    await new Promise((r) => setTimeout(r, 100));
  }
}
try {
  const client = new DeviceClient();
  const devices = await client.list();
  if (cmd === "list") {
    // Same order as the RFC 2217 ports: the Nth device here is on port 2217+N. Use its `rfc2217` URL for esptool,
    // pyserial, mpremote and PlatformIO (real hardware first, then simulators).
    // Debug probes follow, each with the OpenOCD commands for its own port (4441, 4442, ...).
    console.log(
      JSON.stringify(
        [
          ...orderDevices(devices).map((d, i) => ({ ...d, rfc2217: rfc2217Url(i) })),
          ...orderProbes(devices).map((d, i) => ({ ...d, openocd: openocdConfig(i) })),
        ],
        null,
        2,
      ),
    );
  } else {
    const d = devices.find((d) => d.id === id);
    if (!d) throw Error("Device not exposed; run device list");
    await client.using(d, async (lease) => {
      if (cmd === "probe-open") {
        // One human approval opens a debug session; OpenOCD runs inside it need no further clicks. It lapses after
        // 10 minutes without probe traffic, or when the human cuts it off in the page.
        console.error("Waiting for approval in the DeviceDock page (up to 25 s)...");
        const r = (await client.call("probe.open", d, {}, lease)) as { session: string };
        console.log(`Probe session ${r.session}. Now run OpenOCD with the device's \`openocd\` commands from \`device list\`.`);
      } else if (cmd === "probe-close") {
        await client.call("probe.close", d, {}, lease);
        console.log("Probe session closed.");
      } else if (cmd === "send") {
        const data = flags.includes("--hex")
          ? Buffer.from(hexBytes(value("--hex")))
          : flags.includes("--text")
            ? Buffer.from(value("--text"))
            : undefined;
        if (!data) throw Error("Use --text or --hex");
        // --text sends the characters as given: use \r for Enter on a REPL. --read N then prints the reply for N
        // seconds within the SAME lease; without it the reply is lost, because the lease's read queue ends with it.
        const wait = flags.includes("--read") ? seconds("--read") : 0;
        await client.call(
          "serial.write",
          d,
          { data: data.toString("base64") },
          lease,
        );
        if (wait) await readFor(client, d, lease, wait * 1000);
      } else if (cmd === "connect" || cmd === "configure")
        await client.call(
          cmd === "connect" ? "serial.connect" : "serial.configure",
          d,
          { baudRate: Number(value("--baud") || 115200) },
          lease,
        );
      else if (cmd === "disconnect")
        await client.call("serial.disconnect", d, {}, lease);
      else if (cmd === "signals") {
        const parse = (flag: string) => {
          const v = value(flag);
          if (v !== "true" && v !== "false")
            throw Error(`${flag} requires true or false`);
          return v === "true";
        };
        await client.call(
          "serial.signals",
          d,
          {
            ...(flags.includes("--dtr")
              ? { dataTerminalReady: parse("--dtr") }
              : {}),
            ...(flags.includes("--rts")
              ? { requestToSend: parse("--rts") }
              : {}),
          },
          lease,
        );
      } else if (cmd === "monitor") {
        // Runs until Ctrl-C, or for --seconds N. It holds the device exclusively: nothing else (another
        // `device send`, esptool on the RFC 2217 port) can talk to the board meanwhile.
        await readFor(client, d, lease, flags.includes("--seconds") ? seconds("--seconds") * 1000 : Infinity);
      } else
        throw Error(
          "Commands: list, connect, configure, send (--text|--hex [--read SECONDS]), signals, monitor [--seconds N], disconnect, probe-open, probe-close",
        );
    });
  }
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
}
