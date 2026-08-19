# Interface alignment with claude-in-chrome (v1.1.0)

Source of truth: live schemas pulled from the official `claude-in-chrome` MCP
(22 tools), stored alongside this file. Strategy: **adopt the official surface
verbatim** (same names, same parameter schemas, same semantics), keep the
durable tab-group layer as chrome-agent extensions, delete our redundant
originals.

> **Historical snapshot (v1.1.0).** The tool surface has since moved to the
> `threadTitle` model, which removed every agent-facing tab-group tool; see
> the README for the current list. One deliberate divergence from the official
> MCP is called out inline below and worth stating up front:
>
> **Window model — divergent on purpose.** The official MCP puts the agent's
> group in a NEW unfocused window. We instead join the profile's **last-active
> normal window**, because even an unfocused new window is user-visible (window
> list, Dock/taskbar, Mission Control). A window is created only when there is
> no normal window to borrow, and only such a self-created window is ever
> closed during cleanup. Anywhere below that says "a NEW unfocused window",
> read: the user's current window.

## Aligned tools (22) — identical names & schemas

| Tool | Implementation notes |
|---|---|
| `tabs_context_mcp` | Session's current group = "the MCP tab group". `createIfEmpty:true` creates a group in a NEW unfocused window with one empty tab (official behavior) and registers it in the durable registry (so it still gets a `grp_…` id). |
| `tabs_create_mcp` | New empty background tab in the session group (auto-creates group if none). |
| `tabs_close_mcp` | Strict: only closes tabs in the session's current group. (`close_tab` remains as the permissive variant.) |
| `navigate` | Standalone URL nav with no tabId auto-runs `tabs_context_mcp{createIfEmpty:true}` and appends the context to the result. `back`/`forward` require tabId. Inside `browser_batch`, tabId is required (no session default injected). Superset: also accepts `reload`. |
| `computer` | Adds official actions `zoom` (region screenshot, auto-magnified), `scroll_to` (ref), `hover` (ref or coordinate); `ref` usable instead of `coordinate` for clicks; `modifiers` as STRING (`"ctrl+shift"`; legacy array still accepted); `key` takes space-separated sequences (`"Backspace Backspace"`) + `repeat` (1-100); `save_to_disk` writes the image to ~/Downloads and returns the path. Superset: keeps `middle_click`, `left_mouse_down/up`, `hold_key`, `cursor_position` (extra enum values). `wait` max 10 s (aligned). |
| `read_page` | Official params: `filter` (`interactive`\|`all`, default **all** — includes non-visible elements, marked `(hidden)`), `depth` (default 15), `max_chars` (default 50000, truncates at line boundary with full-size note), `ref_id` (subtree focus). Refs renamed to official format `ref_N` (stale-ref detection kept internally via per-document nonce). |
| `get_page_text` | Aligned; keeps optional `maxChars`/`offset` pagination extras. |
| `find` | Natural-language matching: tokenized scoring over role/name/text/attributes (CSS selector still tried first). Max 20 results + "narrow your query" note when more match. |
| `form_input` | Aligned (`ref` required in schema; `selector` kept as optional extra). |
| `javascript_tool` | `{action:'javascript_exec', text, tabId}`. REPL semantics via CDP `Runtime.evaluate` `replMode:true` (top-level await, last-expression value). Replaces `execute_javascript`. |
| `file_upload` | Renames `upload_file`. Absolute local paths (no session-sharing sandbox — local trust model), `selector` extra kept. |
| `upload_image` | Server caches every screenshot/zoom image under an `imageId` (returned in metadata). Injects a File built from the cached bytes into a file input (`ref`) or synthesizes a drop at `coordinate`. |
| `browser_batch` | Server-side sequential executor, stop-on-first-error, images interleaved, cannot nest. Page-acting tools require explicit tabId inside a batch. |
| `gif_creator` | Real implementation. Extension records JPEG frames + action annotations per group (max 150 frames); overlays (click circles, drag arrows, labels, progress bar, watermark) composited in the extension via OffscreenCanvas; server encodes GIF with `gifenc` (+`fast-png` decode) and writes to ~/Downloads; `download:true` additionally triggers a browser download via `chrome.downloads`. |
| `read_console_messages` | Renames `read_console`; official params (`pattern` required regex, `onlyErrors`, `limit` 100, `clear`). |
| `read_network_requests` | Renames `read_network`; official params (`urlPattern` substring, `limit` 100, `clear`); buffer cleared on cross-domain navigation (aligned). |
| `resize_window` | Resizes the real window containing the tab. Since agent groups now live in the user's last-active window (see the window-model note above), this usually resizes a window the user is looking at: it is allowed, and flags `sharedWithUser` in the result. `set_viewport` is the non-intrusive alternative. |
| `list_connected_browsers` | Hub now supports MULTIPLE extension connections (e.g. Chrome + Chrome Canary + another profile). Each extension sends a persistent `instanceId` + platform info on hello. |
| `select_browser` | Per-session routing by `deviceId`. |
| `switch_browser` | Broadcasts a pairing request: every connected extension shows a notification + a "Connect" button in its popup; first user click wins (2-minute wait, aligned). Auto-selects when only one browser is connected. |
| `shortcuts_list` / `shortcuts_execute` | Storage-backed registry (`chrome.storage.local.shortcuts`: `[{id, command, description, isWorkflow, steps:[{name, input}]}]`, `$TAB` placeholder → tabId). Execute runs steps sequentially in the background and returns immediately (aligned). Empty by default. |

## Kept chrome-agent extensions (18)

`get_status` · `create_tab_group` (had a `window:"separate"|"current"` param;
removed along with the agent-facing group tools — placement is no longer a
choice, see the window-model note above) · `list_tab_groups` ·
`reconnect_tab_group` · `update_tab_group` · `close_tab_group` · `new_tab` ·
`list_tabs` · `close_tab` · `screenshot` (fullPage/element/format + imageId) ·
`set_viewport` · `click` (selector, middle button, clickCount, modifier array)
· `fill` · `drag_and_drop` (html5 DataTransfer mode) · `wait_for` ·
`get_response_body` · `bring_to_foreground` · `reload_extension`

## Removed (superseded by aligned tools)

`execute_javascript` → `javascript_tool` · `press_key` → `computer key` ·
`hover`/`scroll_to` → `computer` actions · `upload_file` → `file_upload` ·
`read_console` → `read_console_messages` · `read_network` →
`read_network_requests`

The extension keeps the old method names as protocol aliases so live sessions
running the previous server continue to work after the extension reloads.

Total surface: 40 tools.
