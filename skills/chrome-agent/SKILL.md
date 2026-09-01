---
name: chrome-agent
description: Drive the user's real Chrome in the background via the Chrome Agent Bridge MCP (mcp__chrome-agent__* tools). Use whenever a task needs web browsing, web-app interaction, scraping, or web testing in the user's logged-in browser. Every call takes a required threadTitle identifying your private tab workspace. Covers that contract, background-only driving, cleaning up with delete_my_tabs, and when to use reading vs screenshots vs coordinates.
---

# Driving Chrome with the Chrome Agent Bridge

You have `mcp__chrome-agent__*` tools that drive the user's real, logged-in
Chrome **in the background**: nothing you do focuses Chrome, activates the
user's tabs, or otherwise interrupts them.

Your tabs live in your own tab group **inside the window the user is already
using** — no new window is opened. They are never activated, so the user keeps
looking at their own tab, but your group is visible in their tab strip. Treat
that window as shared space: don't resize it (see `set_viewport` below) and
clean up when you're done.

## Your workspace: threadTitle

**Every tool call requires `threadTitle`** — a short, stable, distinctive title
for the task you are doing (e.g. `"Refactor auth flow"`, `"Check CI failure"`).
Pick one at the start and pass the *same* value on every single call.

That title *is* your browser identity. The bridge keeps one private tab group
per threadTitle and creates it for you on first use, so:

- You see **only your own tabs**. The user's tabs and other agents' tabs are
  invisible and unreachable — acting on a tab outside your workspace is refused.
- There is nothing to set up: `new_tab {url, threadTitle}` or
  `navigate {url, threadTitle}` just works.
- Changing your threadTitle mid-task **strands** your tabs and starts an empty
  workspace, so keep it stable. Reusing it later (even from a restarted agent
  or a different MCP process) re-attaches you to the same tabs.
- You cannot create, name, list, or switch groups; the group is infrastructure
  you do not manage.

## Finishing — always clean up

Call `delete_my_tabs {threadTitle}` when you are done with the browser. It
permanently deletes your tabs **and** the group.

Use it rather than closing tabs one by one: Chrome auto-saves every tab group,
so merely closing tabs leaves a saved group in the user's bookmarks bar that
also syncs to their account. `delete_my_tabs` ungroups first, which is what
actually removes it. Abandoned workspaces are also reclaimed after 24h.

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
- **Use `set_viewport` for responsive testing**, not `resize_window`. Your tabs
  sit in the user's own window, so `resize_window` resizes the window they are
  looking at; it is allowed (and tells you when the window is shared) but it
  interrupts them. `set_viewport` emulates any size with no visible effect.
- **Multiple profiles: you must choose.** When more than one Chrome is
  connected, nothing is selected by default and page tools fail with the list
  of candidates — the bridge will not guess which of the user's profiles to
  drive, because a wrong guess files their tab groups (which Chrome auto-saves
  and syncs) into the wrong Google account. Call `list_connected_browsers` →
  `select_browser`, or `switch_browser` to let them click Connect in the one
  they want. Each browser reports the profile's signed-in `email`; quote that
  rather than the deviceId, since it is how the user recognizes a profile. The
  choice is per-thread, so it never retargets another agent. With just one
  browser connected, it is adopted automatically and none of this applies.

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
- **"Tab … does not belong to this thread's tab group"** → that tab is someone
  else's. Use `tabs_context_mcp` to list your own, and check you are passing the
  same `threadTitle` as before.
- **Your tabs seem to have vanished** → usually a changed `threadTitle`; pass
  the original one. If the user closed the window, just open a tab again.
- **After updating extension code** → `reload_extension` applies it in place.
