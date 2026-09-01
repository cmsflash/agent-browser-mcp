// Smoke test against the user's REAL Chrome profile (minimal, self-cleaning).
// Covers: hub connection, implicit workspace creation, background driving,
// trusted click, stale-ref refusal, main-world JS, and true cleanup.
//
// With multiple Chrome profiles connected, set CAB_TEST_BROWSER (deviceId or
// email substring) — see real-harness.mjs.
import { connect, mkCall, selectTargetBrowser, requireVersion } from "./real-harness.mjs";

const TH = "smoke-real test";
const client = await connect("smoke-real");
const call = mkCall(client, TH);
const out = [];
const step = (name, ok, detail = "") => {
  out.push(`${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) throw new Error(name);
};

try {
  const browser = await selectTargetBrowser(call);
  step("target browser selected", true, browser.email || browser.name);
  await requireVersion(call, "1.2.0");

  // NO retry loop: the very first status call must succeed on its own.
  const st = await call("get_status");
  step("first call connects with no retry", !st.isError && st.json.connected,
    `bridge mode: ${st.json?.session?.bridgeMode}, extension v${st.json?.extensionVersion}`);

  // reset any workspace left by a crashed previous run (idempotent)
  await call("delete_my_tabs");

  const tab = (await call("new_tab", { url: "https://example.com" })).json;
  step("workspace created implicitly by first tab", tab.tabId > 0 && tab.active === false, `tab ${tab.tabId}`);

  const txt = (await call("get_page_text", { tabId: tab.tabId })).json;
  step("page text read", (txt.text || "").includes("Example Domain"));

  const shot = await call("screenshot", { tabId: tab.tabId });
  step("background screenshot captured", !!shot.img && shot.img.data.length > 3000, `${Math.round(shot.img.data.length * 3 / 4 / 1024)}KB jpeg`);

  const found = (await call("find", { tabId: tab.tabId, query: "Learn more" })).json;
  step("element found by text", found.count >= 1 && ["natural-language", "selector"].includes(found.results[0].matchedBy),
    `${found.results?.[0]?.ref} "${found.results?.[0]?.text}"`);

  await call("click", { tabId: tab.tabId, ref: found.results[0].ref });
  const wf = await call("wait_for", { tabId: tab.tabId, text: "IANA", timeoutMs: 20000 });
  step("trusted click navigated to iana.org", !wf.isError && wf.json.satisfied === true);

  const stale = await call("click", { tabId: tab.tabId, ref: found.results[0].ref });
  step("stale ref rejected after navigation", stale.isError && /previous page|stale/i.test(stale.text), stale.text.slice(0, 90));

  const kb = await call("javascript_tool", { action: "javascript_exec", text: "location.host", tabId: tab.tabId });
  step("javascript runs in main world", kb.json.result === "www.iana.org" || kb.json.result === "iana.org", kb.json.result);

  // Agent tabs share the user's window, and a window has exactly one active
  // tab — so "no agent tab is active" IS "the user kept theirs". Only the
  // agent's own tabs are visible to it, which is all this invariant needs.
  const mine = (await call("list_tabs")).json;
  step("user's tab undisturbed (no agent tab active)",
    (mine.tabs || []).length >= 1 && mine.tabs.every((t) => !t.active),
    JSON.stringify(mine.tabs?.map((t) => [String(t.url).slice(0, 30), t.active])));

  const del = (await call("delete_my_tabs")).json;
  step("cleanup deletes the workspace", del.deleted === true && del.closedTabs >= 1, `${del.closedTabs} tab(s)`);
} catch (e) {
  out.push("❌ " + (e?.message || e));
} finally {
  try { await call("delete_my_tabs"); } catch {}
  console.log(out.join("\n"));
  await client.close();
}
process.exit(out.some((l) => l.startsWith("❌")) ? 1 : 0);
