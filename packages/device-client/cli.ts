import { DeviceClient } from "./index.ts";
import { hexBytes } from "../protocol/index.ts";
const [cmd, id, ...flags] = process.argv.slice(2);
const value = (key: string) => flags[flags.indexOf(key) + 1];
try {
  const client = new DeviceClient();
  const devices = await client.list();
  if (cmd === "list") {
    console.log(JSON.stringify(devices, null, 2));
  } else {
    const d = devices.find((d) => d.id === id);
    if (!d) throw Error("Device not exposed; run device list");
    await client.using(d, async (lease) => {
      if (cmd === "send") {
        const data = flags.includes("--hex")
          ? Buffer.from(hexBytes(value("--hex")))
          : flags.includes("--text")
            ? Buffer.from(value("--text"))
            : undefined;
        if (!data) throw Error("Use --text or --hex");
        await client.call(
          "serial.write",
          d,
          { data: data.toString("base64") },
          lease,
        );
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
        while (true) {
          const r = (await client.call(
            "serial.read",
            d,
            { maxBytes: 16384 },
            lease,
          )) as { data: string };
          process.stdout.write(Buffer.from(r.data, "base64"));
          await new Promise((r) => setTimeout(r, 100));
        }
      } else
        throw Error(
          "Commands: list, connect, configure, send, signals, monitor, disconnect",
        );
    });
  }
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
}
