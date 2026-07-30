// Higher-level element actions: click-by-ref, fill, form_input, drag-and-drop,
// file upload, JS execution, and wait_for.
//
// Element-targeted actions resolve a ref/selector to coordinates and dispatch
// TRUSTED events via CDP (so React/Vue/analytics handlers see real input);
// value-setting fallbacks use native setters to defeat framework wrappers.

import { cdp, ensureAttached } from "./cdp.js";
import { click as cdpClick, drag as cdpDrag, typeText, pressChord, moveMouse } from "./input.js";
import { exec, locate } from "./reading.js";

// ---------- click / hover on an element ----------

export async function clickElement(tabId, { ref, selector, button = "left", clickCount = 1, modifiers = [] }) {
  const loc = await locate(tabId, { ref, selector });
  await cdpClick(tabId, loc.center.x, loc.center.y, { button, clickCount, modifiers });
  return { clicked: true, at: loc.center, element: { tag: loc.tag, text: loc.text } };
}

export async function hoverElement(tabId, { ref, selector }) {
  const loc = await locate(tabId, { ref, selector });
  await moveMouse(tabId, loc.center.x, loc.center.y);
  return { hovered: true, at: loc.center };
}

export async function scrollToElement(tabId, { ref, selector }) {
  const loc = await locate(tabId, { ref, selector, scrollIntoView: true });
  return { scrolled: true, rect: loc.rect, inViewport: loc.inViewport };
}

// ---------- fill (text entry) ----------

function setValueFn(ref, selector, value, mode) {
  function fromRef(r) {
    const refs = window.__cabRefs;
    if (!refs || !refs.has(r)) return null;
    const el = refs.get(r).deref();
    return el && el.isConnected ? el : null;
  }
  const el = ref ? fromRef(ref) : document.querySelector(selector);
  if (!el) return { error: "element not found (stale ref? call read_page/find again)" };
  el.scrollIntoView({ block: "center", behavior: "instant" });
  el.focus();
  if (el.isContentEditable) {
    if (mode === "clear" || mode === "replace") el.textContent = "";
    if (value) el.textContent = (el.textContent || "") + value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return { done: true, kind: "contenteditable" };
  }
  if (!("value" in el)) return { error: `<${el.tagName.toLowerCase()}> is not a text input or contenteditable` };
  if (el.tagName === "SELECT") return { error: "use form_input for <select> elements" };
  // native setter defeats framework value tracking (React/Vue controlled inputs)
  const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype
    : el.tagName === "INPUT" ? HTMLInputElement.prototype
    : Object.getPrototypeOf(el);
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  const next = mode === "append" ? (el.value || "") + value : value;
  try {
    if (setter) setter.call(el, next);
    else el.value = next;
  } catch (_) {
    el.value = next;
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { done: true, kind: el.tagName.toLowerCase(), value: String(el.value).slice(0, 200) };
}

export async function fill(tabId, { ref, selector, text, mode = "replace", method = "fast", pressEnter = false }) {
  if (text == null) throw new Error("text is required");
  let result;
  if (method === "keys") {
    // realistic path: click to focus, select-all + clear, then type key-by-key
    const loc = await locate(tabId, { ref, selector });
    await cdpClick(tabId, loc.center.x, loc.center.y, {});
    if (mode === "replace") {
      const r = await exec(tabId, function () {
        const el = document.activeElement;
        if (el && ("value" in el || el.isContentEditable)) {
          if (el.isContentEditable) {
            const sel = getSelection();
            sel.removeAllRanges();
            const range = document.createRange();
            range.selectNodeContents(el);
            sel.addRange(range);
          } else if (el.select) el.select();
          return true;
        }
        return false;
      });
      if (r) await pressChord(tabId, "Backspace");
    }
    await typeText(tabId, text);
    result = { done: true, method: "keys" };
  } else {
    const r = await exec(tabId, setValueFn, [ref || null, selector || null, text, mode]);
    if (r.error) throw new Error(r.error);
    result = { ...r, method: "fast" };
  }
  if (pressEnter) await pressChord(tabId, "Enter");
  return result;
}

// ---------- form_input (select / checkbox / radio / range / date) ----------

function formInputFn(ref, selector, value) {
  function fromRef(r) {
    const refs = window.__cabRefs;
    if (!refs || !refs.has(r)) return null;
    const el = refs.get(r).deref();
    return el && el.isConnected ? el : null;
  }
  const el = ref ? fromRef(ref) : document.querySelector(selector);
  if (!el) return { error: "element not found (stale ref? call read_page/find again)" };
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute("type") || "").toLowerCase();
  const fire = (t) => el.dispatchEvent(new Event(t, { bubbles: true }));

  if (tag === "select") {
    const values = Array.isArray(value) ? value.map(String) : [String(value)];
    // resolve matches BEFORE mutating so a no-match never wipes the selection
    const hits = Array.from(el.options).filter(
      (opt) => values.includes(opt.value) || values.includes(opt.text.trim())
    );
    if (!hits.length) {
      return { error: `no <option> matches ${JSON.stringify(value)}. Options: ${Array.from(el.options).map((o) => o.text.trim()).slice(0, 20).join(" | ")}` };
    }
    if (el.multiple) {
      for (const opt of el.options) opt.selected = hits.includes(opt);
    } else {
      el.value = hits[0].value;
    }
    fire("input"); fire("change");
    return { done: true, kind: "select", selected: Array.from(el.selectedOptions).map((o) => o.text.trim()) };
  }
  if (type === "checkbox" || type === "radio") {
    const want = value === true || value === "true" || value === "checked" || value === 1;
    if (el.checked !== want) {
      el.click(); // click keeps radio-group semantics + fires events
      if (el.checked !== want) { el.checked = want; fire("input"); fire("change"); }
    }
    return { done: true, kind: type, checked: el.checked };
  }
  if ("value" in el) {
    const proto = tag === "textarea" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, String(value)); else el.value = String(value);
    fire("input"); fire("change");
    return { done: true, kind: type || tag, value: el.value };
  }
  return { error: `unsupported element <${tag}>` };
}

export async function formInput(tabId, { ref, selector, value }) {
  const r = await exec(tabId, formInputFn, [ref || null, selector || null, value]);
  if (r.error) throw new Error(r.error);
  return r;
}

// ---------- drag and drop ----------

function html5DragFn(fromRef, fromSel, toRef, toSel) {
  function resolve(ref, sel) {
    if (ref) {
      const refs = window.__cabRefs;
      if (!refs || !refs.has(ref)) return null;
      const el = refs.get(ref).deref();
      return el && el.isConnected ? el : null;
    }
    return document.querySelector(sel);
  }
  const src = resolve(fromRef, fromSel);
  const dst = resolve(toRef, toSel);
  if (!src) return { error: "drag source not found" };
  if (!dst) return { error: "drop target not found" };
  const dt = new DataTransfer();
  const rectS = src.getBoundingClientRect();
  const rectD = dst.getBoundingClientRect();
  const mk = (type, el, rect) =>
    el.dispatchEvent(new DragEvent(type, {
      bubbles: true, cancelable: true, composed: true, dataTransfer: dt,
      clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2,
    }));
  mk("dragstart", src, rectS);
  mk("dragenter", dst, rectD);
  mk("dragover", dst, rectD);
  mk("drop", dst, rectD);
  mk("dragend", src, rectS);
  return { done: true, method: "html5" };
}

export async function dragAndDrop(tabId, args) {
  const { method = "pointer" } = args;
  const resolvePoint = async (spec, label) => {
    if (spec.coordinate) return { x: spec.coordinate[0], y: spec.coordinate[1] };
    const loc = await locate(tabId, { ref: spec.ref, selector: spec.selector });
    if (!loc.found) throw new Error(`${label} element not found`);
    return loc.center;
  };
  if (method === "html5") {
    const r = await exec(tabId, html5DragFn, [
      args.from.ref || null, args.from.selector || null,
      args.to.ref || null, args.to.selector || null,
    ]);
    if (r.error) throw new Error(r.error);
    return r;
  }
  const from = await resolvePoint(args.from, "source");
  const to = await resolvePoint(args.to, "target");
  await cdpDrag(tabId, from, to, { steps: args.steps || 12 });
  return { done: true, method: "pointer", from, to };
}

// ---------- file upload ----------

export async function uploadFile(tabId, { ref, selector, paths }) {
  if (!paths || !paths.length) throw new Error("paths is required (absolute file paths)");
  await ensureAttached(tabId);
  // mark the element so we can find its CDP node
  const marked = await exec(tabId, function (r, sel) {
    function fromRef(rr) {
      const refs = window.__cabRefs;
      if (!refs || !refs.has(rr)) return null;
      const el = refs.get(rr).deref();
      return el && el.isConnected ? el : null;
    }
    let el = r ? fromRef(r) : document.querySelector(sel);
    if (!el) return { error: "element not found" };
    if (el.tagName !== "INPUT" || (el.getAttribute("type") || "").toLowerCase() !== "file") {
      const inner = el.querySelector('input[type="file"]');
      if (inner) el = inner;
      else return { error: `element is <${el.tagName.toLowerCase()}>, not a file input` };
    }
    el.setAttribute("data-cab-upload", "1");
    return { ok: true };
  }, [ref || null, selector || null]);
  if (marked.error) throw new Error(marked.error);
  try {
    const doc = await cdp(tabId, "DOM.getDocument", { depth: -1, pierce: true });
    const { nodeId } = await cdp(tabId, "DOM.querySelector", {
      nodeId: doc.root.nodeId,
      selector: '[data-cab-upload="1"]',
    });
    if (!nodeId) throw new Error("could not resolve the file input via CDP");
    await cdp(tabId, "DOM.setFileInputFiles", { files: paths, nodeId });
  } finally {
    await exec(tabId, function () {
      const el = document.querySelector('[data-cab-upload="1"]');
      if (el) el.removeAttribute("data-cab-upload");
    });
  }
  return { uploaded: paths };
}

// ---------- JavaScript execution ----------

export async function executeJavascript(tabId, { code, awaitPromise = true, returnByValue = true, timeoutMs, replMode = true }) {
  await ensureAttached(tabId);
  const budget = Math.min(Math.max(timeoutMs ?? 30000, 1000), 40000);
  const res = await cdp(tabId, "Runtime.evaluate", {
    expression: code,
    returnByValue,
    awaitPromise,
    userGesture: true,
    timeout: budget,
    // REPL semantics (aligned with javascript_tool): top-level await works
    // and the last expression's value is returned.
    replMode,
  }, { timeoutMs: budget + 5000 });
  if (res.exceptionDetails) {
    const d = res.exceptionDetails;
    const desc = d.exception?.description || d.text || "JavaScript error";
    throw new Error(desc.slice(0, 2000));
  }
  const v = res.result || {};
  let value;
  if ("value" in v) value = v.value;
  else if (v.type === "undefined") value = undefined;
  else value = v.description || `<${v.type}>`;
  let text;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch (_) {
    text = String(value);
  }
  if (text && text.length > 50000) text = text.slice(0, 50000) + "\n…(truncated)";
  return { result: text === undefined ? "undefined" : text };
}

// ---------- wait_for ----------

export async function waitFor(tabId, { text, selector, selectorGone, js, timeoutMs = 10000 }) {
  if (!text && !selector && !selectorGone && !js) {
    throw new Error("Provide at least one condition: text, selector, selectorGone, or js.");
  }
  const deadline = Date.now() + Math.min(Math.max(timeoutMs, 100), 60000);
  // The condition is evaluated in the page's MAIN world (same as
  // execute_javascript), so `js` can use the page's own globals.
  const expression = `(() => { try {
    ${text ? `if (!document.body || !document.body.innerText.includes(${JSON.stringify(text)})) return false;` : ""}
    ${selector ? `if (!document.querySelector(${JSON.stringify(selector)})) return false;` : ""}
    ${selectorGone ? `if (document.querySelector(${JSON.stringify(selectorGone)})) return false;` : ""}
    ${js ? `if (!(${js})) return false;` : ""}
    return true;
  } catch (e) { return "__cab_err:" + String((e && e.message) || e); } })()`;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      await ensureAttached(tabId);
      const res = await cdp(tabId, "Runtime.evaluate", { expression, returnByValue: true });
      const v = res.result?.value;
      if (v === true) return { satisfied: true };
      if (typeof v === "string" && v.startsWith("__cab_err:")) lastErr = v.slice(10);
      if (res.exceptionDetails) {
        lastErr = res.exceptionDetails.exception?.description || res.exceptionDetails.text || "evaluation error";
        if (/SyntaxError/.test(lastErr)) {
          throw new Error(`wait_for js condition has a syntax error: ${lastErr.slice(0, 300)}`);
        }
      }
    } catch (e) {
      if (/syntax error/i.test(String(e.message))) throw e;
      // page may be mid-navigation; keep polling
    }
    await new Promise((res) => setTimeout(res, 250));
  }
  throw new Error(
    `wait_for timed out after ${timeoutMs}ms` + (lastErr ? ` (condition error: ${lastErr})` : "")
  );
}

// ---------- upload_image: inject a cached screenshot as a File ----------
// The server sends the image bytes (base64) here; we rebuild a File inside
// the page and either assign it to a file input (ref) or synthesize a drop
// at the given coordinate. Runs in the ISOLATED world — it shares the DOM,
// and events dispatched from it are visible to the page.

function injectImageFn(ref, coordinate, filename, b64, mimeType) {
  function fromRef(r) {
    const refs = window.__cabRefs;
    if (!refs || !refs.has(r)) return null;
    const el = refs.get(r).deref();
    return el && el.isConnected ? el : null;
  }
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const file = new File([bytes], filename, { type: mimeType });
  const dt = new DataTransfer();
  dt.items.add(file);

  if (ref) {
    let el = fromRef(ref);
    if (!el) return { error: `ref "${ref}" not found or stale — call read_page or find again` };
    if (!(el.tagName === "INPUT" && (el.getAttribute("type") || "").toLowerCase() === "file")) {
      const inner = el.querySelector && el.querySelector('input[type="file"]');
      if (inner) el = inner;
      else return { error: `element is <${el.tagName.toLowerCase()}>, not a file input — use coordinate for drop targets` };
    }
    el.files = dt.files;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { done: true, via: "file-input", filename, bytes: bytes.length };
  }

  const [x, y] = coordinate;
  const target = document.elementFromPoint(x, y);
  if (!target) return { error: `no element at coordinate [${x}, ${y}]` };
  const opts = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, dataTransfer: dt };
  target.dispatchEvent(new DragEvent("dragenter", opts));
  target.dispatchEvent(new DragEvent("dragover", opts));
  target.dispatchEvent(new DragEvent("drop", opts));
  return { done: true, via: "drop", filename, bytes: bytes.length, target: target.tagName.toLowerCase() };
}

export async function uploadImageInject(tabId, { ref, coordinate, filename, data, mimeType }) {
  const r = await exec(tabId, injectImageFn, [ref || null, coordinate || null, filename || "image.png", data, mimeType || "image/png"]);
  if (r.error) throw new Error(r.error);
  return r;
}
