#!/usr/bin/env node
// HTTP entrypoint — for hosting this MCP server on a VPS/server so it can be
// added to Claude as a remote connector (Streamable HTTP transport, MCP
// protocol 2025-03-26+). Requires MCP_AUTH_TOKEN to be set; every request
// must send "Authorization: Bearer <MCP_AUTH_TOKEN>".
//
// Stateless design: each request gets its own Server + Transport instance.
// This tool set has no session state (it's a pure CRUD proxy to the Twenty
// API), so statelessness keeps the deployment simple and restart-safe.

import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { TwentyCRMServer } from "./lib/twenty-crm-server.js";

const PORT = process.env.PORT || 3939;
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;

if (!AUTH_TOKEN) {
  console.error("MCP_AUTH_TOKEN environment variable is required to host this server over HTTP.");
  process.exit(1);
}

const app = express();
app.use(express.json());

function checkAuth(req, res) {
  const header = req.headers["authorization"] || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (token !== AUTH_TOKEN) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

app.post("/mcp", async (req, res) => {
  if (!checkAuth(req, res)) return;

  try {
    const instance = new TwentyCRMServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless mode
    });

    res.on("close", () => {
      transport.close();
      instance.server.close();
    });

    await instance.server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("MCP request error:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

// Health check (no auth) for uptime monitoring / load balancers
app.get("/healthz", (req, res) => res.status(200).send("ok"));

app.listen(PORT, () => {
  console.log(`Twenty CRM MCP server (HTTP) listening on port ${PORT}`);
  console.log(`POST /mcp with "Authorization: Bearer <token>" to use it.`);
});
