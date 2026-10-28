# Chrome Agent Bridge

An MCP bridge for Chrome that works with **Claude
Cowork**, Claude Code, and any MCP client. It drives your real, logged-in
Chrome **in the background** — each agent thread is confined to its own
**private tab group** while you keep using your machine (and Chrome) normally.

Isolation is **enforced, not advised**: every tool takes a required
`threadTitle`, the bridge maps that to exactly one tab group, and an agent can
neither see nor touch anything outside it — not other threads' tabs, not yours.

```
Cowork thread A ──stdio MCP──▶ server (HUB, ws://127.0.0.1:47120)◀──WebSocket── Chrome extension
Cowork thread B ──stdio MCP──▶ server (RELAY ─▶ hub)                    │
                                                              tab groups + CDP (debugger)
```

- **`extension/`** — Manifest V3 extension. Owns the `threadTitle → tab group`
  registry (persisted in `chrome.storage.local`) and enforces the boundary:
  a command may only touch tabs in its own thread's group. Trusted input,
  screenshots, JS, console/network capture via `chrome.debugger` (CDP) — all of
  which work on **background tabs without focusing Chrome**.
- **`server/`** — stdio MCP server (35 tools). First process binds the port and
  becomes the hub; further agent threads run as relays through it, so any
  number of concurrent agents share the one extension.
- **`skills/chrome-agent/`** — the agent-facing skill: the `threadTitle`
  contract, cleaning up with `delete_my_tabs`, background etiquette.

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

## Updating

```bash
./update.sh           # idempotent; restarts the hub only if it predates the code
```

Every harness (Claude Code, Codex, OpenCode, DSH) launches the server from this
checkout by absolute path, so **new** agent sessions always get current code for
free. Two things do not update themselves:

- **The hub** — one MCP process owns port 47120 for the whole machine and can be
  days old. `update.sh` restarts it, winning the takeover race against the other
  relays (which would otherwise inherit the role while still running old code).
- **The extension** — reload it per profile at `chrome://extensions`, or call the
  `reload_extension` tool once per profile.

Agent sessions already running keep their older MCP code until their app restarts; server-side safety changes do not retrofit those processes. Upgraded relays can reuse a compatible hub's acknowledged exact-device routing. An unsupported or mismatched selection acknowledgment is refused rather than guessed. Roll out changes to other live owners only with their operator's approval.

## The contract

| Requirement | How it's met |
|---|---|
| One tab group per agent thread | **Enforced.** Every tool requires `threadTitle`; the extension resolves it to that thread's single group (created on first use) and injects it. No tool accepts a group id, so a thread cannot select, create or enumerate another group. |
| A thread may only touch its own tabs | Every tab-scoped command passes through `assertTabInGroup`, which refuses any tab outside the caller's group — including the user's own tabs. `list_tabs` has no `all:true`. |
| Cleanup leaves nothing behind | `delete_my_tabs` **ungroups before closing**, which is what actually removes the group; closing alone would leave a Chrome saved group (and sync it to the user's account). Abandoned workspaces are GC'd after 24h without activity. |
| Identity survives process churn | `threadTitle` is a request parameter, not connection state, so it works whether the host gives each thread its own MCP process or shares one across all of them, and it survives a server restart mid-thread. |
| Background driving | Agent groups live in a tab group inside the profile's **last-active window** — no window is created or focused — and tabs are created `active:false`, so the user's active tab never changes. Input + screenshots go through CDP, which doesn't need visibility. `bring_to_foreground` is the single explicit exception. |
| Text or visual page reps | `read_page` (outline + refs), `get_page_text`, `find`, `screenshot` (viewport / full-page / element, CSS-pixel-aligned with `computer` coordinates). |
| Element / JS / coordinate interaction | `click`/`fill`/`form_input`/`drag_and_drop`/`upload_file` by ref or selector; `execute_javascript`; `computer` by coordinates. |
| All user input primitives | left/right/middle clicks, double/triple clicks, modifier-clicks, mouse move/down/up, pointer & HTML5 drag-and-drop, wheel scrolling, full keyboard incl. chords and hold, typing, file upload. |

## Tools (35)

**Every tool below requires `threadTitle`**, except `get_status`,
`list_connected_browsers` and `reload_extension` (browser-wide utilities that
touch no tabs). `select_browser` / `switch_browser` take it too, because the
chosen browser is remembered per thread rather than per process.

The bridge uses a mandatory `threadTitle`; no tab-group management
(agents never name or switch groups — the group is infrastructure);
**`delete_my_tabs` instead of closing tabs** (Chrome auto-saves closed tab
groups, so "close" always leaves a synced saved-group behind); and the window
model — agent groups join the profile's last-active window rather than opening
a new one, because even an unfocused new window is a user-visible event.

`tabs_context_mcp` · `tabs_create_mcp` · `navigate` ·
`computer` (incl. `zoom`, `scroll_to`, `hover`, ref targeting, key sequences)
· `read_page` (`filter`/`depth`/`max_chars`/`ref_id`) · `get_page_text` ·
`find` (natural language) · `form_input` · `javascript_tool` (REPL) ·
`file_upload` · `upload_image` · `browser_batch` · `gif_creator` ·
`read_console_messages` · `read_network_requests` · `resize_window` ·
`list_connected_browsers` · `select_browser` · `switch_browser` ·
`shortcuts_list` · `shortcuts_execute`

Workspace and interaction utilities:

`get_status` · `delete_my_tabs` · `new_tab` · `list_tabs` · `close_tab` ·
`bring_to_foreground` · `screenshot` (fullPage/element + imageId) ·
`set_viewport` · `click` · `fill` · `drag_and_drop` · `wait_for` ·
`get_response_body` · `reload_extension`

Removed on purpose: `create_tab_group`, `list_tab_groups`,
`reconnect_tab_group`, `update_tab_group`, `close_tab_group`, `tabs_close_mcp`,
`list_tabs {all:true}` and `new_tab {ungrouped:true}` — groups are no longer an
agent-facing concept, and "close" is never the right cleanup verb (see below).

Shortcuts are user-defined in `chrome.storage.local` under `shortcuts`:
`[{id, command, description, isWorkflow, steps: [{name, input}]}]` with
`"$TAB"` as the target-tab placeholder in step inputs.

## Server profile and caller isolation

For an isolated companion, configure the server process, not tool arguments:

```bash
CHROME_AGENT_PROFILE_EMAIL='work@example.test' \
DSH_REMOTE_CONTEXT_ID='host-resolved-peer-and-caller-id' \
node server/index.mjs
```

- `CHROME_AGENT_PROFILE_EMAIL` is an optional exact, case-insensitive match against the extension's reported profile email. A configured empty value is an error. Automatic and explicit selection cannot choose another reported profile. This is a Chrome-profile routing constraint, not proof of the account signed into a website.
- A selected device stays pinned for that exact thread until an explicit successful `select_browser` or `switch_browser`. Disconnects never discard the pin, retry the action, or substitute the sole remaining profile. Pins are process-local; use the profile constraint for companion restarts. At 200 retained selections, new selections fail instead of evicting old pins.
- `DSH_REMOTE_CONTEXT_ID` is an optional trusted, opaque caller identity. A configured empty value is an error. The server derives `dsh-<128-bit SHA-256 prefix>-` from it and adds a lowercased, bounded display suffix, keeping the complete title within Chrome's 60 UTF-16-code-unit limit. Explicit nested batch titles receive the same caller prefix; omitted nested titles inherit the parent. Threadless utilities use a namespaced `global` key. Model titles never choose the prefix. Pass ordinary titles from the gateway; do not pre-prefix them. Omission preserves local title behavior.

MCP initialization advertises `capabilities.experimental["chrome-agent/safety"]`; `get_status` also returns it as `safety`. Version `1` reports `stickyDevicePin`, `exactProfileEmail`, `callerNamespace: 1`, the configured `requiredProfileEmail`, and `remoteContextConfigured`/`remoteContextHash`. `get_status` accepts an optional `threadTitle`; `connected` reports available browser connections and `ready` reports whether that selection can be used.

### Cancellation and compatibility

MCP cancellation reaches connection waits, pairing waits, outstanding bridge waits, and the boundaries between batch actions. A failed or cancelled batch returns `isError: true`, keeps earlier step output, and reports `_meta["chrome-agent/error"]` with a `code` and `outcome`. `not-dispatched` means no browser command was sent for the failed request; `unknown` means a sent command may still apply. The server never automatically replays a browser command, and cancellation is not rollback. GIF encoding yields between frames and checks cancellation before saving or requesting a browser download.

`shortcuts_execute` retains its existing fire-and-forget behavior: `started` acknowledges submission, not completion. Its result and `_meta["chrome-agent/submission"]` explicitly report `submissionOnly: true` and `cancellableAfterReturn: false`. Once its MCP call returns, later MCP cancellation cannot stop its background steps. The safety marker therefore reports `cancellation: "server-boundaries"`, `extensionAbort: false`, and `shortcuts: "submission-only"`.

No extension changes are required for these server guarantees. A compatible older shared hub can remain running: the relay requires acknowledgment of the exact selected device and reported profile before sending an explicitly device-addressed command. Missing or mismatched acknowledgments fail closed. Updated hubs additionally check the profile at socket dispatch and accept relay cancellation. An older hub can still finish a command already forwarded to it; cancellation of that request remains `unknown`. Do not reload a live hub or extension just to run the fake tests below.

## Security notes

- The hub binds `127.0.0.1` only.
- `/ext` registration requires a `chrome-extension://` Origin (web pages can't
  fake it); `/relay` requires a custom header (web pages can't set one).
- Anything with local shell access could still connect — same trust model as
  a local CDP port. Don't run untrusted local software while using this.
- **Profile routing is never guessed.** With two or more Chrome profiles
  connected, a thread that has not chosen one is refused (with both accounts
  named) instead of being pointed at whichever extension reconnected last.
  Picking wrong is not a cosmetic error: Chrome 129+ auto-saves tab groups, so
  a misrouted group syncs into the wrong Google account. The updated hub refuses unselected ambiguous relay choices and retains each relay thread's accepted device. An ordinary request cannot change that device; an explicit selection control is required.

## Testing

Fake Node/MCP/WebSocket tests use only owned in-memory transports and ephemeral loopback ports, without Chrome or the live hub:

```bash
npm ci --ignore-scripts --prefix server
node --test test/session-safety.mjs test/bridge-safety.mjs
```

The browser suites below are separate and require explicit browser access:

```bash
cd test
npm install
npx @puppeteer/browsers install chrome@stable --path ./browsers   # once

# isolated (throwaway browser — never touches your real Chrome)
node e2e.mjs                    # 126-assertion full tool matrix + hub failover
node thread-isolation.mjs       # enforced one-group-per-thread + true delete
node no-blank-tab.mjs           # a new workspace strands no blank tab
node window-reuse.mjs           # groups land in the user's window; cleanup is safe
node freeze-recovery.mjs        # frozen-renderer recovery
node background-guarantee.mjs   # OS-level focus-steal check

# against your real, logged-in Chrome (creates + deletes its own tab group)
node smoke-real.mjs             # connect, browse, screenshot, click, cleanup
node reconnect-real.mjs         # agent restarts, re-attaches by threadTitle
node tools-real.mjs             # tabs_context/zoom/batch/gif/resize/browsers
node thread-isolation-real.mjs  # 25 assertions: isolation + delete, self-cleaning
node frontmost-real.mjs         # macOS frontmost check in the real profile
```

Real-profile tests never guess which Chrome profile to drive: with exactly one
connected they use it; with several they fail and ask for `CAB_TEST_BROWSER`
(a deviceId or email substring):

```bash
CAB_TEST_BROWSER=you@example.com node smoke-real.mjs
```

The browser suites need **Chrome for Testing**, and specifically a build that still honours
`--load-extension` (Chrome ≥137 ignores it, and newer Chrome-for-Testing builds
do too, so `harness.mjs` picks the newest installed build **≤136** rather than
the newest overall — otherwise every test fails with "extension never
connected"). Install one with
`npx @puppeteer/browsers install chrome@136 --path ./browsers`. **Test isolation matters here:** the production extension
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
- **Closing a tab group does NOT delete it; ungrouping does.** Chrome 129+
  auto-saves every tab group, and `chrome.tabGroups` has no `remove`/`delete`
  method (only get/move/query/update). So closing a group's tabs leaves a saved
  group chip in the user's bookmarks bar, which then syncs to their account —
  the agent thinks it cleaned up, but the trace is permanent and accumulates one
  entry per thread. Verified empirically on Chrome 151 with A/B trials
  (single- and multi-tab groups): `tabs.remove()` alone always left a saved
  chip, while `tabs.ungroup()` **followed by** `tabs.remove()` left none.
  `deleteGroup()` therefore ungroups first — the ordering is load-bearing.
  Corollary: saved-but-closed groups are invisible to `chrome.tabGroups.query()`,
  so the extension cannot retroactively clean up chips already leaked; those
  must be removed by hand.
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
- **Connection grace is cancellable, not permission to retarget.** The bridge can wait up to 15 seconds for a link. A missing initial eligible profile is reported unavailable; a lost existing pin is retained. Neither case authorizes using another connected profile.
- **Agent groups join the profile's last-active window; they do not create one.**
  Even an unfocused `chrome.windows.create` is a user-visible event (a new entry
  in the window list, the Dock/taskbar and Mission Control), so agent tabs go
  into a collapsed-free tab group in the window the user is already using.
  Consequences worth knowing:
  - The testable invariant is now simply **no agent tab is ever `active`** —
    a window has exactly one active tab, so that alone proves the user kept
    theirs. (Previously an agent tab was legitimately active in its own window,
    which made the invariant window-relative and much weaker.)
  - A window is still created in one case: the profile has no *normal* window to
    borrow (macOS keeps Chrome running with no windows; popups/PWAs are skipped
    on purpose).
  - **Cleanup closes tabs, not windows.** Measured on Chrome 136: removing a
    window's last tab closes the window, so `delete_my_tabs` needs no window
    bookkeeping. `deleteGroup` keeps an empty-window sweep as a belt-and-braces
    fallback, gated purely on the window being empty. Tracking *which* window
    the extension created (an earlier design) is actively unsafe: window ids are
    recycled across restarts, so a remembered id can later name the user's window.
  - `resize_window` therefore usually resizes a window the user is looking at.
    It is deliberately unguarded, and flags `sharedWithUser` in its result;
    `set_viewport` remains the non-intrusive way to test responsive layouts.
- **`Page.captureScreenshot` can exceed a 20s CDP budget under heavy machine
  load** (a whole e2e screenshot section failed this way once). Screenshot now
  resumes the page and retries once at 45s.
- **A mixed-version hub/relay is real**: an old hub forwards unknown `hub:*`
  ops straight to the extension, so the extension answers them about itself.
