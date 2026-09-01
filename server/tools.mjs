// MCP tool definitions for the Chrome Agent Bridge — v1.1.0.
//
// The primary surface is a VERBATIM alignment with the official
// claude-in-chrome MCP (22 tools: same names, same parameter schemas, same
// semantics — see reference/alignment-map.md). On top of that, chrome-agent
// keeps its durable tab-group layer and a few power tools as extensions.
//
// Design contract:
//   * ENFORCED: exactly one tab group per agent thread. Every tool takes a
//     required threadTitle; the bridge maps that to the thread's own group and
//     refuses any tab outside it. Agents cannot create, name, list, switch, or
//     close groups — the group is invisible infrastructure.
//   * Background-only driving; the user's own tabs are never reachable.

const T = [];

// Identity is a parameter rather than a property of the connection, because a
// single MCP process may serve several agent threads (some hosts share one
// server across sessions), and one process may be restarted mid-thread.
const threadProp = {
  threadTitle: {
    type: "string",
    description:
      "REQUIRED on every call: the title of YOUR agent thread (a short, stable, distinctive label for the task you are working on — e.g. \"Refactor auth flow\"). This is your browser workspace identity: all your tabs live in a private group keyed to it, and you can only ever see and act on tabs in that group. Pass the SAME value on every call for the duration of the thread; changing it strands your tabs and starts a fresh workspace.",
  },
};

// threadTitle is required everywhere except the few browser-wide utilities.
function tool(name, description, properties, { required = [], method = name, timeout, threadless = false } = {}) {
  const props = threadless ? properties : { ...properties, ...threadProp };
  const req = threadless ? required : [...required, "threadTitle"];
  T.push({ name, description, inputSchema: { type: "object", properties: props, required: req }, method, timeout });
}

const tabIdReq = (what) => ({
  tabId: { type: "number", description: `Tab ID ${what}. Must be one of YOUR tabs. Use tabs_context_mcp to list them.` },
});
const tabIdOpt = {
  tabId: { type: "number", description: "Target tab ID. Defaults to the session's current tab (the last tab you created, navigated, or reconnected to)." },
};
const refProp = {
  ref: { type: "string", description: 'Element reference ID from read_page or find tools (e.g., "ref_1", "ref_2"). Refs go stale after navigation — re-read the page if a ref fails.' },
};
const selectorProp = {
  selector: { type: "string", description: "CSS selector, used if ref is not given (chrome-agent extension)." },
};

// ═══════════════════════════════════════════════════════════════════
// ALIGNED SURFACE — identical to claude-in-chrome
// ═══════════════════════════════════════════════════════════════════

tool(
  "tabs_context_mcp",
  "List YOUR tabs — the tabs in your thread's private browser workspace. Your workspace is created automatically on your first call, so this always works. You can only see your own tabs: the user's tabs and other threads' tabs are not visible or reachable. Call this when you need your tab IDs.",
  {},
  { method: "tabs_context", timeout: 45000 }
);

tool(
  "tabs_create_mcp",
  "Create a new empty background tab in your thread's workspace and return its tab ID.",
  {},
  { method: "tabs_create", timeout: 45000 }
);

tool(
  "navigate",
  `Navigate to a URL, or go forward/back in browser history. tabId may be omitted for URL navigation when calling navigate STANDALONE (not inside browser_batch): your workspace's first tab is used (the workspace is created if you don't have one yet), and the tab list is appended to this call's output so you have ids for subsequent calls. Inside browser_batch, navigate (and other tools that act on a page) requires an explicit tabId. tabId is required for url:"back"/"forward". Also accepts "reload".`,
  {
    url: { type: "string", description: 'The URL to navigate to. Can be provided with or without protocol (defaults to https://). Use "forward" to go forward in history or "back" to go back in history.' },
    tabId: { type: "number", description: `Tab ID to navigate. Must be one of your own tabs. If omitted for URL navigation when calling navigate standalone, your workspace's first tab is used. Required for url:"back"/"forward" and inside browser_batch.` },
  },
  { required: ["url"], timeout: 45000 }
);

tool(
  "computer",
  "Use a mouse and keyboard to interact with a web browser, and take screenshots. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.\n* Whenever you intend to click on an element like an icon, you should consult a screenshot to determine the coordinates of the element before moving the cursor.\n* If you tried clicking on a program or link but it failed to load, even after waiting, try adjusting your click location so that the tip of the cursor visually falls on the element that you want to click.\n* Make sure to click any buttons, links, icons, etc with the cursor tip in the center of the element. Don't click boxes on their edges unless asked.",
  {
    action: {
      type: "string",
      description: "The action to perform:\n* `left_click`: Click the left mouse button at the specified coordinates.\n* `right_click`: Click the right mouse button at the specified coordinates to open context menus.\n* `double_click`: Double-click the left mouse button at the specified coordinates.\n* `triple_click`: Triple-click the left mouse button at the specified coordinates.\n* `type`: Type a string of text.\n* `screenshot`: Take a screenshot of the screen.\n* `wait`: Wait for a specified number of seconds.\n* `scroll`: Scroll up, down, left, or right at the specified coordinates.\n* `key`: Press a specific keyboard key or space-separated sequence of keys.\n* `left_click_drag`: Drag from start_coordinate to coordinate.\n* `zoom`: Take a screenshot of a specific region for closer inspection.\n* `scroll_to`: Scroll an element into view using its element reference ID from read_page or find tools.\n* `hover`: Move the mouse cursor to the specified coordinates or element without clicking. Useful for revealing tooltips, dropdown menus, or triggering hover states.\nAdditional chrome-agent primitives: `middle_click`, `left_mouse_down`, `left_mouse_up`, `hold_key`, `cursor_position`.",
      enum: ["left_click", "right_click", "type", "screenshot", "wait", "scroll", "key", "left_click_drag", "double_click", "triple_click", "zoom", "scroll_to", "hover", "middle_click", "left_mouse_down", "left_mouse_up", "hold_key", "cursor_position"],
    },
    coordinate: { type: "array", items: { type: "number" }, description: "(x, y): The x (pixels from the left edge) and y (pixels from the top edge) coordinates. Required for `left_click`, `right_click`, `double_click`, `triple_click`, and `scroll`. For `left_click_drag`, this is the end position." },
    start_coordinate: { type: "array", items: { type: "number" }, description: "(x, y): The starting coordinates for `left_click_drag`." },
    text: { type: "string", description: 'The text to type (for `type` action) or the key(s) to press (for `key` action). For `key` action: Provide space-separated keys (e.g., "Backspace Backspace Delete"). Supports keyboard shortcuts using the platform\'s modifier key (use "cmd" on Mac, "ctrl" on Windows/Linux, e.g., "cmd+a" or "ctrl+a" for select all).' },
    duration: { type: "number", minimum: 0, maximum: 10, description: "The number of seconds to wait. Required for `wait`. Maximum 10 seconds." },
    scroll_direction: { type: "string", enum: ["up", "down", "left", "right"], description: "The direction to scroll. Required for `scroll`." },
    scroll_amount: { type: "number", minimum: 1, maximum: 10, description: "The number of scroll wheel ticks. Optional for `scroll`, defaults to 3." },
    modifiers: { type: "string", description: 'Modifier keys for click actions. Supports: "ctrl", "shift", "alt", "cmd" (or "meta"), "win" (or "windows"). Can be combined with "+" (e.g., "ctrl+shift", "cmd+alt"). Optional.' },
    ref: { type: "string", description: 'Element reference ID from read_page or find tools (e.g., "ref_1", "ref_2"). Required for `scroll_to` action. Can be used as alternative to `coordinate` for click actions.' },
    region: { type: "array", items: { type: "number" }, description: "(x0, y0, x1, y1): The rectangular region to capture for `zoom`. Coordinates define a rectangle from top-left (x0, y0) to bottom-right (x1, y1) in pixels from the viewport origin. Required for `zoom` action. Useful for inspecting small UI elements like icons, buttons, or text." },
    repeat: { type: "number", minimum: 1, maximum: 100, description: "Number of times to repeat the key sequence. Only applicable for `key` action. Must be a positive integer between 1 and 100. Default is 1. Useful for navigation tasks like pressing arrow keys multiple times." },
    save_to_disk: { type: "boolean", description: "For screenshot/zoom actions: save the image to disk so it can be attached to a message for the user. Returns the saved path in the tool result. Only set this when you intend to share the image — screenshots you're just looking at don't need saving." },
    ...tabIdReq("to execute the action on"),
  },
  { required: ["action", "tabId"], timeout: 45000 }
);

tool(
  "read_page",
  "Get an accessibility tree representation of elements on the page. By default returns all elements including non-visible ones. Output is limited to 50000 characters by default. If the output exceeds this limit it is truncated at a line boundary, with a note giving the full size — pass a larger max_chars, or use depth/ref_id to focus on part of the page. Optionally filter for only interactive elements. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
  {
    filter: { type: "string", enum: ["interactive", "all"], description: 'Filter elements: "interactive" for buttons/links/inputs only, "all" for all elements including non-visible ones (default: all elements)' },
    depth: { type: "number", description: "Maximum depth of the tree to traverse (default: 15). Use a smaller depth if output is too large." },
    max_chars: { type: "number", description: "Maximum characters for output (default: 50000). Set to a higher value if your client can handle large outputs." },
    ref_id: { type: "string", description: "Reference ID of a parent element to read. Will return the specified element and all its children. Use this to focus on a specific part of the page when output is too large." },
    ...tabIdReq("to read from"),
  },
  { required: ["tabId"] }
);

tool(
  "get_page_text",
  "Extract raw text content from the page, prioritizing article content. Ideal for reading articles, blog posts, or other text-heavy pages. Returns plain text without HTML formatting. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
  {
    ...tabIdReq("to extract text from"),
    maxChars: { type: "number", description: "Max characters per call (default 16000; chrome-agent extension)." },
    offset: { type: "number", description: "Character offset to continue from (default 0; chrome-agent extension)." },
  },
  { required: ["tabId"] }
);

tool(
  "find",
  "Find elements on the page using natural language. Can search for elements by their purpose (e.g., \"search bar\", \"login button\") or by text content (e.g., \"organic mango product\"). Returns up to 20 matching elements with references that can be used with other tools. If more than 20 matches exist, you'll be notified to use a more specific query. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
  {
    query: { type: "string", description: 'Natural language description of what to find (e.g., "search bar", "add to cart button", "product title containing organic")' },
    ...tabIdReq("to search in"),
  },
  { required: ["query", "tabId"] }
);

tool(
  "form_input",
  "Set values in form elements using element reference ID from the read_page tool. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
  {
    ref: { type: "string", description: 'Element reference ID from the read_page tool (e.g., "ref_1", "ref_2")' },
    value: { description: "The value to set. For checkboxes use boolean, for selects use option value or text, for other inputs use appropriate string/number" },
    ...selectorProp,
    ...tabIdReq("to set form value in"),
  },
  { required: ["ref", "tabId"] }
);

tool(
  "javascript_tool",
  "Execute JavaScript code in the context of the current page. The code runs in the page's context and can interact with the DOM, window object, and page variables. Returns the result of the last expression or any thrown errors. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
  {
    action: { type: "string", description: "Must be set to 'javascript_exec'" },
    text: { type: "string", description: "The JavaScript code to execute. Evaluated in the page context with REPL semantics: top-level `await` works, and the result of the last expression is returned automatically — write the expression you want (e.g. `window.myData.value`, or `await fetch(url).then(r=>r.json())`) rather than `return ...`. You can access and modify the DOM, call page functions, and interact with page variables.", },
    ...tabIdReq("to execute the code in"),
  },
  { required: ["action", "text", "tabId"], method: "javascript_exec", timeout: 45000 }
);

tool(
  "file_upload",
  "Upload one or multiple files to a file input element on the page. Do not click on file upload buttons or file inputs — clicking opens a native file picker dialog that you cannot see or interact with. Instead, use read_page or find to locate the file input element, then use this tool with its ref to upload files directly. Paths must be absolute paths on this machine.",
  {
    paths: { type: "array", items: { type: "string" }, description: "Absolute paths to the files to upload." },
    ...refProp,
    ...selectorProp,
    ...tabIdReq("where the file input is located"),
  },
  { required: ["paths", "tabId"], method: "upload_file" }
);

tool(
  "upload_image",
  "Upload a previously captured screenshot to a file input or drag & drop target. Supports two approaches: (1) ref - for targeting specific elements, especially hidden file inputs, (2) coordinate - for drag & drop to visible locations like Google Docs. Provide either ref or coordinate, not both.",
  {
    imageId: { type: "string", description: "ID of a previously captured screenshot (from the computer tool's screenshot/zoom action or the screenshot tool — the imageId is in the result metadata)" },
    ref: { type: "string", description: 'Element reference ID from read_page or find tools (e.g., "ref_1", "ref_2"). Use this for file inputs (especially hidden ones) or specific elements. Provide either ref or coordinate, not both.' },
    coordinate: { type: "array", items: { type: "number" }, description: "Viewport coordinates [x, y] for drag & drop to a visible location. Use this for drag & drop targets like Google Docs. Provide either ref or coordinate, not both." },
    filename: { type: "string", description: 'Optional filename for the uploaded file (default: "image.png")' },
    ...tabIdReq("where the target element is located"),
  },
  { required: ["imageId", "tabId"], method: "upload_image_inject", timeout: 45000 }
);

tool(
  "browser_batch",
  "Execute a sequence of browser tool calls in ONE round trip. Each item is {name, input} where input is exactly what you'd pass to that tool standalone. Actions execute SEQUENTIALLY (not in parallel) and stop on the first error. Use this tool extensively to quickly execute work whenever you can predict two or more steps ahead — e.g. navigate, click a field, type, press Return, screenshot. Screenshots and other images are returned interleaved with outputs; coordinates you write in THIS batch refer to the screenshot taken BEFORE this call. browser_batch cannot be nested. Tools that act on a page require an explicit tabId inside a batch.",
  {
    actions: {
      type: "array",
      description: 'List of tool calls to execute sequentially. Example: [{"name":"computer","input":{"action":"left_click","coordinate":[100,200],"tabId":123}},{"name":"computer","input":{"action":"type","text":"hello","tabId":123}},{"name":"navigate","input":{"url":"https://example.com","tabId":123}}]',
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "Tool name (e.g. computer, navigate, find, tabs_create_mcp). browser_batch cannot be nested." },
          input: { type: "object", description: "That tool's input — same shape you'd pass when calling it directly." },
        },
        required: ["name", "input"],
      },
    },
  },
  { required: ["actions"], timeout: 300000 }
);

tool(
  "gif_creator",
  "Manage GIF recording and export for browser automation sessions. Control when to start/stop recording browser actions (clicks, scrolls, navigation), then export as an animated GIF with visual overlays (click indicators, action labels, progress bar, watermark). All operations are scoped to your own workspace. When starting recording, take a screenshot immediately after to capture the initial state as the first frame. When stopping recording, take a screenshot immediately before to capture the final state as the last frame. For export, set 'download: true' to download the GIF in the browser; the GIF is also always written to ~/Downloads on this machine.",
  {
    action: { type: "string", enum: ["start_recording", "stop_recording", "export", "clear"], description: "Action to perform: 'start_recording' (begin capturing), 'stop_recording' (stop capturing but keep frames), 'export' (generate and export GIF), 'clear' (discard frames)" },
    download: { type: "boolean", description: "Always set this to true for the 'export' action only. This causes the gif to be downloaded in the browser." },
    filename: { type: "string", description: "Optional filename for exported GIF (default: 'recording-[timestamp].gif'). For 'export' action only." },
    options: {
      type: "object",
      description: "Optional GIF enhancement options for 'export' action. Properties: showClickIndicators (bool), showDragPaths (bool), showActionLabels (bool), showProgressBar (bool), showWatermark (bool), quality (number 1-30). All default to true except quality (default: 10).",
      properties: {
        showClickIndicators: { type: "boolean", description: "Show orange circles at click locations (default: true)" },
        showDragPaths: { type: "boolean", description: "Show red arrows for drag actions (default: true)" },
        showActionLabels: { type: "boolean", description: "Show black labels describing actions (default: true)" },
        showProgressBar: { type: "boolean", description: "Show orange progress bar at bottom (default: true)" },
        showWatermark: { type: "boolean", description: "Show watermark (default: true)" },
        quality: { type: "number", description: "GIF compression quality, 1-30 (lower = better quality, slower encoding). Default: 10" },
      },
      additionalProperties: true,
    },
    tabId: { type: "number", description: "One of your tab IDs (identifies your workspace)" },
  },
  { required: ["action", "tabId"], timeout: 120000 }
);

tool(
  "read_console_messages",
  "Read browser console messages (console.log, console.error, console.warn, etc.) from a specific tab. Useful for debugging JavaScript errors, viewing application logs, or understanding what's happening in the browser console. Returns console messages from the current domain only. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs. IMPORTANT: Always provide a pattern to filter messages - without a pattern, you may get too many irrelevant messages.",
  {
    pattern: { type: "string", description: "Regex pattern to filter console messages. Only messages matching this pattern will be returned (e.g., 'error|warning' to find errors and warnings, 'MyApp' to filter app-specific logs). You should always provide a pattern to avoid getting too many irrelevant messages." },
    onlyErrors: { type: "boolean", description: "If true, only return error and exception messages. Default is false (return all message types)." },
    limit: { type: "number", description: "Maximum number of messages to return. Defaults to 100. Increase only if you need more results." },
    clear: { type: "boolean", description: "If true, clear the console messages after reading to avoid duplicates on subsequent calls. Default is false." },
    ...tabIdReq("to read console messages from"),
  },
  { required: ["tabId", "pattern"], method: "read_console" }
);

tool(
  "read_network_requests",
  "Read HTTP network requests (XHR, Fetch, documents, images, etc.) from a specific tab. Useful for debugging API calls, monitoring network activity, or understanding what requests a page is making. Returns all network requests made by the current page, including cross-origin requests. Requests are automatically cleared when the page navigates to a different domain. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
  {
    urlPattern: { type: "string", description: "Optional URL pattern to filter requests. Only requests whose URL contains this string will be returned (e.g., '/api/' to filter API calls, 'example.com' to filter by domain)." },
    limit: { type: "number", description: "Maximum number of requests to return. Defaults to 100. Increase only if you need more results." },
    clear: { type: "boolean", description: "If true, clear the network requests after reading to avoid duplicates on subsequent calls. Default is false." },
    ...tabIdReq("to read network requests from"),
  },
  { required: ["tabId"], method: "read_network" }
);

tool(
  "resize_window",
  "Resize the real browser window your tabs live in. NOTE: that is normally the user's own window, so they will see it change size. Prefer set_viewport, which emulates a viewport size for responsive testing without touching the window; use this only when a real window resize is genuinely required.",
  {
    width: { type: "number", description: "Target window width in pixels" },
    height: { type: "number", description: "Target window height in pixels" },
    ...tabIdReq("to get the window for"),
  },
  { required: ["width", "height", "tabId"] }
);

tool(
  "list_connected_browsers",
  "List all Chrome browsers (extension instances) currently connected to this bridge. Returns each browser's deviceId, signed-in profile email (when available), display name, OS platform, and connection info. Use this before select_browser to present choices to the user — quote the email, since that is how the user recognizes a profile.",
  {},
  { method: "hub:list_browsers", threadless: true }
);

tool(
  "select_browser",
  "Select, for YOUR thread only, which Chrome browser (profile) to drive — by deviceId, without broadcasting a pairing request. Use this after list_connected_browsers when the user has chosen one from the list. When more than one browser is connected, nothing is selected by default and page tools fail until you call this: the bridge will not guess which of the user's profiles to drive.",
  { deviceId: { type: "string", description: "The deviceId from list_connected_browsers." } },
  { required: ["deviceId"], method: "hub:select_browser" }
);

tool(
  "switch_browser",
  "Send a connection request to every Chrome browser with the extension installed and wait (up to 2 minutes) for the user to click 'Connect' in the one they want to use (extension icon → Connect). Use this when the user wants to pick the browser themselves from inside Chrome rather than choosing from a list; otherwise prefer select_browser with a known deviceId. Auto-selects immediately when only one browser is connected. The choice applies to YOUR thread only.",
  {},
  { method: "hub:switch_browser", timeout: 130000 }
);

tool(
  "shortcuts_list",
  "List all available shortcuts and workflows (shortcuts and workflows are interchangeable). Returns shortcuts with their commands, descriptions, and whether they are workflows. Use shortcuts_execute to run a shortcut or workflow. Shortcuts are stored in the extension (chrome.storage.local 'shortcuts'); see the README for the format.",
  { ...tabIdReq("to list shortcuts from") },
  { required: ["tabId"] }
);

tool(
  "shortcuts_execute",
  "Execute a shortcut or workflow by running its steps on the given tab (shortcuts and workflows are interchangeable). Use shortcuts_list first to see available shortcuts. This starts the execution and returns immediately - it does not wait for completion.",
  {
    shortcutId: { type: "string", description: "The ID of the shortcut to execute" },
    command: { type: "string", description: "The command name of the shortcut to execute (e.g., 'debug', 'summarize'). Do not include the leading slash." },
    ...tabIdReq("to execute the shortcut on"),
  },
  { required: ["tabId"] }
);

// ═══════════════════════════════════════════════════════════════════
// CHROME-AGENT EXTENSIONS — durable tab groups & power tools
// ═══════════════════════════════════════════════════════════════════

tool(
  "get_status",
  "Health check: is the Chrome extension connected, and which browser is selected for your thread. Call this first if other tools fail. With more than one profile connected and nothing selected yet, this returns the candidate browsers (with their signed-in emails) instead of guessing — you must then call select_browser.",
  {},
  { method: "status", threadless: true }
);

tool(
  "delete_my_tabs",
  "Clean up completely: permanently DELETE your thread's browser workspace — every tab you opened, plus the tab group itself. Call this when you are finished with the browser. This is a true delete, not a close: Chrome auto-saves closed tab groups, so merely closing your tabs would leave a saved group behind in the user's bookmarks bar and sync it to their account. Nothing is recoverable afterwards; a later call simply starts a fresh workspace. Abandoned workspaces are also deleted automatically after 24h without activity.",
  {}
);

tool(
  "new_tab",
  "Open a new BACKGROUND tab in your thread's workspace. It is never activated and never steals focus, so the user keeps looking at whatever tab they were on — but it does live in their current window, inside your own tab group.",
  {
    url: { type: "string", description: "URL to open (https:// assumed if no scheme). Default: about:blank." },
  },
  { timeout: 45000 }
);

tool(
  "list_tabs",
  "List the tabs in your thread's workspace (same as tabs_context_mcp).",
  {},
  { method: "tabs_context" }
);

tool(
  "close_tab",
  "Close ONE of your own tabs by ID. The tab must be in your thread's workspace. To discard the whole workspace when you are done, use delete_my_tabs.",
  { tabId: { type: "number" } },
  { required: ["tabId"] }
);

tool(
  "bring_to_foreground",
  "EXCEPTION CASE: activate one of your tabs and focus its Chrome window, interrupting the user. Only use when the user explicitly asked to see the page (e.g. to log in or solve a CAPTCHA themselves).",
  { ...tabIdOpt }
);

tool(
  "screenshot",
  "Screenshot the tab WITHOUT bringing it to the foreground (works on background tabs). Default: visible viewport, sized in CSS pixels so coordinates on the image map 1:1 to `computer` coordinates. Options: fullPage:true for the whole page (capped at 8000px tall), or ref/selector for a single element. The result metadata includes an imageId usable with upload_image.",
  {
    ...tabIdOpt,
    fullPage: { type: "boolean" },
    ...refProp,
    ...selectorProp,
    format: { type: "string", enum: ["jpeg", "png"], description: "Default jpeg." },
    quality: { type: "number", description: "JPEG quality 1-100 (default 85)." },
  },
  { timeout: 45000 }
);

tool(
  "set_viewport",
  "Emulate a viewport size on the tab (responsive testing) without resizing any real window (resize_window resizes the real window). Pass clear:true to remove the override.",
  {
    ...tabIdOpt,
    width: { type: "number" },
    height: { type: "number" },
    deviceScaleFactor: { type: "number", description: "Default 1." },
    mobile: { type: "boolean", description: "Emulate mobile (touch, viewport meta). Default false." },
    clear: { type: "boolean" },
  }
);

tool(
  "click",
  "Click an element (by ref from read_page/find, or CSS selector). Scrolls it into view, then dispatches a TRUSTED click at its center via the debugger — indistinguishable from a real user click. Supports button (incl. middle), clickCount, and modifier keys.",
  {
    ...refProp,
    ...selectorProp,
    button: { type: "string", enum: ["left", "right", "middle"], description: "Default left." },
    clickCount: { type: "number", description: "1=single (default), 2=double, 3=triple." },
    modifiers: { type: "array", items: { type: "string" }, description: "Held modifier keys, e.g. ['shift'] or ['cmd']." },
    ...tabIdOpt,
  }
);

tool(
  "fill",
  "Enter text into an input/textarea/contenteditable. Default method 'fast' sets the value directly (with proper input/change events — works with React/Vue). method 'keys' clicks the field and types every character with trusted key events (use for editors, autocomplete fields, or pages that need real keystrokes). pressEnter:true presses Enter afterwards.",
  {
    ...refProp,
    ...selectorProp,
    text: { type: "string" },
    method: { type: "string", enum: ["fast", "keys"], description: "Default fast." },
    mode: { type: "string", enum: ["replace", "append"], description: "Default replace." },
    pressEnter: { type: "boolean" },
    ...tabIdOpt,
  },
  { required: ["text"] }
);

tool(
  "drag_and_drop",
  "Drag and drop. method 'pointer' (default) presses the mouse at the source, moves in steps, releases at the target — for sliders, canvases, sortable lists. method 'html5' synthesizes dragstart/dragover/drop DataTransfer events — for HTML5 draggable elements. from/to each take {ref} | {selector} | {coordinate:[x,y]}.",
  {
    from: { type: "object", description: "{ref} or {selector} or {coordinate:[x,y]}" },
    to: { type: "object", description: "{ref} or {selector} or {coordinate:[x,y]}" },
    method: { type: "string", enum: ["pointer", "html5"] },
    steps: { type: "number", description: "Pointer path granularity (default 12)." },
    ...tabIdOpt,
  },
  { required: ["from", "to"] }
);

tool(
  "wait_for",
  "Wait until a condition holds: text appears, a selector exists, a selector disappears (selectorGone), or a JS expression is truthy. Polls every 250ms up to timeoutMs (default 10000, max 60000).",
  {
    text: { type: "string" },
    selector: { type: "string" },
    selectorGone: { type: "string" },
    js: { type: "string", description: "JS expression evaluated in the page." },
    timeoutMs: { type: "number" },
    ...tabIdOpt,
  },
  { timeout: 70000 }
);

tool(
  "get_response_body",
  "Fetch the response body for a requestId from read_network_requests (while the tab is still attached).",
  { requestId: { type: "string" }, ...tabIdOpt },
  { required: ["requestId"] }
);

tool(
  "reload_extension",
  "Reload the Chrome Agent Bridge extension itself (applies extension code updates without touching Chrome's UI). The bridge reconnects automatically within a few seconds.",
  {},
  { method: "reload_self", threadless: true }
);

export const TOOLS = T;
