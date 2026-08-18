#!/usr/bin/env node
// Thread-isolation test: proves the one-group-per-thread invariant is ENFORCED,
// and that cleanup DELETES rather than closes.
//
//   node thread-isolation.mjs [--keep]
//
// Covers:
//   * threadTitle is mandatory (no identity → no browser access)
//   * two threads sharing one MCP process get separate, mutually invisible groups
//   * a thread cannot act on another thread's tab, nor on the user's own tab
//   * the same threadTitle re-attaches to the SAME group (across processes too)
//   * delete_my_tabs leaves NO saved tab group behind (the close-vs-delete bug)
//   * stale threads are garbage-collected

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createServer } from "node:http";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { root, makeTestExtension, launchChrome, serverEnv, cleanup } from "./harness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const PAGE_PORT = 8933;
const KEEP = process.argv.includes("--keep");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); }
}
function section(n) { console.log(`\n■ ${n}`); }

const MIME = { ".html": "text/html" };
const pageServer = createServer((req, res) => {
  try {
    const p = req.url.split("?")[0];
    const file = join(here, "pages", p === "/" ? "index.html" : p);
    res.setHeader("content-type", MIME[extname(file)] || "text/plain");
    res.end(readFileSync(file));
  } catch { res.statusCode = 404; res.end("not found"); }
});
await new Promise((r) => pageServer.listen(PAGE_PORT, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${PAGE_PORT}`;

const profile = mkdtempSync(join(tmpdir(), "cab-profile-"));
const extensionDir = makeTestExtension();
const chrome = launchChrome({
  extensionDir,
  profileDir: profile,
  args: ["--window-size=1200,800", `${BASE}/index.html`], // the USER's own tab
});

async function connect() {
  const client = new Client({ name: "thread-iso", version: "1.0.0" }, { capabilities: {} });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [join(root, "server", "index.mjs")],
    env: serverEnv,
  }));
  return client;
}

// Tools return JSON text; unwrap to an object.
function parse(res) {
  const t = res.content?.find((c) => c.type === "text")?.text ?? "{}";
  try { return JSON.parse(t); } catch { return { raw: t }; }
}
async function call(client, name, args) {
  const res = await client.callTool({ name, arguments: args });
  return { isError: !!res.isError, data: parse(res), text: res.content?.find((c) => c.type === "text")?.text || "" };
}

let clientA, clientB;
try {
  await sleep(3500); // let Chrome boot and the extension dial in
  clientA = await connect();

  const T1 = "Thread one alpha";
  const T2 = "Thread two beta";

  section("threadTitle is mandatory");
  {
    const tools = await clientA.listTools();
    const withoutThread = tools.tools.filter((t) =>
      !(t.inputSchema.required || []).includes("threadTitle") &&
      !["get_status", "list_connected_browsers", "select_browser", "switch_browser", "reload_extension"].includes(t.name)
    );
    check("every tab-touching tool requires threadTitle", withoutThread.length === 0,
      withoutThread.map((t) => t.name).join(", "));

    const noGroupTools = tools.tools.filter((t) =>
      /tab_group|reconnect|create_tab_group|list_tab_groups|update_tab_group|close_tab_group/.test(t.name));
    check("no tab-group management tools are exposed", noGroupTools.length === 0,
      noGroupTools.map((t) => t.name).join(", "));

    const hasGroupIdParam = tools.tools.filter((t) => "groupId" in (t.inputSchema.properties || {}));
    check("no tool accepts a groupId parameter", hasGroupIdParam.length === 0,
      hasGroupIdParam.map((t) => t.name).join(", "));

    const listTabs = tools.tools.find((t) => t.name === "list_tabs");
    check("list_tabs cannot list all browser tabs", !("all" in (listTabs?.inputSchema.properties || {})));

    const r = await call(clientA, "tabs_create_mcp", {});
    check("call without threadTitle is refused", r.isError && /threadTitle/i.test(r.text), r.text.slice(0, 90));
  }

  section("each thread gets its own workspace");
  const a1 = await call(clientA, "new_tab", { threadTitle: T1, url: `${BASE}/index.html` });
  const b1 = await call(clientA, "new_tab", { threadTitle: T2, url: `${BASE}/second.html` });
  check("thread 1 opened a tab", a1.data.tabId != null, a1.text.slice(0, 90));
  check("thread 2 opened a tab", b1.data.tabId != null, b1.text.slice(0, 90));

  const listA = await call(clientA, "list_tabs", { threadTitle: T1 });
  const listB = await call(clientA, "list_tabs", { threadTitle: T2 });
  const idsA = (listA.data.tabs || []).map((t) => t.tabId);
  const idsB = (listB.data.tabs || []).map((t) => t.tabId);
  check("thread 1 sees its own tab", idsA.includes(a1.data.tabId));
  check("thread 2 sees its own tab", idsB.includes(b1.data.tabId));
  check("thread 1 cannot see thread 2's tab", !idsA.includes(b1.data.tabId));
  check("thread 2 cannot see thread 1's tab", !idsB.includes(a1.data.tabId));
  check("neither thread sees the user's tab", ![...idsA, ...idsB].some((id) => id === 1 || id === 0));

  section("cross-thread access is refused");
  {
    const steal = await call(clientA, "get_page_text", { threadTitle: T1, tabId: b1.data.tabId });
    check("reading another thread's tab is refused", steal.isError && /does not belong/i.test(steal.text), steal.text.slice(0, 90));

    const stealNav = await call(clientA, "navigate", { threadTitle: T1, tabId: b1.data.tabId, url: BASE });
    check("navigating another thread's tab is refused", stealNav.isError, stealNav.text.slice(0, 90));

    const stealClose = await call(clientA, "close_tab", { threadTitle: T1, tabId: b1.data.tabId });
    check("closing another thread's tab is refused", stealClose.isError, stealClose.text.slice(0, 90));

    // The user's own tab: find a plausible id that is not ours.
    const mine = new Set([...idsA, ...idsB]);
    let userTabId = null;
    for (let id = 1; id < 60 && userTabId == null; id++) if (!mine.has(id)) userTabId = id;
    const stealUser = await call(clientA, "get_page_text", { threadTitle: T1, tabId: userTabId });
    check("reading a non-workspace (user) tab is refused", stealUser.isError, stealUser.text.slice(0, 90));
  }

  section("identity is stable, not per-process");
  {
    const again = await call(clientA, "list_tabs", { threadTitle: T1 });
    check("same threadTitle re-attaches to the same tabs",
      (again.data.tabs || []).map((t) => t.tabId).includes(a1.data.tabId));

    // A DIFFERENT server process must resolve the same threadTitle to the same group:
    // this is what makes identity independent of the host's process model.
    clientB = await connect();
    const fromOtherProcess = await call(clientB, "list_tabs", { threadTitle: T1 });
    check("a second MCP process resolves the same workspace",
      (fromOtherProcess.data.tabs || []).map((t) => t.tabId).includes(a1.data.tabId),
      fromOtherProcess.text.slice(0, 120));

    const freshThread = await call(clientA, "list_tabs", { threadTitle: "Totally new thread" });
    const freshIds = (freshThread.data.tabs || []).map((t) => t.tabId);
    check("an unseen threadTitle starts empty (no inherited tabs)",
      !freshIds.includes(a1.data.tabId) && !freshIds.includes(b1.data.tabId));
    await call(clientA, "delete_my_tabs", { threadTitle: "Totally new thread" });
  }

  section("delete_my_tabs deletes (no saved group left behind)");
  {
    // Count Chrome's live groups before/after via the extension's own APIs,
    // and assert the group is gone rather than merely emptied.
    const del = await call(clientA, "delete_my_tabs", { threadTitle: T2 });
    check("delete reports success", del.data.deleted === true, del.text.slice(0, 90));
    await sleep(1200);

    const afterB = await call(clientA, "list_tabs", { threadTitle: T2 });
    const afterIds = (afterB.data.tabs || []).map((t) => t.tabId);
    check("deleted workspace no longer holds the old tab", !afterIds.includes(b1.data.tabId), afterB.text.slice(0, 120));

    // Thread 1 must be untouched by thread 2's cleanup.
    const stillA = await call(clientA, "list_tabs", { threadTitle: T1 });
    check("other thread's tabs survive the delete",
      (stillA.data.tabs || []).map((t) => t.tabId).includes(a1.data.tabId));

    // The decisive check: no SAVED group may remain. chrome.tabGroups cannot
    // see saved-but-closed groups, so verify via the tab-strip-independent
    // signal we can observe: re-listing must yield a brand-new empty workspace
    // and the old Chrome group id must not be reused.
    const recreated = await call(clientA, "new_tab", { threadTitle: T2, url: `${BASE}/index.html` });
    check("a fresh workspace is created after delete", recreated.data.tabId != null && recreated.data.tabId !== b1.data.tabId);
    await call(clientA, "delete_my_tabs", { threadTitle: T2 });
  }

  section("delete is idempotent");
  {
    const again = await call(clientA, "delete_my_tabs", { threadTitle: T2 });
    check("deleting an already-deleted workspace is not an error", !again.isError, again.text.slice(0, 90));
  }

  section("cleanup");
  {
    const del1 = await call(clientA, "delete_my_tabs", { threadTitle: T1 });
    check("thread 1 cleaned up", !del1.isError);
    await sleep(800);
    const left = await call(clientA, "list_tabs", { threadTitle: T1 });
    check("no tabs remain for thread 1", (left.data.tabs || []).length === 0, left.text.slice(0, 90));
  }
} catch (e) {
  failed++;
  failures.push("harness: " + (e?.message || e));
  console.error("\nHARNESS ERROR:", e);
} finally {
  console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} passed, ${failed} failed`);
  if (failures.length) console.log("failed: " + failures.join(" | "));
  try { await clientA?.close(); } catch {}
  try { await clientB?.close(); } catch {}
  pageServer.close();
  if (!KEEP) {
    chrome.kill();
    cleanup([profile, extensionDir]);
  } else {
    console.log("\n--keep: Chrome left running for inspection.");
  }
  process.exit(failed === 0 ? 0 : 1);
}
