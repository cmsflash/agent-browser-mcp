#!/usr/bin/env node
// Background-driving guarantee test (OS level).
//
// Launches the test Chrome, then drives an intensive battery of agent actions
// while sampling the macOS frontmost application every 500ms. PASS iff the
// test Chrome instance never becomes frontmost after its initial launch
// window, and the in-browser active tab never changes.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execSync } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { root, makeTestExtension, launchChrome, serverEnv, cleanup } from "./harness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function frontApp() {
  try {
    const out = execSync("lsappinfo info -only name `lsappinfo front`", { encoding: "utf8" });
    return (out.match(/"LSDisplayName"="([^"]+)"/) || [])[1] || "unknown";
  } catch {
    return "unknown";
  }
}

const MIME = { ".html": "text/html", ".json": "application/json" };
const pageServer = createServer((req, res) => {
  const path = req.url.split("?")[0];
  if (path === "/api/data.json") { res.setHeader("content-type", "application/json"); res.end('{"answer":42}'); return; }
  try {
    const file = join(here, "pages", path === "/" ? "index.html" : path);
    res.setHeader("content-type", MIME[extname(file)] || "text/plain");
    res.end(readFileSync(file));
  } catch { res.statusCode = 404; res.end("nf"); }
});
await new Promise((r) => pageServer.listen(8951, "127.0.0.1", r));
const BASE = "http://127.0.0.1:8951";

const originalFront = frontApp();
console.log("frontmost before launch:", originalFront);

const profile = mkdtempSync(join(tmpdir(), "cab-bg-"));
const extensionDir = makeTestExtension();  // isolated port: never touches the real Chrome
const chrome = launchChrome({
  extensionDir,
  profileDir: profile,
  // remote-debugging is the TEST's own out-of-band view of the browser: agent
  // tabs share the user's window now, so "which tab is active" must be read
  // from Chrome itself, not from tools that only see the agent's own tabs.
  args: ["--remote-debugging-port=9447", "--window-size=1000,700", "--window-position=200,200", `${BASE}/index.html`],
});

// The user's own page targets, observed out-of-band (the agent's tools can
// only ever see the agent's own tabs).
async function userPages(excludeUrls = new Set()) {
  const targets = await (await fetch("http://127.0.0.1:9447/json/list")).json();
  return targets.filter((x) => x.type === "page" && !excludeUrls.has(x.url));
}
await sleep(2500);
console.log("frontmost after launch:", frontApp(), "(launch itself may focus — that's the OS, not the agent)");

// hand focus back to the previously-front app so we can observe steals
try { execSync(`osascript -e 'tell application "${originalFront}" to activate'`); } catch {}
await sleep(800);
console.log("frontmost after refocus:", frontApp());

// frontmost sampler
const samples = [];
const sampler = setInterval(() => samples.push(frontApp()), 500);

const transport = new StdioClientTransport({ command: "node", args: [join(root, "server", "index.mjs")], stderr: "pipe", env: serverEnv });
const client = new Client({ name: "bg-guarantee", version: "1.0.0" });
await client.connect(transport);
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const t = (r.content || []).find((c) => c.type === "text");
  return { isError: !!r.isError, json: t ? (() => { try { return JSON.parse(t.text); } catch { return { _raw: t.text }; } })() : null };
};

const THREAD = "bg guarantee";
// Every tool call carries the thread identity; the group is implicit.
const t = (name, args = {}) => call(name, { threadTitle: THREAD, ...args });

let ok = true;
for (let i = 0; i < 25; i++) { const s = await call("get_status"); if (!s.isError && s.json?.connected) break; await sleep(1000); }

// Record the user's pre-existing tabs BEFORE the agent does anything: agent
// tabs now share this window, so these must survive it untouched.
const userPagesBefore = await userPages();
console.log("user's pages before:", userPagesBefore.map((p) => p.url).join(", "));
// Precondition for the "no agent tab is active" assertion below: a borrowable
// window exists, so the agent shares it instead of creating its own (where its
// tab would necessarily be that window's active one).
if (!userPagesBefore.length) {
  console.log("❌ FAIL: no user window to borrow — the focus assertion would be vacuous");
  process.exit(1);
}

console.log("\ndriving agent action battery…");
const first = (await t("new_tab", { url: `${BASE}/index.html` })).json;
const tab = first.tabId;
const battery = [
  ["new_tab", { url: `${BASE}/second.html` }],
  ["navigate", { tabId: tab, url: `${BASE}/second.html` }],
  ["navigate", { tabId: tab, url: "back" }],
  ["read_page", { tabId: tab }],
  ["screenshot", { tabId: tab }],
  ["screenshot", { tabId: tab, fullPage: true }],
  ["click", { tabId: tab, selector: "#inc" }],
  ["fill", { tabId: tab, selector: "#textInput", text: "background test" }],
  ["computer", { tabId: tab, action: "key", text: "ctrl+a" }],
  ["computer", { tabId: tab, action: "double_click", coordinate: [300, 300] }],
  ["computer", { tabId: tab, action: "scroll", coordinate: [600, 40], scroll_direction: "down", scroll_amount: 4 }],
  ["drag_and_drop", { tabId: tab, from: { selector: "#pointerBox" }, to: { selector: "#pointerTarget" } }],
  ["javascript_tool", { tabId: tab, action: "javascript_exec", text: "document.title" }],
  ["wait_for", { tabId: tab, selector: "body", timeoutMs: 2000 }],
];
for (const [name, args] of battery) {
  const r = await t(name, args);
  if (r.isError) { console.log(`  ⚠ ${name} errored: ${JSON.stringify(r.json).slice(0, 120)}`); }
  else process.stdout.write(`  ${name} ✓\n`);
}

// Agent tabs share the user's window, and a window has exactly ONE active tab
// — so "no agent tab is active" is precisely the guarantee that the user's tab
// kept the focus. This is decidable from the agent's own view of its tabs.
const agentTabs = (await t("list_tabs")).json.tabs || [];
const agentActive = agentTabs.filter((x) => x.active);
const agentWindows = new Set(agentTabs.map((x) => x.windowId));

// The user's own tabs must still be there afterwards.
const urlsAfter = new Set((await userPages()).map((p) => p.url));
const userPagesLost = userPagesBefore.filter((p) => !urlsAfter.has(p.url));

await t("delete_my_tabs");
clearInterval(sampler);

const chromeSteals = samples.filter((s) => s.includes("Chrome for Testing")).length;
console.log(`\nsamples: ${samples.length}, frontmost distribution:`, [...new Set(samples)].join(", "));
console.log(`Chrome-for-Testing frontmost samples during battery: ${chromeSteals}`);
console.log(`agent tabs: ${agentTabs.length} in ${agentWindows.size} window(s); active among them: ${agentActive.length}`);

if (chromeSteals > 0) { ok = false; console.log("❌ FAIL: agent actions brought Chrome to the foreground"); }
else console.log("✅ PASS: Chrome never became frontmost during agent driving");

if (agentTabs.length === 0) { ok = false; console.log("❌ FAIL: agent had no tabs — the battery proved nothing"); }

// The load-bearing one: agent tabs share the user's window, and a window has
// exactly one active tab, so an inactive agent tab means the user kept theirs.
else if (agentActive.length > 0) {
  ok = false;
  console.log(`❌ FAIL: an agent tab became the active tab (${agentActive.map((x) => x.url).join(", ")})`);
} else console.log("✅ PASS: no agent tab ever became active — the user's tab kept focus");

if (userPagesLost.length > 0) {
  ok = false;
  console.log(`❌ FAIL: the user's own tabs disappeared: ${userPagesLost.map((p) => p.url).join(", ")}`);
} else console.log("✅ PASS: the user's own tabs survived untouched");

await client.close();
chrome.kill();
pageServer.close();
cleanup([profile, extensionDir]);
process.exit(ok ? 0 : 1);
