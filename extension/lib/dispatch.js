// Command dispatch: maps bridge-protocol methods to implementations.
//
// v1.1.0 speaks the claude-in-chrome-aligned protocol AND keeps every 1.0.x
// method name as an alias, so live sessions running an older server keep
// working after the extension reloads.

import * as groups from "./groups.js";
import * as tabs from "./tabs.js";
import * as reading from "./reading.js";
import * as input from "./input.js";
import * as actions from "./actions.js";
import * as shot from "./screenshot.js";
import * as cdp from "./cdp.js";
import { gifCreator, recordAction } from "./gif.js";

// Identity for hub:* fallbacks (mirrors background.js's hello payload).
async function selfIdentity() {
  const stored = await chrome.storage.local.get(["instanceId", "browserName"]);
  let platform = "unknown";
  try { platform = (await chrome.runtime.getPlatformInfo()).os; } catch (_) {}
  const deviceId = stored.instanceId || "unknown";
  let email = null;
  try {
    email = (await chrome.identity.getProfileUserInfo({ accountStatus: "ANY" }))?.email || null;
  } catch (_) {}
  return {
    deviceId,
    name: stored.browserName || email || `Chrome (${platform}, ${String(deviceId).slice(0, 6)})`,
    ...(email ? { email } : {}),
    platform,
    extensionVersion: chrome.runtime.getManifest().version,
  };
}

// Every tab-scoped command proves the tab belongs to the calling thread's own
// group before doing anything to it.
async function requireTab(params) {
  if (params.tabId == null) throw new Error("tabId is required — call tabs_context_mcp (or create a tab) first.");
  await tabs.assertTabInGroup(params.tabId, params.groupId);
  await tabs.getTab(params.tabId); // wakes frozen/discarded tabs
  return params.tabId;
}

// modifiers: aligned string form ("ctrl+shift") or legacy array (["ctrl"])
function normalizeModifiers(m) {
  if (!m) return [];
  if (Array.isArray(m)) return m;
  return String(m).split("+").map((s) => s.trim()).filter(Boolean);
}

// The unified coordinate/keyboard tool, aligned with claude-in-chrome's
// computer tool (ref targeting, zoom, scroll_to, hover, key sequences) plus
// chrome-agent's extra raw primitives.
async function computer(params) {
  const tabId = await requireTab(params);
  const { action } = params;
  const modifiers = normalizeModifiers(params.modifiers);

  // clicks accept ref as an alternative to coordinate (aligned)
  const point = async (required = true) => {
    if (Array.isArray(params.coordinate) && params.coordinate.length === 2) {
      return { x: params.coordinate[0], y: params.coordinate[1] };
    }
    if (params.ref) {
      const loc = await reading.locate(tabId, { ref: params.ref });
      return loc.center;
    }
    if (required) throw new Error(`action "${action}" requires coordinate:[x,y] (or ref)`);
    return null;
  };

  switch (action) {
    case "left_click":
    case "right_click":
    case "middle_click":
    case "double_click":
    case "triple_click": {
      const { x, y } = await point();
      const button = action === "right_click" ? "right" : action === "middle_click" ? "middle" : "left";
      const clickCount = action === "double_click" ? 2 : action === "triple_click" ? 3 : 1;
      await input.click(tabId, x, y, { button, clickCount, modifiers });
      await recordAction(tabId, { type: action, coordinate: [x, y], label: `${action.replace("_", " ")} (${Math.round(x)}, ${Math.round(y)})` });
      return { done: true, action, at: [x, y] };
    }
    case "hover": {
      const { x, y } = await point();
      await input.moveMouse(tabId, x, y);
      await recordAction(tabId, { type: "hover", coordinate: [x, y], label: `hover (${Math.round(x)}, ${Math.round(y)})` });
      return { done: true, action, at: [x, y] };
    }
    case "scroll_to": {
      if (!params.ref) throw new Error("scroll_to requires ref (from read_page or find)");
      const r = await actions.scrollToElement(tabId, { ref: params.ref });
      await recordAction(tabId, { type: "scroll", label: "scroll to element" });
      return { done: true, action, ...r };
    }
    case "mouse_move": {
      const { x, y } = await point();
      await input.moveMouse(tabId, x, y);
      return { done: true, action, at: [x, y] };
    }
    case "left_mouse_down": {
      const { x, y } = await point();
      await input.mouseDown(tabId, x, y);
      return { done: true, action, at: [x, y] };
    }
    case "left_mouse_up": {
      const { x, y } = await point();
      await input.mouseUp(tabId, x, y);
      return { done: true, action, at: [x, y] };
    }
    case "left_click_drag": {
      if (!Array.isArray(params.start_coordinate)) throw new Error("left_click_drag requires start_coordinate:[x,y]");
      if (!Array.isArray(params.coordinate) && !Array.isArray(params.end_coordinate)) {
        throw new Error("left_click_drag requires coordinate (the end position)");
      }
      const from = { x: params.start_coordinate[0], y: params.start_coordinate[1] };
      const end = params.coordinate || params.end_coordinate;
      const to = { x: end[0], y: end[1] };
      await input.drag(tabId, from, to, { steps: params.steps || 12 });
      await recordAction(tabId, { type: "drag", from: [from.x, from.y], to: [to.x, to.y], label: "drag" });
      return { done: true, action, from: [from.x, from.y], to: [to.x, to.y] };
    }
    case "scroll": {
      const { x, y } = await point();
      const dir = params.scroll_direction || "down";
      const amount = Math.min(Math.max(params.scroll_amount ?? 3, 1), 10) * 120;
      const delta = {
        down: { deltaY: amount }, up: { deltaY: -amount },
        right: { deltaX: amount }, left: { deltaX: -amount },
      }[dir];
      if (!delta) throw new Error(`invalid scroll_direction: ${dir}`);
      await input.scroll(tabId, x, y, delta);
      await recordAction(tabId, { type: "scroll", coordinate: [x, y], label: `scroll ${dir}` });
      return { done: true, action, at: [x, y], direction: dir };
    }
    case "type": {
      if (params.text == null) throw new Error("type requires text");
      await input.typeText(tabId, params.text);
      await recordAction(tabId, { type: "type", label: `type "${String(params.text).slice(0, 40)}"` });
      return { done: true, action, chars: String(params.text).length };
    }
    case "key": {
      if (!params.text) throw new Error('key requires text, e.g. "Enter", "cmd+a", or "Backspace Backspace"');
      const repeat = Math.min(Math.max(params.repeat || 1, 1), 100);
      // aligned: space-separated SEQUENCE of keys/chords, repeated `repeat` times.
      // A literal/lone space means the space BAR (parseChord would trim it away).
      const sequence = /^\s+$/.test(params.text) ? ["space"] : params.text.split(/\s+/).filter(Boolean);
      for (let i = 0; i < repeat; i++) {
        for (const chord of sequence) await input.pressChord(tabId, chord);
      }
      await recordAction(tabId, { type: "key", label: `key ${params.text}${repeat > 1 ? ` ×${repeat}` : ""}` });
      return { done: true, action, keys: params.text, repeat };
    }
    case "hold_key": {
      if (!params.text) throw new Error("hold_key requires text (the key to hold)");
      await input.holdKey(tabId, params.text, Math.round(Math.min(params.duration ?? 1, 10) * 1000));
      return { done: true, action, keys: params.text };
    }
    case "wait": {
      const ms = Math.min(Math.round((params.duration ?? 1) * 1000), 10000);
      await new Promise((r) => setTimeout(r, ms));
      return { done: true, action, ms };
    }
    case "cursor_position":
      return { position: input.cursorPosition(tabId) };
    case "screenshot":
      return await shot.screenshot(tabId, {});
    case "zoom": {
      if (!Array.isArray(params.region) || params.region.length !== 4) {
        throw new Error("zoom requires region:[x0, y0, x1, y1] (viewport pixels)");
      }
      return await shot.screenshot(tabId, { region: params.region });
    }
    default:
      throw new Error(`unknown computer action: ${action}`);
  }
}

// ---------- shortcuts (storage-backed registry) ----------

async function shortcutsList() {
  const data = await chrome.storage.local.get("shortcuts");
  const raw = Array.isArray(data.shortcuts) ? data.shortcuts : [];
  const shortcuts = raw
    .filter((s) => s && s.id && s.command && Array.isArray(s.steps))
    .map((s) => ({
      id: String(s.id),
      command: String(s.command),
      description: String(s.description || ""),
      isWorkflow: !!s.isWorkflow,
      steps: s.steps,
    }));
  return {
    shortcuts,
    ...(shortcuts.length ? {} : {
      note: "No shortcuts defined. Add them to chrome.storage.local key 'shortcuts' as [{id, command, description, isWorkflow, steps:[{name, input}]}]; use \"$TAB\" in step inputs as the target-tab placeholder.",
    }),
  };
}

// Commands that operate on the browser at large rather than on a thread's tabs.
const THREADLESS = new Set([
  "status", "reload_self", "reload_extension", "download_data", "shortcuts_list",
  "hub:list_browsers", "hub:select_browser", "hub:switch_browser",
]);

// Only these bring a workspace (and its browser window) into being. Everything
// else — reads, cleanup — must observe the workspace as it is: otherwise
// listing tabs right after deleting them would silently reopen a window, and an
// empty workspace could never be observed as empty.
const CREATES_WORKSPACE = new Set(["tabs_create", "new_tab"]);

// Reclaiming stale groups needs no timer: sweep opportunistically, at most
// hourly, on whatever command happens to arrive.
let lastGcAt = 0;
async function maybeGc() {
  if (Date.now() - lastGcAt < 60 * 60 * 1000) return;
  lastGcAt = Date.now();
  try { await groups.gcStaleThreads(); } catch (_) {}
}

export async function handle(method, params = {}) {
  // ── the thread-identity chokepoint ──
  // Resolve (creating on first use) THE one group owned by this threadTitle and
  // inject it as groupId. Downstream code can therefore only ever act inside
  // the caller's own group: there is no parameter that selects another one.
  if (!THREADLESS.has(method)) {
    void maybeGc();
    const creates = CREATES_WORKSPACE.has(method);
    // Hand the destination down so a group being born opens its mandatory seed
    // tab AT that url — the seed then IS the caller's first tab instead of a
    // blank one stranded beside it.
    const g = await groups.groupForThread(params.threadTitle, {
      create: creates,
      ...(creates ? { url: params.url } : {}),
    });
    if (!g) {
      if (method === "delete_my_tabs") return { deleted: true, closedTabs: 0, note: "nothing to delete — this thread had no workspace" };
      if (method === "tabs_context" || method === "list_tabs") {
        return { tabs: [], note: "You have no tabs yet. Create one (tabs_create_mcp or new_tab) to start your workspace." };
      }
      throw new Error("You have no tabs yet — create one with tabs_create_mcp or new_tab first.");
    }
    // seedTabId is assigned here and NOWHERE else: writing it unconditionally
    // overwrites any client-supplied value, so a caller cannot hand us a tab id
    // and have newTab adopt that instead of opening a fresh tab.
    params = { ...params, groupId: g.groupId, seedTabId: g.seedTabId ?? null };
  }

  switch (method) {
    // status
    case "status": {
      const reg = await groups.listGroups();
      return {
        connected: true,
        extensionVersion: chrome.runtime.getManifest().version,
        threads: reg.groups.length,
      };
    }

    // tab model (always scoped to the caller's own group)
    case "tabs_context": return await tabs.tabsContext(params);
    case "tabs_create": return await tabs.tabsCreate(params);
    case "resize_window": return await tabs.resizeWindow(params);

    // The thread's own workspace: delete everything it opened. There is no
    // "close" variant, because closing leaves a saved group behind.
    case "delete_my_tabs": {
      try {
        const { live } = await groups.resolveGroup(params.groupId);
        if (live) {
          const groupTabs = await chrome.tabs.query({ groupId: live.id });
          await Promise.all(groupTabs.map((t) => cdp.detach(t.id)));
        }
      } catch (_) {}
      return await groups.deleteGroup(params.groupId);
    }

    // tabs
    case "new_tab": return await tabs.newTab(params);
    case "list_tabs": return await tabs.listTabs(params);
    case "close_tab": return await tabs.closeTab(params);
    case "navigate": {
      await requireTab(params);
      const r = await tabs.navigate(params);
      await recordAction(params.tabId, { type: "navigate", label: `navigate ${String(params.url).slice(0, 60)}` });
      return r;
    }
    case "bring_to_foreground": return await tabs.bringToForeground(params);

    // reading
    case "read_page": return await reading.readPage(await requireTab(params), params);
    case "get_page_text": return await reading.getPageText(await requireTab(params), params);
    case "find": return await reading.find(await requireTab(params), params.query, params.maxResults);
    case "screenshot": return await shot.screenshot(await requireTab(params), params);
    case "set_viewport": return await shot.setViewport(await requireTab(params), params);

    // interaction
    case "computer": return await computer(params);
    case "click": {
      const tabId = await requireTab(params);
      const r = await actions.clickElement(tabId, { ...params, modifiers: normalizeModifiers(params.modifiers) });
      await recordAction(tabId, { type: "click", coordinate: [r.at.x, r.at.y], label: `click ${r.element?.text ? JSON.stringify(r.element.text.slice(0, 30)) : ""}` });
      return r;
    }
    case "hover": return await actions.hoverElement(await requireTab(params), params);
    case "scroll_to": return await actions.scrollToElement(await requireTab(params), params);
    case "fill": {
      const tabId = await requireTab(params);
      const r = await actions.fill(tabId, params);
      await recordAction(tabId, { type: "fill", label: `fill "${String(params.text).slice(0, 30)}"` });
      return r;
    }
    case "form_input": {
      const tabId = await requireTab(params);
      const r = await actions.formInput(tabId, params);
      await recordAction(tabId, { type: "form_input", label: "set form value" });
      return r;
    }
    case "drag_and_drop": {
      const tabId = await requireTab(params);
      const r = await actions.dragAndDrop(tabId, params);
      await recordAction(tabId, { type: "drag", from: r.from ? [r.from.x, r.from.y] : undefined, to: r.to ? [r.to.x, r.to.y] : undefined, label: "drag and drop" });
      return r;
    }
    case "press_key": {
      // legacy alias for computer {action:"key"}
      const tabId = await requireTab(params);
      const repeat = Math.min(params.repeat || 1, 50);
      for (let i = 0; i < repeat; i++) await input.pressChord(tabId, params.keys);
      return { done: true, keys: params.keys, repeat };
    }
    case "upload_file": return await actions.uploadFile(await requireTab(params), params);
    case "upload_image_inject": return await actions.uploadImageInject(await requireTab(params), params);
    case "javascript_exec": {
      const tabId = await requireTab(params);
      return await actions.executeJavascript(tabId, { code: params.text ?? params.code, timeoutMs: params.timeoutMs });
    }
    case "execute_javascript": {
      // legacy alias (pre-1.1 servers)
      const tabId = await requireTab(params);
      return await actions.executeJavascript(tabId, params);
    }
    case "wait_for": return await actions.waitFor(await requireTab(params), params);

    // gif recording
    case "gif_creator": {
      await requireTab(params);
      return await gifCreator(params);
    }
    case "download_data": {
      if (!params.dataUrl || !params.filename) throw new Error("filename and dataUrl are required");
      const id = await chrome.downloads.download({
        url: params.dataUrl,
        filename: params.filename,
        conflictAction: "uniquify",
      });
      return { downloadId: id, filename: params.filename };
    }

    // shortcuts
    case "shortcuts_list": return await shortcutsList();

    // hub control ops, answered by the extension when an OLD hub (v1.0.x)
    // forwards them here instead of handling them itself. A current hub
    // intercepts these before they ever reach the extension.
    case "hub:list_browsers": {
      const id = await selfIdentity();
      return { browsers: [{ ...id, connectedAt: Date.now(), thisComputer: true }] };
    }
    case "hub:select_browser": {
      const id = await selfIdentity();
      if (params.deviceId && params.deviceId !== id.deviceId) {
        throw new Error(`Browser ${params.deviceId} is not connected (this hub predates multi-browser support; only ${id.deviceId} is reachable).`);
      }
      return { selected: id };
    }
    case "hub:switch_browser": {
      const id = await selfIdentity();
      return { selected: id, note: "Only one browser is reachable through this hub — selected automatically." };
    }

    // maintenance
    case "reload_self":
    case "reload_extension": {
      // Unpacked extensions re-read their files from disk on reload, so this
      // applies code changes without visiting chrome://extensions. The
      // WebSocket drops; the extension reconnects a moment later.
      setTimeout(() => chrome.runtime.reload(), 100);
      return { reloading: true, note: "Extension is reloading; reconnects within a few seconds." };
    }

    // diagnostics
    case "read_console": return cdp.readConsole(await requireTab(params), params);
    case "read_network": return cdp.readNetwork(await requireTab(params), params);
    case "get_response_body": return await cdp.getResponseBody(await requireTab(params), params.requestId);

    default:
      throw new Error(`unknown method: ${method}`);
  }
}
