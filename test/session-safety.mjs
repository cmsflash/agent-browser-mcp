// Pure tool-session and in-memory MCP tests. No browser, hub port, cookies, or real downloads.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { createToolSession } from "../server/session.mjs";
import { createMcpServer } from "../server/index.mjs";
import { BridgeError, cancelled, checkCancelled, profileMatches } from "../server/safety.mjs";
import { namespaceThreadTitle, remoteContextHash } from "../server/namespace.mjs";

const require = createRequire(new URL("../server/package.json", import.meta.url));
const { Client } = await import(pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/index.js")));
const { InMemoryTransport } = await import(pathToFileURL(require.resolve("@modelcontextprotocol/sdk/inMemory.js")));
const WORK = "work@example.test";
const OTHER = "other@example.test";
const controller = () => new AbortController();
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function text(result) { return result.content.filter(block => block.type === "text").map(block => block.text).join("\n"); }
function json(result) { return JSON.parse(text(result)); }

class FakeBridge {
  mode = "hub";
  browsers = new Map([["a", { deviceId: "a", email: WORK }], ["b", { deviceId: "b", email: OTHER }]]);
  calls = [];
  controls = [];
  shortcuts = [];
  handler = null;
  async call(method, params = {}, timeout, deviceId, options = {}) {
    checkCancelled(options.signal, { method, deviceId });
    if (method.startsWith("hub:")) {
      this.controls.push({ method, params });
      if (method === "hub:list_browsers") return { browsers: [...this.browsers.values()] };
      const selected = method === "hub:select_browser" ? this.browsers.get(params.deviceId)
        : [...this.browsers.values()].find(info => profileMatches(info, options.profileEmail));
      if (!selected) throw new BridgeError("PROFILE_UNAVAILABLE", "Selected browser is not connected.");
      if (!profileMatches(selected, options.profileEmail)) throw new BridgeError("PROFILE_MISMATCH", "Configured profile mismatch.");
      return { selected };
    }
    const browser = this.browsers.get(deviceId);
    if (!browser) throw new BridgeError("PROFILE_UNAVAILABLE", "Selected browser is not connected.", { deviceId });
    if (!profileMatches(browser, options.profileEmail)) throw new BridgeError("PROFILE_MISMATCH", "Configured profile mismatch.", { deviceId });
    options.onDispatch?.();
    const call = { method, params, deviceId, signal: options.signal };
    this.calls.push(call);
    if (this.handler) return this.handler(call);
    if (method === "status") return { connected: true, browser: deviceId };
    if (method === "tabs_context") return { tabs: [{ tabId: 1 }] };
    if (method === "new_tab" || method === "tabs_create") return { tabId: 42 };
    if (method === "shortcuts_list") return { shortcuts: this.shortcuts };
    return { method, deviceId, tabId: params.tabId };
  }
}

async function select(session, deviceId = "a", threadTitle = "task") {
  const result = await session.execute("select_browser", { deviceId, threadTitle });
  assert.equal(result.isError, undefined, text(result));
}

test("a missing selected browser never repins or retries on the remaining profile", async () => {
  const bridge = new FakeBridge();
  const session = createToolSession(bridge);
  await select(session);
  bridge.browsers.delete("a");
  const result = await session.execute("click", { threadTitle: "task", tabId: 1 });
  assert.equal(result.isError, true);
  assert.equal(result._meta["chrome-agent/error"].outcome, "not-dispatched");
  assert.equal(bridge.calls.length, 0);
  const status = json(await session.execute("get_status", { threadTitle: "task" }));
  assert.equal(status.session.selectedBrowser, "a");
  assert.equal(status.ready, false);
  assert.equal(status.safety.stickyDevicePin, true);
  await select(session, "b");
  assert.equal((await session.execute("click", { threadTitle: "task", tabId: 1 })).isError, undefined);
  assert.equal(bridge.calls[0].deviceId, "b");
});

test("exact configured profile is required for automatic and explicit selection", async () => {
  const bridge = new FakeBridge();
  const session = createToolSession(bridge, { profileEmail: " WORK@EXAMPLE.TEST " });
  await session.execute("click", { threadTitle: "task", tabId: 1 });
  assert.equal(bridge.calls[0].deviceId, "a");
  assert.equal((await session.execute("select_browser", { threadTitle: "task", deviceId: "b" })).isError, true);
  bridge.browsers.delete("a");
  assert.equal((await session.execute("click", { threadTitle: "another", tabId: 1 })).isError, true);
  assert.equal(bridge.calls.length, 1);
  assert.throws(() => createToolSession(bridge, { profileEmail: "" }), /non-empty/);
});

test("single-browser auto-adoption remains pinned and saturation never evicts older pins", async () => {
  const bridge = new FakeBridge();
  bridge.browsers.delete("b");
  const session = createToolSession(bridge);
  await session.execute("click", { threadTitle: "first", tabId: 1 });
  for (let index = 1; index < 200; index++) await select(session, "a", `thread-${index}`);
  const overflow = await session.execute("select_browser", { threadTitle: "overflow", deviceId: "a" });
  assert.equal(overflow._meta["chrome-agent/error"].code, "PIN_LIMIT");
  bridge.browsers.delete("a");
  bridge.browsers.set("b", { deviceId: "b", email: OTHER });
  const count = bridge.calls.length;
  assert.equal((await session.execute("click", { threadTitle: "first", tabId: 1 })).isError, true);
  assert.equal(bridge.calls.length, count);
});

test("cancellation stops later batch actions and reports uncertain dispatched effects", async () => {
  const bridge = new FakeBridge();
  const session = createToolSession(bridge, { profileEmail: WORK });
  const stop = controller();
  bridge.handler = async () => { stop.abort(new Error("stop after first action")); return { applied: true }; };
  const result = await session.execute("browser_batch", {
    threadTitle: "task",
    actions: [{ name: "click", input: { tabId: 1 } }, { name: "click", input: { tabId: 2 } }],
  }, stop.signal);
  assert.equal(bridge.calls.length, 1);
  assert.equal(result.isError, true);
  assert.equal(result._meta["chrome-agent/error"].code, "CANCELLED");
  assert.equal(result._meta["chrome-agent/error"].outcome, "unknown");
  assert.match(text(result), /Batch stopped/);
});

test("a concurrent explicit profile switch cannot retarget the rest of an older batch", async () => {
  const bridge = new FakeBridge();
  const session = createToolSession(bridge);
  await select(session);
  const started = deferred();
  const release = deferred();
  bridge.handler = async () => { started.resolve(); await release.promise; return { applied: true }; };
  const pending = session.execute("browser_batch", {
    threadTitle: "task", actions: [{ name: "click", input: { tabId: 1 } }, { name: "click", input: { tabId: 2 } }],
  });
  await started.promise;
  await select(session, "b");
  release.resolve();
  const result = await pending;
  assert.equal(result._meta["chrome-agent/error"].code, "PROFILE_PIN_CONFLICT");
  assert.equal(bridge.calls.length, 1);
  assert.equal(bridge.calls[0].deviceId, "a");
});

test("switching profiles clears stale implicit tab state", async () => {
  const bridge = new FakeBridge();
  const session = createToolSession(bridge);
  await select(session);
  await session.execute("new_tab", { threadTitle: "task" });
  await select(session, "b");
  await session.execute("navigate", { threadTitle: "task", url: "https://example.test/" });
  const navigation = bridge.calls.find(call => call.method === "navigate");
  assert.equal(navigation.deviceId, "b");
  assert.equal(navigation.params.tabId, 1);
});

test("trusted caller identity owns explicit, nested, inherited, and global title keys", async () => {
  const bridge = new FakeBridge();
  const contextId = "authenticated-peer-and-caller";
  const session = createToolSession(bridge, { profileEmail: WORK, remoteContextId: contextId });
  const inputs = { threadTitle: "Report", actions: [
    { name: "click", input: { tabId: 1, threadTitle: "Explicit" } },
    { name: "click", input: { tabId: 2 } },
  ] };
  const before = structuredClone(inputs);
  await session.execute("browser_batch", inputs);
  assert.deepEqual(bridge.calls.map(call => call.params.threadTitle), [namespaceThreadTitle(contextId, "Explicit"), namespaceThreadTitle(contextId, "Report")]);
  assert.deepEqual(inputs, before);
  const status = json(await session.execute("get_status"));
  assert.equal(bridge.calls.at(-1).params.threadTitle, namespaceThreadTitle(contextId));
  assert.equal(status.safety.remoteContextHash, remoteContextHash(contextId));
  assert.equal(status.safety.callerNamespace, 1);
  const spoof = namespaceThreadTitle("other-caller", "stolen");
  await session.execute("click", { threadTitle: spoof, tabId: 1, DSH_REMOTE_CONTEXT_ID: "other-caller", trustedTitle: true });
  assert.equal(bridge.calls.at(-1).params.threadTitle, namespaceThreadTitle(contextId, spoof));
  assert.throws(() => createToolSession(bridge, { remoteContextId: " " }), /non-empty/);
});

test("namespace prefixes survive truncation and never split supplementary characters", () => {
  const first = namespaceThreadTitle("first-context", "😀".repeat(100));
  const second = namespaceThreadTitle("second-context", "😀".repeat(100));
  assert.ok(first.length <= 60);
  assert.match(first, /^dsh-[a-f0-9]{32}-/);
  assert.notEqual(first, second);
  assert.equal(first.includes("\ufffd"), false);
  assert.equal(namespaceThreadTitle("first-context", " Mixed Case "), namespaceThreadTitle("first-context", "mixed case"));
});

test("local titles stay unchanged without the trusted environment namespace", async () => {
  const bridge = new FakeBridge();
  const session = createToolSession(bridge, { profileEmail: WORK });
  await session.execute("click", { threadTitle: "Local Title", tabId: 1 });
  assert.equal(bridge.calls[0].params.threadTitle, "Local Title");
  const invalid = await session.execute("click", { threadTitle: { title: "object" }, tabId: 1 });
  assert.equal(invalid.isError, true);
  assert.equal(bridge.calls.length, 1);
});

test("shortcut acknowledgment stays submission-only and namespaces nested stored steps", async () => {
  const bridge = new FakeBridge();
  const session = createToolSession(bridge, { profileEmail: WORK, remoteContextId: "caller" });
  bridge.shortcuts = [{ id: "nested", command: "nested", steps: [{ name: "browser_batch", input: { actions: [
    { name: "click", input: { tabId: "$TAB", threadTitle: "Nested" } },
  ] } }] }];
  const started = deferred();
  const release = deferred();
  bridge.handler = async call => {
    if (call.method === "shortcuts_list") return { shortcuts: bridge.shortcuts };
    started.resolve(call);
    await release.promise;
    return { applied: true };
  };
  const result = await session.execute("shortcuts_execute", { threadTitle: "Outer", tabId: 7, shortcutId: "nested" });
  assert.equal(json(result).submissionOnly, true);
  assert.equal(result._meta["chrome-agent/submission"].cancellableAfterReturn, false);
  const step = await started.promise;
  assert.equal(step.params.threadTitle, namespaceThreadTitle("caller", "Nested"));
  assert.equal(step.params.tabId, 7);
  release.resolve();
});

test("a submitted shortcut retains its active parent request cancellation signal", async () => {
  const bridge = new FakeBridge();
  const session = createToolSession(bridge, { profileEmail: WORK, remoteContextId: "shortcut-signal" });
  const childEntered = deferred();
  const parentEntered = deferred();
  const childAborted = deferred();
  const stop = controller();
  bridge.shortcuts = [{ id: "held", command: "held", steps: [
    { name: "click", input: { tabId: 1 } }, { name: "click", input: { tabId: 2 } },
  ] }];
  bridge.handler = call => {
    if (call.method === "shortcuts_list") return { shortcuts: bridge.shortcuts };
    assert.equal(call.signal, stop.signal);
    if (call.method === "click") childEntered.resolve();
    else if (call.method === "wait_for") parentEntered.resolve();
    return new Promise((resolve, reject) => {
      call.signal.addEventListener("abort", () => {
        if (call.method === "click") childAborted.resolve();
        reject(cancelled(call.signal, { outcome: "unknown" }));
      }, { once: true });
    });
  };
  const pending = session.execute("browser_batch", {
    threadTitle: "task", actions: [
      { name: "shortcuts_execute", input: { shortcutId: "held", tabId: 1 } },
      { name: "wait_for", input: { tabId: 1, js: "true" } },
    ],
  }, stop.signal);
  await Promise.all([childEntered.promise, parentEntered.promise]);
  stop.abort(new Error("cancel the still-active parent batch"));
  const result = await pending;
  await childAborted.promise;
  assert.equal(result.isError, true);
  assert.equal(result._meta["chrome-agent/error"].code, "CANCELLED");
  assert.equal(bridge.calls.filter(call => call.method === "click").length, 1);
});

test("MCP request cancellation reaches the active bridge wait and advertises honest capabilities", async t => {
  const bridge = new FakeBridge();
  const entered = deferred();
  const aborted = deferred();
  bridge.handler = call => new Promise((resolve, reject) => {
    entered.resolve(call);
    call.signal.addEventListener("abort", () => { aborted.resolve(); reject(cancelled(call.signal, { outcome: "unknown" })); }, { once: true });
  });
  const server = createMcpServer(bridge, { profileEmail: WORK, remoteContextId: "trusted-context" });
  const client = new Client({ name: "test-client", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await Promise.all([server.connect(left), client.connect(right)]);
  const capability = client.getServerCapabilities().experimental["chrome-agent/safety"];
  assert.equal(capability.stickyDevicePin, true);
  assert.equal(capability.requiredProfileEmail, WORK);
  assert.equal(capability.remoteContextHash, remoteContextHash("trusted-context"));
  assert.equal(capability.extensionAbort, false);
  const stop = controller();
  const pending = client.callTool({ name: "click", arguments: { threadTitle: "task", tabId: 1 } }, undefined, { signal: stop.signal });
  const rejected = assert.rejects(pending);
  await entered.promise;
  stop.abort(new Error("cancel MCP request"));
  await rejected;
  await aborted.promise;
  assert.equal(bridge.calls.length, 1);
});
