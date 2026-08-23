// Tab lifecycle + navigation. Everything happens in the BACKGROUND:
// tabs are created with active:false and windows are never focused.
// The only exception is the explicit bring_to_foreground tool.

import { resolveGroup, touchGroup, groupForTab, tabInfo, scheduleSnapshots, tabEditRetry } from "./groups.js";
import { detach, wakeTab } from "./cdp.js";
import { exec } from "./reading.js";
import { normalizeUrl } from "./url.js";

// ---------- tab model ----------
// Every tab operation is scoped to the calling thread's own group. The
// dispatcher resolves that group from the required threadTitle and injects it
// as groupId, so these functions never decide WHICH group they act on.

export async function tabsContext({ groupId }) {
  const { entry, live } = await resolveGroup(groupId).catch(() => ({ entry: null, live: null }));
  if (!live) return { tabs: [], note: "This thread's tab group has no live window; create a tab to get one." };
  const tabs = await chrome.tabs.query({ groupId: live.id });
  return { windowId: live.windowId, name: entry.name, tabs: tabs.map(tabInfo) };
}

export async function tabsCreate({ groupId, seedTabId }) {
  return newTab({ groupId, seedTabId, url: "about:blank" });
}

// Resizes the real window the agent's tabs live in — which is now normally the
// user's own window, shared with their tabs. Kept unguarded deliberately, so
// the caller is responsible for preferring set_viewport (which emulates a size
// without touching the window) unless a real resize is actually required.
export async function resizeWindow({ tabId, width, height, groupId }) {
  if (!width || !height) throw new Error("width and height are required");
  const t = await assertTabInGroup(tabId, groupId);
  const winTabs = await chrome.tabs.query({ windowId: t.windowId }).catch(() => []);
  let sharedWithUser = false;
  for (const wt of winTabs) {
    if (!(await groupForTab(wt))) { sharedWithUser = true; break; }
  }
  const win = await chrome.windows.update(t.windowId, {
    width: Math.round(width),
    height: Math.round(height),
    state: "normal",
  });
  return {
    windowId: win.id,
    width: win.width,
    height: win.height,
    ...(sharedWithUser ? { sharedWithUser: true, note: "This window also holds the user's own tabs — they saw it resize. Prefer set_viewport for responsive testing." } : {}),
  };
}

export function waitForLoad(tabId, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (timedOut) => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve(!timedOut);
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") finish(false);
    };
    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(() => finish(true), timeoutMs);
    // resolve immediately if it's already complete
    chrome.tabs.get(tabId).then((t) => {
      if (t.status === "complete") finish(false);
    }).catch(() => finish(true));
  });
}

// seedTabId is set when THIS call is what brought the group into being: the
// group's mandatory seed tab was already opened at our url, so adopt it. Making
// a second tab here is exactly what used to strand a blank one in every new
// workspace. The seed is already grouped and already loading, so the only work
// left is to await it — the return contract is identical either way.
export async function newTab({ url, groupId, seedTabId }) {
  if (!groupId) throw new Error("no tab group for this thread — internal error: the group should have been resolved from threadTitle.");
  const { live } = await resolveGroup(groupId);
  if (!live) throw new Error(`This thread's tab group has no live window (group ${groupId}).`);

  let tabId = seedTabId;
  // Trust but verify: a seed that vanished or was pulled out of the group in
  // the moment between creation and here must not silently become a no-op.
  if (tabId != null) {
    const seed = await chrome.tabs.get(tabId).catch(() => null);
    if (!seed || seed.groupId !== live.id) tabId = null;
  }

  if (tabId == null) {
    const tab = await chrome.tabs.create({
      url: url ? normalizeUrl(url) : "about:blank",
      active: false,
      windowId: live.windowId,
    });
    await tabEditRetry(() => chrome.tabs.group({ tabIds: [tab.id], groupId: live.id }));
    tabId = tab.id;
  }

  await touchGroup(groupId);
  if (url) await waitForLoad(tabId);
  const t = await chrome.tabs.get(tabId);
  return tabInfo(t);
}

// The single enforcement point for "a thread may only touch its own tabs".
// Every tab-scoped command resolves its tabId through this, so a guessed or
// leaked tabId from another thread (or from the user's own browsing) is refused.
export async function assertTabInGroup(tabId, groupId) {
  if (tabId == null) throw new Error("tabId is required.");
  if (!groupId) throw new Error("no tab group for this thread yet — create a tab first.");
  const t = await chrome.tabs.get(tabId).catch(() => null);
  if (!t) throw new Error(`Tab ${tabId} does not exist (it may have been closed).`);
  const { live } = await resolveGroup(groupId);
  if (!live || t.groupId !== live.id) {
    throw new Error(`Tab ${tabId} does not belong to this thread's tab group. You can only act on your own tabs; use list_tabs to see them.`);
  }
  return t;
}

// Only ever the caller's own tabs: the group is resolved from threadTitle by
// the dispatcher, and there is no parameter to widen the scope.
export async function listTabs({ groupId }) {
  if (!groupId) throw new Error("no tab group for this thread yet — create a tab first.");
  const { entry, live } = await resolveGroup(groupId);
  if (!live) return { status: "closed", tabs: [], savedTabs: entry.tabSnapshot };
  const tabs = await chrome.tabs.query({ groupId: live.id });
  return { status: "open", tabs: tabs.map(tabInfo) };
}

export async function closeTab({ tabId, groupId }) {
  await assertTabInGroup(tabId, groupId);
  await detach(tabId);
  await chrome.tabs.remove(tabId);
  scheduleSnapshots();
  return { closed: true, tabId };
}

export async function navigate({ tabId, url }) {
  if (tabId == null) throw new Error("tabId is required");
  if (!url) throw new Error("url is required (a URL, or 'back' / 'forward' / 'reload')");
  const keyword = String(url).toLowerCase();
  if (keyword === "back" || keyword === "forward") {
    // chrome.tabs.goBack/goForward reject on background (collapsed-group)
    // tabs, so drive history from inside the page instead.
    const fn = keyword === "back"
      ? function () { const can = history.length > 1; history.back(); return can; }
      : function () { history.forward(); return true; };
    await exec(tabId, fn).catch((e) => {
      throw new Error(`cannot go ${keyword}: ${e.message}`);
    });
    await new Promise((r) => setTimeout(r, 300)); // let the navigation start
  } else if (keyword === "reload") {
    await chrome.tabs.reload(tabId);
  } else {
    await chrome.tabs.update(tabId, { url: normalizeUrl(url), active: false });
  }
  const loaded = await waitForLoad(tabId);
  const t = await chrome.tabs.get(tabId);
  scheduleSnapshots();
  return { ...tabInfo(t), loaded };
}

export async function bringToForeground({ tabId, groupId }) {
  const t = await assertTabInGroup(tabId, groupId);
  await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(t.windowId, { focused: true });
  return {
    done: true,
    note: "Tab activated and window focused — this interrupts whatever the user was doing. Use sparingly.",
  };
}

export async function getTab(tabId) {
  const t = await chrome.tabs.get(tabId).catch(() => null);
  if (!t) throw new Error(`Tab ${tabId} does not exist (it may have been closed).`);
  // Chrome may have frozen or discarded this background tab to save memory;
  // revive it before any tool touches it, or script injection would hang.
  if (t.discarded || t.frozen) {
    await wakeTab(tabId);
    return (await chrome.tabs.get(tabId).catch(() => null)) || t;
  }
  return t;
}
