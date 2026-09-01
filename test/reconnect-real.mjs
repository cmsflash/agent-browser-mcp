// End to end in the REAL profile: a thread's workspace is keyed by its
// threadTitle, NOT by its process. Process A creates a workspace and exits;
// process B — knowing only the same threadTitle — re-attaches to the same
// tabs and keeps working. This is what lets an agent restart mid-task
// without stranding its tabs.
//
// With multiple Chrome profiles connected, set CAB_TEST_BROWSER (deviceId or
// email substring) — see real-harness.mjs.
import { connect, mkCall, selectTargetBrowser, requireVersion } from "./real-harness.mjs";

const TH = "reconnect-real proof";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = [];
const step = (n, ok, d = "") => { out.push(`${ok ? "✅" : "❌"} ${n}${d ? " — " + d : ""}`); };

// --- agent process A ---
const a = await connect("reconnect-A");
const callA = mkCall(a, TH);
await selectTargetBrowser(callA);
await requireVersion(callA, "1.2.0");
await callA("delete_my_tabs"); // reset any crashed-run leftover (idempotent)

const t1 = (await callA("new_tab", { url: "https://example.com" })).json;
step("A: workspace created", t1.tabId > 0, `tab ${t1.tabId}`);
await callA("new_tab", { url: "https://iana.org" });
const ctxA = (await callA("list_tabs")).json;
step("A: two tabs in the workspace", (ctxA.tabs || []).length === 2, JSON.stringify(ctxA.tabs?.map((t) => t.url)));
await a.close();                                  // agent "shuts down"
await sleep(3000);                                // hub may die with it; relays re-elect

// --- agent process B: knows only the threadTitle ---
const b = await connect("reconnect-B");
const callB = mkCall(b, TH);
let up = false;
for (let i = 0; i < 10 && !up; i++) {
  try {
    await selectTargetBrowser(callB);
    const s = await callB("get_status");
    up = !s.isError && s.json?.connected;
  } catch { /* hub mid-re-election */ }
  if (!up) await sleep(1500);
}
step("B: bridge reachable after A exited", up);

const ctxB = (await callB("list_tabs")).json;
step("B: re-attached to A's tabs by threadTitle alone", (ctxB.tabs || []).length === 2,
  JSON.stringify(ctxB.tabs?.map((t) => t.url)));
const ianaTab = (ctxB.tabs || []).find((t) => (t.url || "").includes("iana"));
step("B: sees the tab it expected", !!ianaTab);

const txt = ianaTab ? (await callB("get_page_text", { tabId: ianaTab.tabId })).json : null;
step("B: can drive a re-attached tab", !!(txt?.text || "").includes("IANA"));

const del = (await callB("delete_my_tabs")).json;
step("B: cleanup deletes the inherited workspace", del.deleted === true && del.closedTabs === 2, `${del.closedTabs} tab(s)`);
await b.close();

console.log(out.join("\n"));
process.exit(out.some((l) => l.startsWith("❌")) ? 1 : 0);
