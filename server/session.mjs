// Per-MCP-process tool state. Pins survive disconnects; only explicit selection retargets them.
import { writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { TOOLS } from "./tools.mjs";
import { encodeGif } from "./gif.mjs";
import { namespaceThreadTitle, normalizeRemoteContextId, remoteContextHash } from "./namespace.mjs";
import { BridgeError, SAFETY_CAPABILITIES, checkCancelled, failureMetadata, normalizeProfileEmail, profileMatches } from "./safety.mjs";

export const VERSION = "1.3.0";
const MAX_THREADS = 200;
const byName = Object.fromEntries(TOOLS.map(tool => [tool.name, tool]));
const NO_TAB_DEFAULT = new Set(["close_tab"]);
const PAGE_TOOLS_NEED_TAB = new Set([
  "computer", "read_page", "get_page_text", "find", "form_input", "javascript_tool", "file_upload", "upload_image",
  "navigate", "click", "fill", "drag_and_drop", "wait_for", "screenshot", "set_viewport", "read_console_messages",
  "read_network_requests", "get_response_body", "resize_window", "gif_creator",
]);
const keyOf = thread => thread ?? null;
const isImage = result => result && typeof result === "object" && result.data && result.mimeType?.startsWith("image/");

export function toContent(result) {
  if (result?.__content) return result.__content;
  if (isImage(result)) {
    const { data, mimeType, ...meta } = result;
    return [{ type: "image", data, mimeType }, { type: "text", text: JSON.stringify(meta) }];
  }
  return [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result ?? {}, null, 2) }];
}

export function createToolSession(bridge, {
  profileEmail,
  remoteContextId,
  downloadsDir = join(homedir(), "Downloads"),
} = {}) {
  const requiredProfile = normalizeProfileEmail(profileEmail);
  const contextId = normalizeRemoteContextId(remoteContextId);
  const selectedBrowser = new Map();
  const currentTab = new Map();
  const imageCache = new Map();
  let imageCounter = 0;
  const safety = Object.freeze({
    ...SAFETY_CAPABILITIES,
    requiredProfileEmail: requiredProfile,
    remoteContextConfigured: contextId !== null,
    remoteContextHash: contextId === null ? null : remoteContextHash(contextId),
  });

  const browserFor = thread => selectedBrowser.get(keyOf(thread)) ?? null;
  const active = execution => checkCancelled(execution.signal, { outcome: execution.dispatched ? "unknown" : "not-dispatched" });

  function rememberBrowser(thread, deviceId, explicit = false) {
    const key = keyOf(thread);
    const previous = selectedBrowser.get(key);
    if (previous && !explicit) return previous;
    if (!selectedBrowser.has(key) && selectedBrowser.size >= MAX_THREADS) {
      throw new BridgeError("PIN_LIMIT", "Browser selection capacity reached. Existing pins are retained; start a new configured server rather than forgetting a thread's selection.");
    }
    if (previous && previous !== deviceId) currentTab.delete(thread);
    selectedBrowser.set(key, deviceId);
    return deviceId;
  }

  function rememberTab(thread, tabId, execution) {
    if (!thread || tabId == null || browserFor(thread) !== execution.pins.get(keyOf(thread))) return;
    currentTab.delete(thread);
    currentTab.set(thread, tabId);
    while (currentTab.size > MAX_THREADS) currentTab.delete(currentTab.keys().next().value);
  }

  async function control(method, params, execution, timeout = 10000) {
    active(execution);
    return bridge.call(method, params, timeout, null, { signal: execution.signal, profileEmail: requiredProfile });
  }

  async function ensurePinned(thread, execution) {
    active(execution);
    const key = keyOf(thread);
    const captured = execution.pins.get(key);
    if (captured) {
      if (browserFor(thread) !== captured) throw new BridgeError("PROFILE_PIN_CONFLICT", "This request's browser selection changed. No later step was sent to the replacement profile.", { deviceId: captured });
      return captured;
    }
    let deviceId = browserFor(thread);
    if (!deviceId) {
      const result = await control("hub:list_browsers", {}, execution);
      active(execution);
      deviceId = browserFor(thread);
      if (!deviceId) {
        const eligible = (result.browsers || []).filter(info => profileMatches(info, requiredProfile));
        if (!eligible.length) throw new BridgeError("PROFILE_UNAVAILABLE", requiredProfile
          ? "No connected browser matches CHROME_AGENT_PROFILE_EMAIL. Other profiles will not be used."
          : "No Chrome browser is connected. Reconnect the intended profile before issuing work.");
        if (eligible.length !== 1) throw new BridgeError("PROFILE_SELECTION_REQUIRED", "Several eligible Chrome profiles are connected. Ask the user which profile to use, then call select_browser.");
        deviceId = rememberBrowser(thread, eligible[0].deviceId);
      }
    }
    execution.pins.set(key, deviceId);
    return deviceId;
  }

  async function browserCall(method, args, timeout, execution) {
    const deviceId = await ensurePinned(args.threadTitle, execution);
    active(execution);
    return bridge.call(method, args, timeout, deviceId, {
      signal: execution.signal,
      profileEmail: requiredProfile,
      onDispatch: () => { execution.dispatched = true; },
    });
  }

  function defaults(name, args, execution, inBatch) {
    const value = { ...args };
    if (!inBatch && !NO_TAB_DEFAULT.has(name) && value.tabId == null && "tabId" in (byName[name]?.inputSchema.properties || {})) {
      if (browserFor(value.threadTitle) === execution.pins.get(keyOf(value.threadTitle))) {
        const tab = currentTab.get(value.threadTitle);
        if (tab != null) value.tabId = tab;
      }
    }
    return value;
  }

  function timeout(tool, args) {
    if (tool.name === "wait_for" && args.timeoutMs) return Math.min(args.timeoutMs, 60000) + 10000;
    if (tool.name === "computer" && ["wait", "hold_key"].includes(args.action)) return Math.round((args.duration ?? 1) * 1000) + 15000;
    return tool.timeout || 30000;
  }

  function updateSession(name, args, result, execution) {
    const thread = args.threadTitle;
    if (browserFor(thread) !== execution.pins.get(keyOf(thread))) return;
    switch (name) {
      case "tabs_context_mcp":
      case "list_tabs": {
        const ids = (result.tabs || []).map(tab => tab.tabId).filter(id => id != null);
        if (ids.length && !ids.includes(currentTab.get(thread))) rememberTab(thread, ids[0], execution);
        break;
      }
      case "new_tab":
      case "tabs_create_mcp": rememberTab(thread, result.tabId, execution); break;
      case "navigate": rememberTab(thread, args.tabId, execution); break;
      case "close_tab": if (args.tabId === currentTab.get(thread)) currentTab.delete(thread); break;
      case "delete_my_tabs": currentTab.delete(thread); break;
    }
  }

  async function status(args, execution) {
    let browsers;
    try { browsers = (await control("hub:list_browsers", {}, execution)).browsers || []; }
    catch (error) {
      active(execution);
      return { connected: false, ready: false, serverVersion: VERSION, safety, error: error.message, session: { selectedBrowser: browserFor(args.threadTitle), bridgeMode: bridge.mode } };
    }
    const selected = browserFor(args.threadTitle);
    const eligible = browsers.filter(info => profileMatches(info, requiredProfile));
    const selectedInfo = browsers.find(info => info.deviceId === selected);
    if ((selected && (!selectedInfo || !profileMatches(selectedInfo, requiredProfile))) || (!selected && eligible.length !== 1)) {
      return {
        connected: browsers.length > 0,
        ready: false,
        ambiguous: !selected && eligible.length > 1,
        browsers,
        serverVersion: VERSION,
        safety,
        note: selected ? "The pinned browser is unavailable or no longer matches the configured profile. The pin is retained; no fallback is permitted."
          : eligible.length ? "Choose an eligible browser with select_browser." : "No permitted browser is connected.",
        session: { selectedBrowser: selected, selectedProfile: selectedInfo?.email || null, bridgeMode: bridge.mode, threadsSeen: selectedBrowser.size },
      };
    }
    const result = await browserCall("status", args, 30000, execution);
    const deviceId = execution.pins.get(keyOf(args.threadTitle));
    const info = browsers.find(browser => browser.deviceId === deviceId);
    return {
      ...result, ready: true, serverVersion: VERSION, safety,
      session: { selectedBrowser: deviceId, selectedProfile: info?.email || info?.name || null, bridgeMode: bridge.mode, threadsSeen: selectedBrowser.size },
    };
  }

  async function runTool(name, rawArgs, execution, { inBatch = false, noSession = false, trustedTitle = false } = {}) {
    active(execution);
    const tool = byName[name];
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    if (rawArgs?.threadTitle !== undefined && typeof rawArgs.threadTitle !== "string") throw new Error("threadTitle must be a string.");
    if (tool.inputSchema.required.includes("threadTitle") && !String(rawArgs?.threadTitle ?? "").trim()) {
      throw new Error(`${name} requires a stable threadTitle identifying your private browser workspace.`);
    }
    if (contextId !== null && !trustedTitle) rawArgs = { ...rawArgs, threadTitle: namespaceThreadTitle(contextId, rawArgs.threadTitle) };
    if (name === "browser_batch") return runBatch(rawArgs, execution);
    if (name === "get_status") return status(rawArgs, execution);
    if (tool.method.startsWith("hub:")) {
      if (name === "select_browser" && (typeof rawArgs.deviceId !== "string" || !rawArgs.deviceId)) throw new Error("select_browser requires deviceId.");
      const result = await control(tool.method, rawArgs, execution, tool.timeout || 30000);
      active(execution);
      if (name === "select_browser" || name === "switch_browser") {
        if (typeof result?.selected?.deviceId !== "string" || !result.selected.deviceId) throw new BridgeError("HUB_SELECTION_UNSUPPORTED", "The hub did not acknowledge an exact browser selection. No fallback is permitted.");
        if (!profileMatches(result.selected, requiredProfile)) throw new BridgeError("PROFILE_MISMATCH", "The chosen browser does not match CHROME_AGENT_PROFILE_EMAIL; the existing pin is unchanged.");
        if (name === "select_browser" && result.selected.deviceId !== rawArgs.deviceId) throw new BridgeError("PROFILE_MISMATCH", "The hub did not confirm the requested browser; the existing pin is unchanged.");
        const id = rememberBrowser(rawArgs.threadTitle, result.selected.deviceId, true);
        execution.pins.set(keyOf(rawArgs.threadTitle), id);
      }
      return result;
    }
    await ensurePinned(rawArgs.threadTitle, execution);
    const args = defaults(name, rawArgs, execution, inBatch || noSession);
    if (name === "upload_image") return runUploadImage(args, execution);
    if (name === "gif_creator" && args.action === "export") return runGifExport(args, execution);
    if (name === "shortcuts_execute") return runShortcut(args, execution);
    if (name === "navigate" && !inBatch) return runNavigate(args, tool, execution);
    let result;
    try { result = await browserCall(tool.method, args, timeout(tool, args), execution); }
    catch (error) {
      if (args.tabId != null && args.tabId === currentTab.get(args.threadTitle) && /does not exist/.test(String(error.message))) currentTab.delete(args.threadTitle);
      throw error;
    }
    active(execution);
    if (!noSession) updateSession(name, args, result, execution);
    if (isImage(result)) {
      const imageId = `img_${++imageCounter}`;
      imageCache.set(imageId, { data: result.data, mimeType: result.mimeType });
      while (imageCache.size > 20) imageCache.delete(imageCache.keys().next().value);
      result = { ...result, imageId };
      if (args.save_to_disk) {
        active(execution);
        mkdirSync(downloadsDir, { recursive: true });
        const path = join(downloadsDir, `chrome-agent-${Date.now()}.${result.mimeType.includes("png") ? "png" : "jpg"}`);
        writeFileSync(path, Buffer.from(result.data, "base64"));
        result.savedPath = path;
      }
    }
    return result;
  }

  async function runNavigate(args, tool, execution) {
    const keyword = String(args.url || "").toLowerCase();
    if (args.tabId == null && ["back", "forward", "reload"].includes(keyword)) throw new Error(`tabId is required for url:"${keyword}".`);
    let context;
    let tabId = args.tabId;
    if (tabId == null) {
      context = await runTool("tabs_context_mcp", { threadTitle: args.threadTitle }, execution, { trustedTitle: true });
      tabId = context.tabs?.[0]?.tabId;
      if (tabId == null) tabId = (await runTool("tabs_create_mcp", { threadTitle: args.threadTitle }, execution, { trustedTitle: true })).tabId;
      if (tabId == null) throw new Error("Could not create a tab for navigation.");
    }
    active(execution);
    const result = await browserCall("navigate", { ...args, tabId }, timeout(tool, args), execution);
    active(execution);
    rememberTab(args.threadTitle, tabId, execution);
    return context === undefined ? result : { ...result, context };
  }

  async function runBatch(args, execution) {
    const actions = args.actions;
    if (!Array.isArray(actions) || !actions.length) throw new Error("actions must be a non-empty array");
    if (actions.length > 25) throw new Error("browser_batch is limited to 25 actions per call");
    const content = [];
    for (let i = 0; i < actions.length; i++) {
      const { name, input } = actions[i] || {};
      const label = `[${i + 1}/${actions.length}] ${name}`;
      try {
        active(execution);
        if (name === "browser_batch") throw new Error("browser_batch cannot be nested");
        if (!byName[name]) throw new Error(`Unknown tool: ${name}`);
        if (PAGE_TOOLS_NEED_TAB.has(name) && input?.tabId == null) throw new Error(`${name} requires an explicit tabId inside browser_batch`);
        const inherited = input?.threadTitle === undefined;
        const stepInput = { ...(input || {}), threadTitle: inherited ? args.threadTitle : input.threadTitle };
        const result = await runTool(name, stepInput, execution, { inBatch: true, trustedTitle: inherited });
        content.push({ type: "text", text: `${label}:` }, ...toContent(result));
      } catch (error) {
        content.push({ type: "text", text: `${label}: ERROR — ${error.message || error}. Batch stopped (${actions.length - i - 1} action(s) skipped).` });
        return { __content: content, __isError: true, __meta: {
          "chrome-agent/error": { ...failureMetadata(error, execution.dispatched), completedActions: i, skippedActions: actions.length - i - 1 },
        } };
      }
    }
    return { __content: content };
  }

  async function runUploadImage(args, execution) {
    const image = imageCache.get(args.imageId);
    if (!image) throw new Error(`Unknown imageId "${args.imageId}". Take a screenshot first; the cache holds the last 20 images.`);
    if (args.ref && args.coordinate) throw new Error("Provide either ref or coordinate, not both.");
    if (!args.ref && !args.coordinate) throw new Error("Provide ref or coordinate.");
    return browserCall("upload_image_inject", { ...args, filename: args.filename || "image.png", ...image }, 45000, execution);
  }

  async function runGifExport(args, execution) {
    const collected = await browserCall("gif_creator", { ...args, action: "export_frames" }, 120000, execution);
    active(execution);
    if (!collected.frames?.length) throw new Error("No recorded frames. Start recording and perform actions before exporting.");
    const quality = Math.min(Math.max(args.options?.quality ?? 10, 1), 30);
    const { bytes, width, height } = await encodeGif(collected.frames, collected.delays, quality, execution.signal);
    active(execution);
    const filename = (args.filename || `recording-${Date.now()}`).replace(/\.gif$/i, "").replace(/[\/\\]/g, "_").replace(/^\.+/, "") + ".gif";
    mkdirSync(downloadsDir, { recursive: true });
    const path = join(downloadsDir, filename);
    writeFileSync(path, bytes);
    let downloaded = false;
    if (args.download) {
      try {
        await browserCall("download_data", { threadTitle: args.threadTitle, filename, dataUrl: `data:image/gif;base64,${Buffer.from(bytes).toString("base64")}` }, 30000, execution);
        downloaded = true;
      } catch (error) {
        active(execution);
        if (error.outcome === "unknown") throw error;
        process.stderr.write(`[chrome-agent] browser download not dispatched (${error.message}); file remains at ${path}\n`);
      }
    }
    return { exported: true, path, frames: collected.frames.length, width, height, sizeBytes: bytes.length, downloadedInBrowser: downloaded };
  }

  async function runShortcut(args, execution) {
    if (args.tabId == null) throw new Error("shortcuts_execute requires a tabId.");
    const list = await browserCall("shortcuts_list", { threadTitle: args.threadTitle, tabId: args.tabId }, 15000, execution);
    active(execution);
    const all = list.shortcuts || [];
    const shortcut = all.find(item => item.id === args.shortcutId) || all.find(item => item.command === args.command);
    if (!shortcut) throw new Error("Shortcut not found. Use shortcuts_list to inspect available shortcuts.");
    if (!Array.isArray(shortcut.steps)) throw new Error("Shortcut steps must be an array.");
    const background = { signal: execution.signal, pins: new Map(execution.pins), dispatched: false };
    void (async () => {
      for (const [i, step] of shortcut.steps.entries()) {
        try {
          active(background);
          const input = JSON.parse(JSON.stringify(step.input || {}).replaceAll('"$TAB"', String(args.tabId)));
          input.threadTitle = args.threadTitle;
          await runTool(step.name, input, background, { inBatch: true, noSession: true, trustedTitle: true });
        } catch (error) {
          process.stderr.write(`[chrome-agent] shortcut step ${i + 1} stopped: ${error.message}\n`);
          break;
        }
      }
    })();
    return {
      started: true, shortcutId: shortcut.id, command: shortcut.command, steps: shortcut.steps.length,
      submissionOnly: true, cancellableAfterReturn: false,
      note: "This acknowledges submission only. After return, MCP request cancellation cannot stop this shortcut. Already-dispatched browser actions may still apply.",
    };
  }

  return {
    safety,
    async execute(name, args = {}, signal) {
      const execution = { signal, pins: new Map(), dispatched: false };
      try {
        const result = await runTool(name, args, execution);
        return {
          content: toContent(result),
          ...(result?.__isError ? { isError: true } : {}),
          ...(result?.__meta ? { _meta: result.__meta } : {}),
          ...(name === "shortcuts_execute" ? { _meta: { "chrome-agent/submission": { submissionOnly: true, cancellableAfterReturn: false } } } : {}),
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error.message || error}${execution.dispatched && error.outcome !== "unknown" ? " Earlier browser commands may have applied; inspect effects before issuing new work." : ""}` }],
          isError: true,
          _meta: { "chrome-agent/error": failureMetadata(error, execution.dispatched) },
        };
      }
    },
  };
}
