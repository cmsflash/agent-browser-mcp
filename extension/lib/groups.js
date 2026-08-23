// Tab-group registry: gives every agent-managed tab group a STABLE internal ID
// (grp_xxxxxxxx) that survives extension restarts and browser restarts, so an
// agent that was shut down can reconnect to its group later.
//
// Chrome's own tabGroups IDs are ephemeral (they change across browser
// restarts), so we persist a mapping in chrome.storage.local and recover by
// title+color match, or by re-creating the group from its last tab snapshot.

import { normalizeUrl } from "./url.js";

const STORAGE_KEY = "agentGroups";

// A thread's group is reclaimed after this long without any interaction.
// Recorded on every command (see touchThread) so an active thread never expires.
export const THREAD_TTL_MS = 24 * 60 * 60 * 1000;

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

// Agent tabs join the profile's last-active window rather than opening one of
// their own: a new window is a visible, user-facing event (it takes a slot in
// the window list, the Dock/taskbar, and Mission Control) even when it never
// takes focus.
//
// Incognito and non-"normal" windows (popups, PWAs, devtools) are skipped: a
// group placed there would be surprising, and an incognito one dies with the
// session.
function usableWindow(w) {
  return !!w && w.type === "normal" && !w.incognito && w.id != null;
}

async function lastActiveWindowId() {
  try {
    const w = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
    if (usableWindow(w)) return w.id;
  } catch (_) {}
  const wins = (await chrome.windows.getAll({ windowTypes: ["normal"] }).catch(() => [])).filter(usableWindow);
  if (!wins.length) return null;
  return (wins.find((w) => w.focused) || wins[wins.length - 1]).id;
}

// Where a group's first tab goes. A window is created ONLY when the profile
// has none to borrow — on macOS Chrome outlives its last closed window, so
// "no window at all" is a real state we must still work in.
async function acquireWindow(url) {
  const windowId = await lastActiveWindowId();
  if (windowId != null) {
    const tab = await chrome.tabs.create({ url, active: false, windowId });
    return { windowId, tab };
  }
  const win = await chrome.windows.create({ url, focused: false, width: 1280, height: 900 });
  const tab = win.tabs?.[0] || (await chrome.tabs.query({ windowId: win.id }))[0];
  return { windowId: win.id, tab };
}

async function snapshotTabs(chromeGroupId) {
  try {
    const tabs = await chrome.tabs.query({ groupId: chromeGroupId });
    return tabs.map((t) => ({ url: t.url || t.pendingUrl || "about:blank", title: t.title || "" }));
  } catch (_) {
    return [];
  }
}

// A Chrome group cannot be created empty — chrome.tabs.group needs a tab to
// put in it — so every group is born around a seed tab. `url` is that tab's
// destination: the caller's FIRST navigation, threaded down from the command
// that triggered creation. Passing it here (rather than defaulting to
// about:blank and opening the real tab separately) is what stops every new
// workspace from stranding a blank tab. The seed's id comes back as seedTabId
// so the caller adopts it instead of creating a second tab.
export async function createGroup({ name, color, url, threadTitle }) {
  if (!name) throw new Error("name is required");
  if (color !== undefined && !COLORS.includes(color)) {
    throw new Error(`invalid color "${color}" — use one of: ${COLORS.join(", ")}`);
  }
  const existing = await loadRegistry(); // read-only, for color rotation
  const id = genId();
  const chosenColor = color || COLORS[1 + (Object.keys(existing).length % (COLORS.length - 1))];

  const seedUrl = url ? normalizeUrl(url) : "about:blank";
  const { windowId, tab } = await acquireWindow(seedUrl);
  const chromeGroupId = await tabEditRetry(() => chrome.tabs.group({ tabIds: [tab.id], createProperties: { windowId } }));
  await tabEditRetry(() => chrome.tabGroups.update(chromeGroupId, { title: name, color: chosenColor, collapsed: false }));

  await mutateRegistry((reg) => {
    reg[id] = {
      id,
      name,
      color: chosenColor,
      chromeGroupId,
      windowId,
      ...(threadTitle ? { threadTitle } : {}),
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      tabSnapshot: [{ url: seedUrl, title: "" }],
    };
  });
  return { groupId: id, chromeGroupId, name, color: chosenColor, tabId: tab.id, seedTabId: tab.id, windowId };
}

// ---------- thread identity ----------
// A thread is identified by the threadTitle it passes on every command. The
// mapping threadTitle -> group is owned here, so an agent can never name,
// enumerate, or switch groups: it only ever says who it is.

function normalizeThread(threadTitle) {
  const t = String(threadTitle ?? "").trim();
  if (!t) throw new Error("threadTitle is required — pass the title of the agent thread making this call.");
  return t.slice(0, 60);
}

// The registry is keyed by internal group id, so find the entry claimed by
// this thread. Case-insensitive so trivial retitling doesn't orphan a group.
function findThreadEntry(reg, thread) {
  const key = thread.toLowerCase();
  return Object.values(reg).find((e) => (e.threadTitle || "").toLowerCase() === key) || null;
}

// Resolve (or lazily create) THE group belonging to this thread. Every
// tab-touching command funnels through here, which is what makes one group
// per thread an invariant rather than a suggestion.
// `url` is the destination of the command that forced this group into
// existence. It is used ONLY when a group is actually born (or revived): the
// seed tab Chrome demands becomes the caller's real first tab, and the returned
// seedTabId tells the caller to adopt it rather than open another.
export async function groupForThread(threadTitle, { create = true, url } = {}) {
  const thread = normalizeThread(threadTitle);
  const reg = await loadRegistry();
  const entry = findThreadEntry(reg, thread);

  if (entry) {
    const { live } = await resolveGroup(entry.id);
    if (live) {
      await touchThread(entry.id);
      return { groupId: entry.id, chromeGroupId: live.id, windowId: live.windowId, name: entry.name, created: false };
    }
    // The window was closed (by the user, or a crash) while the thread lives
    // on. Reuse the SAME record so the thread keeps its identity. Callers that
    // opted out of creation still get the record, so cleanup can finish the job.
    if (!create) return { groupId: entry.id, chromeGroupId: null, windowId: null, name: entry.name, live: false };
    const revived = await recreateGroupWindow(entry, url);
    return { ...revived, created: true, revived: true };
  }

  if (!create) return null;
  const made = await createGroup({ name: thread, threadTitle: thread, url });
  return {
    groupId: made.groupId,
    chromeGroupId: made.chromeGroupId,
    windowId: made.windowId,
    name: made.name,
    seedTabId: made.seedTabId,
    created: true,
  };
}

// Rebuild a live group for an existing registry entry, keeping its id. The
// group's old window is gone, so this re-homes it in whatever window is
// current now — not necessarily the one it lived in before.
async function recreateGroupWindow(entry, url) {
  const { windowId, tab } = await acquireWindow(url ? normalizeUrl(url) : "about:blank");
  const chromeGroupId = await tabEditRetry(() => chrome.tabs.group({ tabIds: [tab.id], createProperties: { windowId } }));
  await tabEditRetry(() => chrome.tabGroups.update(chromeGroupId, { title: entry.name, color: entry.color, collapsed: false }));
  await mutateRegistry((reg) => {
    if (reg[entry.id]) {
      reg[entry.id].chromeGroupId = chromeGroupId;
      reg[entry.id].windowId = windowId;
      reg[entry.id].lastSeenAt = Date.now();
    }
  });
  return { groupId: entry.id, chromeGroupId, windowId, name: entry.name, tabId: tab.id, seedTabId: tab.id };
}

// Record interaction so an active thread's group is never garbage-collected.
export async function touchThread(groupId) {
  await mutateRegistry((reg) => {
    if (reg[groupId]) reg[groupId].lastSeenAt = Date.now();
  });
}

// Reclaim groups whose thread has been silent past the TTL. Runs opportunistically
// on command dispatch (MV3 has no reliable long-lived timer) and deletes for real.
export async function gcStaleThreads(ttlMs = THREAD_TTL_MS) {
  const reg = await loadRegistry();
  const cutoff = Date.now() - ttlMs;
  const stale = Object.values(reg).filter((e) => (e.lastSeenAt ?? e.createdAt ?? 0) < cutoff);
  const removed = [];
  for (const entry of stale) {
    try {
      await deleteGroup(entry.id);
      removed.push({ groupId: entry.id, threadTitle: entry.threadTitle, name: entry.name });
    } catch (_) { /* keep going; a stuck entry must not block the sweep */ }
  }
  return removed;
}

// Resolve an internal group ID to a LIVE Chrome group, transparently
// re-binding after a browser restart. Returns { entry, live } where live is
// the chrome.tabGroups group or null if the group has no live counterpart.
export async function resolveGroup(groupId, { rebind = true } = {}) {
  const reg = await loadRegistry();
  const entry = reg[groupId];
  if (!entry) throw new Error(`Unknown group ID: ${groupId}.`);
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

// DELETE a group for real, leaving nothing behind.
//
// Chrome 129+ auto-saves every tab group, and chrome.tabGroups exposes no
// remove/delete method — so closing a group's tabs (the obvious implementation)
// leaves a saved-group chip in the bookmarks bar that also syncs to the user's
// account. Verified empirically on Chrome 151: UNGROUPING the tabs first
// dissolves the group so no saved entry survives; closing first does not.
// Hence the order below is load-bearing, not stylistic.
export async function deleteGroup(groupId) {
  const { live } = await resolveGroup(groupId);
  let closedTabIds = [];
  let windowId = null;
  if (live) {
    windowId = live.windowId;
    const tabs = await chrome.tabs.query({ groupId: live.id });
    closedTabIds = tabs.map((t) => t.id);
    if (closedTabIds.length) {
      // 1. dissolve the group (kills the saved entry)
      await tabEditRetry(() => chrome.tabs.ungroup(closedTabIds)).catch(() => {});
      // 2. then discard the now-loose tabs
      await chrome.tabs.remove(closedTabIds).catch(() => {});
    }
  }
  // Belt-and-braces. Measured on Chrome 136: removing a window's last tab
  // closes the window, so this should find nothing to do — it exists only in
  // case some future/other build leaves an empty husk.
  //
  // Emptiness is deliberately the ENTIRE test. A window still holding tabs is
  // the user's and is left alone; one holding none has nothing of theirs left
  // to lose. Tracking which window we created would be worse than useless
  // here: window ids are recycled across restarts, so a remembered id can name
  // someone else's window later.
  if (windowId != null) {
    // A failed query must never read as "empty" — that would authorize closing
    // a window we know nothing about.
    const remaining = await chrome.tabs.query({ windowId }).catch(() => null);
    if (remaining && remaining.length === 0) await chrome.windows.remove(windowId).catch(() => {});
  }
  await mutateRegistry((reg) => { delete reg[groupId]; });
  return { groupId, deleted: true, closedTabs: closedTabIds.length, closedTabIds };
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
