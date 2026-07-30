// CDP (Chrome DevTools Protocol) plumbing via chrome.debugger.
//
// This is what enables true BACKGROUND driving: Input.dispatchMouseEvent /
// dispatchKeyEvent deliver trusted events to a tab regardless of whether it is
// active or its window is focused, and Page.captureScreenshot renders a
// background tab without bringing it forward.

const CDP_VERSION = "1.3";
const COMMAND_TIMEOUT_MS = 20000;

// tabId -> { console: [], network: Map<requestId, entry>, networkOrder: [] }
const attached = new Map();

const CONSOLE_RING = 500;
const NETWORK_RING = 400;

export function isAttached(tabId) {
  return attached.has(tabId);
}

// In-flight attaches, so concurrent callers share one attach instead of
// racing into "Another debugger is already attached".
const attaching = new Map(); // tabId -> Promise

export function attach(tabId) {
  if (attached.has(tabId)) return Promise.resolve();
  if (attaching.has(tabId)) return attaching.get(tabId);
  const p = doAttach(tabId).finally(() => attaching.delete(tabId));
  attaching.set(tabId, p);
  return p;
}

async function doAttach(tabId) {
  try {
    await chrome.debugger.attach({ tabId }, CDP_VERSION);
  } catch (e) {
    // If a previous service-worker incarnation attached and died, the session
    // is orphaned but still owned by this extension — detach and retry once.
    if (/Another debugger/i.test(String(e.message || e))) {
      await chrome.debugger.detach({ tabId }).catch(() => {});
      await chrome.debugger.attach({ tabId }, CDP_VERSION);
    } else {
      throw e;
    }
  }
  attached.set(tabId, { console: [], network: new Map(), networkOrder: [] });
  try {
    await Promise.all([
      cdp(tabId, "Page.enable"),
      cdp(tabId, "Runtime.enable"),
      cdp(tabId, "DOM.enable"),
      cdp(tabId, "Log.enable"),
      cdp(tabId, "Network.enable", { maxPostDataSize: 16384 }),
    ]);
  } catch (e) {
    // Leave the entry in place — a partially-enabled session is still usable
    // for input dispatch; individual tools will surface their own errors.
    console.warn("CDP domain enable failed:", e.message);
  }
  // Prevent native OS drags (draggable elements, images, links) from
  // entering a nested drag loop that would hang dispatchMouseEvent.
  try { await cdp(tabId, "Input.setInterceptDrags", { enabled: true }); } catch (_) {}
  // Background tabs that have never been visible have no compositor surface;
  // input hit-testing silently fails until one frame has been produced.
  await forcePaint(tabId);
}

export async function detach(tabId) {
  // wait out any in-flight attach so we don't leave a half-attached session
  if (attaching.has(tabId)) {
    await attaching.get(tabId).catch(() => {});
  }
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  try {
    await chrome.debugger.detach({ tabId });
  } catch (_) {
    // already detached (tab closed, user cancelled) — fine
  }
}

export async function ensureAttached(tabId) {
  try {
    await attach(tabId);
  } catch (e) {
    const msg = String(e.message || e);
    if (/Another debugger/i.test(msg)) {
      throw new Error(
        `Cannot attach to tab ${tabId}: another debugger (DevTools?) is already attached. Close DevTools for that tab and retry.`
      );
    }
    if (/Cannot attach|chrome:\/\/|webstore/i.test(msg)) {
      throw new Error(
        `Cannot attach to tab ${tabId}: Chrome forbids automation on this page (chrome:// pages, the Web Store, and some extension pages). Navigate the tab to a normal URL first.`
      );
    }
    throw e;
  }
}

// Raw CDP command with timeout (sendCommand can hang if the renderer is gone).
export function cdp(tabId, method, params = {}, { timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(result);
    });
  });
}

export async function withCdp(tabId, fn) {
  await ensureAttached(tabId);
  return fn();
}

// ---------- event buffering (console + network) ----------

function pushConsole(tabId, entry) {
  const s = attached.get(tabId);
  if (!s) return;
  s.console.push(entry);
  if (s.console.length > CONSOLE_RING) s.console.splice(0, s.console.length - CONSOLE_RING);
}

function remoteObjectToString(obj) {
  if (!obj) return "";
  if (obj.type === "string") return obj.value;
  if ("value" in obj) return JSON.stringify(obj.value);
  if (obj.description) return obj.description;
  return `<${obj.type}>`;
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (tabId == null || !attached.has(tabId)) return;
  const s = attached.get(tabId);
  const ts = Date.now();

  switch (method) {
    case "Page.frameNavigated": {
      // Aligned with claude-in-chrome: the network buffer clears when the
      // page navigates to a different domain.
      if (!params.frame || params.frame.parentId) break; // main frame only
      let origin = "";
      try { origin = new URL(params.frame.url).origin; } catch (_) {}
      if (s.lastOrigin && origin && s.lastOrigin !== origin) {
        s.network.clear();
        s.networkOrder = [];
        s.console = []; // official parity: messages are "from the current domain only"
      }
      if (origin) s.lastOrigin = origin;
      break;
    }
    case "Page.screencastFrame":
      // ack immediately so the stream keeps flowing (see beginLiveFrames)
      chrome.debugger.sendCommand({ tabId }, "Page.screencastFrameAck", { sessionId: params.sessionId }, () => {
        void chrome.runtime.lastError;
      });
      break;
    case "Runtime.consoleAPICalled":
      pushConsole(tabId, {
        ts,
        level: params.type,
        text: (params.args || []).map(remoteObjectToString).join(" ").slice(0, 2000),
      });
      break;
    case "Runtime.exceptionThrown": {
      const d = params.exceptionDetails || {};
      pushConsole(tabId, {
        ts,
        level: "error",
        text: `Uncaught ${d.exception ? remoteObjectToString(d.exception) : d.text || "exception"} at ${d.url || "?"}:${d.lineNumber ?? "?"}`.slice(0, 2000),
      });
      break;
    }
    case "Log.entryAdded": {
      const e = params.entry || {};
      pushConsole(tabId, {
        ts,
        level: e.level || "info",
        text: `[${e.source || "log"}] ${e.text || ""}`.slice(0, 2000),
      });
      break;
    }
    case "Network.requestWillBeSent": {
      const { requestId, request, type } = params;
      if (!s.network.has(requestId)) {
        s.networkOrder.push(requestId);
        if (s.networkOrder.length > NETWORK_RING) {
          const evict = s.networkOrder.splice(0, s.networkOrder.length - NETWORK_RING);
          for (const id of evict) s.network.delete(id);
        }
      }
      s.network.set(requestId, {
        requestId,
        ts,
        url: request.url,
        method: request.method,
        resourceType: type,
        status: null,
        mimeType: null,
        failed: false,
      });
      break;
    }
    case "Network.responseReceived": {
      const e = s.network.get(params.requestId);
      if (e) {
        e.status = params.response.status;
        e.mimeType = params.response.mimeType;
      }
      break;
    }
    case "Network.loadingFailed": {
      const e = s.network.get(params.requestId);
      if (e) {
        e.failed = true;
        e.errorText = params.errorText;
      }
      break;
    }
  }
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId != null) attached.delete(source.tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  attached.delete(tabId);
});

// ---------- frame forcing (background-tab input) ----------
//
// A background tab's compositor is idle: requestAnimationFrame never fires,
// so mouse events either get dropped (no surface yet) or hang waiting for a
// compositor frame (wheel, drags). Page.startScreencast does NOT produce
// frames through chrome.debugger on a never-visible tab — but each
// Page.captureScreenshot forces one full BeginFrame. So:
//   * forcePaint(): one forced frame — creates the surface; run on attach so
//     hit-testing works from the first click.
//   * withFramePump(): keeps forcing frames every ~90ms while a compositor-
//     dependent input sequence (wheel scroll, pointer drag) is in flight.

export async function forcePaint(tabId) {
  try {
    await cdp(tabId, "Page.captureScreenshot", { format: "jpeg", quality: 1 });
  } catch (_) { /* best-effort */ }
}

// ---------- waking suspended tabs ----------
//
// Chrome reclaims memory from background tabs (especially in collapsed groups,
// and harder under memory pressure): a FROZEN tab's renderer stops running
// tasks, so chrome.scripting.executeScript never resolves; a DISCARDED tab has
// no renderer at all. Both must be revived before injecting scripts. The
// debugger's Page.setWebLifecycleState is the supported way to resume a frozen
// page; a discarded tab has to be reloaded.

async function waitComplete(tabId, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) return;
    if (t.status === "complete" && !t.discarded) return;
    await new Promise((r) => setTimeout(r, 150));
  }
}

export async function resumePage(tabId) {
  await ensureAttached(tabId);
  try {
    await cdp(tabId, "Page.setWebLifecycleState", { state: "active" });
  } catch (_) { /* not frozen, or unsupported — fine */ }
}

export async function wakeTab(tabId) {
  const t = await chrome.tabs.get(tabId).catch(() => null);
  if (!t) return;
  if (t.discarded) {
    await chrome.tabs.reload(tabId);
    await waitComplete(tabId);
  } else if (t.frozen) {
    await resumePage(tabId);
  }
}

export async function withFramePump(tabId, fn) {
  await ensureAttached(tabId);
  let running = true;
  const pumper = (async () => {
    while (running) {
      await forcePaint(tabId);
      await new Promise((r) => setTimeout(r, 90));
    }
  })();
  try {
    return await fn();
  } finally {
    running = false;
    await pumper.catch(() => {});
  }
}

// ---------- buffer readers ----------

export function readConsole(tabId, { level, pattern, onlyErrors = false, limit = 100, clear = false } = {}) {
  const s = attached.get(tabId);
  if (!s) return { attached: false, messages: [], note: "Not attached yet — interact with or screenshot the tab first; console buffering starts on attach." };
  let msgs = s.console;
  if (onlyErrors || level === "error") {
    msgs = msgs.filter((m) => m.level === "error" || m.level === "assert");
  } else if (level === "warn") {
    msgs = msgs.filter((m) => ["error", "assert", "warning", "warn"].includes(m.level));
  }
  if (pattern) {
    let re;
    try {
      re = new RegExp(pattern, "i");
    } catch (e) {
      throw new Error(`Invalid regex pattern "${pattern}": ${e.message}`);
    }
    msgs = msgs.filter((m) => re.test(m.text));
  }
  const out = msgs.slice(-limit);
  if (clear) s.console = [];
  return { attached: true, total: msgs.length, messages: out };
}

export function readNetwork(tabId, { filter, urlPattern, limit = 100, clear = false } = {}) {
  const s = attached.get(tabId);
  if (!s) return { attached: false, requests: [], note: "Not attached yet — interact with or screenshot the tab first; network buffering starts on attach." };
  let reqs = s.networkOrder.map((id) => s.network.get(id)).filter(Boolean);
  if (filter === "failed") reqs = reqs.filter((r) => r.failed || (r.status && r.status >= 400));
  if (urlPattern) reqs = reqs.filter((r) => r.url.includes(urlPattern));
  const out = reqs.slice(-limit);
  if (clear) {
    s.network.clear();
    s.networkOrder = [];
  }
  return { attached: true, total: reqs.length, requests: out };
}

const BODY_CAP = 150000; // chars (base64 bodies ≈ 110KB binary at this cap)

export async function getResponseBody(tabId, requestId) {
  await ensureAttached(tabId);
  let res;
  try {
    res = await cdp(tabId, "Network.getResponseBody", { requestId });
  } catch (e) {
    throw new Error(
      `Response body for ${requestId} is no longer available (the tab navigated or the body was evicted). Re-trigger the request and read it promptly.`
    );
  }
  const { body, base64Encoded } = res;
  return {
    body: body.slice(0, BODY_CAP),
    base64Encoded,
    truncated: body.length > BODY_CAP,
    totalChars: body.length,
  };
}
