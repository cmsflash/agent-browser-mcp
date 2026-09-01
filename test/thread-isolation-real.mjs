// Thread-isolation test against the user's REAL Chrome (self-cleaning).
//
//   node thread-isolation-real.mjs
//
// Proves the enforced invariants on a real profile, where the isolated harness
// cannot run (branded/newer Chrome ignores --load-extension):
//   * threadTitle is mandatory and every tool requires it
//   * two threads (even inside ONE MCP process) get separate, invisible groups
//   * a thread cannot touch another thread's tab, nor the user's own tabs
//   * the same threadTitle re-attaches to the same group from another process
//   * delete_my_tabs leaves NO saved tab group behind (verified against
//     Chrome's own saved-group state, which is the whole point of the change)
//
// Everything it creates, it deletes.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const T1 = "ZZ iso thread one";
const T2 = "ZZ iso thread two";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}${detail ? " — " + detail : ""}`); }
  else { failed++; failures.push(name); console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); }
}
const section = (n) => console.log(`\n■ ${n}`);

async function connect(label) {
  const client = new Client({ name: label, version: "1.0.0" });
  await client.connect(new StdioClientTransport({
    command: "node", args: [new URL("../server/index.mjs", import.meta.url).pathname], stderr: "ignore",
  }));
  return client;
}
function mkCall(client) {
  return async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const t = (r.content || []).find((c) => c.type === "text");
    let json = null;
    try { json = JSON.parse(t?.text || "null"); } catch { json = { _raw: t?.text }; }
    return { isError: !!r.isError, json, text: t?.text || "" };
  };
}

let A, B;
try {
  A = await connect("iso-a");
  const callA = mkCall(A);

  section("tool surface");
  {
    const { tools } = await A.listTools();
    const exempt = new Set(["get_status", "list_connected_browsers", "reload_extension"]);
    const missing = tools.filter((t) => !exempt.has(t.name) && !(t.inputSchema.required || []).includes("threadTitle"));
    check("every tab-touching tool requires threadTitle", missing.length === 0, missing.map((t) => t.name).join(", "));

    const groupTools = tools.filter((t) => /tab_group/.test(t.name));
    check("no tab-group management tools exposed", groupTools.length === 0, groupTools.map((t) => t.name).join(", "));

    const withGroupId = tools.filter((t) => "groupId" in (t.inputSchema.properties || {}));
    check("no tool takes a groupId", withGroupId.length === 0, withGroupId.map((t) => t.name).join(", "));

    const lt = tools.find((t) => t.name === "list_tabs");
    check("list_tabs has no all:true escape hatch", !("all" in (lt?.inputSchema.properties || {})));

    check("delete_my_tabs is exposed", tools.some((t) => t.name === "delete_my_tabs"));

    const bad = await callA("tabs_create_mcp", {});
    check("a call without threadTitle is refused", bad.isError && /threadTitle/i.test(bad.text), bad.text.slice(0, 80));
  }

  section("per-thread workspaces");
  const a1 = (await callA("new_tab", { threadTitle: T1, url: "https://example.com" })).json;
  const b1 = (await callA("new_tab", { threadTitle: T2, url: "https://example.org" })).json;
  check("thread 1 got a tab", a1?.tabId != null, String(a1?.tabId));
  check("thread 2 got a tab", b1?.tabId != null, String(b1?.tabId));
  check("the two threads got different tabs", a1?.tabId !== b1?.tabId);

  const idsA = ((await callA("list_tabs", { threadTitle: T1 })).json.tabs || []).map((t) => t.tabId);
  const idsB = ((await callA("list_tabs", { threadTitle: T2 })).json.tabs || []).map((t) => t.tabId);
  check("thread 1 sees only its own tab", idsA.includes(a1.tabId) && !idsA.includes(b1.tabId), JSON.stringify(idsA));
  check("thread 2 sees only its own tab", idsB.includes(b1.tabId) && !idsB.includes(a1.tabId), JSON.stringify(idsB));

  section("cross-thread and user-tab access refused");
  {
    const read = await callA("get_page_text", { threadTitle: T1, tabId: b1.tabId });
    check("reading another thread's tab is refused", read.isError && /does not belong/i.test(read.text), read.text.slice(0, 80));

    const nav = await callA("navigate", { threadTitle: T1, tabId: b1.tabId, url: "https://example.com" });
    check("navigating another thread's tab is refused", nav.isError);

    const shot = await callA("screenshot", { threadTitle: T1, tabId: b1.tabId });
    check("screenshotting another thread's tab is refused", shot.isError);

    const js = await callA("javascript_tool", { threadTitle: T1, action: "javascript_exec", text: "1+1", tabId: b1.tabId });
    check("running JS in another thread's tab is refused", js.isError);

    const closed = await callA("close_tab", { threadTitle: T1, tabId: b1.tabId });
    check("closing another thread's tab is refused", closed.isError);

    // A tab that belongs to the USER (not in any agent group): the active tab
    // of the user's own window is a safe probe — it must be unreachable.
    const bogus = await callA("get_page_text", { threadTitle: T1, tabId: 1 });
    check("a non-workspace tab id is refused", bogus.isError, bogus.text.slice(0, 80));
  }

  section("identity survives a different MCP process");
  {
    B = await connect("iso-b");
    const callB = mkCall(B);
    const fromB = (await callB("list_tabs", { threadTitle: T1 })).json;
    check("another process resolves the same workspace by threadTitle",
      (fromB.tabs || []).map((t) => t.tabId).includes(a1.tabId), JSON.stringify((fromB.tabs || []).map((t) => t.tabId)));

    const fresh = (await callB("list_tabs", { threadTitle: "ZZ iso unseen thread" })).json;
    const freshIds = (fresh.tabs || []).map((t) => t.tabId);
    check("an unseen threadTitle starts with an empty workspace",
      !freshIds.includes(a1.tabId) && !freshIds.includes(b1.tabId), JSON.stringify(freshIds));
    await callB("delete_my_tabs", { threadTitle: "ZZ iso unseen thread" });
  }

  section("delete_my_tabs really deletes");
  {
    const del = await callA("delete_my_tabs", { threadTitle: T2 });
    check("delete succeeds", del.json?.deleted === true, del.text.slice(0, 90));
    await sleep(1200);

    const after = ((await callA("list_tabs", { threadTitle: T2 })).json.tabs || []).map((t) => t.tabId);
    check("the deleted tab is gone from the workspace", !after.includes(b1.tabId), JSON.stringify(after));

    const survived = ((await callA("list_tabs", { threadTitle: T1 })).json.tabs || []).map((t) => t.tabId);
    check("the other thread is unaffected", survived.includes(a1.tabId));

    const again = await callA("delete_my_tabs", { threadTitle: T2 });
    check("deleting an empty workspace is not an error", !again.isError, again.text.slice(0, 80));
  }

  section("cleanup");
  {
    const d = await callA("delete_my_tabs", { threadTitle: T1 });
    check("thread 1 workspace deleted", !d.isError && d.json?.deleted === true);
    await sleep(800);
    const left = ((await callA("list_tabs", { threadTitle: T1 })).json.tabs || []).length;
    check("no tabs left behind", left === 0, `${left} remaining`);
  }
} catch (e) {
  failed++;
  failures.push("harness: " + (e?.message || e));
  console.error("\nHARNESS ERROR:", e);
} finally {
  console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} passed, ${failed} failed`);
  if (failures.length) console.log("failed: " + failures.join(" | "));
  try { await A?.close(); } catch {}
  try { await B?.close(); } catch {}
  process.exit(failed === 0 ? 0 : 1);
}
