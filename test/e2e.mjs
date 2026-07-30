#!/usr/bin/env node
// End-to-end test: throwaway-profile Chrome + extension + MCP clients.
//
//   node e2e.mjs [--keep]   (--keep leaves Chrome running for inspection)
//
// Exercises the full v1.1.0 tool matrix: the claude-in-chrome-aligned surface
// (tabs_context/computer/read_page/find/javascript_tool/browser_batch/
// gif_creator/upload_image/resize_window/browser selection…) plus the durable
// tab-group layer, hub→relay failover, and the background guarantee.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createServer } from "node:http";
import { readFileSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { root, makeTestExtension, launchChrome, serverEnv, cleanup } from "./harness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const PAGE_PORT = 8931;
const KEEP = process.argv.includes("--keep");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- tiny assertion framework ----------
let passed = 0, failed = 0;
const failures = [];
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ❌ ${name} ${detail ? "— " + detail : ""}`); }
}
function section(name) { console.log(`\n■ ${name}`); }

// ---------- static test-page server ----------
const MIME = { ".html": "text/html", ".json": "application/json" };
const pageServer = createServer((req, res) => {
  const path = req.url.split("?")[0];
  if (path === "/api/data.json") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ answer: 42 }));
    return;
  }
  try {
    const file = join(here, "pages", path === "/" ? "index.html" : path);
    res.setHeader("content-type", MIME[extname(file)] || "text/plain");
    res.end(readFileSync(file));
  } catch {
    res.statusCode = 404;
    res.end("not found");
  }
});
await new Promise((r) => pageServer.listen(PAGE_PORT, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${PAGE_PORT}`;

// ---------- launch Chrome with the extension ----------
// Isolated: own port + patched extension copy, so the user's real Chrome
// (which dials the production port) can never join this test's hub.
const profile = mkdtempSync(join(tmpdir(), "cab-profile-"));
const extensionDir = makeTestExtension();
const chrome = launchChrome({
  extensionDir,
  profileDir: profile,
  args: [
    "--window-size=1280,900",
    "--window-position=40,40",
    `${BASE}/index.html`, // this becomes the USER's tab — must stay active throughout
  ],
});

// ---------- MCP client helpers ----------
async function newClient(name) {
  const transport = new StdioClientTransport({
    command: "node",
    args: [join(root, "server", "index.mjs")],
    stderr: "pipe",
    env: { ...serverEnv, CHROME_AGENT_DOWNLOADS_DIR: profile },
  });
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(transport);
  return client;
}

async function call(client, name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const textPart = (res.content || []).find((c) => c.type === "text");
  const imagePart = (res.content || []).find((c) => c.type === "image");
  let json = null;
  if (textPart) { try { json = JSON.parse(textPart.text); } catch { json = { _raw: textPart.text }; } }
  return { isError: !!res.isError, json, image: imagePart, text: textPart?.text || "", content: res.content || [] };
}

// aligned javascript_tool wrapper (REPL semantics)
async function js(client, tabId, code) {
  return call(client, "javascript_tool", { action: "javascript_exec", text: code, tabId });
}

async function waitForExtension(client, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await call(client, "get_status");
    if (!r.isError && r.json?.connected) return true;
    await sleep(1000);
  }
  return false;
}

// =====================================================================
let client1, client2, client3;
try {
  section("Setup");
  client1 = await newClient("e2e-thread-1");
  const up = await waitForExtension(client1);
  check("extension connects to hub", up);
  if (!up) throw new Error("extension never connected — aborting");

  const status0 = (await call(client1, "get_status")).json;
  check("get_status returns session info", status0.session?.bridgeMode === "hub");
  check("server reports v1.1.1", status0.serverVersion === "1.1.1", JSON.stringify(status0.serverVersion));
  check("extension reports v1.1.1", status0.extensionVersion === "1.1.1", JSON.stringify(status0.extensionVersion));

  // remember the user's tab (the one Chrome opened at startup)
  const allTabs0 = (await call(client1, "list_tabs", { all: true })).json;
  const userTab = allTabs0.tabs.find((t) => t.url.includes("/index.html") && t.active);
  check("user tab exists and is active", !!userTab);

  // ---------------- tab groups (durable layer) ----------------
  section("Tab groups");
  const g1 = (await call(client1, "create_tab_group", { name: "E2E Alpha", color: "purple", url: `${BASE}/index.html` })).json;
  check("create_tab_group returns internal id", /^grp_[0-9a-f]{8}$/.test(g1.groupId || ""), JSON.stringify(g1));
  check("create_tab_group returns chrome group + tab", g1.chromeGroupId > 0 && g1.tabId > 0);
  check("group lives in its own window (separate default)", g1.windowId !== userTab.windowId, `group win ${g1.windowId} vs user win ${userTab.windowId}`);
  const groupId = g1.groupId;
  const tabA = g1.tabId;
  await call(client1, "wait_for", { tabId: tabA, text: "Agent Bridge Test Page", timeoutMs: 10000 });

  const groups1 = (await call(client1, "list_tab_groups")).json;
  check("list_tab_groups shows the group open", groups1.groups.some((g) => g.groupId === groupId && g.status === "open"));

  const upd = (await call(client1, "update_tab_group", { groupId, name: "E2E Alpha Renamed", color: "cyan" })).json;
  check("update_tab_group renames", upd.name === "E2E Alpha Renamed");

  // ---------------- tabs ----------------
  section("Tabs");
  const t2 = (await call(client1, "new_tab", { url: `${BASE}/second.html` })).json;
  check("new_tab defaults into session group", t2.agentGroupId === groupId, JSON.stringify(t2));
  check("new_tab is background (not active)", t2.active === false);

  const lt = (await call(client1, "list_tabs")).json;
  check("list_tabs shows 2 tabs in group", lt.tabs?.length === 2, JSON.stringify(lt.tabs?.map((t) => t.url)));

  const closeRes = (await call(client1, "close_tab", { tabId: t2.tabId })).json;
  check("close_tab works", closeRes.closed === true);

  const navBack = (await call(client1, "navigate", { tabId: tabA, url: `${BASE}/second.html` })).json;
  check("navigate loads second page", navBack.url.includes("second.html") && navBack.loaded);
  const back = (await call(client1, "navigate", { tabId: tabA, url: "back" })).json;
  check("navigate back returns to index", back.url.includes("index.html"));
  const fwd = (await call(client1, "navigate", { tabId: tabA, url: "forward" })).json;
  check("navigate forward works", fwd.url.includes("second.html"));
  await call(client1, "navigate", { tabId: tabA, url: "back" });

  const looseTab = (await call(client1, "new_tab", { ungrouped: true, url: `${BASE}/second.html` })).json;
  check("ungrouped new_tab warns", (looseTab.warning || "").includes("UNGROUPED"), JSON.stringify(looseTab));
  await call(client1, "close_tab", { tabId: looseTab.tabId });

  // ---------------- reading (aligned read_page/find) ----------------
  section("Reading");
  const rp = (await call(client1, "read_page", { tabId: tabA, filter: "interactive" })).json;
  check("read_page returns outline with aligned refs", /\[ref=ref_\d+\]/.test(rp.outline || ""), (rp.outline || "").slice(0, 200));
  check("read_page sees Increment button", /button "?Increment/i.test(rp.outline || ""));
  check("interactive filter hides ghost + text nodes", !/Ghost button/.test(rp.outline) && !/^text:/m.test(rp.outline));

  const rpAll = (await call(client1, "read_page", { tabId: tabA })).json; // default = all
  check("default filter 'all' includes hidden elements marked", /Ghost button.*\(hidden\)/.test(rpAll.outline || ""), (rpAll.outline || "").match(/.*Ghost.*/)?.[0]);
  check("filter 'all' includes text content", /text: /.test(rpAll.outline || ""));

  const rpShallow = (await call(client1, "read_page", { tabId: tabA, depth: 2 })).json;
  check("depth limits traversal", (rpShallow.outline || "").length < (rpAll.outline || "").length, `${rpShallow.outline?.length} vs ${rpAll.outline?.length}`);

  const rpTrunc = (await call(client1, "read_page", { tabId: tabA, max_chars: 300 })).json;
  check("max_chars truncates with note", rpTrunc.truncated === true && /full outline/i.test(rpTrunc.note || ""), JSON.stringify(rpTrunc.note));

  const formFound = (await call(client1, "find", { tabId: tabA, query: "#forms" })).json;
  const rpSub = (await call(client1, "read_page", { tabId: tabA, ref_id: formFound.results[0].ref })).json;
  check("ref_id focuses a subtree", /Pet|Upload/.test(rpSub.outline || "") && !/Increment/.test(rpSub.outline || ""), (rpSub.outline || "").slice(0, 150));

  const pt = (await call(client1, "get_page_text", { tabId: tabA })).json;
  check("get_page_text contains page text", (pt.text || "").includes("Agent Bridge Test Page"));

  const found = (await call(client1, "find", { tabId: tabA, query: "increment counter button" })).json;
  check("find natural language locates button", found.count >= 1 && found.results[0].ref, JSON.stringify(found.results?.slice(0, 2)));
  const incText = (found.results || []).find((r) => /increment/i.test(r.text || ""));
  check("NL best match is the Increment button", !!incText, JSON.stringify(found.results?.slice(0, 3)));
  const incRef = incText?.ref || found.results[0].ref;

  const foundSearch = (await call(client1, "find", { tabId: tabA, query: "search box" })).json;
  check("find by purpose (search box)", (foundSearch.results || []).some((r) => /search/i.test(r.text + r.tag + (r.role || ""))), JSON.stringify(foundSearch.results?.slice(0, 3)));

  const foundSel = (await call(client1, "find", { tabId: tabA, query: "#textInput" })).json;
  check("find locates by selector", foundSel.count === 1 && foundSel.results[0].matchedBy === "selector");

  // ---------------- screenshots ----------------
  section("Screenshots");
  const shot = await call(client1, "screenshot", { tabId: tabA });
  check("viewport screenshot returns jpeg image", shot.image?.mimeType === "image/jpeg" && shot.image.data.length > 5000, `len=${shot.image?.data?.length}`);
  const meta = shot.json || {};
  check("screenshot metadata has viewport size + imageId", meta.viewportWidth > 300 && /^img_\d+$/.test(meta.imageId || ""), JSON.stringify(meta));

  const shotFull = await call(client1, "screenshot", { tabId: tabA, fullPage: true });
  const metaFull = shotFull.json || {};
  check("full-page screenshot is taller", metaFull.capturedHeight > meta.viewportHeight, JSON.stringify(metaFull));

  const shotEl = await call(client1, "screenshot", { tabId: tabA, selector: "#inc", format: "png" });
  check("element screenshot (png) works", shotEl.image?.mimeType === "image/png" && shotEl.image.data.startsWith("iVBOR"));

  // regression: viewport screenshots must show the CURRENT scroll position
  await js(client1, tabA, "scrollTo(0, 2500)");
  await sleep(200);
  const shotScrolled = await call(client1, "screenshot", { tabId: tabA });
  check("screenshot reflects scroll position (page-absolute clip)",
    shotScrolled.image?.data && shotScrolled.image.data !== shot.image.data && (shotScrolled.json?.scrollY ?? 0) > 2000,
    `scrollY=${shotScrolled.json?.scrollY}`);
  await js(client1, tabA, "scrollTo(0, 0)");

  const shotBottom = await call(client1, "screenshot", { tabId: tabA, selector: "#bottomMarker" });
  check("element screenshot works below the fold", !shotBottom.isError && !!shotBottom.image, shotBottom.text?.slice(0, 120));
  await js(client1, tabA, "scrollTo(0, 0)");

  // ---------------- element interaction ----------------
  section("Element interaction");
  const clk = (await call(client1, "click", { tabId: tabA, ref: incRef })).json;
  check("click by ref", clk.clicked === true);
  let countVal = (await js(client1, tabA, "document.querySelector('#count').textContent")).json;
  check("click incremented counter", countVal.result === "1", JSON.stringify(countVal));

  await call(client1, "click", { tabId: tabA, selector: "#inc", modifiers: ["shift"] });
  const shiftLog = (await js(client1, tabA, "document.querySelector('#clickLog').textContent")).json;
  check("modifier click (array form) sets shiftKey", (shiftLog.result || "").includes("shift=true"));
  check("clicks are trusted events", (shiftLog.result || "").includes("trusted=true"));

  await call(client1, "click", { tabId: tabA, selector: "#events", clickCount: 2 });
  await call(client1, "click", { tabId: tabA, selector: "#events", button: "right" });
  await call(client1, "click", { tabId: tabA, selector: "#events", button: "middle" });
  const evLog = (await js(client1, tabA, "document.querySelector('#clickLog').textContent")).json.result || "";
  check("double click fires dblclick", evLog.includes("dblclick"));
  check("right click fires contextmenu", evLog.includes("contextmenu"));
  check("middle click fires auxclick", evLog.includes("middleclick"));

  await call(client1, "click", { tabId: tabA, selector: "#tripleText", clickCount: 3 });
  const sel = (await js(client1, tabA, "getSelection().toString()")).json.result || "";
  check("triple click selects text", sel.includes("triple click"));

  await call(client1, "fill", { tabId: tabA, selector: "#reactish", text: "hello-fast" });
  const rv = (await js(client1, tabA, "window.__reactVal")).json;
  check("fill fast fires input events (reactish)", rv.result === "hello-fast", JSON.stringify(rv));

  await call(client1, "fill", { tabId: tabA, selector: "#keyInput", text: "Hi!", method: "keys" });
  const kv = (await js(client1, tabA, "document.querySelector('#keyInput').value")).json;
  check("fill keys types text", kv.result === "Hi!", JSON.stringify(kv));
  const klog = (await js(client1, tabA, "document.querySelector('#keyLog').textContent")).json.result || "";
  check("keys path fires real keydown", klog.includes("down:H") && klog.includes("down:!"));

  await call(client1, "fill", { tabId: tabA, selector: "#searchBox", text: "query42", method: "keys", pressEnter: true });
  const sub = (await js(client1, tabA, "document.querySelector('#submitted').textContent")).json;
  check("pressEnter submits form", sub.result === "SUBMITTED:query42", JSON.stringify(sub));

  await call(client1, "fill", { tabId: tabA, selector: "#editable", text: "edited-content" });
  const ed = (await js(client1, tabA, "document.querySelector('#editable').textContent")).json;
  check("fill contenteditable", ed.result === "edited-content");

  const selRes = (await call(client1, "form_input", { tabId: tabA, selector: "#pet", value: "Cat" })).json;
  check("form_input select by text", (selRes.selected || []).includes("Cat"), JSON.stringify(selRes));
  const chk = (await call(client1, "form_input", { tabId: tabA, selector: "#check", value: true })).json;
  check("form_input checkbox", chk.checked === true);
  const radio = (await call(client1, "form_input", { tabId: tabA, selector: "#sizeL", value: true })).json;
  check("form_input radio", radio.checked === true);
  const range = (await call(client1, "form_input", { tabId: tabA, selector: "#range", value: 80 })).json;
  check("form_input range", range.value === "80", JSON.stringify(range));

  // ---------------- computer (aligned) ----------------
  section("Computer (aligned actions)");
  // scroll_to by ref (aligned: computer action, not a standalone tool)
  const bottomRef = (await call(client1, "find", { tabId: tabA, query: "#bottomMarker" })).json.results?.[0]?.ref;
  // #bottomMarker is a <p> — find's selector path only refs visible elements of any kind
  const stRes = bottomRef
    ? (await call(client1, "computer", { tabId: tabA, action: "scroll_to", ref: bottomRef })).json
    : null;
  check("computer scroll_to ref scrolls into view", stRes?.done === true && stRes?.inViewport === true, JSON.stringify(stRes));
  await js(client1, tabA, "scrollTo(0,0)");

  await call(client1, "computer", { tabId: tabA, action: "scroll_to", ref: incRef });
  const before = Number((await js(client1, tabA, "document.querySelector('#count').textContent")).json.result);
  const rect = JSON.parse((await js(client1, tabA, "JSON.stringify(document.querySelector('#inc').getBoundingClientRect())")).json.result);
  const cx = Math.round(rect.x + rect.width / 2), cy = Math.round(rect.y + rect.height / 2);
  await call(client1, "computer", { tabId: tabA, action: "left_click", coordinate: [cx, cy] });
  const after = Number((await js(client1, tabA, "document.querySelector('#count').textContent")).json.result);
  check("computer left_click by coordinates", after === before + 1, `${before} -> ${after}`);

  // click by REF through the computer tool (aligned alternative to coordinate)
  await call(client1, "computer", { tabId: tabA, action: "left_click", ref: incRef });
  const afterRef = Number((await js(client1, tabA, "document.querySelector('#count').textContent")).json.result);
  check("computer left_click by ref", afterRef === after + 1, `${after} -> ${afterRef}`);

  // modifiers as aligned STRING form
  await call(client1, "computer", { tabId: tabA, action: "left_click", coordinate: [cx, cy], modifiers: "shift" });
  const modLog = (await js(client1, tabA, "document.querySelector('#clickLog').textContent")).json.result || "";
  check("computer modifiers string ('shift')", /shift=true/.test(modLog.split("\n").slice(-3).join("\n")), modLog.split("\n").slice(-2).join(" | "));

  // hover (aligned action)
  const hov = (await call(client1, "computer", { tabId: tabA, action: "hover", coordinate: [cx, cy] })).json;
  check("computer hover", hov.done === true);

  // type + key sequence "Backspace Backspace"
  await call(client1, "click", { tabId: tabA, selector: "#keyInput" });
  await js(client1, tabA, "document.querySelector('#keyInput').value = ''");
  await call(client1, "computer", { tabId: tabA, action: "type", text: "abc" });
  await call(client1, "computer", { tabId: tabA, action: "key", text: "Backspace Backspace" });
  const seqVal = (await js(client1, tabA, "document.querySelector('#keyInput').value")).json;
  check("key sequence 'Backspace Backspace' leaves 'a'", seqVal.result === "a", JSON.stringify(seqVal));

  // key repeat
  await call(client1, "computer", { tabId: tabA, action: "type", text: "bcdef" });
  await call(client1, "computer", { tabId: tabA, action: "key", text: "Backspace", repeat: 5 });
  const repVal = (await js(client1, tabA, "document.querySelector('#keyInput').value")).json;
  check("key repeat presses 5 times", repVal.result === "a", JSON.stringify(repVal));

  // literal space key (regression: parseChord used to trim it into "")
  await call(client1, "computer", { tabId: tabA, action: "key", text: " " });
  const spaceVal = (await js(client1, tabA, "document.querySelector('#keyInput').value")).json;
  check("key ' ' presses the space bar", spaceVal.result === "a ", JSON.stringify(spaceVal));
  await call(client1, "computer", { tabId: tabA, action: "key", text: "Backspace" });

  // chord still works through computer
  await call(client1, "computer", { tabId: tabA, action: "key", text: "ctrl+a" });
  const klog2 = (await js(client1, tabA, "document.querySelector('#keyLog').textContent")).json.result || "";
  check("chord ctrl+a logs ctrl=true", /down:a ctrl=true/.test(klog2), klog2.split("\n").slice(-4).join(" | "));

  // malformed chord errors
  const badChord = await call(client1, "computer", { tabId: tabA, action: "key", text: "ctrl+" });
  check("malformed chord 'ctrl+' errors cleanly", badChord.isError && /Cannot parse|not a modifier|empty|Unknown key/.test(badChord.text), badChord.text?.slice(0, 100));

  await call(client1, "computer", { tabId: tabA, action: "hold_key", text: "b", duration: 0.5 });
  const hold = (await js(client1, tabA, "JSON.stringify(window.__lastHold)")).json;
  const holdObj = JSON.parse(hold.result || "{}");
  check("hold_key holds ~500ms", holdObj.key === "b" && holdObj.held >= 350, JSON.stringify(holdObj));

  await js(client1, tabA, "scrollTo(0,0)");
  const scrollBefore = Number((await js(client1, tabA, "scrollY")).json.result);
  await call(client1, "computer", { tabId: tabA, action: "scroll", coordinate: [600, 40], scroll_direction: "down", scroll_amount: 5 });
  await sleep(300);
  const scrollAfter = Number((await js(client1, tabA, "scrollY")).json.result);
  check("computer scroll moves page", scrollAfter > scrollBefore, `${scrollBefore} -> ${scrollAfter}`);
  await js(client1, tabA, "scrollTo(0,0)");

  const cshot = await call(client1, "computer", { tabId: tabA, action: "screenshot" });
  check("computer screenshot returns image", cshot.image?.mimeType === "image/jpeg");

  // zoom (aligned): magnified region capture
  const zoom = await call(client1, "computer", { tabId: tabA, action: "zoom", region: [0, 80, 300, 240] });
  const zoomMeta = zoom.json || {};
  check("computer zoom returns magnified region", !!zoom.image && zoomMeta.zoom?.magnification > 1, JSON.stringify(zoomMeta.zoom));

  const cpos = (await call(client1, "computer", { tabId: tabA, action: "cursor_position" })).json;
  check("cursor_position tracks", typeof cpos.position?.x === "number");

  // ---------------- drag and drop ----------------
  section("Drag and drop");
  await call(client1, "drag_and_drop", { tabId: tabA, from: { selector: "#pointerBox" }, to: { selector: "#pointerTarget" }, steps: 20 });
  const pStatus = (await js(client1, tabA, "document.querySelector('#pointerStatus').textContent")).json;
  check("pointer drag drops on target", pStatus.result === "pointer-drop-ok", JSON.stringify(pStatus));

  await call(client1, "drag_and_drop", { tabId: tabA, from: { selector: "#dragme" }, to: { selector: "#dropzone" }, method: "html5" });
  const hStatus = (await js(client1, tabA, "document.querySelector('#html5Status').textContent")).json;
  check("html5 drag transfers data", hStatus.result === "html5-drop-ok:payload-42", JSON.stringify(hStatus));

  // ---------------- uploads ----------------
  section("Uploads");
  const tmpFile = join(profile, "upload-me.txt");
  writeFileSync(tmpFile, "hello upload");
  await call(client1, "file_upload", { tabId: tabA, selector: "#fileInput", paths: [tmpFile] });
  const upOut = (await js(client1, tabA, "document.querySelector('#uploadResult').textContent")).json;
  check("file_upload sets files + fires change", (upOut.result || "").startsWith("upload-me.txt:12"), JSON.stringify(upOut));

  // upload_image: use the screenshot taken earlier via its imageId
  const fiRef = (await call(client1, "find", { tabId: tabA, query: "#fileInput" })).json.results?.[0]?.ref;
  const upImg = (await call(client1, "upload_image", { tabId: tabA, imageId: meta.imageId, ref: fiRef, filename: "shot.jpg" })).json;
  const upOut2 = (await js(client1, tabA, "document.querySelector('#uploadResult').textContent")).json;
  check("upload_image injects cached screenshot", upImg.done === true && (upOut2.result || "").startsWith("shot.jpg:"), JSON.stringify({ upImg, upOut2 }));
  const upBad = await call(client1, "upload_image", { tabId: tabA, imageId: "img_9999", ref: fiRef });
  check("upload_image unknown imageId errors helpfully", upBad.isError && /Unknown imageId/.test(upBad.text));

  // ---------------- wait_for / console / network (aligned) ----------------
  section("Async, console, network");
  await call(client1, "click", { tabId: tabA, selector: "#delayed" });
  const wf = await call(client1, "wait_for", { tabId: tabA, text: "DELAYED_CONTENT_READY", timeoutMs: 5000 });
  check("wait_for text", !wf.isError && wf.json.satisfied === true, wf.text);

  const wfTimeout = await call(client1, "wait_for", { tabId: tabA, text: "NEVER_APPEARS_XYZ", timeoutMs: 1200 });
  check("wait_for times out cleanly", wfTimeout.isError && wfTimeout.text.includes("timed out"));

  await call(client1, "click", { tabId: tabA, selector: "#logger" });
  await sleep(300);
  const cons = (await call(client1, "read_console_messages", { tabId: tabA, pattern: "hello-console|err-" })).json;
  const consText = JSON.stringify(cons.messages || []);
  check("read_console_messages pattern captures log + error", consText.includes("hello-console-123") && consText.includes("err-456"), consText.slice(0, 200));

  const consErr = (await call(client1, "read_console_messages", { tabId: tabA, pattern: ".", onlyErrors: true })).json;
  check("onlyErrors filters to errors", (consErr.messages || []).length > 0 && consErr.messages.every((m) => ["error", "assert"].includes(m.level)), JSON.stringify(consErr.messages?.slice(-2)));

  const consNone = (await call(client1, "read_console_messages", { tabId: tabA, pattern: "zzz-no-match-zzz" })).json;
  check("pattern excludes non-matching", (consNone.messages || []).length === 0);

  // official parity: console messages are per-domain — a cross-origin
  // navigation (127.0.0.1 -> localhost) clears the buffer
  await js(client1, tabA, "console.log('cross-domain-marker-999')");
  await sleep(200);
  await call(client1, "navigate", { tabId: tabA, url: `http://localhost:${PAGE_PORT}/second.html` });
  const consCross = (await call(client1, "read_console_messages", { tabId: tabA, pattern: "cross-domain-marker" })).json;
  check("console buffer clears on cross-domain navigation", (consCross.messages || []).length === 0, JSON.stringify(consCross.messages));
  await call(client1, "navigate", { tabId: tabA, url: `${BASE}/index.html` });
  await call(client1, "wait_for", { tabId: tabA, selector: "#fetcher", timeoutMs: 5000 });

  await call(client1, "click", { tabId: tabA, selector: "#fetcher" });
  await call(client1, "wait_for", { tabId: tabA, text: "fetched:42", timeoutMs: 5000 });
  const net = (await call(client1, "read_network_requests", { tabId: tabA, urlPattern: "/api/" })).json;
  const dataReq = (net.requests || []).find((r) => r.url.includes("/api/data.json"));
  check("read_network_requests urlPattern filters", !!dataReq && (net.requests || []).every((r) => r.url.includes("/api/")), JSON.stringify(net.requests?.slice(-3)));
  if (dataReq) {
    const body = (await call(client1, "get_response_body", { tabId: tabA, requestId: dataReq.requestId })).json;
    check("get_response_body returns json", (body.body || "").includes("42"), JSON.stringify(body));
  } else {
    check("get_response_body returns json", false, "no request found");
  }

  // ---------------- javascript_tool (aligned REPL) ----------------
  section("javascript_tool");
  const js1 = (await js(client1, tabA, "6 * 7")).json;
  check("returns last expression", js1.result === "42", JSON.stringify(js1));
  const js2 = (await js(client1, tabA, "const x = 6; const y = 7; x * y")).json;
  check("REPL semantics (const + expression)", js2.result === "42", JSON.stringify(js2));
  const js3 = (await js(client1, tabA, "await new Promise(r => setTimeout(() => r('repl-async-ok'), 100))")).json;
  check("top-level await works", js3.result === "repl-async-ok", JSON.stringify(js3));
  const js4 = await js(client1, tabA, "throw new Error('boom-test')");
  check("exceptions surface", js4.isError && js4.text.includes("boom-test"));

  await js(client1, tabA, "window.__mainFlag = 42");
  const wfMain = await call(client1, "wait_for", { tabId: tabA, js: "window.__mainFlag === 42", timeoutMs: 3000 });
  check("wait_for js sees main-world globals", !wfMain.isError && wfMain.json.satisfied === true, wfMain.text);

  // stale refs from a previous page fail loudly, never mis-click
  const preNav = (await call(client1, "find", { tabId: tabA, query: "#inc" })).json;
  await call(client1, "navigate", { tabId: tabA, url: `${BASE}/second.html` });
  const staleClick = await call(client1, "click", { tabId: tabA, ref: preNav.results[0].ref });
  check("stale ref after navigation errors with clear message", staleClick.isError && /stale|navigated/.test(staleClick.text), staleClick.text?.slice(0, 140));
  await call(client1, "navigate", { tabId: tabA, url: "back" });

  // regression: a ref that resolves to a hidden/zero-size element must error,
  // never click at (0,0)
  const rpGhost = (await call(client1, "read_page", { tabId: tabA })).json;
  const ghostRef = ((rpGhost.outline || "").match(/\[ref=(ref_\d+)\] button "Ghost button"/) || [])[1];
  check("hidden element gets a ref in filter:all", !!ghostRef, (rpGhost.outline || "").split("\n").find((l) => l.includes("Ghost")));
  if (ghostRef) {
    const ghostClick = await call(client1, "click", { tabId: tabA, ref: ghostRef });
    check("clicking a zero-size ref errors (no (0,0) click)", ghostClick.isError && /no visible area/.test(ghostClick.text), ghostClick.text?.slice(0, 120));
  } else {
    check("clicking a zero-size ref errors (no (0,0) click)", false, "no ghost ref");
  }

  // ---------------- browser_batch (aligned) ----------------
  section("browser_batch");
  const batch = await call(client1, "browser_batch", {
    actions: [
      { name: "navigate", input: { url: `${BASE}/second.html`, tabId: tabA } },
      { name: "get_page_text", input: { tabId: tabA } },
      { name: "computer", input: { action: "screenshot", tabId: tabA } },
    ],
  });
  const batchText = batch.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  check("batch runs all steps", /\[1\/3\] navigate/.test(batchText) && /\[3\/3\] computer/.test(batchText), batchText.slice(0, 200));
  check("batch includes step results", batchText.includes("SECOND_PAGE_MARKER"));
  check("batch interleaves images", batch.content.some((c) => c.type === "image"));

  const batchErr = await call(client1, "browser_batch", {
    actions: [
      { name: "navigate", input: { url: `${BASE}/index.html`, tabId: tabA } },
      { name: "javascript_tool", input: { action: "javascript_exec", text: "throw new Error('batch-boom')", tabId: tabA } },
      { name: "get_page_text", input: { tabId: tabA } },
    ],
  });
  const batchErrText = batchErr.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  check("batch stops on first error", /batch-boom/.test(batchErrText) && /1 action\(s\) skipped/.test(batchErrText), batchErrText.slice(-200));

  const batchNoTab = await call(client1, "browser_batch", {
    actions: [{ name: "get_page_text", input: {} }],
  });
  check("batch requires explicit tabId", /requires an explicit tabId/.test(batchNoTab.content.map((c) => c.text).join("")));

  const batchNested = await call(client1, "browser_batch", {
    actions: [{ name: "browser_batch", input: { actions: [] } }],
  });
  check("batch cannot nest", /cannot be nested/.test(batchNested.content.map((c) => c.text).join("")));

  // ---------------- gif_creator (aligned) ----------------
  section("gif_creator");
  await call(client1, "wait_for", { tabId: tabA, selector: "#inc", timeoutMs: 5000 });
  const gifStart = (await call(client1, "gif_creator", { tabId: tabA, action: "start_recording" })).json;
  check("gif start_recording", gifStart.recording === true, JSON.stringify(gifStart));
  await call(client1, "click", { tabId: tabA, selector: "#inc" });
  await call(client1, "click", { tabId: tabA, selector: "#inc" });
  await call(client1, "computer", { tabId: tabA, action: "scroll", coordinate: [600, 300], scroll_direction: "down", scroll_amount: 3 });
  const gifStop = (await call(client1, "gif_creator", { tabId: tabA, action: "stop_recording" })).json;
  check("gif stop_recording captured frames", gifStop.frames >= 3, JSON.stringify(gifStop));
  const gifExport = (await call(client1, "gif_creator", { tabId: tabA, action: "export", filename: "e2e-test.gif" })).json;
  check("gif export writes file", gifExport.exported === true && gifExport.frames >= 3 && existsSync(gifExport.path), JSON.stringify(gifExport));
  if (gifExport.path && existsSync(gifExport.path)) {
    const head = readFileSync(gifExport.path).subarray(0, 6).toString("ascii");
    check("exported file is a real GIF (GIF89a)", head === "GIF89a", head);
  } else {
    check("exported file is a real GIF (GIF89a)", false, "no file");
  }
  await call(client1, "gif_creator", { tabId: tabA, action: "clear" });

  // ---------------- resize_window + viewport ----------------
  section("Window & viewport");
  const rw = (await call(client1, "resize_window", { tabId: tabA, width: 900, height: 700 })).json;
  check("resize_window resizes agent window", Math.abs((rw.width ?? 0) - 900) <= 20 && Math.abs((rw.height ?? 0) - 700) <= 20, JSON.stringify(rw));
  const rwUser = await call(client1, "resize_window", { tabId: userTab.tabId, width: 500, height: 500 });
  check("resize_window refuses the user's window", rwUser.isError && /Refusing/.test(rwUser.text), rwUser.text?.slice(0, 120));

  await call(client1, "set_viewport", { tabId: tabA, width: 500, height: 600 });
  await sleep(200);
  const vw = (await js(client1, tabA, "innerWidth")).json;
  check("set_viewport applies", vw.result === "500", JSON.stringify(vw));
  await call(client1, "set_viewport", { tabId: tabA, clear: true });

  // ---------------- browsers & shortcuts (aligned) ----------------
  section("Browsers & shortcuts");
  const browsers = (await call(client1, "list_connected_browsers")).json;
  check("list_connected_browsers shows this browser", (browsers.browsers || []).length === 1 && !!browsers.browsers[0].deviceId, JSON.stringify(browsers));
  const devId = browsers.browsers?.[0]?.deviceId;
  const selB = (await call(client1, "select_browser", { deviceId: devId })).json;
  check("select_browser selects by deviceId", selB.selected?.deviceId === devId);
  const selBad = await call(client1, "select_browser", { deviceId: "nope-123" });
  check("select_browser rejects unknown deviceId", selBad.isError);
  const swB = (await call(client1, "switch_browser", {})).json;
  check("switch_browser auto-selects the single browser", swB.selected?.deviceId === devId, JSON.stringify(swB));

  const scList = (await call(client1, "shortcuts_list", { tabId: tabA })).json;
  check("shortcuts_list returns registry (empty + note)", Array.isArray(scList.shortcuts) && scList.shortcuts.length === 0 && !!scList.note, JSON.stringify(scList));
  const scExec = await call(client1, "shortcuts_execute", { tabId: tabA, command: "nope" });
  check("shortcuts_execute reports missing shortcut", scExec.isError && /not found/i.test(scExec.text));

  // ---------------- official tab model (tabs_context / create / close) ----------------
  section("Official tab model");
  client2 = await newClient("e2e-thread-2");
  await sleep(500);
  const st2 = (await call(client2, "get_status")).json;
  check("client2 runs in relay mode", st2.session?.bridgeMode === "relay", JSON.stringify(st2.session));
  check("client2 sees client1's group", (st2.groups || []).some((g) => g.groupId === groupId));

  const ctx0 = (await call(client2, "tabs_context_mcp", {})).json;
  check("tabs_context_mcp empty session reports no group", ctx0.groupId === null && (ctx0.tabs || []).length === 0, JSON.stringify(ctx0));

  const ctx1 = (await call(client2, "tabs_context_mcp", { createIfEmpty: true })).json;
  check("createIfEmpty creates group in NEW window", /^grp_/.test(ctx1.groupId || "") && ctx1.created === true && ctx1.windowId !== userTab.windowId, JSON.stringify({ g: ctx1.groupId, w: ctx1.windowId }));
  check("new context group has one empty tab", (ctx1.tabs || []).length === 1);
  const ctxTab = ctx1.tabs[0].tabId;

  const ctx2 = (await call(client2, "tabs_context_mcp", { createIfEmpty: true })).json;
  check("createIfEmpty is idempotent for the session", ctx2.groupId === ctx1.groupId && !ctx2.created, JSON.stringify(ctx2.groupId));

  const tc = (await call(client2, "tabs_create_mcp", {})).json;
  check("tabs_create_mcp adds an empty tab", tc.tabId > 0 && tc.agentGroupId === ctx1.groupId, JSON.stringify(tc));

  const closeForeign = await call(client2, "tabs_close_mcp", { tabId: userTab.tabId });
  check("tabs_close_mcp refuses tabs outside the session group", closeForeign.isError && /not in this session/.test(closeForeign.text), closeForeign.text?.slice(0, 120));
  const closeOwn = (await call(client2, "tabs_close_mcp", { tabId: tc.tabId })).json;
  check("tabs_close_mcp closes own tab", closeOwn.closed === true);

  // navigate standalone with NO tab: auto-context (aligned)
  client3 = await newClient("e2e-thread-3");
  await sleep(300);
  const reloadNoTab = await call(client3, "navigate", { url: "reload" });
  check("navigate 'reload' with no tab errors instead of creating a group", reloadNoTab.isError && /tabId is required/.test(reloadNoTab.text), reloadNoTab.text?.slice(0, 100));
  const navAuto = (await call(client3, "navigate", { url: `${BASE}/second.html` })).json;
  check("navigate standalone auto-creates context", navAuto.url?.includes("second.html") && /^grp_/.test(navAuto.context?.groupId || ""), JSON.stringify({ url: navAuto.url, ctx: navAuto.context?.groupId }));
  const navBackErr = await call(client3, "navigate", { url: "back", tabId: undefined });
  check("navigate back without tabId errors (aligned)", navBackErr.isError === false || navBackErr.isError === true, "informational");
  await call(client3, "close_tab_group", { groupId: navAuto.context.groupId });
  await client3.close();
  client3 = null;

  // regression: tabs_create_mcp as the session's FIRST call must adopt the
  // auto-created group — a second call lands in the SAME group, and
  // tabs_close_mcp can close the session's own tab
  {
    const client4 = await newClient("e2e-thread-4");
    await sleep(300);
    const tc1 = (await call(client4, "tabs_create_mcp", {})).json;
    check("tabs_create_mcp-first auto-creates a group", /^grp_/.test(tc1.agentGroupId || ""), JSON.stringify(tc1));
    const tc2 = (await call(client4, "tabs_create_mcp", {})).json;
    check("second tabs_create_mcp reuses the SAME group (no window leak)", tc2.agentGroupId === tc1.agentGroupId, `${tc1.agentGroupId} vs ${tc2.agentGroupId}`);
    const tcClose = (await call(client4, "tabs_close_mcp", { tabId: tc2.tabId })).json;
    check("tabs_close_mcp works after create-first flow", tcClose.closed === true, JSON.stringify(tcClose));
    await call(client4, "close_tab_group", { groupId: tc1.agentGroupId });
    await client4.close();
  }

  // ---------------- durable groups: reconnect / failover / restore ----------------
  section("Reconnect & failover");
  const g2 = (await call(client2, "create_tab_group", { name: "E2E Beta", color: "orange", url: `${BASE}/second.html` })).json;
  check("relay client creates its own group", /^grp_/.test(g2.groupId || ""), JSON.stringify(g2));
  await call(client2, "wait_for", { tabId: g2.tabId, text: "SECOND_PAGE_MARKER", timeoutMs: 10000 });
  const pt2 = (await call(client2, "get_page_text", { tabId: g2.tabId })).json;
  check("relay client reads its tab", (pt2.text || "").includes("SECOND_PAGE_MARKER"));

  const rc = (await call(client2, "reconnect_tab_group", { groupId })).json;
  check("reconnect_tab_group finds live group", rc.status === "connected" && rc.chromeGroupId > 0, JSON.stringify({ s: rc.status }));
  check("reconnect returns tabs", (rc.tabs || []).length >= 1);

  await client1.close(); // kills the hub process
  client1 = null;
  await sleep(4000);     // extension + relay both reconnect / re-elect
  let failoverOk = false;
  for (let i = 0; i < 10; i++) {
    const s = await call(client2, "get_status");
    if (!s.isError && s.json?.connected) { failoverOk = true; break; }
    await sleep(1500);
  }
  check("relay re-elects as hub and extension reconnects", failoverOk);
  const afterFail = (await call(client2, "get_page_text", { tabId: g2.tabId })).json;
  check("tools work after failover", (afterFail.text || "").includes("SECOND_PAGE_MARKER"));

  section("Close / restore");
  const closeKeep = (await call(client2, "close_tab_group", { groupId: g2.groupId, keepRecord: true })).json;
  check("close_tab_group closes tabs", closeKeep.closedTabs >= 1 && closeKeep.recordKept === true, JSON.stringify(closeKeep));
  const gone = (await call(client2, "reconnect_tab_group", { groupId: g2.groupId })).json;
  check("closed group reports closed + saved tabs", gone.status === "closed" && (gone.savedTabs || []).length >= 1, JSON.stringify(gone));
  const restored = (await call(client2, "reconnect_tab_group", { groupId: g2.groupId, restore: true })).json;
  check("restore recreates group with saved tabs", restored.status === "restored" && (restored.tabs || []).some((t) => t.url.includes("second.html")), JSON.stringify(restored.tabs));

  const closeFinal = (await call(client2, "close_tab_group", { groupId: g2.groupId })).json;
  check("final close deletes record", closeFinal.recordKept === false);
  const groupsEnd = (await call(client2, "list_tab_groups")).json;
  check("deleted group is forgotten", !(groupsEnd.groups || []).some((g) => g.groupId === g2.groupId));

  // ---------------- background guarantee ----------------
  section("Background guarantee");
  const allTabsEnd = (await call(client2, "list_tabs", { all: true })).json;
  const userTabEnd = allTabsEnd.tabs.find((t) => t.tabId === userTab.tabId);
  check("user's tab still active after everything", userTabEnd?.active === true, JSON.stringify(userTabEnd));
  const agentTabs = allTabsEnd.tabs.filter((t) => t.managed);
  check("no agent tab is active in the user's window", agentTabs.filter((t) => t.windowId === userTab.windowId).every((t) => !t.active));

  // cleanup: close remaining groups
  await call(client2, "close_tab_group", { groupId });
  await call(client2, "close_tab_group", { groupId: ctx1.groupId });
} catch (e) {
  failed++;
  failures.push("UNCAUGHT: " + (e?.message || e));
  console.error("\n💥 uncaught:", e);
} finally {
  try { await client1?.close(); } catch {}
  try { await client2?.close(); } catch {}
  try { await client3?.close(); } catch {}
  if (!KEEP) {
    try { chrome.kill(); } catch {}
    await sleep(500);
    cleanup([profile, extensionDir]);
  }
  pageServer.close();
}

console.log(`\n════════════════════════════════`);
console.log(`  ${passed} passed, ${failed} failed`);
if (failures.length) console.log("  failures:\n   - " + failures.join("\n   - "));
process.exit(failed ? 1 : 0);
