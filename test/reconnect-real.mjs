// Requirement 1, end to end in the REAL profile:
// process A creates a group and exits; process B (a "restarted agent")
// reconnects to it by internal ID alone and keeps working.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const mk = async (name) => {
  const t = new StdioClientTransport({ command: "node", args: ["../server/index.mjs"], stderr: "ignore" });
  const c = new Client({ name, version: "1.0.0" });
  await c.connect(t);
  return c;
};
const call = async (c, name, args = {}) => {
  const r = await c.callTool({ name, arguments: args });
  const t = (r.content || []).find((x) => x.type === "text");
  let j = null; try { j = JSON.parse(t?.text || "null"); } catch { j = { _raw: t?.text }; }
  return { isError: !!r.isError, json: j };
};

// Warn if the extension in Chrome predates the fixes these tests check.
async function requireVersion(c, want) {
  const r = await c.callTool({ name: "get_status", arguments: {} });
  const t = (r.content || []).find((x) => x.type === "text");
  const v = (() => { try { return JSON.parse(t.text).extensionVersion; } catch { return null; } })();
  if (v !== want) {
    console.log(`\n⚠ Loaded extension is v${v}, expected v${want}.\n  Reload it: chrome://extensions → Chrome Agent Bridge → ↻\n  (or, from v1.0.1+, call the reload_extension tool)\n`);
  }
  return v;
}

const out = [];
const step = (n, ok, d = "") => { out.push(`${ok ? "✅" : "❌"} ${n}${d ? " — " + d : ""}`); };

// --- agent process A ---
const a = await mk("agent-A");
await requireVersion(a, "1.1.1");
const g = (await call(a, "create_tab_group", { name: "Reconnect proof", color: "pink", url: "https://example.com" })).json;
step("A: group created", /^grp_/.test(g.groupId || ""), g.groupId);
await call(a, "new_tab", { url: "https://iana.org" });
const tabsA = (await call(a, "list_tabs")).json;
step("A: two tabs in group", tabsA.tabs.length === 2);
await a.close();                                  // agent "shuts down"
await new Promise((r) => setTimeout(r, 3000));    // hub dies, extension reconnects

// --- agent process B: knows only the groupId ---
const b = await mk("agent-B");
const rec = (await call(b, "reconnect_tab_group", { groupId: g.groupId })).json;
step("B: reconnected by ID after A exited", rec.status === "connected", `${rec.tabs?.length} tabs recovered`);
step("B: group tabs preserved", (rec.tabs || []).some((t) => t.url.includes("iana")));

console.log("recovered tabs:", JSON.stringify(rec.tabs));
const txtR = await call(b, "get_page_text", { tabId: rec.tabs[0].tabId });
console.log("get_page_text ->", txtR.isError ? JSON.stringify(txtR.json).slice(0, 300) : `${(txtR.json.text||"").length} chars`);
const txtR2 = await call(b, "get_page_text", { tabId: rec.tabs[1].tabId });
console.log("get_page_text tab2 ->", txtR2.isError ? JSON.stringify(txtR2.json).slice(0, 300) : `${(txtR2.json.text||"").length} chars`);
const txt = txtR.json;
step("B: can drive the reconnected tab", !!(txt.text || "").length);

const cl = (await call(b, "close_tab_group", { groupId: g.groupId })).json;
step("B: closed the group it inherited", cl.closedTabs === 2, `${cl.closedTabs} tabs closed`);

const left = (await call(b, "list_tab_groups")).json;
step("no agent groups left behind", (left.groups || []).length === 0);
await b.close();
console.log(out.join("\n"));
process.exit(out.some((l) => l.startsWith("❌")) ? 1 : 0);
