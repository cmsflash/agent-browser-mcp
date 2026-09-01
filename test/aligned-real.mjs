// Live check of the aligned tool surface against the user's real Chrome:
// tabs_context/tabs_create, read_page/find, computer zoom, browser_batch,
// javascript REPL, gif_creator, resize_window, browsers, close_tab.
//
// With multiple Chrome profiles connected, set CAB_TEST_BROWSER (deviceId or
// email substring) — see real-harness.mjs.
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { connect, mkCall, selectTargetBrowser, requireVersion } from "./real-harness.mjs";

const TH = "aligned-real check";
const client = await connect("aligned-real");
const call = mkCall(client, TH);
const out = [];
const step = (n, ok, d = "") => { out.push(`${ok ? "✅" : "❌"} ${n}${d ? " — " + d : ""}`); };

try {
  await selectTargetBrowser(call);
  await requireVersion(call, "1.2.0");
  await call("delete_my_tabs"); // reset any crashed-run leftover (idempotent)

  const st = (await call("get_status")).json;
  step("get_status reports the session", st.serverVersion === "1.2.1" && !!st.session?.selectedBrowser, st.session?.selectedProfile || "");

  const ctx0 = (await call("tabs_context_mcp")).json;
  step("fresh thread's context is empty", (ctx0.tabs || []).length === 0, JSON.stringify(ctx0).slice(0, 90));

  const tab = (await call("tabs_create_mcp")).json;
  step("tabs_create_mcp starts the workspace", tab.tabId > 0, `tab ${tab.tabId}`);

  await call("navigate", { url: "https://example.com", tabId: tab.tabId });
  const rp = (await call("read_page", { tabId: tab.tabId, filter: "interactive" })).json;
  step("read_page interactive + ref_N", /\[ref=ref_\d+\]/.test(rp.outline || ""), (rp.outline || "").split("\n")[0]);

  const f = (await call("find", { tabId: tab.tabId, query: "more information link" })).json;
  step("NL find locates the link", f.count >= 1 && /learn more/i.test(f.results[0].text || ""), `${f.results?.[0]?.ref} "${f.results?.[0]?.text}"`);

  const z = await call("computer", { tabId: tab.tabId, action: "zoom", region: [0, 0, 400, 200] });
  step("computer zoom returns magnified image", !!z.img && z.json?.zoom?.magnification > 1, `x${z.json?.zoom?.magnification}`);

  const b = await call("browser_batch", { actions: [
    { name: "navigate", input: { url: "https://example.org", tabId: tab.tabId } },
    { name: "get_page_text", input: { tabId: tab.tabId } },
    { name: "computer", input: { action: "screenshot", tabId: tab.tabId } },
  ]});
  const btxt = b.content.filter((x) => x.type === "text").map((x) => x.text).join("\n");
  step("browser_batch runs 3 steps + image", /\[3\/3\]/.test(btxt) && b.content.some((x) => x.type === "image"), btxt.slice(0, 50).replace(/\n/g, " "));

  const js = (await call("javascript_tool", { action: "javascript_exec", text: "const a=6,b=7; a*b", tabId: tab.tabId })).json;
  step("javascript_tool REPL semantics", js.result === "42");

  await call("gif_creator", { tabId: tab.tabId, action: "start_recording" });
  await call("computer", { tabId: tab.tabId, action: "scroll", coordinate: [400, 300], scroll_direction: "down", scroll_amount: 2 });
  await call("navigate", { url: "https://example.com", tabId: tab.tabId });
  const stop = (await call("gif_creator", { tabId: tab.tabId, action: "stop_recording" })).json;
  const exp = (await call("gif_creator", { tabId: tab.tabId, action: "export", filename: "aligned-real-check" })).json;
  const isGif = exp.path && existsSync(exp.path) && readFileSync(exp.path).subarray(0, 6).toString("ascii") === "GIF89a";
  step("gif_creator records + exports a real GIF", stop.frames >= 2 && exp.exported && isGif, `${exp.frames} frames, ${Math.round((exp.sizeBytes || 0) / 1024)}KB`);
  if (exp.path && existsSync(exp.path)) unlinkSync(exp.path);

  // Agent tabs share the USER's window, so a real resize is user-visible:
  // measure, resize, verify the shared-window flag, then restore.
  const dim = (await call("javascript_tool", { action: "javascript_exec", text: "JSON.stringify([outerWidth, outerHeight])", tabId: tab.tabId })).json;
  const [w0, h0] = JSON.parse(dim.result || "[0,0]");
  const rw = (await call("resize_window", { tabId: tab.tabId, width: 1000, height: 720 })).json;
  const back = (await call("resize_window", { tabId: tab.tabId, width: w0, height: h0 })).json;
  step("resize_window resizes + flags the shared window, then restores",
    Math.abs((rw.width || 0) - 1000) <= 20 && rw.sharedWithUser === true && Math.abs((back.width || 0) - w0) <= 20,
    `${w0}x${h0} → ${rw.width}x${rw.height} → ${back.width}x${back.height}`);

  const br = (await call("list_connected_browsers")).json;
  step("list_connected_browsers sees the real Chrome", (br.browsers || []).length >= 1, br.browsers?.[0]?.email || br.browsers?.[0]?.name);

  const tc = (await call("tabs_create_mcp")).json;
  const cl = (await call("close_tab", { tabId: tc.tabId })).json;
  step("tabs_create_mcp + close_tab round-trip", tc.tabId > 0 && cl.closed === true);

  const del = (await call("delete_my_tabs")).json;
  step("delete_my_tabs cleans up", del.deleted === true, `${del.closedTabs} tab(s)`);
} catch (e) {
  step("uncaught", false, e?.message || String(e));
} finally {
  try { await call("delete_my_tabs"); } catch {}
  console.log(out.join("\n"));
  await client.close();
  process.exit(out.some((l) => l.startsWith("❌")) ? 1 : 0);
}
