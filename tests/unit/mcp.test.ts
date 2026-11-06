import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDeviceMcpServer } from "../../packages/mcp-server/server.ts";
import { DeviceClient } from "../../packages/device-client/index.ts";
import { Broker } from "../../apps/server/broker.ts";
test("MCP discovery and writes use SDK leases and physical approval enforcement", async () => {
  const broker = new Broker(),
    sent: any[] = [];
  const d = {
    id: randomUUID(),
    name: "Physical fixture",
    kind: "serial" as const,
    generation: 1,
    baudRate: 115200,
    autoApprove: false,
  };
  broker.expose(
    "browser",
    (m) => {
      sent.push(m);
      if ((m as any).type === "approval")
        queueMicrotask(() =>
          broker.approve("browser", (m as any).request.id, false),
        );
    },
    d,
  );
  const sdk = new DeviceClient("http://test/rpc", "test");
  const original = fetch;
  globalThis.fetch = async (_url, init) => {
    const m = JSON.parse(init!.body as string);
    try {
      return new Response(
        JSON.stringify({
          id: m.request.id,
          ok: true,
          result: await broker.run(m.client, "agent", m.request),
        }),
      );
    } catch (e) {
      return new Response(
        JSON.stringify({
          id: m.request.id,
          ok: false,
          error: (e as Error).message,
        }),
      );
    }
  };
  const server = createDeviceMcpServer(sdk),
    client = new Client({ name: "test", version: "1.0.0" }),
    [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(a), client.connect(b)]);
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 9);
    const acquired = await client.callTool({
      name: "serial_acquire",
      arguments: { device: d },
    });
    const { lease } = JSON.parse((acquired.content as any)[0].text);
    const denied = await client.callTool({
      name: "serial_write",
      arguments: { device: d, lease, data: "AA==" },
    });
    assert.equal(denied.isError, true);
    assert.match((denied.content as any)[0].text, /denied/);
    assert.equal(sent[0].type, "approval");
    const missing = await client.callTool({
      name: "serial_write",
      arguments: { device: d, lease: randomUUID(), data: "AA==" },
    });
    assert.equal(missing.isError, true);
    assert.match((missing.content as any)[0].text, /lease required/);
  } finally {
    await client.close();
    await server.close();
    broker.close();
    globalThis.fetch = original;
  }
});
