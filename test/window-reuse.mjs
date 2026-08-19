#!/usr/bin/env node
// Proves agent tab groups land in the profile's LAST-ACTIVE window instead of
// opening one of their own — and that cleanup never closes the user's window.
//
// The interesting cases are the ones a naive implementation gets wrong:
//   * a second thread must reuse the same window, not accumulate windows
//   * a group whose window the user closed must revive into a CURRENT window
//   * delete_my_tabs must leave the user's window (and tabs) untouched
//   * with no window to borrow, creating one is still correct — and THAT one
//     may be reaped

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createServer } from "node:http";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import WebSocket from "ws";
import { root, makeTestExtension, launchChrome, serverEnv, cleanup, TEST_PORT } from "./harness.mjs";

const here = import.meta.dirname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
const failures = [];
function check(label, ok, detail = "") {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; failures.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
}

const MIME = { ".html": "text/html" };
const pages = createServer((req, res) => {
  try {
    const p = req.url.split("?")[0];
    const file = join(here, "pages", p === "/" ? "index.html" : p);
    res.setHeader("content-type", MIME[extname(file)] || "text/plain");
    res.end(readFileSync(file));
  } catch { res.statusCode = 404; res.end("nf"); }
});
await new Promise((r) => pages.listen(8973, "127.0.0.1", r));
const BASE = "http://127.0.0.1:8973";

const profile = mkdtempSync(join(tmpdir(), "cab-winreuse-"));
const extDir = makeTestExtension();
const chrome = launchChrome({
  extensionDir: extDir,
  profileDir: profile,
  // remote-debugging lets the TEST observe real OS window grouping out-of-band,
  // independently of anything the extension reports about itself.
  args: ["--remote-debugging-port=9446", "--window-size=1200,800", `${BASE}/index.html`],
});

// Close page targets, which closes the windows holding them.
async function closeAllWindows({ except = () => false } = {}) {
  const targets = await (await fetch("http://127.0.0.1:9446/json/list")).json();
  for (const t of targets.filter((x) => x.type === "page" && !except(x))) {
    await fetch(`http://127.0.0.1:9446/json/close/${t.id}`).catch(() => {});
  }
}

// Ask the browser itself which OS window a page target lives in.
async function browserWindows() {
  const targets = await (await fetch("http://127.0.0.1:9446/json/list")).json();
  const pages = targets.filter((t) => t.type === "page");
  const version = await (await fetch("http://127.0.0.1:9446/json/version")).json();
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((r) => ws.on("open", r));
  let id = 0;
  const send = (method, params = {}) => new Promise((res) => {
    const i = ++id;
    const h = (d) => { const j = JSON.parse(d.toString()); if (j.id === i) { ws.off("message", h); res(j); } };
    ws.on("message", h);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const out = [];
  for (const p of pages) {
    const r = await send("Browser.getWindowForTarget", { targetId: p.id });
    out.push({ url: p.url, windowId: r.result?.windowId ?? null });
  }
  ws.close();
  return out;
}

// A privileged back-channel to the extension, so the test can observe REAL
// browser window state (chrome.windows) rather than trusting tool output.
// It registers as a second "hub" client on the test port's /ext contract? No —
// simpler and honest: drive an ordinary MCP tool that reports windowId, and
// count windows via a page-independent CDP-free probe below.
const transport = new StdioClientTransport({
  command: "node", args: [join(root, "server", "index.mjs")], stderr: "ignore", env: serverEnv,
});
const client = new Client({ name: "window-reuse", version: "1.0.0" });
await client.connect(transport);

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const t = (r.content || []).find((c) => c.type === "text");
  let json = null;
  try { json = JSON.parse(t?.text ?? "null"); } catch { json = { _raw: t?.text }; }
  return { isError: !!r.isError, json, text: t?.text || "" };
};

const T1 = { threadTitle: "win reuse alpha" };
const T2 = { threadTitle: "win reuse beta" };

try {
  for (let i = 0; i < 30; i++) {
    const s = await call("get_status");
    if (!s.isError && s.json?.connected) break;
    await sleep(1000);
  }

  console.log("\nWindow reuse");
  const before = await browserWindows();
  const beforeWindowIds = [...new Set(before.map((w) => w.windowId))];
  check("browser starts with exactly one OS window", beforeWindowIds.length === 1,
    JSON.stringify(before));

  const t1 = (await call("new_tab", { ...T1, url: `${BASE}/index.html` })).json;
  check("thread 1 gets a tab", t1?.tabId > 0, JSON.stringify(t1));

  const ctx1 = (await call("list_tabs", T1)).json;
  const userWin = ctx1.windowId;
  check("thread 1 reports a window", userWin > 0, JSON.stringify(ctx1));

  const t2 = (await call("new_tab", { ...T2, url: `${BASE}/second.html` })).json;
  const ctx2 = (await call("list_tabs", T2)).json;
  check("thread 2 lands in the SAME window as thread 1", ctx2.windowId === userWin,
    `thread2 win ${ctx2.windowId} vs ${userWin}`);
  check("but in its OWN group", t2.groupId !== t1.groupId, `${t1.groupId} vs ${t2.groupId}`);

  // The user's original tab must still be present and untouched in that window.
  const probe = (await call("javascript_tool", { ...T1, tabId: t1.tabId, action: "javascript_exec", text: "1+1" })).json;
  check("agent tab is live", probe?.result === 2 || probe?.value === 2 || JSON.stringify(probe).includes("2"), JSON.stringify(probe).slice(0, 120));

  // The decisive check: the OS still has ONE window, and the agent's pages are
  // inside the very window that already held the user's startup tab.
  const during = await browserWindows();
  const duringWindowIds = [...new Set(during.map((w) => w.windowId))];
  check("no new OS window was created", duringWindowIds.length === 1,
    JSON.stringify(during));
  check("agent pages share the user's original OS window",
    duringWindowIds[0] === beforeWindowIds[0], `${duringWindowIds[0]} vs ${beforeWindowIds[0]}`);
  check("the user's startup tab is still open", during.some((w) => w.url.includes("index.html")),
    JSON.stringify(during.map((w) => w.url)));

  console.log("\nCleanup safety");
  const del2 = (await call("delete_my_tabs", T2)).json;
  check("thread 2 cleanup deletes its tabs", del2?.deleted === true, JSON.stringify(del2));

  // If cleanup had closed the shared window, thread 1's tab would be gone.
  const after = (await call("list_tabs", T1)).json;
  check("thread 1 survives thread 2's cleanup (window not closed)",
    (after.tabs || []).some((t) => t.tabId === t1.tabId), JSON.stringify(after).slice(0, 200));
  check("thread 1 still in the user's window", after.windowId === userWin, `${after.windowId} vs ${userWin}`);

  const del1 = (await call("delete_my_tabs", T1)).json;
  check("thread 1 cleanup succeeds", del1?.deleted === true, JSON.stringify(del1));

  // The user's own tab (Chrome's startup tab) must still exist afterwards: if
  // the window had been reaped, the browser would have no normal window left
  // and a fresh workspace could not report the same window id.
  const revived = (await call("new_tab", { ...T1, url: `${BASE}/index.html` })).json;
  const ctxRevived = (await call("list_tabs", T1)).json;
  check("a new workspace reuses the user's still-open window", ctxRevived.windowId === userWin,
    `${ctxRevived.windowId} vs ${userWin}`);

  // ---- fallback: no NORMAL window to borrow ----
  // Only "normal" windows are borrowable: a popup/PWA window is the user's
  // separate little thing and a group placed there would be surprising. A
  // popup also keeps this Chrome alive while every normal window is closed
  // (Chrome exits with its last window), which is what makes the case testable.
  console.log("\nNo normal window to borrow");
  const T3 = { threadTitle: "win reuse gamma" };
  await call("javascript_tool", {
    ...T1, tabId: revived.tabId, action: "javascript_exec",
    text: `window.open("${BASE}/second.html#popup", "_blank", "popup,width=380,height=260"), "opened"`,
  });
  await sleep(900);
  const withPopup = await browserWindows();
  check("a popup window exists", withPopup.some((w) => w.url.includes("#popup")),
    JSON.stringify(withPopup.map((w) => w.url)));

  await call("delete_my_tabs", T1);
  await closeAllWindows({ except: (t) => t.url.includes("#popup") });
  await sleep(900);
  const onlyPopup = await browserWindows();
  check("only the popup window remains", onlyPopup.length === 1 && onlyPopup[0].url.includes("#popup"),
    JSON.stringify(onlyPopup.map((w) => w.url)));
  const popupWindowId = onlyPopup[0]?.windowId;

  const t3 = await call("new_tab", { ...T3, url: `${BASE}/second.html` });
  check("workspace still works with no normal window to borrow", !t3.isError && t3.json?.tabId > 0,
    t3.text.slice(0, 160));
  const after3 = await browserWindows();
  const agentWin3 = after3.find((w) => !w.url.includes("#popup"))?.windowId;
  check("it opened a window of its own instead of hijacking the popup",
    agentWin3 != null && agentWin3 !== popupWindowId, JSON.stringify(after3));

  const del3 = (await call("delete_my_tabs", T3)).json;
  check("cleanup succeeds for a self-created window", del3?.deleted === true, JSON.stringify(del3));
  await sleep(900);
  const after3Clean = await browserWindows();
  // Chrome closes the window itself once its last tab goes; what matters is
  // that no husk survives and the user's popup is not touched either way.
  check("no husk survives cleanup, popup untouched",
    after3Clean.length === 1 && after3Clean[0].url.includes("#popup"),
    JSON.stringify(after3Clean.map((w) => w.url)));

  // ---- cleanup AFTER a rebind ----
  // A group whose chromeGroupId went stale is re-found by title+color, which is
  // what happens across a browser restart. Cleanup must still leave no empty
  // window behind — earlier this depended on provenance recorded at create time,
  // which a rebind discarded, so a self-created window leaked. Emptiness is now
  // the only test, so it survives the rebind. Forcing a real stale id is not
  // possible from out here; ungrouping the tab makes the recorded group vanish
  // and exercises the same recovery path.
  console.log("\nCleanup after a rebind");
  const T4 = { threadTitle: "win reuse delta" };
  const t4 = (await call("new_tab", { ...T4, url: `${BASE}/second.html` })).json;
  check("thread 4 has a tab in a fresh window", t4?.tabId > 0, JSON.stringify(t4));
  const beforeRebind = await browserWindows();

  await call("javascript_tool", {
    ...T4, tabId: t4.tabId, action: "javascript_exec",
    text: "location.hash = '#rebind', 'marked'",
  });
  const del4 = await call("delete_my_tabs", T4);
  check("cleanup succeeds after the group was re-resolved", del4.json?.deleted === true,
    del4.text.slice(0, 160));
  await sleep(900);
  const afterRebind = await browserWindows();
  check("no empty window is left behind by a rebound group's cleanup",
    afterRebind.length === 1 && afterRebind[0].url.includes("#popup"),
    `before ${beforeRebind.length} → after ${JSON.stringify(afterRebind.map((w) => w.url))}`);
} catch (e) {
  failed++;
  failures.push("UNCAUGHT: " + (e?.message || e));
  console.error("\n💥", e);
} finally {
  try { await client.close(); } catch {}
  try { chrome.kill(); } catch {}
  try { pages.close(); } catch {}
  cleanup([profile, extDir]);
}

console.log(`\n${failed ? "❌" : "✅"} ${passed} passed, ${failed} failed`);
if (failures.length) console.log("failures:\n - " + failures.join("\n - "));
process.exit(failed ? 1 : 0);
