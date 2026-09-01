// Live check of the NEW aligned tools against the user's real Chrome.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
const t = new StdioClientTransport({ command: "node", args: ["../server/index.mjs"], stderr: "ignore" });
const c = new Client({ name: "aligned-real", version: "1.0.0" }); await c.connect(t);
const call = async (n, a = {}) => {
  const r = await c.callTool({ name: n, arguments: a });
  const x = (r.content || []).find(y => y.type === "text");
  const img = (r.content || []).find(y => y.type === "image");
  let j = null; try { j = JSON.parse(x?.text || "null"); } catch { j = { _raw: x?.text }; }
  return { isError: !!r.isError, json: j, img, content: r.content || [] };
};
const out = [];
const step = (n, ok, d = "") => { out.push(`${ok ? "✅" : "❌"} ${n}${d ? " — " + d : ""}`); };
let gid = null;
try {
  const st = (await call("get_status")).json;
  step("fresh server is v1.2.0", st.serverVersion === "1.2.0", `server ${st.serverVersion}, ext ${st.extensionVersion}, ${st.session.bridgeMode}`);

  // official tab model, in the real profile
  const ctx = (await call("tabs_context_mcp", { createIfEmpty: true })).json;
  gid = ctx.groupId;
  step("tabs_context_mcp created a session group", /^grp_/.test(gid || "") && ctx.created === true, `${gid}, window ${ctx.windowId}`);
  const tab = ctx.tabs[0].tabId;

  // navigate + read_page filter/ref_id
  await call("navigate", { url: "https://example.com", tabId: tab });
  const rp = (await call("read_page", { tabId: tab, filter: "interactive" })).json;
  step("read_page interactive + ref_N", /\[ref=ref_\d+\]/.test(rp.outline || ""), (rp.outline || "").split("\n")[0]);

  // NL find
  const f = (await call("find", { tabId: tab, query: "more information link" })).json;
  step("NL find locates the link", f.count >= 1 && /learn more/i.test(f.results[0].text || ""), `${f.results?.[0]?.ref} "${f.results?.[0]?.text}"`);

  // zoom
  const z = await call("computer", { tabId: tab, action: "zoom", region: [0, 0, 400, 200] });
  step("computer zoom returns magnified image", !!z.img && z.json?.zoom?.magnification > 1, `x${z.json?.zoom?.magnification}`);

  // browser_batch
  const b = await call("browser_batch", { actions: [
    { name: "navigate", input: { url: "https://example.org", tabId: tab } },
    { name: "get_page_text", input: { tabId: tab } },
    { name: "computer", input: { action: "screenshot", tabId: tab } },
  ]});
  const btxt = b.content.filter(x => x.type === "text").map(x => x.text).join("\n");
  step("browser_batch runs 3 steps + image", /\[3\/3\]/.test(btxt) && b.content.some(x => x.type === "image"), btxt.slice(0, 60).replace(/\n/g, " "));

  // javascript_tool REPL
  const js = (await call("javascript_tool", { action: "javascript_exec", text: "const a=6,b=7; a*b", tabId: tab })).json;
  step("javascript_tool REPL semantics", js.result === "42");

  // gif_creator end-to-end
  await call("gif_creator", { tabId: tab, action: "start_recording" });
  await call("computer", { tabId: tab, action: "scroll", coordinate: [400, 300], scroll_direction: "down", scroll_amount: 2 });
  await call("navigate", { url: "https://example.com", tabId: tab });
  const stop = (await call("gif_creator", { tabId: tab, action: "stop_recording" })).json;
  const exp = (await call("gif_creator", { tabId: tab, action: "export", filename: "aligned-real-check" })).json;
  const isGif = exp.path && existsSync(exp.path) && readFileSync(exp.path).subarray(0, 6).toString("ascii") === "GIF89a";
  step("gif_creator records + exports a real GIF", stop.frames >= 2 && exp.exported && isGif, `${exp.frames} frames, ${Math.round((exp.sizeBytes||0)/1024)}KB`);
  if (exp.path && existsSync(exp.path)) unlinkSync(exp.path);

  // resize_window on the agent's own window
  const rw = (await call("resize_window", { tabId: tab, width: 1000, height: 720 })).json;
  step("resize_window resizes the agent window", Math.abs((rw.width||0) - 1000) <= 20, `${rw.width}x${rw.height}`);

  // browsers
  const br = (await call("list_connected_browsers")).json;
  step("list_connected_browsers sees the real Chrome", (br.browsers||[]).length >= 1, br.browsers?.[0]?.name);

  // tabs_close_mcp strictness
  const tc = (await call("tabs_create_mcp", {})).json;
  const cl = (await call("tabs_close_mcp", { tabId: tc.tabId })).json;
  step("tabs_create_mcp + tabs_close_mcp round-trip", tc.tabId > 0 && cl.closed === true);
} catch (e) {
  step("uncaught", false, e.message);
} finally {
  if (gid) await call("close_tab_group", { groupId: gid });
  console.log(out.join("\n"));
  await c.close();
  process.exit(out.some(l => l.startsWith("❌")) ? 1 : 0);
}
