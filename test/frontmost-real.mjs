// OS-level check in the REAL profile: driving agent tabs must never bring
// Chrome to the foreground. Samples frontmost continuously and records when
// each tool call runs; a failure requires a NON-CHROME → CHROME transition
// DURING a call — i.e. focus moved to Chrome while the agent was acting.
//
// Chrome samples outside any call, or a Chrome frontmost that predates the
// call, are user activity on this live machine (the user may be reading this
// very GUI in Chrome) and are reported as contamination, not failure.
//
// With multiple Chrome profiles connected, set CAB_TEST_BROWSER (deviceId or
// email substring) — see real-harness.mjs.
import { execSync } from "node:child_process";
import { connect, mkCall, selectTargetBrowser } from "./real-harness.mjs";

const TH = "frontmost-real check";
const front = () => execSync(`osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true'`).toString().trim();
const client = await connect("frontmost-real");
const call = mkCall(client, TH);

// timestamped samples + [start, end] windows of each tool call
const samples = [];
const actions = [];
const timer = setInterval(() => { try { samples.push([Date.now(), front()]); } catch {} }, 250);
const act = async (label, fn) => {
  const t = Date.now();
  const r = await fn();
  actions.push([label, t, Date.now()]);
  return r;
};

let ok = true;
try {
  await act("select_browser", () => selectTargetBrowser(call).then(() => ({})));
  await act("delete_my_tabs", () => call("delete_my_tabs"));

  const tab = (await act("new_tab", () => call("new_tab", { url: "https://example.com" }))).json;
  await act("screenshot", () => call("screenshot", { tabId: tab.tabId }));
  await act("scroll", () => call("computer", { tabId: tab.tabId, action: "scroll", coordinate: [400, 300], scroll_direction: "down", scroll_amount: 3 }));
  await act("find", () => call("find", { tabId: tab.tabId, query: "Learn more" }));
  await act("navigate", () => call("navigate", { tabId: tab.tabId, url: "https://example.org" }));
  await act("screenshot2", () => call("computer", { tabId: tab.tabId, action: "screenshot" }));

  // Agent tabs share the user's window; one active tab per window means "no
  // agent tab active" is precisely "the user kept theirs".
  const mine = (await act("list_tabs", () => call("list_tabs"))).json;
  const activeAgentTabs = (mine.tabs || []).filter((t) => t.active);
  if (activeAgentTabs.length) {
    ok = false;
    console.log(`❌ agent tab(s) became active: ${JSON.stringify(activeAgentTabs.map((t) => t.url))}`);
  }
} catch (e) {
  ok = false;
  console.log("❌ " + (e?.message || e));
} finally {
  clearInterval(timer);
  try { await call("delete_my_tabs"); } catch {}
  await client.close();
}

const isChrome = (s) => /Chrome/i.test(s);
// For each action, find the samples DURING it. A steal is: some sample during
// the action is Chrome AND the sample just before the action was not Chrome.
// Chrome already frontmost before the action = the user was in Chrome.
const steals = [];
const contaminated = [];
for (const [label, s, e] of actions) {
  const during = samples.filter(([t]) => t >= s && t <= e);
  if (!during.some(([, f]) => isChrome(f))) continue;
  const before = [...samples].reverse().find(([t]) => t < s);
  if (before && isChrome(before[1])) contaminated.push(label);
  else steals.push(label);
}
const chromeTotal = samples.filter(([, f]) => isChrome(f)).length;
console.log(`samples: ${samples.length}, chrome-frontmost: ${chromeTotal}`);
console.log(`actions: ${actions.length}, contaminated (user in Chrome): ${contaminated.length}${contaminated.length ? " — " + contaminated.join(", ") : ""}`);
if (steals.length) {
  ok = false;
  console.log(`❌ FAIL: focus moved to Chrome DURING: ${steals.join(", ")}`);
} else {
  console.log("✅ PASS: no action pulled focus into Chrome" + (contaminated.length ? " (user was using Chrome during some actions; those windows are excluded)" : ""));
}
process.exit(ok ? 0 : 1);
