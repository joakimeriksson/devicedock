import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { DeviceClient } from "../device-client/index.ts";
import { options, signals, base64 } from "../protocol/index.ts";
export function createDeviceMcpServer(client: DeviceClient) {
  const server = new Server(
    { name: "devicedock", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  const device = z.object({
    id: z.string().uuid(),
    generation: z.number().int().positive(),
    name: z.string().default("Device"),
    kind: z.enum(["serial", "mock", "sim"]).default("serial"),
    baudRate: z.number().default(115200),
  });
  const uuid = { type: "string", format: "uuid" };
  const deviceJson = {
    type: "object",
    properties: { id: uuid, generation: { type: "integer", minimum: 1 } },
    required: ["id", "generation"],
  };
  const leaseJson = { device: deviceJson, lease: uuid };
  type Tool = {
    name: string;
    description: string;
    inputSchema: {
      type: "object";
      properties: Record<string, unknown>;
      required: string[];
    };
    schema: z.ZodTypeAny;
    run: (args: any) => Promise<unknown>;
  };
  const tools: Tool[] = [];
  function add(
    name: string,
    description: string,
    properties: Record<string, unknown>,
    required: string[],
    schema: z.ZodTypeAny,
    run: Tool["run"],
  ) {
    tools.push({
      name,
      description,
      inputSchema: { type: "object", properties, required },
      schema,
      run,
    });
  }
  add(
    "devices_list",
    "Discover browser-exposed devices",
    {},
    [],
    z.object({}).strict(),
    () => client.list(),
  );
  add(
    "serial_acquire",
    "Acquire a 30-second exclusive lease. Operations renew it.",
    { device: deviceJson },
    ["device"],
    z.object({ device }).strict(),
    (a) => client.call("serial.acquire", a.device),
  );
  for (const op of ["release", "disconnect"] as const)
    add(
      `serial_${op}`,
      `${op} device access`,
      leaseJson,
      ["device", "lease"],
      z.object({ device, lease: z.string().uuid() }).strict(),
      (a) => client.call(`serial.${op}`, a.device, {}, a.lease),
    );
  add(
    "serial_read",
    "Consume bytes from the lease queue",
    { ...leaseJson, maxBytes: { type: "integer", minimum: 1, maximum: 16384 } },
    ["device", "lease"],
    z
      .object({
        device,
        lease: z.string().uuid(),
        maxBytes: z.number().int().min(1).max(16384).default(16384),
      })
      .strict(),
    (a) =>
      client.call("serial.read", a.device, { maxBytes: a.maxBytes }, a.lease),
  );
  add(
    "serial_write",
    "Write base64 bytes. Physical devices require approval for every operation.",
    {
      ...leaseJson,
      data: {
        type: "string",
        description: "Base64; maximum 16384 decoded bytes",
      },
    },
    ["device", "lease", "data"],
    z.object({ device, lease: z.string().uuid(), data: base64 }).strict(),
    (a) => client.call("serial.write", a.device, { data: a.data }, a.lease),
  );
  for (const op of ["connect", "configure"] as const)
    add(
      `serial_${op}`,
      "Configure serial port; physical devices require approval",
      {
        ...leaseJson,
        options: {
          type: "object",
          properties: {
            baudRate: { type: "integer", minimum: 300, maximum: 4000000 },
            dataBits: { enum: [7, 8] },
            stopBits: { enum: [1, 2] },
            parity: { enum: ["none", "even", "odd"] },
            flowControl: { enum: ["none", "hardware"] },
          },
          required: ["baudRate"],
        },
      },
      ["device", "lease", "options"],
      z.object({ device, lease: z.string().uuid(), options }).strict(),
      (a) => client.call(`serial.${op}`, a.device, a.options, a.lease),
    );
  add(
    "serial_signals",
    "Set control/reset lines; physical devices require approval",
    {
      ...leaseJson,
      signals: {
        type: "object",
        properties: {
          dataTerminalReady: { type: "boolean" },
          requestToSend: { type: "boolean" },
          break: { type: "boolean" },
        },
      },
    },
    ["device", "lease", "signals"],
    z.object({ device, lease: z.string().uuid(), signals }).strict(),
    (a) => client.call("serial.signals", a.device, a.signals, a.lease),
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      const tool = tools.find((t) => t.name === req.params.name);
      if (!tool) throw Error("Unsupported device tool");
      const result = await tool.run(
        tool.schema.parse(req.params.arguments ?? {}),
      );
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (e) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: (e as Error).message }),
          },
        ],
      };
    }
  });
  return server;
}
