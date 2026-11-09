import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { request, response, type Request } from "../protocol/index.ts";
export type Device = {
  id: string;
  generation: number;
  name: string;
  kind: "serial" | "mock" | "sim" | "probe";
  simulated?: boolean;
  engine?: string;
  board?: string;
  baudRate: number;
};
export class DeviceClient {
  readonly client = randomUUID();
  constructor(
    private url = "http://127.0.0.1:47832/rpc",
    private token = readFileSync("/home/node/.bridge-token", "utf8").trim(),
  ) {}
  async call(
    op: Request["op"],
    device?: Device,
    args: Record<string, unknown> = {},
    lease?: string,
    timeoutMs = 25000,
  ) {
    const r = request.parse({
      v: 1,
      id: randomUUID(),
      op,
      deviceId: device?.id,
      generation: device?.generation,
      deadline: Date.now() + timeoutMs,
      args,
      lease,
    });
    const res = await fetch(this.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({ client: this.client, request: r }),
      signal: AbortSignal.timeout(timeoutMs + 1000),
    });
    if (!res.ok) throw Error(`Bridge returned HTTP ${res.status}`);
    const m = response.parse(await res.json());
    if (!m.ok) throw Error(m.error);
    return m.result;
  }
  async list() {
    return (await this.call("devices.list")) as Device[];
  }
  async using<T>(device: Device, fn: (lease: string) => Promise<T>) {
    const { lease } = (await this.call("serial.acquire", device)) as {
      lease: string;
    };
    try {
      return await fn(lease);
    } finally {
      await this.call("serial.release", device, {}, lease).catch(() => {});
    }
  }
}
