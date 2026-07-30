// Tab-group registry: gives every agent-managed tab group a STABLE internal ID
// (grp_xxxxxxxx) that survives extension restarts and browser restarts, so an
// agent that was shut down can reconnect to its group later.
//
// Chrome's own tabGroups IDs are ephemeral (they change across browser
// restarts), so we persist a mapping in chrome.storage.local and recover by
// title+color match, or by re-creating the group from its last tab snapshot.

const STORAGE_KEY = "agentGroups";

// chrome.tabs.group / chrome.tabGroups.update throw "Tabs cannot be edited
// right now (user may be dragging a tab)" while any tab-strip gesture or
// animation is in flight — retry briefly instead of failing the tool call.
export async function tabEditRetry(fn, tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!/cannot be edited right now/i.test(String(e.message || e))) throw e;
      await new Promise((r) => setTimeout(r, 300 * (i + 1)));
    }
  }
  throw lastErr;
}

const COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];

function genId() {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return "grp_" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function loadRegistry() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return data[STORAGE_KEY] || {};
}

async function saveRegistry(reg) {
  await chrome.storage.local.set({ [STORAGE_KEY]: reg });
}

// All registry WRITES are serialized through this lock and re-load the
// registry inside it. Commands arrive concurrently (multiple agent threads
// share the one extension) and the debounced snapshot timer also writes —
// unserialized whole-object load/mutate/save would lose or resurrect entries.
let regLock = Promise.resolve();
function withRegLock(fn) {
  const run = regLock.then(fn, fn);
  regLock = run.then(() => {}, () => {});
  return run;
}

function mutateRegistry(fn) {
  return withRegLock(async () => {
    const reg = await loadRegistry();
    const result = await fn(reg);
    await saveRegistry(reg);
    return result;
  });
}

async function chromeGroupExists(chromeGroupId) {
  if (chromeGroupId == null) return null;
  try {
    return await chrome.tabGroups.get(chromeGroupId);
  } catch (_) {
    return null;
  }
}

// Find a live Chrome group matching a registry entry (after browser restart
// the numeric ID changes but title+color survive).
async function findByTitleColor(entry) {
  try {
    const groups = await chrome.tabGroups.query({ title: entry.name });
    const exact = groups.filter((g) => g.color === entry.color);
    return (exact.length ? exact : groups)[0] || null;
  } catch (_) {
    return null;
  }
}

async function targetWindowId() {
  // Prefer the last-focused normal window; never create or focus windows.
  try {
    const w = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
    if (w && w.id != null) return w.id;
  } catch (_) {}
  const wins = await chrome.windows.getAll({ windowTypes: ["normal"] });
  if (!wins.length) throw new Error("No normal Chrome window is open.");
  return wins[0].id;
}

async function snapshotTabs(chromeGroupId) {
  try {
    const tabs = await chrome.tabs.query({ groupId: chromeGroupId });
    return tabs.map((t) => ({ url: t.url || t.pendingUrl || "about:blank", title: t.title || "" }));
  } catch (_) {
    return [];
  }
}

export async function createGroup({ name, color, url, window: windowMode = "separate" }) {
  if (!name) throw new Error("name is required");
  if (color !== undefined && !COLORS.includes(color)) {
    throw new Error(`invalid color "${color}" — use one of: ${COLORS.join(", ")}`);
  }
  const existing = await loadRegistry(); // read-only, for color rotation
  const id = genId();
  const chosenColor = color || COLORS[1 + (Object.keys(existing).length % (COLORS.length - 1))];

  let windowId;
  let tab;
  if (windowMode === "separate") {
    // Own background window (matches the official claude-in-chrome model):
    // never steals focus, keeps the user's window clean, and makes
    // resize_window safe (no user tabs share the window).
    const win = await chrome.windows.create({
      url: url || "about:blank",
      focused: false,
      width: 1280,
      height: 900,
    });
    windowId = win.id;
    tab = win.tabs?.[0] || (await chrome.tabs.query({ windowId }))[0];
  } else {
    windowId = await targetWindowId();
    tab = await chrome.tabs.create({ url: url || "about:blank", active: false, windowId });
  }
  const chromeGroupId = await tabEditRetry(() => chrome.tabs.group({ tabIds: [tab.id], createProperties: { windowId } }));
  // Collapse only when sharing the user's window; in a dedicated window an
  // expanded group is more useful (and collapse invites tab freezing).
  await tabEditRetry(() => chrome.tabGroups.update(chromeGroupId, { title: name, color: chosenColor, collapsed: windowMode !== "separate" }));

  await mutateRegistry((reg) => {
    reg[id] = {
      id,
      name,
      color: chosenColor,
      chromeGroupId,
      windowId,
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      tabSnapshot: [{ url: url || "about:blank", title: "" }],
    };
  });
  return { groupId: id, chromeGroupId, name, color: chosenColor, tabId: tab.id, windowId };
}

// Resolve an internal group ID to a LIVE Chrome group, transparently
// re-binding after a browser restart. Returns { entry, live } where live is
// the chrome.tabGroups group or null if the group has no live counterpart.
export async function resolveGroup(groupId, { rebind = true } = {}) {
  const reg = await loadRegistry();
  const entry = reg[groupId];
  if (!entry) throw new Error(`Unknown group ID: ${groupId}. Use list_tab_groups to see known groups.`);
  let live = await chromeGroupExists(entry.chromeGroupId);
  if (!live && rebind) {
    live = await findByTitleColor(entry);
    if (live) {
      entry.chromeGroupId = live.id;
      entry.windowId = live.windowId;
      entry.lastSeenAt = Date.now();
      await mutateRegistry((fresh) => {
        if (fresh[groupId]) {
          fresh[groupId].chromeGroupId = live.id;
          fresh[groupId].windowId = live.windowId;
          fresh[groupId].lastSeenAt = entry.lastSeenAt;
        }
      });
    }
  }
  return { entry, live };
}

export async function reconnectGroup(groupId, { restore = false } = {}) {
  const { entry, live } = await resolveGroup(groupId);
  if (live) {
    const tabs = await chrome.tabs.query({ groupId: live.id });
    await touchGroup(groupId);
    return {
      groupId,
      status: "connected",
      chromeGroupId: live.id,
      name: entry.name,
      color: entry.color,
      windowId: live.windowId,
      tabs: tabs.map(tabInfo),
    };
  }
  if (!restore) {
    return {
      groupId,
      status: "closed",
      name: entry.name,
      lastSeenAt: entry.lastSeenAt,
      savedTabs: entry.tabSnapshot,
      hint: "The group's tabs are gone (closed or browser restarted without session restore). Call reconnect_tab_group with restore:true to recreate it with its last-known tabs.",
    };
  }
  // Recreate the group from its snapshot, in its own background window
  // (same model as createGroup's default).
  const urls = (entry.tabSnapshot || []).map((t) => t.url).filter((u) => /^(https?|about|file):/i.test(u));
  if (!urls.length) urls.push("about:blank");
  const win = await chrome.windows.create({ url: urls[0], focused: false, width: 1280, height: 900 });
  const windowId = win.id;
  const tabIds = [win.tabs?.[0]?.id ?? (await chrome.tabs.query({ windowId }))[0].id];
  for (const u of urls.slice(1, 10)) {
    const t = await chrome.tabs.create({ url: u, active: false, windowId });
    tabIds.push(t.id);
  }
  const chromeGroupId = await tabEditRetry(() => chrome.tabs.group({ tabIds, createProperties: { windowId } }));
  await tabEditRetry(() => chrome.tabGroups.update(chromeGroupId, { title: entry.name, color: entry.color, collapsed: false }));
  await mutateRegistry((reg) => {
    reg[groupId] = { ...entry, chromeGroupId, windowId, lastSeenAt: Date.now() };
  });
  const tabs = await chrome.tabs.query({ groupId: chromeGroupId });
  return {
    groupId,
    status: "restored",
    chromeGroupId,
    name: entry.name,
    color: entry.color,
    windowId,
    tabs: tabs.map(tabInfo),
  };
}

export async function listGroups() {
  const reg = await loadRegistry();
  const out = [];
  for (const entry of Object.values(reg)) {
    const live = await chromeGroupExists(entry.chromeGroupId) || await findByTitleColor(entry);
    let tabs = [];
    if (live) tabs = (await chrome.tabs.query({ groupId: live.id })).map(tabInfo);
    out.push({
      groupId: entry.id,
      name: entry.name,
      color: entry.color,
      status: live ? "open" : "closed",
      chromeGroupId: live ? live.id : null,
      windowId: live ? live.windowId : null,
      createdAt: entry.createdAt,
      lastSeenAt: entry.lastSeenAt,
      tabs,
      ...(live ? {} : { savedTabs: entry.tabSnapshot }),
    });
  }
  return { groups: out };
}

export async function updateGroup(groupId, { name, color, collapsed }) {
  const { live } = await resolveGroup(groupId);
  if (!live) throw new Error(`Group ${groupId} has no open tabs — reconnect with restore:true first.`);
  if (color !== undefined && !COLORS.includes(color)) {
    throw new Error(`invalid color "${color}" — use one of: ${COLORS.join(", ")}`);
  }
  const props = {};
  if (name) props.title = name;
  if (color) props.color = color;
  if (collapsed !== undefined) props.collapsed = !!collapsed;
  const updated = await tabEditRetry(() => chrome.tabGroups.update(live.id, props));
  const final = await mutateRegistry((reg) => {
    const e = reg[groupId];
    if (!e) return { name: updated.title, color: updated.color };
    if (name) e.name = name;
    if (color) e.color = color;
    return { name: e.name, color: e.color };
  });
  return { groupId, ...final, collapsed: updated.collapsed };
}

export async function closeGroup(groupId, { keepRecord = false } = {}) {
  const { live } = await resolveGroup(groupId);
  let closedTabIds = [];
  if (live) {
    const tabs = await chrome.tabs.query({ groupId: live.id });
    closedTabIds = tabs.map((t) => t.id);
    if (closedTabIds.length) await chrome.tabs.remove(closedTabIds);
  }
  await mutateRegistry((reg) => {
    if (keepRecord) {
      if (reg[groupId]) reg[groupId].lastSeenAt = Date.now();
    } else {
      delete reg[groupId];
    }
  });
  return { groupId, closedTabs: closedTabIds.length, closedTabIds, recordKept: keepRecord };
}

// Keep each group's tab snapshot fresh so restore-after-restart works.
export async function touchGroup(groupId) {
  await mutateRegistry(async (reg) => {
    const entry = reg[groupId];
    if (!entry) return;
    const live = await chromeGroupExists(entry.chromeGroupId);
    if (live) {
      entry.tabSnapshot = await snapshotTabs(live.id);
      entry.lastSeenAt = Date.now();
    }
  });
}

// Called (debounced) from tab event listeners in background.js.
let snapshotTimer = null;
export function scheduleSnapshots() {
  if (snapshotTimer) return;
  snapshotTimer = setTimeout(() => {
    snapshotTimer = null;
    mutateRegistry(async (reg) => {
      for (const entry of Object.values(reg)) {
        const live = await chromeGroupExists(entry.chromeGroupId);
        if (live) {
          entry.tabSnapshot = await snapshotTabs(live.id);
          entry.lastSeenAt = Date.now();
        }
      }
    }).catch(() => {});
  }, 1500);
}

// Which internal group (if any) does this tab belong to?
export async function groupForTab(tab) {
  if (!tab || tab.groupId == null || tab.groupId === -1) return null;
  const reg = await loadRegistry();
  for (const entry of Object.values(reg)) {
    if (entry.chromeGroupId === tab.groupId) return entry.id;
  }
  return null;
}

export function tabInfo(t) {
  return {
    tabId: t.id,
    url: t.url || t.pendingUrl || "",
    title: t.title || "",
    active: !!t.active,
    groupId: t.groupId === -1 ? null : t.groupId,
    windowId: t.windowId,
    status: t.status,
    ...(t.discarded ? { discarded: true } : {}),
    ...(t.frozen ? { frozen: true } : {}),
  };
}
