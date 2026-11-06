import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DeviceClient } from "../device-client/index.ts";
import { createDeviceMcpServer } from "./server.ts";
await createDeviceMcpServer(new DeviceClient()).connect(
  new StdioServerTransport(),
);
