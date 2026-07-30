// Tab lifecycle + navigation. Everything happens in the BACKGROUND:
// tabs are created with active:false and windows are never focused.
// The only exception is the explicit bring_to_foreground tool.

import { resolveGroup, touchGroup, groupForTab, tabInfo, scheduleSnapshots, createGroup, tabEditRetry } from "./groups.js";
import { detach, wakeTab } from "./cdp.js";
import { exec } from "./reading.js";

// ---------- official claude-in-chrome tab model ----------
// The "MCP tab group" of a session is simply its current agent group. These
// methods receive the session's internal groupId from the server (injected
// into params), so the extension itself stays session-agnostic.

export async function tabsContext({ groupId, createIfEmpty = false }) {
  if (groupId) {
    const { entry, live } = await resolveGroup(groupId).catch(() => ({ entry: null, live: null }));
    if (live) {
      const tabs = await chrome.tabs.query({ groupId: live.id });
      return {
        groupId,
        chromeGroupId: live.id,
        windowId: live.windowId,
        name: entry.name,
        tabs: tabs.map(tabInfo),
        note: "Use tabs_create_mcp for a fresh tab rather than reusing existing ones, unless the user asked otherwise.",
      };
    }
  }
  if (!createIfEmpty) {
    return {
      groupId: null,
      tabs: [],
      note: "No MCP tab group exists for this session. Call tabs_context_mcp with createIfEmpty:true (or create_tab_group for a named group).",
    };
  }
  // official behavior: new window with a new group containing one empty tab
  const suffix = Math.random().toString(36).slice(2, 6);
  const created = await createGroup({ name: `Agent ${suffix}`, window: "separate" });
  const tabs = await chrome.tabs.query({ groupId: created.chromeGroupId });
  return {
    groupId: created.groupId,
    chromeGroupId: created.chromeGroupId,
    windowId: created.windowId,
    name: created.name,
    created: true,
    tabs: tabs.map(tabInfo),
  };
}

export async function tabsCreate({ groupId }) {
  if (!groupId) {
    const ctx = await tabsContext({ createIfEmpty: true });
    return { ...ctx.tabs[0], agentGroupId: ctx.groupId, context: ctx };
  }
  return newTab({ groupId, url: "about:blank" });
}

export async function tabsClose({ tabId, groupId }) {
  if (tabId == null) throw new Error("tabId is required");
  if (!groupId) throw new Error("This session has no MCP tab group — tabs_close_mcp only closes tabs in the session's group. Use close_tab for other agent tabs.");
  const { live } = await resolveGroup(groupId);
  const t = await chrome.tabs.get(tabId).catch(() => null);
  if (!t) return { closed: false, reason: "tab does not exist" };
  if (!live || t.groupId !== live.id) {
    throw new Error(`Tab ${tabId} is not in this session's tab group — tabs_close_mcp only closes the session's own tabs. Use close_tab if you really mean another agent tab.`);
  }
  return closeTab({ tabId });
}

export async function resizeWindow({ tabId, width, height }) {
  if (!width || !height) throw new Error("width and height are required");
  const t = await chrome.tabs.get(tabId).catch(() => null);
  if (!t) throw new Error(`Tab ${tabId} does not exist.`);
  const winTabs = await chrome.tabs.query({ windowId: t.windowId });
  for (const wt of winTabs) {
    if (!(await groupForTab(wt))) {
      throw new Error(
        "Refusing to resize: this window contains tabs that are not agent-managed (likely the user's own). Use a group created by tabs_context_mcp or create_tab_group (default separate window), or set_viewport for emulation."
      );
    }
  }
  const win = await chrome.windows.update(t.windowId, {
    width: Math.round(width),
    height: Math.round(height),
    state: "normal",
  });
  return { windowId: win.id, width: win.width, height: win.height };
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

function normalizeUrl(url) {
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) return "https://" + url;
  return url;
}

export async function newTab({ url, groupId, ungrouped = false }) {
  if (!groupId && !ungrouped) {
    throw new Error(
      "new_tab requires groupId (the agent's tab group). Creating tabs OUTSIDE a group is the exception case — pass ungrouped:true only if the user explicitly asked for a loose tab."
    );
  }
  let windowId;
  let chromeGroupId = null;
  if (groupId) {
    const { entry, live } = await resolveGroup(groupId);
    if (!live) {
      throw new Error(
        `Group ${groupId} ("${entry.name}") has no open tabs. Call reconnect_tab_group with restore:true first.`
      );
    }
    windowId = live.windowId;
    chromeGroupId = live.id;
  }
  const tab = await chrome.tabs.create({
    url: url ? normalizeUrl(url) : "about:blank",
    active: false,
    ...(windowId != null ? { windowId } : {}),
  });
  if (chromeGroupId != null) {
    await tabEditRetry(() => chrome.tabs.group({ tabIds: [tab.id], groupId: chromeGroupId }));
    await touchGroup(groupId);
  }
  if (url) await waitForLoad(tab.id);
  const t = await chrome.tabs.get(tab.id);
  return {
    ...tabInfo(t),
    ...(groupId ? { agentGroupId: groupId } : { warning: "This tab is UNGROUPED — it lives among the user's own tabs. Prefer group tabs." }),
  };
}

export async function listTabs({ groupId, all = false }) {
  if (all) {
    const tabs = await chrome.tabs.query({});
    const annotated = [];
    for (const t of tabs) {
      const agentGroupId = await groupForTab(t);
      annotated.push({ ...tabInfo(t), agentGroupId, managed: !!agentGroupId });
    }
    return {
      tabs: annotated,
      note: "Tabs with managed:false belong to the user. Do not interact with them unless the user explicitly asked.",
    };
  }
  if (!groupId) throw new Error("Provide groupId, or all:true to list every tab (read-only awareness of the user's tabs).");
  const { entry, live } = await resolveGroup(groupId);
  if (!live) return { groupId, status: "closed", tabs: [], savedTabs: entry.tabSnapshot };
  const tabs = await chrome.tabs.query({ groupId: live.id });
  return { groupId, status: "open", tabs: tabs.map(tabInfo) };
}

export async function closeTab({ tabId }) {
  if (tabId == null) throw new Error("tabId is required");
  const t = await chrome.tabs.get(tabId).catch(() => null);
  if (!t) return { closed: false, reason: "tab does not exist" };
  const agentGroupId = await groupForTab(t);
  await detach(tabId);
  await chrome.tabs.remove(tabId);
  scheduleSnapshots();
  return { closed: true, wasManaged: !!agentGroupId };
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

export async function bringToForeground({ tabId }) {
  if (tabId == null) throw new Error("tabId is required");
  const t = await chrome.tabs.get(tabId);
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
