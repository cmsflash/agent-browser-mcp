#!/usr/bin/env node
// A new workspace must not strand a blank tab.
//
// A Chrome group cannot be created empty, so every group is born around a seed
// tab. The bug this guards: that seed was always about:blank and the caller's
// real tab was opened separately, so every fresh workspace kept a stray blank
// tab forever. The seed must instead BE the caller's first tab.
//
// The cases worth separating are the ones a partial fix passes:
//   * new_tab(url) on a fresh workspace — the direct path
//   * navigate(url) standalone — reaches creation through the server, not the tool
//   * tabs_create — legitimately wants a blank, so must get exactly ONE
//   * a REVIVED workspace — separate code path that had the bug hardcoded
//   * an existing workspace — control: tabs must still accumulate normally

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createServer } from "node:http";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import { root, makeTestExtension, launchChrome, serverEnv, cleanup } from "./harness.mjs";

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
await new Promise((r) => pages.listen(8975, "127.0.0.1", r));
const BASE = "http://127.0.0.1:8975";

const profile = mkdtempSync(join(tmpdir(), "cab-noblank-"));
const extDir = makeTestExtension();
const chrome = launchChrome({
  extensionDir: extDir,
  profileDir: profile,
  args: ["--window-size=1200,800", `${BASE}/index.html`],
});

const transport = new StdioClientTransport({
  command: "node", args: [join(root, "server", "index.mjs")], stderr: "ignore", env: serverEnv,
});
const client = new Client({ name: "no-blank-tab", version: "1.0.0" });
await client.connect(transport);

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const t = (r.content || []).find((c) => c.type === "text");
  let json = null;
  try { json = JSON.parse(t?.text ?? "null"); } catch { json = { _raw: t?.text }; }
  return { isError: !!r.isError, json, text: t?.text || "" };
};

const urlsOf = async (thread) => {
  const list = (await call("list_tabs", thread)).json;
  return (list.tabs || []).map((t) => t.url || "");
};
const isBlank = (u) => u === "about:blank" || u === "";

try {
  for (let i = 0; i < 30; i++) {
    const s = await call("get_status");
    if (!s.isError && s.json?.connected) break;
    await sleep(1000);
  }

  console.log("\nFresh workspace via new_tab(url)");
  const A = { threadTitle: "no blank alpha" };
  const madeA = (await call("new_tab", { ...A, url: `${BASE}/index.html` })).json;
  await sleep(400);
  const a = await urlsOf(A);
  check("exactly one tab", a.length === 1, JSON.stringify(a));
  check("no blank tab", !a.some(isBlank), JSON.stringify(a));
  check("that tab is the requested page", a[0]?.includes("/index.html"), JSON.stringify(a));
  // The returned tabId must be the tab that actually exists, or the caller's
  // very next call would act on a tab it cannot see.
  check("returned tabId is the live tab", madeA?.tabId != null &&
    ((await call("list_tabs", A)).json.tabs || []).some((t) => t.tabId === madeA.tabId),
    JSON.stringify(madeA));
  check("new_tab still reports the loaded url", madeA?.url?.includes("/index.html"), JSON.stringify(madeA));

  console.log("\nFresh workspace via standalone navigate(url)");
  const B = { threadTitle: "no blank beta" };
  await call("navigate", { ...B, url: `${BASE}/second.html` });
  await sleep(400);
  const b = await urlsOf(B);
  check("exactly one tab", b.length === 1, JSON.stringify(b));
  check("no blank tab", !b.some(isBlank), JSON.stringify(b));
  check("that tab is the requested page", b[0]?.includes("/second.html"), JSON.stringify(b));

  console.log("\nFresh workspace via tabs_create (a blank IS the request)");
  const C = { threadTitle: "no blank gamma" };
  await call("tabs_create_mcp", C);
  await sleep(400);
  const c = await urlsOf(C);
  check("exactly one tab — not two", c.length === 1, JSON.stringify(c));
  check("and it is blank, as asked", c.length === 1 && isBlank(c[0]), JSON.stringify(c));

  console.log("\nExisting workspace still accumulates tabs (control)");
  await call("new_tab", { ...A, url: `${BASE}/second.html` });
  await sleep(400);
  const a2 = await urlsOf(A);
  check("second tab is added", a2.length === 2, JSON.stringify(a2));
  check("still no blank tab", !a2.some(isBlank), JSON.stringify(a2));

  console.log("\nRevived workspace (group's window went away)");
  // Close every tab WITHOUT delete_my_tabs, so the registry entry outlives the
  // live group and the next new_tab must revive it.
  for (const id of ((await call("list_tabs", B)).json.tabs || []).map((t) => t.tabId)) {
    await call("close_tab", { ...B, tabId: id });
  }
  await sleep(600);
  check("workspace is now empty", (await urlsOf(B)).length === 0);
  await call("new_tab", { ...B, url: `${BASE}/index.html` });
  await sleep(600);
  const b2 = await urlsOf(B);
  check("revived workspace has exactly one tab", b2.length === 1, JSON.stringify(b2));
  check("revived workspace has no blank tab", !b2.some(isBlank), JSON.stringify(b2));
  check("revived tab is the requested page", b2[0]?.includes("/index.html"), JSON.stringify(b2));

  console.log("\nSeed adoption cannot be driven by the caller");
  // A client-supplied seedTabId must be ignored: otherwise a caller could make
  // new_tab adopt an arbitrary tab instead of opening one.
  const D = { threadTitle: "no blank delta" };
  await call("new_tab", { ...D, url: `${BASE}/index.html` });
  await sleep(400);
  const before = await urlsOf(D);
  const victim = ((await call("list_tabs", A)).json.tabs || [])[0]?.tabId;
  await call("new_tab", { ...D, url: `${BASE}/second.html`, seedTabId: victim });
  await sleep(500);
  const after = await urlsOf(D);
  check("a spoofed seedTabId does not suppress the new tab",
    after.length === before.length + 1, `${JSON.stringify(before)} → ${JSON.stringify(after)}`);
  const aStill = await urlsOf(A);
  check("and the other thread's tab is untouched", aStill.length === 2, JSON.stringify(aStill));
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
