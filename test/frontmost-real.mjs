// OS-level check: creating/driving an agent group in the REAL profile must
// never bring Chrome (or its new window) to the foreground.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execSync } from "node:child_process";
const front = () => execSync(`osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true'`).toString().trim();
const t = new StdioClientTransport({ command: "node", args: ["../server/index.mjs"], stderr: "ignore" });
const c = new Client({ name: "frontmost-real", version: "1.0.0" }); await c.connect(t);
const call = async (n, a = {}) => { const r = await c.callTool({ name: n, arguments: a }); const x = (r.content||[]).find(y=>y.type==="text"); let j=null; try{j=JSON.parse(x?.text||"null")}catch{j={_raw:x?.text}} return { isError:!!r.isError, json:j }; };
const before = front();
console.log("frontmost before:", before);
const samples = [];
const timer = setInterval(() => { try { samples.push(front()); } catch {} }, 400);
let g = null;
try {
  g = (await call("create_tab_group", { name: "Frontmost check", url: "https://example.com" })).json;
  await call("screenshot", { tabId: g.tabId });
  await call("computer", { tabId: g.tabId, action: "scroll", coordinate: [400, 300], scroll_direction: "down", scroll_amount: 3 });
  await call("find", { tabId: g.tabId, query: "Learn more" });
  await call("navigate", { tabId: g.tabId, url: "https://example.org" });
  await call("computer", { tabId: g.tabId, action: "screenshot" });
} finally {
  clearInterval(timer);
  if (g?.groupId) await call("close_tab_group", { groupId: g.groupId });
  await c.close();
}
const after = front();
const chromeSamples = samples.filter((s) => /Chrome/i.test(s));
console.log(`samples: ${samples.length}, distinct: ${[...new Set(samples)].join(", ")}`);
console.log("frontmost after:", after);
const ok = chromeSamples.length === 0 && after === before;
console.log(ok ? "✅ PASS: Chrome never came to the foreground during real-profile driving"
              : `❌ FAIL: Chrome frontmost in ${chromeSamples.length} sample(s); before=${before} after=${after}`);
process.exit(ok ? 0 : 1);
