// Snapshot the real Chrome's tab/group state via the production port.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const transport = new StdioClientTransport({ command: "node", args: ["../server/index.mjs"], stderr: "ignore" });
const client = new Client({ name: "counter", version: "1.0.0" });
await client.connect(transport);
const r = await client.callTool({ name: "list_tabs", arguments: { all: true } });
const j = JSON.parse((r.content || []).find((c) => c.type === "text").text);
const g = await client.callTool({ name: "list_tab_groups", arguments: {} });
const gj = JSON.parse((g.content || []).find((c) => c.type === "text").text);
console.log(JSON.stringify({ tabs: j.tabs.length, activeUrl: j.tabs.find((t) => t.active)?.url?.slice(0, 60), agentGroups: gj.groups.length }));
await client.close(); process.exit(0);
