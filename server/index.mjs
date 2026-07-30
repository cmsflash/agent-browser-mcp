#!/usr/bin/env node
// Chrome Agent Bridge — MCP server (stdio), v1.1.0.
//
// One process per agent thread. The tool surface is aligned verbatim with the
// official claude-in-chrome MCP (see reference/alignment-map.md), plus the
// durable tab-group extension layer. This file owns per-session state
// (current group/tab, selected browser, screenshot image cache) and the
// server-side composites: browser_batch, gif export encoding, upload_image,
// save_to_disk, shortcuts execution, and navigate's auto-context.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Bridge, DEFAULT_PORT } from "./bridge.mjs";
import { TOOLS } from "./tools.mjs";
import { encodeGif } from "./gif.mjs";

const VERSION = "1.1.1";
const port = Number(process.env.CHROME_AGENT_PORT || DEFAULT_PORT);
const bridge = new Bridge(port);
await bridge.start();

// ---------- per-thread session state ----------

const session = {
  groupId: null,   // internal group id (grp_…) — the "MCP tab group" of this session
  tabId: null,
  browserId: null, // deviceId of the selected browser (null = most recent)
};

// screenshot cache for upload_image: imageId -> {data(base64), mimeType}
const imageCache = new Map();
let imageCounter = 0;
function cacheImage(data, mimeType) {
  const id = `img_${++imageCounter}`;
  imageCache.set(id, { data, mimeType });
  while (imageCache.size > 20) imageCache.delete(imageCache.keys().next().value);
  return id;
}

const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

// Destructive tools must never inherit an implicit target.
const NO_TAB_DEFAULT = new Set(["close_tab", "tabs_close_mcp"]);

const DOWNLOADS = process.env.CHROME_AGENT_DOWNLOADS_DIR || join(homedir(), "Downloads");
try { mkdirSync(DOWNLOADS, { recursive: true }); } catch {}

// ---------- session bookkeeping ----------

function applySessionDefaults(name, args, { inBatch = false } = {}) {
  const a = { ...args };
  const wantsTab = "tabId" in (byName[name]?.inputSchema?.properties || {});
  if (wantsTab && !NO_TAB_DEFAULT.has(name) && a.tabId == null && session.tabId != null && !inBatch) {
    a.tabId = session.tabId; // aligned: inside a batch, tabId must be explicit
  }
  if (name === "new_tab" && !a.groupId && !a.ungrouped && session.groupId) a.groupId = session.groupId;
  if (name === "list_tabs" && !a.groupId && !a.all && session.groupId) a.groupId = session.groupId;
  if ((name === "tabs_context_mcp" || name === "tabs_create_mcp") && session.groupId) a.groupId = session.groupId;
  if (name === "tabs_close_mcp") a.groupId = session.groupId; // strict: session group only
  return a;
}

function updateSession(name, args, result) {
  switch (name) {
    case "create_tab_group":
    case "tabs_context_mcp":
      if (result.groupId) {
        session.groupId = result.groupId;
        const ids = [result.tabId, ...(result.tabs || []).map((t) => t.tabId)].filter((x) => x != null);
        // adopt a tab whenever the current one isn't part of this group —
        // this is how a session recovers from a tab that died externally
        if (ids.length && !ids.includes(session.tabId)) session.tabId = ids[0];
      }
      break;
    case "reconnect_tab_group":
      if (result.status === "connected" || result.status === "restored") {
        session.groupId = result.groupId;
        if (result.tabs?.length) session.tabId = result.tabs[0].tabId;
      }
      break;
    case "new_tab":
    case "tabs_create_mcp":
      if (result.tabId != null) session.tabId = result.tabId;
      // tabs_create_mcp/new_tab may have auto-created the session group
      if (!session.groupId && (result.agentGroupId || result.context?.groupId)) {
        session.groupId = result.agentGroupId || result.context.groupId;
      }
      break;
    case "navigate":
      if (args.tabId != null) session.tabId = args.tabId;
      break;
    case "close_tab":
    case "tabs_close_mcp":
      if (args.tabId === session.tabId) session.tabId = null;
      break;
    case "close_tab_group":
      if (args.groupId === session.groupId) {
        session.groupId = null;
        session.tabId = null;
      } else if (result?.closedTabIds?.includes(session.tabId)) {
        session.tabId = null;
      }
      break;
    case "select_browser":
    case "switch_browser":
      if (result?.selected?.deviceId) session.browserId = result.selected.deviceId;
      break;
  }
}

// ---------- result shaping ----------

function isImageResult(r) {
  return r && typeof r === "object" && r.data && r.mimeType?.startsWith("image/");
}

function toContent(name, result) {
  if (result && result.__content) return result.__content; // prebuilt (browser_batch)
  if (isImageResult(result)) {
    const { data, mimeType, ...meta } = result;
    return [
      { type: "image", data, mimeType },
      { type: "text", text: JSON.stringify(meta) },
    ];
  }
  const text = typeof result === "string" ? result : JSON.stringify(result ?? {}, null, 2);
  return [{ type: "text", text }];
}

// ---------- the tool pipeline ----------

function toolTimeout(tool, args) {
  let timeout = tool.timeout || 30000;
  if (tool.name === "wait_for" && args.timeoutMs) timeout = Math.min(args.timeoutMs, 60000) + 10000;
  if (tool.name === "computer" && (args.action === "wait" || args.action === "hold_key")) {
    timeout = Math.round((args.duration ?? 1) * 1000) + 15000;
  }
  return timeout;
}

// Pin the session to a concrete browser on first use, so another Chrome
// profile connecting mid-session can never hijack the routing.
async function ensureBrowserPinned() {
  if (session.browserId) return;
  try {
    const r = await bridge.call("hub:list_browsers", {}, 10000);
    const bs = (r.browsers || []).sort((a, b) => (b.connectedAt || 0) - (a.connectedAt || 0));
    if (bs.length) session.browserId = bs[0].deviceId;
  } catch { /* hub not ready yet — stay unpinned, try again next call */ }
}

async function runTool(name, rawArgs, { inBatch = false, noSession = false } = {}) {
  const tool = byName[name];
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  const args = applySessionDefaults(name, rawArgs || {}, { inBatch: inBatch || noSession });

  // ----- server-side composite tools -----
  if (name === "browser_batch") return runBatch(args);
  if (name === "upload_image") return runUploadImage(args);
  if (name === "gif_creator" && args.action === "export") return runGifExport(args);
  if (name === "shortcuts_execute") return runShortcut(args);
  if (name === "navigate" && !inBatch) return runNavigate(args, tool);

  if (!tool.method.startsWith("hub:")) await ensureBrowserPinned();
  let result;
  try {
    result = await bridge.call(tool.method, args, toolTimeout(tool, args), session.browserId);
  } catch (e) {
    const msg = String(e.message || e);
    // the session's tab died outside our view — drop it so tabs_context/
    // navigate auto-context can recover instead of failing forever
    if (args.tabId != null && args.tabId === session.tabId && /does not exist/.test(msg)) {
      session.tabId = null;
    }
    // pinned browser vanished, but exactly one is connected → repin + retry
    if (/is not connected/.test(msg) && session.browserId) {
      const r = await bridge.call("hub:list_browsers", {}, 10000).catch(() => null);
      const bs = r?.browsers || [];
      if (bs.length === 1) {
        session.browserId = bs[0].deviceId;
        result = await bridge.call(tool.method, args, toolTimeout(tool, args), session.browserId);
      } else {
        throw e;
      }
    } else {
      throw e;
    }
  }
  if (!noSession) updateSession(name, args, result);

  // post-processing for screenshots: image cache + save_to_disk
  if (isImageResult(result)) {
    result.imageId = cacheImage(result.data, result.mimeType);
    if (args.save_to_disk) {
      const ext = result.mimeType.includes("png") ? "png" : "jpg";
      const path = join(DOWNLOADS, `chrome-agent-${Date.now()}.${ext}`);
      writeFileSync(path, Buffer.from(result.data, "base64"));
      result.savedPath = path;
    }
  }
  if (name === "get_status") {
    result.serverVersion = VERSION;
    result.session = {
      currentGroupId: session.groupId,
      currentTabId: session.tabId,
      selectedBrowser: session.browserId,
      bridgeMode: bridge.mode,
    };
  }
  return result;
}

// navigate standalone: auto-create context when the session has no tab yet
async function runNavigate(args, tool) {
  const keyword = String(args.url || "").toLowerCase();
  const isHistory = keyword === "back" || keyword === "forward" || keyword === "reload";
  if (args.tabId == null && !isHistory) {
    const ctx = await runTool("tabs_context_mcp", { createIfEmpty: true });
    const tabId = ctx.tabs?.[0]?.tabId;
    if (tabId == null) throw new Error("Could not create a tab for navigation — is Chrome running?");
    const nav = await bridge.call("navigate", { ...args, tabId }, toolTimeout(tool, args), session.browserId);
    session.tabId = tabId;
    return { ...nav, context: ctx };
  }
  if (args.tabId == null && isHistory) {
    throw new Error(`tabId is required for url:"${keyword}".`);
  }
  const result = await bridge.call("navigate", args, toolTimeout(tool, args), session.browserId);
  session.tabId = args.tabId;
  return result;
}

// browser_batch: sequential, stop on first error, images interleaved
const PAGE_TOOLS_NEED_TAB = new Set([
  "computer", "read_page", "get_page_text", "find", "form_input", "javascript_tool",
  "file_upload", "upload_image", "navigate", "click", "fill", "drag_and_drop",
  "wait_for", "screenshot", "set_viewport", "read_console_messages",
  "read_network_requests", "get_response_body", "resize_window", "gif_creator",
]);

async function runBatch(args) {
  const actions = args.actions;
  if (!Array.isArray(actions) || !actions.length) throw new Error("actions must be a non-empty array");
  if (actions.length > 25) throw new Error("browser_batch is limited to 25 actions per call");
  const content = [];
  for (let i = 0; i < actions.length; i++) {
    const { name, input } = actions[i] || {};
    const label = `[${i + 1}/${actions.length}] ${name}`;
    try {
      if (name === "browser_batch") throw new Error("browser_batch cannot be nested");
      if (!byName[name]) throw new Error(`Unknown tool: ${name}`);
      if (PAGE_TOOLS_NEED_TAB.has(name) && (input?.tabId == null)) {
        throw new Error(`${name} requires an explicit tabId inside browser_batch`);
      }
      const result = await runTool(name, input, { inBatch: true });
      if (result && result.__content) {
        content.push({ type: "text", text: label + ":" }, ...result.__content);
      } else if (isImageResult(result)) {
        const { data, mimeType, ...meta } = result;
        content.push(
          { type: "image", data, mimeType },
          { type: "text", text: `${label}: ${JSON.stringify(meta)}` }
        );
      } else {
        content.push({ type: "text", text: `${label}: ${typeof result === "string" ? result : JSON.stringify(result)}` });
      }
    } catch (e) {
      content.push({ type: "text", text: `${label}: ERROR — ${e.message || e}. Batch stopped (${actions.length - i - 1} action(s) skipped).` });
      break;
    }
  }
  return { __content: content };
}

// upload_image: rebuild the cached screenshot inside the page
async function runUploadImage(args) {
  const img = imageCache.get(args.imageId);
  if (!img) {
    throw new Error(
      `Unknown imageId "${args.imageId}". Take a screenshot first — its result metadata includes the imageId. (The cache holds the last 20 images of this session.)`
    );
  }
  if (args.ref && args.coordinate) throw new Error("Provide either ref or coordinate, not both.");
  if (!args.ref && !args.coordinate) throw new Error("Provide ref (file input) or coordinate (drop target).");
  return bridge.call(
    "upload_image_inject",
    {
      tabId: args.tabId,
      ref: args.ref,
      coordinate: args.coordinate,
      filename: args.filename || "image.png",
      data: img.data,
      mimeType: img.mimeType,
    },
    45000,
    session.browserId
  );
}

// gif export: extension composites frames, server encodes the GIF
async function runGifExport(args) {
  const collected = await bridge.call(
    "gif_creator",
    { ...args, action: "export_frames" },
    120000,
    session.browserId
  );
  if (!collected.frames?.length) {
    throw new Error("No recorded frames. Use action:'start_recording', perform actions, then export.");
  }
  const quality = Math.min(Math.max(args.options?.quality ?? 10, 1), 30);
  const { bytes, width, height } = await encodeGif(collected.frames, collected.delays, quality);
  const filename = (args.filename || `recording-${Date.now()}`)
    .replace(/\.gif$/i, "")
    .replace(/[\/\\]/g, "_")
    .replace(/^\.+/, "") + ".gif";
  const path = join(DOWNLOADS, filename);
  writeFileSync(path, bytes);
  let downloaded = false;
  if (args.download) {
    try {
      await bridge.call(
        "download_data",
        { filename, dataUrl: `data:image/gif;base64,${Buffer.from(bytes).toString("base64")}` },
        30000,
        session.browserId
      );
      downloaded = true;
    } catch (e) {
      process.stderr.write(`[chrome-agent] browser download failed (${e.message}); file is still at ${path}\n`);
    }
  }
  return { exported: true, path, frames: collected.frames.length, width, height, sizeBytes: bytes.length, downloadedInBrowser: downloaded };
}

// shortcuts_execute: resolve, then run steps in the background (fire & forget)
async function runShortcut(args) {
  if (args.tabId == null) throw new Error("shortcuts_execute requires a tabId (the tab the shortcut runs on).");
  const list = await bridge.call("shortcuts_list", { tabId: args.tabId }, 15000, session.browserId);
  const all = list.shortcuts || [];
  const sc = all.find((s) => s.id === args.shortcutId) || all.find((s) => s.command === args.command);
  if (!sc) {
    throw new Error(
      `Shortcut not found${args.shortcutId ? ` (id ${args.shortcutId})` : args.command ? ` (command '${args.command}')` : ""}. ${all.length ? "Available: " + all.map((s) => s.command).join(", ") : "No shortcuts are defined — see the README for how to add them."}`
    );
  }
  const tabId = args.tabId;
  (async () => {
    for (const [i, step] of (sc.steps || []).entries()) {
      try {
        const input = JSON.parse(JSON.stringify(step.input || {}).replaceAll('"$TAB"', String(tabId)));
        // noSession: background steps must not mutate the session state the
        // agent's foreground calls rely on
        await runTool(step.name, input, { inBatch: true, noSession: true });
      } catch (e) {
        process.stderr.write(`[chrome-agent] shortcut '${sc.command}' step ${i + 1} (${step.name}) failed: ${e.message}\n`);
        break;
      }
    }
  })();
  return { started: true, shortcutId: sc.id, command: sc.command, steps: (sc.steps || []).length };
}

// ---------- MCP wiring ----------

const server = new Server(
  { name: "chrome-agent", version: VERSION },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  try {
    const result = await runTool(req.params.name, req.params.arguments || {});
    return { content: toContent(req.params.name, result) };
  } catch (e) {
    return {
      content: [{ type: "text", text: `Error: ${(e && e.message) || e}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`[chrome-agent] MCP server v${VERSION} ready (stdio, bridge mode: ${bridge.mode})\n`);

const shutdown = async () => {
  try { await bridge.stop(); } catch {}
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
// When the MCP client (Cowork/Claude Code) exits, it closes our stdin; the
// SDK transport doesn't surface that, so watch it directly — otherwise an
// orphan hub process would keep the port and never die.
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);
