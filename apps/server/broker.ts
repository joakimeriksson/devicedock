import { randomUUID } from "node:crypto";
import {
  request,
  MAX_BUFFER,
  MAX_PENDING,
  MAX_AUTONOMY_MS,
  type Request,
  type DeviceDescriptor,
} from "../../packages/protocol/index.ts";
type Send = (message: unknown) => void;
type Device = DeviceDescriptor & {
  owner: string;
  send: Send;
  lease?: { id: string; client: string; expires: number };
  buffer: Buffer;
  overflow: boolean;
  busy: boolean;
};
type Pending = {
  deviceId: string;
  generation: number;
  client: string;
  resolve: () => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  stage: "approval" | "operation";
  device: Device;
  req: Request;
};
export class Broker {
  devices = new Map<string, Device>();
  pending = new Map<string, Pending>();
  private seen = new Map<string, number>();
  constructor(
    private now = () => Date.now(),
    private leaseMs = 30000,
  ) {}
  expose(owner: string, send: Send, info: DeviceDescriptor) {
    if (info.kind === "serial" && info.autoApprove)
      throw Error("Physical devices require approval");
    if (info.autonomousUntil) this.checkAutonomy(info.autonomousUntil);
    if (this.devices.has(info.id))
      throw Error("Revoke the existing connection first");
    if (this.devices.size >= 32) throw Error("Device limit reached");
    this.devices.set(info.id, {
      ...info,
      owner,
      send,
      buffer: Buffer.alloc(0),
      overflow: false,
      busy: false,
    });
  }
  private checkAutonomy(until: number) {
    const left = until - this.now();
    if (left <= 0 || left > MAX_AUTONOMY_MS)
      throw Error("Autonomous mode must expire within 2 hours");
  }
  /** Browser owner turns autonomous mode on (with expiry) or off (null). */
  setAutonomy(owner: string, id: string, until: number | null) {
    const d = this.devices.get(id);
    if (!d || d.owner !== owner) return;
    if (until === null) d.autonomousUntil = undefined;
    else {
      this.checkAutonomy(until);
      d.autonomousUntil = until;
    }
  }
  private autonomous(d: Device) {
    return (
      (d.kind === "mock" && d.autoApprove) ||
      (!!d.autonomousUntil && d.autonomousUntil > this.now())
    );
  }
  revoke(owner: string, id: string) {
    const d = this.devices.get(id);
    if (!d || d.owner !== owner) return;
    this.devices.delete(id);
    for (const [key, p] of this.pending)
      if (p.deviceId === id)
        this.finish(key, Error("Device revoked or disconnected"));
  }
  disconnectOwner(owner: string) {
    for (const d of [...this.devices.values()])
      if (d.owner === owner) this.revoke(owner, d.id);
  }
  disconnectClient(client: string) {
    for (const d of this.devices.values())
      if (d.lease?.client === client) {
        d.lease = undefined;
        d.buffer = Buffer.alloc(0);
      }
    for (const [key, p] of this.pending)
      if (p.client === client) this.finish(key, Error("Client disconnected"));
  }
  data(owner: string, id: string, generation: number, data: string) {
    const d = this.devices.get(id);
    if (!d || d.owner !== owner || d.generation !== generation) return;
    if (d.lease && d.lease.expires > this.now()) {
      const bytes = Buffer.from(data, "base64");
      if (d.buffer.length + bytes.length > MAX_BUFFER) {
        d.overflow = true;
        d.buffer = Buffer.alloc(0);
      } else if (!d.overflow) d.buffer = Buffer.concat([d.buffer, bytes]);
    }
  }
  private finish(id: string, error?: Error) {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
    if (error) p.reject(error);
    else p.resolve();
  }
  approve(owner: string, id: string, allow: boolean) {
    const p = this.pending.get(id);
    if (!p || p.stage !== "approval" || p.device.owner !== owner) return;
    if (!allow) return this.finish(id, Error("Human denied operation"));
    if (!this.valid(p))
      return this.finish(id, Error("Approval expired or lease invalid"));
    p.stage = "operation";
    p.device.send({ type: "operation", request: p.req });
  }
  reply(owner: string, id: string, ok: boolean, error?: string) {
    const p = this.pending.get(id);
    if (!p || p.stage !== "operation" || p.device.owner !== owner) return;
    this.finish(
      id,
      !this.valid(p)
        ? Error("Stale operation reply")
        : ok
          ? undefined
          : Error(error ?? "Device operation failed"),
    );
  }
  private valid(p: Pending) {
    return (
      this.devices.get(p.deviceId) === p.device &&
      p.device.generation === p.generation &&
      p.req.deadline > this.now() &&
      !!p.device.lease &&
      p.device.lease.id === p.req.lease &&
      p.device.lease.expires > this.now()
    );
  }
  async run(client: string, source: "ui" | "agent", input: unknown) {
    const r = request.parse(input);
    const now = this.now();
    if (r.deadline <= now || r.deadline > now + 60000)
      throw Error("Deadline expired or exceeds 60 seconds");
    for (const [k, t] of this.seen) if (t < now) this.seen.delete(k);
    if (this.seen.has(r.id)) throw Error("Request replay rejected");
    if (this.seen.size >= 10000) throw Error("Request rate limit");
    this.seen.set(r.id, r.deadline);
    if (r.op === "devices.list")
      return [...this.devices.values()].map(
        ({ id, name, kind, generation, baudRate, autonomousUntil }) => ({
          id,
          name,
          kind,
          generation,
          baudRate,
          autonomous: !!autonomousUntil && autonomousUntil > now,
        }),
      );
    const d = this.devices.get(r.deviceId ?? "");
    if (!d || r.generation !== d.generation)
      throw Error("Device unavailable or stale generation");
    if (d.lease && d.lease.expires <= now) {
      d.lease = undefined;
      d.buffer = Buffer.alloc(0);
      d.overflow = false;
    }
    if (r.op === "serial.acquire") {
      if (d.lease) throw Error("Device already leased");
      d.lease = { id: randomUUID(), client, expires: now + this.leaseMs };
      d.buffer = Buffer.alloc(0);
      d.overflow = false;
      return { lease: d.lease.id, expires: d.lease.expires };
    }
    if (!d.lease || d.lease.id !== r.lease || d.lease.client !== client)
      throw Error("Valid exclusive lease required");
    if (d.busy) throw Error("Device operation in progress");
    if (r.op === "serial.release") {
      d.lease = undefined;
      d.buffer = Buffer.alloc(0);
      return {};
    }
    d.lease.expires = now + this.leaseMs;
    if (r.op === "serial.read") {
      if (d.overflow) {
        d.overflow = false;
        throw Error("Receive buffer overflow: bytes were lost");
      }
      const b = d.buffer.subarray(0, r.args.maxBytes);
      d.buffer = d.buffer.subarray(b.length);
      return { data: b.toString("base64") };
    }
    if (this.pending.size >= MAX_PENDING)
      throw Error("Too many pending requests");
    d.busy = true;
    try {
      await new Promise<void>((resolve, reject) => {
        const approval = source === "agent" && !this.autonomous(d);
        const timer = setTimeout(
          () =>
            this.finish(
              r.id,
              Error("Operation timed out; do not automatically retry writes"),
            ),
          Math.min(r.deadline - now, this.leaseMs),
        );
        this.pending.set(r.id, {
          deviceId: d.id,
          generation: d.generation,
          client,
          resolve,
          reject,
          timer,
          stage: approval ? "approval" : "operation",
          device: d,
          req: r,
        });
        d.send({ type: approval ? "approval" : "operation", request: r });
      });
      if (r.op === "serial.disconnect") this.revoke(d.owner, d.id);
      if (r.op === "serial.configure" || r.op === "serial.connect")
        d.baudRate = r.args.baudRate;
      return {};
    } finally {
      d.busy = false;
    }
  }
  close() {
    for (const key of this.pending.keys())
      this.finish(key, Error("Bridge stopped"));
    this.devices.clear();
  }
}
