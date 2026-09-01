// Chrome Agent Bridge — MV3 service worker entry.
//
// Maintains a WebSocket to the local MCP hub (ws://127.0.0.1:47120/ext) and
// executes bridge commands. The WebSocket doubles as the service-worker
// keep-alive: Chrome 116+ extends the SW lifetime while WS traffic flows,
// and the hub pings every 20s.

import { handle } from "./lib/dispatch.js";
import { scheduleSnapshots, listGroups, deleteGroup } from "./lib/groups.js";

const WS_URL = "ws://127.0.0.1:47120/ext";

let ws = null;
let reconnectDelay = 1000;

function setBadge(connected) {
  try {
    chrome.action.setBadgeText({ text: connected ? "●" : "" });
    chrome.action.setBadgeBackgroundColor({ color: connected ? "#1a7f37" : "#999999" });
  } catch (_) {}
}

function send(obj) {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  } catch (_) {}
}

function scheduleReconnect() {
  setTimeout(() => {
    // Cap the backoff low: this is how long the FIRST tool call of a new agent
    // session waits for the extension to notice the new hub.
    reconnectDelay = Math.min(reconnectDelay * 1.5, 3000);
    connect();
  }, reconnectDelay);
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  try {
    ws = new WebSocket(WS_URL);
  } catch (_) {
    scheduleReconnect();
    return;
  }
  ws.onopen = async () => {
    reconnectDelay = 1000;
    setBadge(true);
    send({ event: "hello", version: chrome.runtime.getManifest().version, ...(await identity()) });
  };
  ws.onclose = () => {
    setBadge(false);
    scheduleReconnect();
  };
  ws.onerror = () => {
    try { ws.close(); } catch (_) {}
  };
  ws.onmessage = async (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (_) { return; }
    if (msg.method === "ping") { send({ method: "pong" }); return; }
    if (msg.method === "pair_request") { onPairRequest(); return; }
    if (!msg.id) return;
    try {
      const result = await handle(msg.method, msg.params || {});
      send({ id: msg.id, ok: true, result });
    } catch (e) {
      send({ id: msg.id, ok: false, error: String((e && e.message) || e) });
    }
  };
}


// ---------- identity (multi-browser support) ----------
// A persistent per-profile instanceId lets the hub tell multiple Chrome
// profiles/channels apart (list_connected_browsers / select_browser).

let identityCache = null;
async function identity() {
  if (identityCache) return identityCache;
  const stored = await chrome.storage.local.get(["instanceId", "browserName"]);
  let { instanceId, browserName } = stored;
  if (!instanceId) {
    instanceId = crypto.randomUUID();
    await chrome.storage.local.set({ instanceId });
  }
  let platform = "unknown";
  try { platform = (await chrome.runtime.getPlatformInfo()).os; } catch (_) {}
  const email = await profileEmail();
  identityCache = {
    instanceId,
    platform,
    ...(email ? { email } : {}),
    name: browserName || email || `Chrome (${platform}, ${instanceId.slice(0, 6)})`,
  };
  return identityCache;
}

// The signed-in address is the only thing that distinguishes one profile from
// another in terms the user can act on: an instanceId prefix names a profile
// they cannot recognize, and picking the wrong one files their tab groups —
// which Chrome 129+ auto-saves and syncs — into the wrong Google account.
//
// getProfileUserInfo needs no OAuth prompt and answers {} on a signed-out
// profile, so a missing email is a normal result rather than a failure.
async function profileEmail() {
  try {
    const info = await chrome.identity.getProfileUserInfo({ accountStatus: "ANY" });
    return info?.email || null;
  } catch (_) {
    return null;
  }
}

// ---------- pairing (switch_browser) ----------
// The hub broadcasts pair_request to every connected browser; the user picks
// one by clicking the notification or the popup's Connect button.

let pairPendingUntil = 0;

function onPairRequest() {
  pairPendingUntil = Date.now() + 120000;
  // survive SW restarts within the 2-minute window
  chrome.storage.session.set({ pairPendingUntil }).catch?.(() => {});
  try {
    chrome.notifications.create("cab-pair", {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "Agent connection request",
      message: "An agent wants to use THIS browser. Click here (or the extension icon → Connect) to choose it.",
      priority: 2,
    });
  } catch (_) {}
  try {
    chrome.action.setBadgeText({ text: "?" });
    chrome.action.setBadgeBackgroundColor({ color: "#d97706" });
  } catch (_) {}
}

async function confirmPair() {
  if (Date.now() > pairPendingUntil) {
    // SW may have restarted since the request — check the persisted window
    const stored = await chrome.storage.session.get("pairPendingUntil").catch(() => ({}));
    if (!stored.pairPendingUntil || Date.now() > stored.pairPendingUntil) return false;
    pairPendingUntil = stored.pairPendingUntil;
  }
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    connect(); // don't consume the click — the user can press again in a second
    return false;
  }
  pairPendingUntil = 0;
  chrome.storage.session.remove("pairPendingUntil").catch?.(() => {});
  send({ event: "pair" });
  try { chrome.notifications.clear("cab-pair"); } catch (_) {}
  setBadge(true);
  return true;
}

if (chrome.notifications) {
  chrome.notifications.onClicked.addListener((id) => {
    if (id === "cab-pair") void confirmPair();
  });
}

// ---------- lifecycle ----------

connect();
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);

// Belt-and-braces keep-alive: an alarm re-runs the SW (and reconnects) even
// if the socket dropped while the worker was asleep.
if (chrome.alarms) {
  chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
  chrome.alarms.onAlarm.addListener((a) => {
    if (a.name === "keepalive") connect();
  });
}

// Keep group tab-snapshots fresh so reconnect-after-restart can restore them.
chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.status === "complete" || info.groupId !== undefined) scheduleSnapshots();
});
chrome.tabs.onRemoved.addListener(() => scheduleSnapshots());
chrome.tabs.onAttached.addListener(() => scheduleSnapshots());
chrome.tabGroups.onUpdated.addListener(() => scheduleSnapshots());

// ---------- popup messaging ----------

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg === "status") {
    (async () => {
      // The popup is the USER's surface, so it sees every thread's group —
      // unlike agents, which are scoped to their own.
      let groups = [];
      try {
        const res = await listGroups();
        groups = res.groups;
      } catch (_) {}
      reply({
        connected: !!(ws && ws.readyState === WebSocket.OPEN),
        url: WS_URL,
        groups,
        pairPending: Date.now() < pairPendingUntil,
      });
    })();
    return true; // async reply
  }
  if (msg === "pair") {
    confirmPair().then((ok) => reply({ ok }));
    return true; // async reply
  }
  if (msg === "reconnect") {
    try { if (ws) ws.close(); } catch (_) {}
    reconnectDelay = 1000;
    connect();
    reply({ ok: true });
    return false;
  }
  if (msg && msg.type === "closeGroup") {
    (async () => {
      try {
        const res = await deleteGroup(msg.groupId);
        reply({ ok: true, res });
      } catch (e) {
        reply({ ok: false, error: String(e.message || e) });
      }
    })();
    return true;
  }
  return false;
});
