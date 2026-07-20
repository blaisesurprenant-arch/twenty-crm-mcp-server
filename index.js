#!/usr/bin/env node
// Stdio entrypoint — used when running via Claude Desktop's mcpServers config
// (command: node, args: ["index.js"]). For hosted/remote use on a server,
// see server-http.js instead.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TwentyCRMServer } from "./lib/twenty-crm-server.js";

async function run() {
  const instance = new TwentyCRMServer();
  const transport = new StdioServerTransport();
  await instance.server.connect(transport);
  console.error("Twenty CRM MCP server running on stdio");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
