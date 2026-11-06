import { DeviceClient } from "../../packages/device-client/index.ts";
const client = new DeviceClient();
const d = (await client.list()).find((d) => d.kind === "mock");
if (!d) throw Error("Add and expose a browser mock first");
await client.using(d, async (lease) => {
  await client.call(
    "serial.write",
    d,
    { data: Buffer.from("PING\n").toString("base64") },
    lease,
  );
  let received = "";
  for (let i = 0; i < 30 && !received.includes("PONG"); i++) {
    await new Promise((r) => setTimeout(r, 100));
    const r = (await client.call(
      "serial.read",
      d,
      { maxBytes: 16384 },
      lease,
    )) as { data: string };
    received += Buffer.from(r.data, "base64").toString();
  }
  if (!received.includes("PONG")) throw Error("PONG was not received");
  console.log(received.trim());
  const binary = Buffer.from([0, 255, 128, 1, 13, 10]);
  await client.call(
    "serial.write",
    d,
    { data: binary.toString("base64") },
    lease,
  );
  await new Promise((r) => setTimeout(r, 200));
  const r = (await client.call(
    "serial.read",
    d,
    { maxBytes: 16384 },
    lease,
  )) as { data: string };
  if (!Buffer.from(r.data, "base64").includes(binary))
    throw Error("Binary round-trip failed");
  console.log("Binary bytes preserved: 00 ff 80 01 0d 0a");
});
