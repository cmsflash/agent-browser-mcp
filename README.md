# Chrome Agent Bridge

A self-owned clone of the Claude-in-Chrome integration that works with **Claude
Cowork**, Claude Code, and any MCP client. It drives your real, logged-in
Chrome **in the background** — agents work inside isolated, **reconnectable tab
groups** while you keep using your machine (and even Chrome itself) normally.

```
Cowork thread A ──stdio MCP──▶ server (HUB, ws://127.0.0.1:47120)◀──WebSocket── Chrome extension
Cowork thread B ──stdio MCP──▶ server (RELAY ─▶ hub)                    │
                                                              tab groups + CDP (debugger)
```

- **`extension/`** — Manifest V3 extension. Tab-group registry with stable
  internal IDs (`grp_…`) persisted in `chrome.storage.local`; trusted input,
  screenshots, JS, console/network capture via `chrome.debugger` (CDP) — all of
  which work on **background tabs without focusing Chrome**.
- **`server/`** — stdio MCP server (40 tools, claude-in-chrome-aligned). First process binds the port and
  becomes the hub; further agent threads run as relays through it, so any
  number of concurrent agents share the one extension.
- **`skills/chrome-agent/`** — the agent-facing skill describing the default
  workflow (one group per thread, reconnect-on-restart, background etiquette).

## Install

```bash
./install.sh          # installs deps, registers the MCP server + skill
```

Then load the extension once:
1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select `extension/` in this directory.
3. Icon badge turns green ● whenever an agent session is running.

Manual registration, if you prefer:

```bash
claude mcp add --scope user chrome-agent -- node "$(pwd)/server/index.mjs"
mkdir -p ~/.claude/skills && ln -s "$(pwd)/skills/chrome-agent" ~/.claude/skills/chrome-agent
```

Optional: launch Chrome with `--silent-debugger-extension-api` to hide the
"…is debugging this browser" info bar (cosmetic only).

## The contract

| Requirement | How it's met |
|---|---|
| Tab-group lifecycle + reconnection | `create_tab_group` returns a stable internal ID; registry survives extension/browser restarts (rebind by name/color, or restore from tab snapshot); `close_tab_group` closes and/or forgets. |
| Background driving | Agent groups live in their own background window (never focused), tabs are created `active:false`; input + screenshots go through CDP, which doesn't need visibility. `bring_to_foreground` is the single explicit exception. |
| Ungrouped tabs = exception | `new_tab` refuses to create loose tabs unless `ungrouped:true`; `list_tabs {all:true}` labels the user's tabs `managed:false`. |
| Text or visual page reps | `read_page` (outline + refs), `get_page_text`, `find`, `screenshot` (viewport / full-page / element, CSS-pixel-aligned with `computer` coordinates). |
| Element / JS / coordinate interaction | `click`/`fill`/`form_input`/`drag_and_drop`/`upload_file` by ref or selector; `execute_javascript`; `computer` by coordinates. |
| All user input primitives | left/right/middle clicks, double/triple clicks, modifier-clicks, mouse move/down/up, pointer & HTML5 drag-and-drop, wheel scrolling, full keyboard incl. chords and hold, typing, file upload. |

## Tools (40) — aligned with claude-in-chrome (v1.1.0)

The primary surface is a verbatim alignment with the official claude-in-chrome
MCP — same names, same parameter schemas, same semantics (see
`reference/alignment-map.md`):

`tabs_context_mcp` · `tabs_create_mcp` · `tabs_close_mcp` · `navigate` ·
`computer` (incl. `zoom`, `scroll_to`, `hover`, ref targeting, key sequences)
· `read_page` (`filter`/`depth`/`max_chars`/`ref_id`) · `get_page_text` ·
`find` (natural language) · `form_input` · `javascript_tool` (REPL) ·
`file_upload` · `upload_image` · `browser_batch` · `gif_creator` ·
`read_console_messages` · `read_network_requests` · `resize_window` ·
`list_connected_browsers` · `select_browser` · `switch_browser` ·
`shortcuts_list` · `shortcuts_execute`

Plus the durable chrome-agent extension layer:

`get_status` · `create_tab_group` · `list_tab_groups` · `reconnect_tab_group` ·
`update_tab_group` · `close_tab_group` · `new_tab` · `list_tabs` · `close_tab`
· `bring_to_foreground` · `screenshot` (fullPage/element + imageId) ·
`set_viewport` · `click` · `fill` · `drag_and_drop` · `wait_for` ·
`get_response_body` · `reload_extension`

Shortcuts are user-defined in `chrome.storage.local` under `shortcuts`:
`[{id, command, description, isWorkflow, steps: [{name, input}]}]` with
`"$TAB"` as the target-tab placeholder in step inputs.

## Security notes

- The hub binds `127.0.0.1` only.
- `/ext` registration requires a `chrome-extension://` Origin (web pages can't
  fake it); `/relay` requires a custom header (web pages can't set one).
- Anything with local shell access could still connect — same trust model as
  a local CDP port. Don't run untrusted local software while using this.

## Testing

```bash
cd test
npm install
npx @puppeteer/browsers install chrome@stable --path ./browsers   # once

# isolated (throwaway browser — never touches your real Chrome)
node e2e.mjs                    # 137-assertion full tool matrix
node freeze-recovery.mjs        # frozen-renderer recovery
node background-guarantee.mjs   # OS-level focus-steal check

# against your real, logged-in Chrome (creates + closes its own tab group)
node smoke-real.mjs             # connect, browse, screenshot, click, reconnect
node reconnect-real.mjs         # agent restarts, reconnects to its group by ID
node aligned-real.mjs           # tabs_context/zoom/batch/gif/resize/browsers
node frontmost-real.mjs         # macOS frontmost check in the real profile
```

Tests need **Chrome for Testing** (branded Chrome ≥137 ignores
`--load-extension`). **Test isolation matters here:** the production extension
dials `127.0.0.1:47120`, so if it's loaded in your everyday Chrome, a test
server on that port would find the *real* extension connecting and drive your
actual tabs. `harness.mjs` prevents that: every isolated test runs its servers
on port `47999` and loads a patched *copy* of the extension pointed at that
port, so the two can never meet.

`background-guarantee.mjs` samples the macOS frontmost app every 500 ms while
driving an intensive action battery and fails if the driven Chrome ever takes
focus or any agent tab becomes active.

### Version compatibility

The extension answers both the current protocol and every v1.0.x method name
(plus `hub:*` control ops), so a Cowork/Claude Code session still running an
older MCP server keeps working after the extension reloads. Reload with the
`reload_extension` tool — no `chrome://extensions` visit needed.

### Hard-won implementation notes (why the code looks like this)

- **Never-visible background tabs have no compositor surface** and their
  `requestAnimationFrame` never fires. Mouse events dispatched via
  `chrome.debugger` are silently dropped (no surface) or hang (wheel/drag wait
  on a compositor frame). `Page.captureScreenshot` forces exactly one
  BeginFrame — so the extension force-paints on attach and runs a "frame pump"
  (repeated cheap captures) around every mouse sequence. `Page.startScreencast`
  does NOT produce frames through `chrome.debugger` on such tabs, so it can't
  be used for this.
- **`chrome.tabs.goBack/goForward` reject on background tabs** — history
  navigation is driven in-page (`history.back()`) instead.
- **Chrome freezes/discards idle background tabs** (aggressively in collapsed
  groups, and under memory pressure in a busy profile). A frozen renderer
  swallows `chrome.scripting.executeScript` *forever* — the call never resolves
  — while CDP still works. So `getTab()` revives frozen/discarded tabs up front
  (`Page.setWebLifecycleState: active`, or reload), and `exec()` bounds every
  injection with a timeout plus a wake-and-retry. This only shows up in real
  profiles with many tabs; a fresh test browser never freezes anything.
- **Branded Chrome ≥137 removed `--load-extension`** — automated tests use
  Chrome for Testing; real installs load the unpacked extension manually.
- **The extension's reconnect backoff bounds first-call latency.** When a new
  agent session starts, its server becomes the hub and the extension must
  notice. The backoff is capped at 3 s and `bridge.call()` waits up to 15 s for
  the link, so the first tool call of a session doesn't fail spuriously.
- **Agent groups get their own background window** (`chrome.windows.create({focused:false})`),
  matching the official model. Consequence: an agent tab is legitimately
  "active" inside that window — the invariant to test is that no agent tab is
  active in a window holding the *user's* tabs.
- **`Page.captureScreenshot` can exceed a 20s CDP budget under heavy machine
  load** (a whole e2e screenshot section failed this way once). Screenshot now
  resumes the page and retries once at 45s.
- **A mixed-version hub/relay is real**: an old hub forwards unknown `hub:*`
  ops straight to the extension, so the extension answers them about itself.
