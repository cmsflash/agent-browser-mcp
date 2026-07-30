// Page reading: structured text representation with element refs, plain-text
// extraction, and natural-language element lookup.
//
// Injected functions run in the extension's ISOLATED world, where globals
// persist for the lifetime of the document — so the ref registry
// (window.__cabRefs) built by read_page/find stays valid for later click/
// fill/etc. calls until the page navigates. Navigation replaces the isolated
// world, so refs from a previous page simply fail to resolve ("stale ref").
//
// Ref format is aligned with claude-in-chrome: "ref_1", "ref_2", …

// ---------- injection helper ----------

import { wakeTab, resumePage } from "./cdp.js";

const INJECT_TIMEOUT_MS = 8000;

async function injectOnce(tabId, func, args, world, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("__cab_inject_timeout")), timeoutMs);
  });
  try {
    const results = await Promise.race([
      chrome.scripting.executeScript({ target: { tabId }, func, args, world }),
      timeout,
    ]);
    const [res] = results;
    if (!res) throw new Error("script injection returned no result");
    return res.result;
  } finally {
    clearTimeout(timer);
  }
}

// A frozen or discarded tab swallows script injection forever, so bound the
// wait, revive the renderer, and retry once before giving up.
export async function exec(tabId, func, args = [], world = "ISOLATED") {
  try {
    return await injectOnce(tabId, func, args, world, INJECT_TIMEOUT_MS);
  } catch (e) {
    if (String(e.message) !== "__cab_inject_timeout") throw e;
  }
  await wakeTab(tabId);
  await resumePage(tabId);
  try {
    return await injectOnce(tabId, func, args, world, 15000);
  } catch (e) {
    if (String(e.message) === "__cab_inject_timeout") {
      throw new Error(
        `Tab ${tabId} is not responding to script injection (its renderer may be frozen or the page is busy). Try navigate/reload on the tab.`
      );
    }
    throw e;
  }
}

// ---------- injected: page snapshot with refs ----------
// filter: "interactive" (visible interactive + structure) | "all" (everything,
// including non-visible elements marked "(hidden)" and text content).
// depth: max tree depth. refId: start from this element's subtree.

function snapshotPage(filter, maxChars, maxDepth, refId) {
  const W = window;
  if (!W.__cabRefs) {
    W.__cabRefs = new Map();
    // random per-document base: a ref minted on a previous page ("ref_312")
    // must never collide with refs minted after navigation
    W.__cabCounter = (1 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900)) * 1000;
  }
  const refs = W.__cabRefs;

  const INTERACTIVE = new Set([
    "a", "button", "input", "textarea", "select", "option", "summary", "label",
    "audio", "video", "embed",
  ]);
  const INTERACTIVE_ROLES = new Set([
    "button", "link", "checkbox", "radio", "tab", "menuitem", "menuitemcheckbox",
    "menuitemradio", "option", "switch", "slider", "spinbutton", "textbox",
    "combobox", "listbox", "searchbox", "treeitem",
  ]);
  const STRUCTURE = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "nav", "main", "header", "footer", "aside", "form", "dialog", "table", "iframe", "img", "details", "section", "article"]);

  function implicitRole(el) {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    switch (tag) {
      case "a": return el.hasAttribute("href") ? "link" : "generic";
      case "button": return "button";
      case "select": return el.multiple ? "listbox" : "combobox";
      case "textarea": return "textbox";
      case "img": return "img";
      case "nav": return "navigation";
      case "main": return "main";
      case "form": return "form";
      case "table": return "table";
      case "dialog": return "dialog";
      case "summary": return "button";
      case "option": return "option";
      case "section": return "region";
      case "article": return "article";
      case "input":
        if (["checkbox", "radio"].includes(type)) return type;
        if (type === "range") return "slider";
        if (type === "number") return "spinbutton";
        if (["button", "submit", "reset", "image"].includes(type)) return "button";
        if (type === "search") return "searchbox";
        if (["hidden"].includes(type)) return "";
        return "textbox";
      default:
        if (/^h[1-6]$/.test(tag)) return "heading";
        return "";
    }
  }

  function accessibleName(el) {
    const aria = el.getAttribute("aria-label");
    if (aria) return aria;
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const parts = labelledBy.split(/\s+/).map((id) => {
        const t = el.ownerDocument.getElementById(id);
        return t ? t.innerText || t.textContent || "" : "";
      });
      const joined = parts.join(" ").trim();
      if (joined) return joined;
    }
    if (el.tagName === "IMG" && el.alt) return el.alt;
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") {
      if (el.labels && el.labels.length) {
        const t = (el.labels[0].innerText || "").trim();
        if (t) return t;
      }
      if (el.placeholder) return el.placeholder;
      if (el.name) return el.name;
    }
    const title = el.getAttribute("title");
    if (title) return title;
    const text = (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ");
    return text;
  }

  function refFor(el) {
    if (el.__cabRef && refs.has(el.__cabRef)) return el.__cabRef;
    const r = "ref_" + ++W.__cabCounter;
    refs.set(r, new WeakRef(el));
    el.__cabRef = r; // expando lives in the extension's isolated world only
    return r;
  }

  const lines = [];
  let chars = 0;
  let truncated = false;
  let count = 0;
  let totalChars = 0; // keeps counting past the cap so the note can report full size
  const HARD_COUNT_CAP = 8000;

  function emit(line) {
    totalChars += line.length + 1;
    count++;
    if (!truncated) {
      if (chars + line.length + 1 > maxChars) {
        truncated = true; // truncate at a line boundary
      } else {
        chars += line.length + 1;
        lines.push(line);
      }
    }
  }

  function describe(el, depth, hidden) {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role") || implicitRole(el);
    const interactive = INTERACTIVE.has(tag) || INTERACTIVE_ROLES.has(role) ||
      el.hasAttribute("onclick") || el.isContentEditable ||
      (el.hasAttribute("tabindex") && el.getAttribute("tabindex") !== "-1");
    const structural = STRUCTURE.has(tag);

    if (!interactive && !structural) {
      if (filter !== "all") return false;
      // in "all" mode include elements that directly own text
      const ownText = Array.from(el.childNodes)
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent.trim())
        .join(" ")
        .trim();
      if (!ownText) return false;
      emit(`${"  ".repeat(depth)}text: ${ownText.replace(/\s+/g, " ").slice(0, 200)}${hidden ? " (hidden)" : ""}`);
      return true;
    }

    let name = accessibleName(el).slice(0, 150);
    const bits = [];
    const r = interactive ? refFor(el) : null;
    if (r) bits.push(`[ref=${r}]`);
    bits.push(role || tag);
    if (/^h[1-6]$/.test(tag)) bits.push(`level=${tag[1]}`);
    if (name) bits.push(JSON.stringify(name));
    if (tag === "a" && el.href) bits.push(`url=${el.getAttribute("href")}`);
    if (tag === "input" || tag === "textarea") {
      if (el.value) bits.push(`value=${JSON.stringify(String(el.value).slice(0, 80))}`);
      if (el.checked) bits.push("(checked)");
    }
    if (tag === "select") {
      const sel = Array.from(el.selectedOptions || []).map((o) => o.text).join(", ");
      if (sel) bits.push(`selected=${JSON.stringify(sel.slice(0, 80))}`);
    }
    if (el.disabled) bits.push("(disabled)");
    if (el.getAttribute("aria-expanded")) bits.push(`(expanded=${el.getAttribute("aria-expanded")})`);
    if (el.getAttribute("aria-checked")) bits.push(`(checked=${el.getAttribute("aria-checked")})`);
    if (hidden) bits.push("(hidden)");
    if (tag === "iframe") {
      let access = "cross-origin";
      try { if (el.contentDocument) access = "same-origin"; } catch (_) {}
      bits.push(`(${access} iframe)`);
    }
    emit(`${"  ".repeat(depth)}${bits.join(" ")}`);
    return true;
  }

  function walk(root, depth) {
    if (count > HARD_COUNT_CAP || depth >= maxDepth) return;
    for (const el of root.children || []) {
      if (count > HARD_COUNT_CAP) return;
      if (["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "META", "LINK"].includes(el.tagName)) continue;
      let cs;
      try { cs = el.ownerDocument.defaultView.getComputedStyle(el); } catch (_) { continue; }
      // Only display:none prunes the subtree: opacity-0 elements are still
      // hit-testable and interactive (styled checkbox/file-input patterns).
      const displayNone = cs.display === "none";
      const r = el.getBoundingClientRect();
      const visible = !displayNone && (r.width > 0 || r.height > 0) && cs.visibility !== "hidden";
      if (displayNone && filter !== "all") continue; // hides the whole subtree
      let described = false;
      if (visible || filter === "all") {
        described = describe(el, depth, !visible);
        if (el.tagName === "IFRAME") {
          try {
            if (el.contentDocument && el.contentDocument.body) {
              walk(el.contentDocument.body, depth + 1);
            }
          } catch (_) {}
          continue;
        }
      }
      walk(el, depth + (described ? 1 : 0));
    }
  }

  let root = document.body || document.documentElement;
  if (refId) {
    const wr = refs.get(refId);
    const el = wr && (wr.deref ? wr.deref() : null);
    if (!el || !el.isConnected) {
      return { error: `ref_id "${refId}" not found or stale — call read_page or find again to get fresh refs` };
    }
    describe(el, 0, false);
    root = el;
  }
  walk(root, refId ? 1 : 0);

  const countCapped = count > HARD_COUNT_CAP;
  const isTruncated = truncated || countCapped;
  return {
    url: location.href,
    title: document.title,
    viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY,
      pageWidth: document.documentElement.scrollWidth,
      pageHeight: document.documentElement.scrollHeight },
    outline: lines.join("\n"),
    elementCount: count,
    truncated: isTruncated,
    ...(isTruncated ? {
      note: countCapped && !truncated
        ? `Output stopped after ${HARD_COUNT_CAP} elements (the page has more). Use a smaller depth, filter:"interactive", or focus with ref_id.`
        : `Output truncated at ${maxChars} chars (full outline ≈ ${totalChars} chars, ${count} elements). Pass a larger max_chars, a smaller depth, filter:"interactive", or focus with ref_id.`,
    } : {}),
  };
}

// ---------- injected: resolve a ref/selector to a viewport rect ----------
// Returns center coordinates in TOP-frame viewport CSS pixels (accumulating
// iframe offsets), scrolling the element into view first if requested.

function locateElement(ref, selector, scrollIntoView) {
  function fromRef(r) {
    const refs = window.__cabRefs;
    if (!refs || !refs.has(r)) return null;
    const el = refs.get(r).deref ? refs.get(r).deref() : null;
    if (!el || !el.isConnected) return null;
    return el;
  }
  function bySelector(sel) {
    try { return document.querySelector(sel); } catch (_) { return null; }
  }
  const el = ref ? fromRef(ref) : bySelector(selector);
  if (!el) {
    return {
      error: ref
        ? `ref "${ref}" not found or stale (the page may have navigated) — call read_page or find again to get fresh refs`
        : `no element matches selector: ${selector}`,
    };
  }
  const preRect = el.getBoundingClientRect();
  const cs0 = el.ownerDocument.defaultView.getComputedStyle(el);
  if ((preRect.width <= 0 && preRect.height <= 0) || cs0.display === "none" || cs0.visibility === "hidden") {
    return { error: ref
      ? `ref "${ref}" resolves to an element with no visible area (hidden or collapsed) — re-read the page and pick a visible element`
      : `selector "${selector}" matches an element with no visible area (hidden or collapsed)` };
  }
  if (scrollIntoView) {
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  }
  // climb iframe chain to compute top-frame coordinates (the inner document's
  // viewport starts inside the iframe's border + padding)
  let rect = el.getBoundingClientRect();
  let x = rect.x, y = rect.y;
  let win = el.ownerDocument.defaultView;
  try {
    while (win && win.frameElement) {
      const fe = win.frameElement;
      const fr = fe.getBoundingClientRect();
      const cs = fe.ownerDocument.defaultView.getComputedStyle(fe);
      x += fr.x + (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.paddingLeft) || 0);
      y += fr.y + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.paddingTop) || 0);
      win = win.parent;
    }
  } catch (_) {}
  const cx = x + rect.width / 2;
  const cy = y + rect.height / 2;
  return {
    found: true,
    rect: { x, y, width: rect.width, height: rect.height },
    center: { x: cx, y: cy },
    inViewport: cx >= 0 && cy >= 0 && cx <= innerWidth && cy <= innerHeight,
    tag: el.tagName.toLowerCase(),
    text: (el.innerText || el.value || "").slice(0, 100),
  };
}

// ---------- injected: plain text ----------

function pageText(maxChars, offset) {
  // Prefer article-ish content when the page has it (aligned with the
  // official get_page_text, which prioritizes article content).
  const article = document.querySelector("article, [role=main], main");
  const source = article && (article.innerText || "").length > 500 ? article : document.body;
  const raw = (source ? source.innerText : "").replace(/\n{3,}/g, "\n\n");
  const slice = raw.slice(offset, offset + maxChars);
  return {
    url: location.href,
    title: document.title,
    totalChars: raw.length,
    offset,
    text: slice,
    truncated: offset + maxChars < raw.length,
    ...(article && source === article ? { source: "article" } : {}),
  };
}

// ---------- injected: find (natural language) ----------

function findElements(query, maxResults) {
  const W = window;
  if (!W.__cabRefs) {
    W.__cabRefs = new Map();
    W.__cabCounter = (1 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900)) * 1000;
  }
  const refs = W.__cabRefs;
  function refFor(el) {
    if (el.__cabRef && refs.has(el.__cabRef)) return el.__cabRef;
    const r = "ref_" + ++W.__cabCounter;
    refs.set(r, new WeakRef(el));
    el.__cabRef = r;
    return r;
  }
  function describeEl(el, matchedBy, score) {
    return {
      ref: refFor(el),
      matchedBy,
      score,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role") || undefined,
      text: (el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.alt || "")
        .trim().replace(/\s+/g, " ").slice(0, 120),
    };
  }

  // 1) CSS selector fast path
  try {
    const els = document.querySelectorAll(query);
    if (els.length) {
      const out = [];
      let visibleMatches = 0;
      for (const el of els) {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 && r.height <= 0) continue;
        try {
          const csEl = el.ownerDocument.defaultView.getComputedStyle(el);
          if (csEl.visibility === "hidden") continue;
        } catch (_) {}
        visibleMatches++;
        if (out.length < maxResults) out.push(describeEl(el, "selector", 100));
      }
      if (out.length) {
        return { query, results: out, count: out.length, totalMatches: visibleMatches,
          ...(visibleMatches > maxResults ? { note: `${visibleMatches} elements matched — showing the first ${maxResults}. Use a more specific query.` } : {}) };
      }
    }
  } catch (_) { /* not a valid selector — natural language path */ }

  // 2) natural-language scoring
  const q = query.toLowerCase().trim();
  const STOP = new Set(["the", "a", "an", "of", "to", "in", "on", "for", "with", "that", "this", "containing", "contains", "element", "which", "where"]);
  const ROLE_HINTS = {
    button: ["button"], link: ["link", "a"], input: ["textbox", "searchbox", "input"],
    field: ["textbox", "searchbox", "input"], box: ["textbox", "searchbox", "checkbox", "input"],
    bar: ["searchbox", "textbox", "navigation"], search: ["searchbox"],
    checkbox: ["checkbox"], radio: ["radio"], dropdown: ["combobox", "listbox", "select"],
    select: ["combobox", "listbox", "select"], menu: ["menu", "menuitem"], tab: ["tab"],
    image: ["img"], icon: ["img", "button"], picture: ["img"], photo: ["img"],
    heading: ["heading"], title: ["heading"], form: ["form"], slider: ["slider"],
    toggle: ["switch", "checkbox"], textarea: ["textbox", "textarea"],
  };
  const tokens = q.split(/\s+/).filter((t) => t && !STOP.has(t));
  const hintRoles = new Set();
  for (const t of tokens) for (const r of ROLE_HINTS[t] || []) hintRoles.add(r);
  const contentTokens = tokens.filter((t) => !ROLE_HINTS[t]);

  const CANDIDATES = 'a,button,input,textarea,select,summary,label,img,[role],[onclick],[contenteditable="true"],[tabindex],h1,h2,h3,h4,h5,h6';
  const NATIVE = new Set(["a", "button", "input", "textarea", "select", "summary"]);
  const scored = [];
  for (const el of document.querySelectorAll(CANDIDATES)) {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 && rect.height <= 0) continue;
    try {
      const csEl = el.ownerDocument.defaultView.getComputedStyle(el);
      if (csEl.visibility === "hidden" || csEl.display === "none") continue;
    } catch (_) {}
    const tag = el.tagName.toLowerCase();
    // bare focus-trap wrappers (tabindex=-1, no role, not native) match huge
    // innerText blobs and outrank the real control — skip them
    if (!NATIVE.has(tag) && el.getAttribute("tabindex") === "-1" && !el.getAttribute("role") && !el.hasAttribute("onclick")) continue;
    const type = (el.getAttribute("type") || "").toLowerCase();
    const role = (el.getAttribute("role") || "").toLowerCase();
    const name = [
      el.getAttribute("aria-label"), el.placeholder, el.title, el.alt,
      (el.labels && el.labels[0] ? el.labels[0].innerText : ""),
      (el.innerText || el.value || "").slice(0, 300),
    ].filter(Boolean).join(" ").toLowerCase().replace(/\s+/g, " ");
    const attrs = [el.id, el.name, el.className && String(el.className)].filter(Boolean).join(" ").toLowerCase();

    let score = 0;
    if (contentTokens.length) {
      const phrase = contentTokens.join(" ");
      if (name.includes(phrase)) score += 40;
      let inName = 0;
      for (const t of contentTokens) {
        if (name.includes(t)) { score += 8; inName++; }
        else if (attrs.includes(t)) score += 4;
      }
      if (inName === contentTokens.length && contentTokens.length > 1) score += 10;
    }
    if (hintRoles.size) {
      const elRoles = new Set([tag, role, type].filter(Boolean));
      if (tag === "input" && ["search"].includes(type)) elRoles.add("searchbox");
      if (tag === "input" && !["checkbox", "radio", "button", "submit"].includes(type)) elRoles.add("textbox").add("input");
      if (tag === "a") elRoles.add("link");
      if (tag === "select") elRoles.add("combobox");
      for (const hr of hintRoles) if (elRoles.has(hr)) { score += hintRoles.size && !contentTokens.length ? 20 : 10; break; }
    }
    if (score > 0) {
      // prefer leaf controls over big containers that merely contain the text
      if (NATIVE.has(tag)) score += 5;
      const textLen = (el.innerText || "").length;
      score -= Math.min(20, Math.floor(textLen / 200));
      scored.push({ el, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  const out = scored.slice(0, maxResults).map(({ el, score }) => describeEl(el, "natural-language", score));
  return {
    query,
    results: out,
    count: out.length,
    totalMatches: scored.length,
    ...(scored.length > maxResults ? { note: `${scored.length} elements matched — showing the ${maxResults} best. Use a more specific query.` } : {}),
  };
}

// ---------- exported tool implementations ----------

export async function readPage(tabId, params = {}) {
  // aligned names (filter/max_chars/depth/ref_id) with legacy fallbacks
  const filter = params.filter || (params.mode === "interactive" ? "interactive" : params.mode === "full" ? "all" : "all");
  const maxChars = params.max_chars ?? params.maxChars ?? 50000;
  const depth = params.depth ?? 15;
  const refId = params.ref_id ?? null;
  const res = await exec(tabId, snapshotPage, [filter, maxChars, depth, refId]);
  if (res && res.error) throw new Error(res.error);
  return res;
}

export async function getPageText(tabId, { maxChars = 16000, offset = 0 } = {}) {
  return exec(tabId, pageText, [maxChars, offset]);
}

export async function find(tabId, query, maxResults = 20) {
  if (!query) throw new Error("query is required");
  return exec(tabId, findElements, [query, Math.min(maxResults || 20, 20)]);
}

export async function locate(tabId, { ref, selector, scrollIntoView = true }) {
  if (!ref && !selector) throw new Error("Provide ref (from read_page/find) or a CSS selector.");
  const res = await exec(tabId, locateElement, [ref || null, selector || null, scrollIntoView]);
  if (res.error) throw new Error(res.error);
  if (scrollIntoView) {
    // allow the scroll to settle, then re-resolve coordinates
    await new Promise((r) => setTimeout(r, 120));
    const res2 = await exec(tabId, locateElement, [ref || null, selector || null, false]);
    if (!res2.error) return res2;
  }
  return res;
}
