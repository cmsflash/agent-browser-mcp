#!/usr/bin/env node
// Chrome Agent Bridge MCP entrypoint. Importing it does not start a hub or touch Chrome.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Bridge, DEFAULT_PORT } from "./bridge.mjs";
import { TOOLS } from "./tools.mjs";
import { createToolSession, VERSION } from "./session.mjs";
import { normalizeProfileEmail } from "./safety.mjs";
import { normalizeRemoteContextId } from "./namespace.mjs";

export function createMcpServer(bridge, options = {}) {
  const session = createToolSession(bridge, options);
  const server = new Server({ name: "chrome-agent", version: VERSION }, {
    capabilities: { tools: {}, experimental: { "chrome-agent/safety": session.safety } },
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  }));
  server.setRequestHandler(CallToolRequestSchema, (request, extra) =>
    session.execute(request.params.name, request.params.arguments || {}, extra.signal));
  return server;
}

export async function main() {
  const profileEmail = normalizeProfileEmail(process.env.CHROME_AGENT_PROFILE_EMAIL);
  const remoteContextId = normalizeRemoteContextId(process.env.DSH_REMOTE_CONTEXT_ID);
  const bridge = new Bridge(Number(process.env.CHROME_AGENT_PORT || DEFAULT_PORT));
  await bridge.start();
  const server = createMcpServer(bridge, {
    profileEmail, remoteContextId,
    ...(process.env.CHROME_AGENT_DOWNLOADS_DIR ? { downloadsDir: process.env.CHROME_AGENT_DOWNLOADS_DIR } : {}),
  });
  await server.connect(new StdioServerTransport());
  process.stderr.write(`[chrome-agent] MCP server v${VERSION} ready (stdio, bridge mode: ${bridge.mode})\n`);
  let stopping;
  const shutdown = () => stopping ??= (async () => {
    try { await server.close(); } finally { await bridge.stop(); }
    process.exit(0);
  })();
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`[chrome-agent] startup failed: ${error.message}\n`); process.exitCode = 1; });
}
