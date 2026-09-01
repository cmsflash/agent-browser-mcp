// Smoke test against the user's REAL Chrome profile (minimal, self-cleaning).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const transport = new StdioClientTransport({ command: "node", args: ["../server/index.mjs"], stderr: "ignore" });
const client = new Client({ name: "smoke-real", version: "1.0.0" });
await client.connect(transport);
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const t = (r.content || []).find((c) => c.type === "text");
  const img = (r.content || []).find((c) => c.type === "image");
  let json = null;
  try { json = JSON.parse(t?.text || "null"); } catch { json = { _raw: t?.text }; }
  return { isError: !!r.isError, json, img };
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
const step = (name, ok, detail = "") => { out.push(`${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`); if (!ok) throw new Error(name); };

let g = null;
try {
  await requireVersion(client, "1.2.0");
  // NO retry loop: the very first call must succeed on its own.
  const st = await call("get_status");
  step("first call connects with no retry", !st.isError && st.json.connected,
    `bridge mode: ${st.json?.session?.bridgeMode}, extension v${st.json?.extensionVersion}`);

  g = (await call("create_tab_group", { name: "Bridge smoke test", color: "green", url: "https://example.com" })).json;
  step("tab group created in real profile", /^grp_/.test(g.groupId || ""), `${g.groupId} (chrome group ${g.chromeGroupId})`);

  const txt = (await call("get_page_text", { tabId: g.tabId })).json;
  step("page text read", (txt.text || "").includes("Example Domain"));

  const shot = await call("screenshot", { tabId: g.tabId });
  step("background screenshot captured", !!shot.img && shot.img.data.length > 3000, `${Math.round(shot.img.data.length * 3 / 4 / 1024)}KB jpeg`);

  const found = (await call("find", { tabId: g.tabId, query: "Learn more" })).json;
  step("element found by text", found.count >= 1 && ["natural-language", "selector"].includes(found.results[0].matchedBy),
    `${found.results?.[0]?.ref} "${found.results?.[0]?.text}"`);

  await call("click", { tabId: g.tabId, ref: found.results[0].ref });
  const wf = await call("wait_for", { tabId: g.tabId, text: "IANA", timeoutMs: 20000 });
  step("trusted click navigated to iana.org", !wf.isError && wf.json.satisfied === true);

  const stale = await call("click", { tabId: g.tabId, ref: found.results[0].ref });
  step("stale ref rejected after navigation", stale.isError && /previous page|stale/.test(stale.json?._raw || ""));

  const kb = await call("javascript_tool", { action: "javascript_exec", text: "location.host", tabId: g.tabId });
  step("javascript runs in main world", kb.json.result === "www.iana.org" || kb.json.result === "iana.org", kb.json.result);

  const all = (await call("list_tabs", { all: true })).json;
  // Agent groups live in their OWN background window, where their tab is
  // necessarily active. The invariant is that no agent tab becomes active in
  // a window the USER owns (i.e. one that holds unmanaged tabs).
  const userWindows = new Set(all.tabs.filter((t) => !t.managed).map((t) => t.windowId));
  const agentActiveInUserWin = all.tabs.filter((t) => t.managed && t.active && userWindows.has(t.windowId));
  const userActive = all.tabs.filter((t) => !t.managed && t.active);
  step("user's tabs undisturbed (no agent tab active in a user window)",
    agentActiveInUserWin.length === 0 && userActive.length >= 1,
    `${all.tabs.length} tabs total across ${userWindows.size} user window(s)`);

  const rec = (await call("reconnect_tab_group", { groupId: g.groupId })).json;
  step("reconnect by internal ID works", rec.status === "connected" && rec.tabs.length >= 1);
} finally {
  if (g?.groupId) {
    const cl = (await call("close_tab_group", { groupId: g.groupId })).json;
    out.push(cl?.closedTabs >= 1 ? "✅ smoke group closed and forgotten" : "⚠ cleanup: " + JSON.stringify(cl).slice(0, 120));
  }
  console.log(out.join("\n"));
  await client.close();
  process.exit(out.some((l) => l.startsWith("❌")) ? 1 : 0);
}
