---
name: chrome-agent
description: Drive the user's real Chrome in the background via the Chrome Agent Bridge MCP (mcp__chrome-agent__* tools). Use whenever a task needs web browsing, web-app interaction, scraping, or web testing in the user's logged-in browser. The tool surface is aligned with the official Claude-in-Chrome tools, plus durable reconnectable tab groups. Covers the required workflow — one tab group per agent thread, background-only driving, and when to use reading vs screenshots vs coordinates.
---

# Driving Chrome with the Chrome Agent Bridge

You have `mcp__chrome-agent__*` tools that drive the user's real, logged-in
Chrome **in the background**: nothing you do focuses Chrome, activates the
user's tabs, or otherwise interrupts them. Agent tab groups live in their own
background window. The tool names and semantics mirror the official
Claude-in-Chrome integration, so the same habits work in both.

## Session start — two ways to get a workspace

- **Quick (official style):** `tabs_context_mcp {createIfEmpty: true}` creates
  an anonymous session group in a new background window with one empty tab.
  `navigate {url}` with no tabId does this for you automatically and returns
  the context alongside the navigation result.
- **Durable (preferred for long-running work):** `create_tab_group {name}`
  with a short, distinctive task name. It returns a stable internal `groupId`
  (e.g. `grp_1a2b3c4d`) — **save it in your task notes** so you can
  `reconnect_tab_group {groupId}` after YOU are restarted. Reconnection
  survives browser restarts (rebinds by name/color); if the tabs are gone,
  call it again with `restore: true` to recreate them.

Either way: **one group per agent thread; do all browsing inside it.**
Ungrouped tabs (`new_tab {ungrouped: true}`) and the user's own tabs
(`list_tabs {all: true}`) are exception cases requiring the user's explicit
ask. When finished with the browser entirely, `close_tab_group` (add
`keepRecord: true` if the user may want you to resume later).

## Reading pages — cheapest first

- `read_page {tabId}` — accessibility-style outline with refs (`[ref=ref_12]`).
  Defaults to everything (incl. hidden, marked `(hidden)`); pass
  `filter: "interactive"` for a compact view, `depth` / `max_chars` /
  `ref_id` to focus when output is large. Refs stay valid until navigation.
- `get_page_text {tabId}` — plain text (article-content aware), paginate with `offset`.
- `find {query, tabId}` — natural-language element search ("search bar",
  "add to cart button") or a CSS selector. Returns refs.
- `screenshot` / `computer {action: "screenshot"}` — when layout matters or
  the DOM is unreadable (canvas, maps). Images are CSS-pixel sized: screenshot
  coordinates map 1:1 to `computer` coordinates. Every screenshot result
  carries an `imageId` (usable with `upload_image`).
- `computer {action: "zoom", region: [x0,y0,x1,y1]}` — magnified region for
  small UI details.

## Interacting

- **Element level (preferred):** `click {ref|selector}` (any button,
  clickCount, modifiers), `fill {ref|selector, text}` (method `"keys"` for
  editors/autocomplete), `form_input {ref, value}`, `drag_and_drop`
  (`method: "html5"` for DataTransfer UIs), `file_upload {paths, ref}`,
  `upload_image {imageId, ref|coordinate}`.
- **Coordinates / keyboard:** `computer` — the full official action set
  (`left_click`, `right_click`, `double_click`, `triple_click`, `type`, `key`
  with space-separated sequences like `"Backspace Backspace"` and chords like
  `"cmd+a"`, `scroll`, `left_click_drag`, `hover`, `scroll_to {ref}`, `wait`,
  `zoom`, `screenshot`) plus raw primitives (`middle_click`,
  `left_mouse_down/up`, `hold_key`, `cursor_position`). All events are
  trusted (debugger-dispatched).
- **Programmatic:** `javascript_tool {action: "javascript_exec", text, tabId}`
  — REPL semantics (top-level `await`, last expression returned).
  `wait_for {text|selector|selectorGone|js}` polls up to 60 s.
- **Batching:** when you can predict 2+ steps, wrap them in `browser_batch`
  (sequential, stops on first error; every page-acting step needs an explicit
  `tabId`; coordinates refer to the screenshot taken BEFORE the batch).

## Debugging pages

`read_console_messages {tabId, pattern}` (always pass a regex pattern),
`read_network_requests {tabId, urlPattern?}`, `get_response_body {requestId}`.
Buffering starts when the tab is first attached (any interaction attaches).

## Recording & windows

- `gif_creator`: `start_recording` → act → `stop_recording` →
  `export {download: true}`. Frames are captured automatically after each
  action; the GIF (with click/drag overlays + progress bar) is written to
  ~/Downloads and optionally downloaded in the browser.
- `resize_window {width, height, tabId}` resizes the agent group's own window
  (refuses windows containing user tabs); `set_viewport` emulates without
  resizing. Multiple browsers: `list_connected_browsers` → `select_browser`,
  or `switch_browser` to let the user click Connect in the one they want.

## Etiquette & exceptions

- Chrome stays in the background — never assume the user sees the page.
- `bring_to_foreground` is the ONLY interrupting tool. Reserve it for things
  only the user can do (login, CAPTCHA, payment), and say why.
- The first debugger attach shows an "is debugging this browser" info bar —
  harmless; `--silent-debugger-extension-api` hides it permanently.

## Troubleshooting

- **"extension is not connected"** → Chrome closed or extension disabled:
  ask the user to check `chrome://extensions`, then `get_status`.
- **Stale ref** → re-run `read_page`/`find` (refs die on navigation).
- **Group gone** → `reconnect_tab_group {groupId, restore: true}` or `list_tab_groups`.
- **After updating extension code** → `reload_extension` applies it in place.
