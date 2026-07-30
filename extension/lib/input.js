// Trusted input primitives via CDP Input domain.
//
// Every user interaction primitive is covered: single/double/triple clicks with
// any button, mouse move, press/release, drag-and-drop, wheel scrolling, key
// presses with modifier chords, key holds, and realistic text typing.
// Coordinates are CSS pixels relative to the tab's viewport — the same
// coordinate space our screenshots are rendered in.

import { cdp, ensureAttached, withFramePump, forcePaint } from "./cdp.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- keyboard layout ----------

export const MODIFIER_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

const KEY_ALIASES = {
  ctrl: "Control", control: "Control",
  alt: "Alt", option: "Alt", opt: "Alt",
  cmd: "Meta", command: "Meta", meta: "Meta", win: "Meta", super: "Meta",
  shift: "Shift",
  esc: "Escape", escape: "Escape",
  enter: "Enter", return: "Enter",
  tab: "Tab", space: " ", spacebar: " ",
  backspace: "Backspace", del: "Delete", delete: "Delete", insert: "Insert",
  up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight",
  arrowup: "ArrowUp", arrowdown: "ArrowDown", arrowleft: "ArrowLeft", arrowright: "ArrowRight",
  home: "Home", end: "End",
  pageup: "PageUp", pgup: "PageUp", pagedown: "PageDown", pgdn: "PageDown",
  plus: "+", minus: "-", equals: "=", underscore: "_", comma: ",", period: ".", slash: "/",
};

// key -> { code, keyCode, text?, shift? }
const KEYS = {};

for (let i = 0; i < 26; i++) {
  const lower = String.fromCharCode(97 + i);
  const upper = String.fromCharCode(65 + i);
  const code = "Key" + upper;
  const keyCode = 65 + i;
  KEYS[lower] = { code, keyCode, text: lower };
  KEYS[upper] = { code, keyCode, text: upper, shift: true };
}
for (let i = 0; i <= 9; i++) {
  KEYS[String(i)] = { code: "Digit" + i, keyCode: 48 + i, text: String(i) };
}

const PUNCT = {
  "-": ["Minus", 189], "=": ["Equal", 187], "[": ["BracketLeft", 219],
  "]": ["BracketRight", 221], "\\": ["Backslash", 220], ";": ["Semicolon", 186],
  "'": ["Quote", 222], "`": ["Backquote", 192], ",": ["Comma", 188],
  ".": ["Period", 190], "/": ["Slash", 191], " ": ["Space", 32],
};
for (const [ch, [code, keyCode]] of Object.entries(PUNCT)) {
  KEYS[ch] = { code, keyCode, text: ch };
}

const SHIFTED = {
  "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7",
  "*": "8", "(": "9", ")": "0", "_": "-", "+": "=", "{": "[", "}": "]",
  "|": "\\", ":": ";", '"': "'", "~": "`", "<": ",", ">": ".", "?": "/",
};
for (const [ch, base] of Object.entries(SHIFTED)) {
  KEYS[ch] = { code: KEYS[base].code, keyCode: KEYS[base].keyCode, text: ch, shift: true };
}

const SPECIAL = {
  Enter: ["Enter", 13, "\r"], Tab: ["Tab", 9], Backspace: ["Backspace", 8],
  Delete: ["Delete", 46], Escape: ["Escape", 27], Insert: ["Insert", 45],
  ArrowUp: ["ArrowUp", 38], ArrowDown: ["ArrowDown", 40],
  ArrowLeft: ["ArrowLeft", 37], ArrowRight: ["ArrowRight", 39],
  Home: ["Home", 36], End: ["End", 35], PageUp: ["PageUp", 33], PageDown: ["PageDown", 34],
  CapsLock: ["CapsLock", 20],
  Shift: ["ShiftLeft", 16], Control: ["ControlLeft", 17],
  Alt: ["AltLeft", 18], Meta: ["MetaLeft", 91],
};
for (const [key, [code, keyCode, text]] of Object.entries(SPECIAL)) {
  KEYS[key] = { code, keyCode, ...(text ? { text } : {}) };
}
for (let i = 1; i <= 12; i++) {
  KEYS["F" + i] = { code: "F" + i, keyCode: 111 + i };
}

function resolveKey(name) {
  if (KEYS[name]) return { key: name, ...KEYS[name] };
  const alias = KEY_ALIASES[name.toLowerCase()];
  if (alias && KEYS[alias]) return { key: alias, ...KEYS[alias] };
  // case-insensitive match for named keys like "pageup" -> "PageUp"
  const named = Object.keys(KEYS).find(
    (k) => k.length > 1 && k.toLowerCase() === name.toLowerCase()
  );
  if (named) return { key: named, ...KEYS[named] };
  throw new Error(`Unknown key: "${name}"`);
}

// Parse a chord like "ctrl+shift+t", "cmd+a", "Enter", or literal "+"
// (also "ctrl++" for ctrl + the plus key).
export function parseChord(chord) {
  let parts = String(chord).split("+");
  // A literal "+" key shows up as two consecutive empty parts at the end
  // ("+" → ["",""], "ctrl++" → ["ctrl","",""]). A single trailing separator
  // ("ctrl+") is malformed and must NOT silently become a "+" press.
  if (parts.length > 1 && parts[parts.length - 1] === "" && parts[parts.length - 2] === "") {
    parts = parts.slice(0, -2).concat("+");
  }
  if (parts.some((p) => p === "")) {
    throw new Error(`Cannot parse key chord: "${chord}" (empty segment — for a literal plus use "+" or "ctrl++")`);
  }
  const main = resolveKey(parts[parts.length - 1].trim());
  const modifiers = parts.slice(0, -1).map((p) => {
    const k = resolveKey(p.trim());
    if (!MODIFIER_BITS[k.key]) {
      throw new Error(`"${p}" is not a modifier key (in chord "${chord}") — modifiers are ctrl, alt/option, shift, cmd/meta`);
    }
    return k;
  });
  return { modifiers, main };
}

function modifierMask(mods) {
  return mods.reduce((m, k) => m | (MODIFIER_BITS[k.key] || 0), 0);
}

const NON_SHIFT_MODIFIERS = MODIFIER_BITS.Alt | MODIFIER_BITS.Control | MODIFIER_BITS.Meta;

async function keyEvent(tabId, type, k, modifiers = 0, extra = {}) {
  // Real Chrome produces no keypress (Char) event while Ctrl/Alt/Meta are
  // held, so suppress `text` there — otherwise the renderer synthesizes a
  // spurious keypress and may insert the literal character.
  const includeText = type === "keyDown" && k.text && !(modifiers & NON_SHIFT_MODIFIERS);
  await cdp(tabId, "Input.dispatchKeyEvent", {
    type,
    key: k.key,
    code: k.code,
    windowsVirtualKeyCode: k.keyCode,
    nativeVirtualKeyCode: k.keyCode,
    modifiers,
    ...(includeText ? { text: k.text, unmodifiedText: k.text } : {}),
    ...extra,
  });
}

export async function pressChord(tabId, chord, { holdMs = 0 } = {}) {
  await ensureAttached(tabId);
  const { modifiers, main } = parseChord(chord);
  // Mimic real key sequences: each modifier's keyDown carries the bits of
  // modifiers pressed SO FAR (including itself); each keyUp drops its own bit.
  let mask = 0;
  for (const m of modifiers) {
    mask |= MODIFIER_BITS[m.key];
    await keyEvent(tabId, "keyDown", m, mask);
  }
  const fullMask = mask | (main.shift ? MODIFIER_BITS.Shift : 0) | (MODIFIER_BITS[main.key] || 0);
  await keyEvent(tabId, "keyDown", main, fullMask);
  if (holdMs > 0) await sleep(Math.min(holdMs, 30000));
  await keyEvent(tabId, "keyUp", main, fullMask);
  for (const m of [...modifiers].reverse()) {
    mask &= ~MODIFIER_BITS[m.key];
    await keyEvent(tabId, "keyUp", m, mask);
  }
}

export async function holdKey(tabId, chord, durationMs) {
  return pressChord(tabId, chord, { holdMs: durationMs });
}

// Realistic typing: mapped characters get trusted keyDown/keyUp pairs (pages
// see keydown/keypress/input); anything unmapped (emoji, CJK…) uses
// Input.insertText which commits text like an IME would.
export async function typeText(tabId, text) {
  await ensureAttached(tabId);
  for (const ch of String(text).replace(/\r\n/g, "\n")) {
    if (ch === "\n" || ch === "\r") {
      await pressChord(tabId, "Enter");
      continue;
    }
    const k = KEYS[ch];
    if (k) {
      const mask = k.shift ? MODIFIER_BITS.Shift : 0;
      await keyEvent(tabId, "keyDown", { key: ch, ...k }, mask);
      await keyEvent(tabId, "keyUp", { key: ch, ...k }, mask);
    } else {
      await cdp(tabId, "Input.insertText", { text: ch });
    }
  }
}

// ---------- mouse ----------

const BUTTONS_BIT = { left: 1, right: 2, middle: 4 };

async function mouseEvent(tabId, type, x, y, opts = {}) {
  await cdp(tabId, "Input.dispatchMouseEvent", {
    type,
    x: Math.round(x),
    y: Math.round(y),
    button: opts.button || "none",
    buttons: opts.buttons ?? 0,
    clickCount: opts.clickCount ?? 0,
    modifiers: opts.modifiers ?? 0,
    deltaX: opts.deltaX,
    deltaY: opts.deltaY,
    pointerType: "mouse",
  });
}

let lastMouse = new Map(); // tabId -> {x, y}

export function cursorPosition(tabId) {
  return lastMouse.get(tabId) || { x: 0, y: 0 };
}

// Chrome evicts a background tab's compositor surface after a few idle
// seconds, and parts of mouse-event delivery are rAF-aligned — so every mouse
// sequence runs under the frame pump (forced paints before AND during it).
export async function moveMouse(tabId, x, y) {
  await withFramePump(tabId, async () => {
    await mouseEvent(tabId, "mouseMoved", x, y);
  });
  lastMouse.set(tabId, { x, y });
}

export async function click(
  tabId,
  x,
  y,
  { button = "left", clickCount = 1, modifiers = [] } = {}
) {
  const mask = modifierMask(modifiers.map((m) => resolveKey(m)));
  await withFramePump(tabId, async () => {
    await mouseEvent(tabId, "mouseMoved", x, y, { modifiers: mask });
    for (let i = 1; i <= clickCount; i++) {
      await mouseEvent(tabId, "mousePressed", x, y, {
        button, buttons: BUTTONS_BIT[button], clickCount: i, modifiers: mask,
      });
      await mouseEvent(tabId, "mouseReleased", x, y, {
        button, buttons: 0, clickCount: i, modifiers: mask,
      });
      if (i < clickCount) await sleep(60);
    }
    // one settling beat so rAF-aligned handlers run before the pump stops
    await sleep(60);
  });
  lastMouse.set(tabId, { x, y });
}

export async function mouseDown(tabId, x, y, button = "left") {
  await withFramePump(tabId, async () => {
    await mouseEvent(tabId, "mouseMoved", x, y);
    await mouseEvent(tabId, "mousePressed", x, y, {
      button, buttons: BUTTONS_BIT[button], clickCount: 1,
    });
  });
  lastMouse.set(tabId, { x, y });
}

export async function mouseUp(tabId, x, y, button = "left") {
  await withFramePump(tabId, async () => {
    await mouseEvent(tabId, "mouseReleased", x, y, { button, buttons: 0, clickCount: 1 });
    await sleep(60);
  });
  lastMouse.set(tabId, { x, y });
}

// Pointer-based drag: works for mousedown/mousemove-driven UIs (sliders,
// canvas, sortable lists using pointer events). Runs under the frame pump —
// move events with a button held are compositor-routed on background tabs.
export async function drag(tabId, from, to, { steps = 12, button = "left" } = {}) {
  steps = Math.max(1, Math.min(Math.round(steps), 100));
  await withFramePump(tabId, async () => {
    await mouseEvent(tabId, "mouseMoved", from.x, from.y);
    await mouseEvent(tabId, "mousePressed", from.x, from.y, {
      button, buttons: BUTTONS_BIT[button], clickCount: 1,
    });
    await sleep(50);
    for (let i = 1; i <= steps; i++) {
      const x = from.x + ((to.x - from.x) * i) / steps;
      const y = from.y + ((to.y - from.y) * i) / steps;
      await mouseEvent(tabId, "mouseMoved", x, y, { button, buttons: BUTTONS_BIT[button] });
      await sleep(15);
    }
    await sleep(50);
    await mouseEvent(tabId, "mouseReleased", to.x, to.y, { button, buttons: 0, clickCount: 1 });
    await sleep(100); // let the release be processed while frames still flow
    // If Chromium's browser-side drag controller latched during the move
    // sequence it keeps eating all future mouse events — clear it.
    try { await cdp(tabId, "Input.cancelDragging"); } catch (_) {}
  });
  lastMouse.set(tabId, { x: to.x, y: to.y });
}

export async function scroll(tabId, x, y, { deltaX = 0, deltaY = 0 } = {}) {
  await withFramePump(tabId, async () => {
    await mouseEvent(tabId, "mouseWheel", x, y, { deltaX, deltaY });
    // let the compositor apply the scroll before the pump stops
    await sleep(120);
  });
}
