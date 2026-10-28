// Loopback-only fake extension/relay fixtures. Port zero never targets the live Chrome hub.
import test from "node:test";
import assert from "node:assert/strict";
import { once, EventEmitter, getEventListeners } from "node:events";
import { createRequire } from "node:module";
import { Bridge, DEFAULT_PORT } from "../server/bridge.mjs";
import { createToolSession } from "../server/session.mjs";
import { namespaceThreadTitle } from "../server/namespace.mjs";

const require = createRequire(new URL("../server/package.json", import.meta.url));
const { WebSocket, WebSocketServer } = require("ws");
const WORK = "work@example.test";
const OTHER = "other@example.test";
const HOLD = Symbol("hold fake response");
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function failure(result) { return result._meta?.["chrome-agent/error"]; }
function json(result) { return JSON.parse(result.content.filter(block => block.type === "text").map(block => block.text).join("\n")); }

async function harness(t) {
  const bridges = [];
  const sockets = [];
  const hub = new Bridge(0);
  bridges.push(hub);
  t.after(async () => {
    for (const bridge of bridges.reverse()) await bridge.stop();
    for (const socket of sockets) if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
  });
  await hub.start();
  assert.notEqual(hub.port, DEFAULT_PORT, "fixtures must never bind the production hub port");
  return {
    hub,
    async relay() { const relay = new Bridge(hub.port); bridges.push(relay); await relay.start(); return relay; },
    async browser(deviceId, email, handler = message => ({ browser: deviceId, method: message.method })) {
      const accepted = once(hub.wss, "connection");
      const socket = new WebSocket(`ws://127.0.0.1:${hub.port}/ext`, { headers: { Origin: "chrome-extension://fixture" } });
      sockets.push(socket);
      socket.on("error", () => {});
      const calls = [];
      const events = new EventEmitter();
      socket.on("message", data => {
        const message = JSON.parse(data.toString());
        if (message.method === "ping") { socket.send(JSON.stringify({ method: "pong" })); return; }
        calls.push(message);
        events.emit("command", message);
        if (!message.id) return;
        const result = handler(message);
        if (result !== HOLD) socket.send(JSON.stringify({ id: message.id, ok: true, result }));
      });
      await once(socket, "open");
      const [serverSocket] = await accepted;
      const hello = once(serverSocket, "message");
      socket.send(JSON.stringify({ event: "hello", instanceId: deviceId, email, version: "test" }));
      await hello;
      assert.equal(hub.browsers.get(deviceId)?.sock, serverSocket);
      return {
        socket, serverSocket, calls,
        next(method) {
          const found = calls.find(message => message.method === method);
          if (found) return Promise.resolve(found);
          return new Promise(resolve => {
            const listener = message => { if (message.method === method) { events.off("command", listener); resolve(message); } };
            events.on("command", listener);
          });
        },
        async disconnect() { const closed = once(serverSocket, "close"); socket.close(); await closed; },
        async send(message) { const received = once(serverSocket, "message"); socket.send(JSON.stringify(message)); await received; },
      };
    },
    async rawRelay() {
      const socket = new WebSocket(`ws://127.0.0.1:${hub.port}/relay`, { headers: { "x-cab-relay": "1" } });
      sockets.push(socket);
      socket.on("error", () => {});
      await once(socket, "open");
      let ordinal = 0;
      return {
        socket,
        request(method, params, deviceId) {
          const id = `request-${++ordinal}`;
          const response = new Promise(resolve => {
            const listener = data => {
              const message = JSON.parse(data.toString());
              if (message.id === id) { socket.off("message", listener); resolve(message); }
            };
            socket.on("message", listener);
          });
          socket.send(JSON.stringify({ id, method, params, deviceId, timeoutMs: 5000 }));
          return { id, response };
        },
      };
    },
  };
}

test("selected device loss is not retried on another profile through a real relay", async t => {
  const owned = await harness(t);
  const a = await owned.browser("a", WORK);
  const b = await owned.browser("b", OTHER);
  const relay = await owned.relay();
  const session = createToolSession(relay, { profileEmail: WORK });
  assert.equal((await session.execute("select_browser", { threadTitle: "task", deviceId: "a" })).isError, undefined);
  await a.disconnect();
  const result = await session.execute("click", { threadTitle: "task", tabId: 1 });
  assert.equal(result.isError, true);
  assert.equal(b.calls.length, 0);
  const status = json(await session.execute("get_status", { threadTitle: "task" }));
  assert.equal(status.session.selectedBrowser, "a");
  assert.equal(status.ready, false);
});

test("updated hub refuses an old relay's automatic retarget after a lost selection", async t => {
  const owned = await harness(t);
  const a = await owned.browser("a", WORK);
  const relay = await owned.rawRelay();
  assert.equal((await relay.request("click", { threadTitle: "legacy", tabId: 1 }, "a").response).ok, true);
  const b = await owned.browser("b", OTHER);
  await a.disconnect();
  assert.equal((await relay.request("click", { threadTitle: "legacy", tabId: 1 }, "a").response).ok, false);
  const fallback = await relay.request("click", { threadTitle: "legacy", tabId: 1 }, "b").response;
  assert.equal(fallback.failure.code, "PROFILE_PIN_CONFLICT");
  assert.equal(b.calls.length, 0);
  assert.equal((await relay.request("hub:select_browser", { threadTitle: "legacy", deviceId: "b" }).response).ok, true);
  assert.equal((await relay.request("click", { threadTitle: "legacy", tabId: 1 }, "b").response).ok, true);
});

test("same-batch profile switch cannot retarget a submitted shortcut", { timeout: 10000 }, async t => {
  const owned = await harness(t);
  const contextId = "shortcut-race-caller";
  const title = namespaceThreadTitle(contextId, "task");
  const shortcut = { id: "held", command: "held", steps: [
    { name: "click", input: { tabId: 1 } },
    { name: "click", input: { tabId: 2 } },
  ] };
  const a = await owned.browser("a", WORK, message => message.method === "shortcuts_list" ? { shortcuts: [shortcut] } : HOLD);
  const b = await owned.browser("b", WORK);
  const session = createToolSession(owned.hub, { profileEmail: WORK, remoteContextId: contextId });
  assert.equal((await session.execute("select_browser", { threadTitle: "task", deviceId: "a" })).isError, undefined);
  const stopped = deferred();
  const originalWrite = process.stderr.write;
  process.stderr.write = function (chunk, ...args) {
    if (String(chunk).startsWith("[chrome-agent] shortcut step 2 stopped:")) stopped.resolve(String(chunk));
    return Reflect.apply(originalWrite, this, [chunk, ...args]);
  };
  t.after(() => { process.stderr.write = originalWrite; });
  const batch = session.execute("browser_batch", {
    threadTitle: "task",
    actions: [
      { name: "shortcuts_execute", input: { tabId: 1, shortcutId: "held" } },
      { name: "wait_for", input: { tabId: 1, js: "true" } },
      { name: "select_browser", input: { deviceId: "b" } },
    ],
  });
  const first = await a.next("click");
  const barrier = await a.next("wait_for");
  assert.equal(first.params.threadTitle, title);
  assert.equal(barrier.params.threadTitle, title);
  // Keep the shortcut's first action pending while the same parent batch commits B.
  await a.send({ id: barrier.id, ok: true, result: { matched: true } });
  assert.equal((await batch).isError, undefined);
  assert.equal(owned.hub.localPins.get(title), "b");
  await a.send({ id: first.id, ok: true, result: { applied: true } });
  const outcome = await Promise.race([
    stopped.promise.then(message => ({ kind: "stopped", message })),
    b.next("click").then(message => ({ kind: "retargeted", message })),
  ]);
  assert.equal(outcome.kind, "stopped", "the submitted shortcut must not inherit the parent batch's replacement pin");
  assert.match(outcome.message, /browser selection changed/);
  assert.equal(b.calls.filter(message => message.method === "click").length, 0);
});

test("cancelled local selection completion leaves the original profile usable", async t => {
  const owned = await harness(t);
  const contextId = "cancelled-selection-caller";
  const title = namespaceThreadTitle(contextId, "task");
  const a = await owned.browser("a", WORK);
  const b = await owned.browser("b", WORK);
  const session = createToolSession(owned.hub, { profileEmail: WORK, remoteContextId: contextId });
  assert.equal((await session.execute("select_browser", { threadTitle: "task", deviceId: "a" })).isError, undefined);
  const controller = new AbortController();
  const selection = session.execute("select_browser", { threadTitle: "task", deviceId: "b" }, controller.signal);
  controller.abort(new Error("cancel after synchronous hub selection, before awaited commit"));
  assert.equal(failure(await selection).code, "CANCELLED");
  assert.equal(owned.hub.localPins.get(title), "a");
  const clicked = await session.execute("click", { threadTitle: "task", tabId: 1 });
  assert.equal(clicked.isError, undefined);
  assert.equal(a.calls.filter(message => message.method === "click").length, 1);
  assert.equal(a.calls.at(-1).params.threadTitle, title);
  assert.equal(b.calls.length, 0);
});

test("connection waits honor caller cancellation and release listeners", async t => {
  const { hub } = await harness(t);
  const controller = new AbortController();
  const call = hub.call("click", { threadTitle: "task" }, 5000, "a", { signal: controller.signal });
  const rejected = assert.rejects(call, error => error.code === "CANCELLED" && error.outcome === "not-dispatched");
  controller.abort();
  await rejected;
  assert.equal(hub.pending.size, 0);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("pairing waits are canceled without committing a late Connect event", async t => {
  const owned = await harness(t);
  const a = await owned.browser("a", WORK);
  await owned.browser("b", OTHER);
  const controller = new AbortController();
  const pending = owned.hub.call("hub:switch_browser", { threadTitle: "task" }, 130000, null, { signal: controller.signal });
  const rejected = assert.rejects(pending, error => error.code === "CANCELLED");
  await a.next("pair_request");
  assert.equal(owned.hub.pairWaiters.size, 1);
  controller.abort();
  await rejected;
  await a.send({ event: "pair" });
  assert.equal(owned.hub.pairWaiters.size, 0);
  assert.equal(owned.hub.localPins.size, 0);
});

test("canceling a dispatched command rejects once with unknown outcome and ignores its late reply", async t => {
  const owned = await harness(t);
  const a = await owned.browser("a", WORK, () => HOLD);
  const controller = new AbortController();
  const pending = owned.hub.call("click", { threadTitle: "task" }, 5000, "a", { signal: controller.signal });
  const rejected = assert.rejects(pending, error => error.code === "CANCELLED" && error.outcome === "unknown");
  const command = await a.next("click");
  controller.abort();
  await rejected;
  assert.equal(owned.hub.pending.size, 0);
  await a.send({ id: command.id, ok: true, result: { applied: true } });
  assert.equal(owned.hub.pending.size, 0);
  assert.equal(a.calls.filter(message => message.method === "click").length, 1);
});

test("relay cancellation prevents a not-yet-connected command from being dispatched later", async t => {
  const owned = await harness(t);
  const relay = await owned.rawRelay();
  const queued = relay.request("click", { threadTitle: "task" }, "a");
  relay.socket.send(JSON.stringify({ cancel: queued.id }));
  const answer = await queued.response;
  assert.equal(answer.failure.code, "CANCELLED");
  assert.equal(answer.failure.outcome, "not-dispatched");
  const a = await owned.browser("a", WORK);
  assert.equal(a.calls.length, 0);
});

test("only the dispatched socket may fulfill a browser request", async t => {
  const owned = await harness(t);
  const a = await owned.browser("a", WORK, () => HOLD);
  const b = await owned.browser("b", OTHER);
  const pending = owned.hub.call("click", { threadTitle: "task" }, 5000, "a");
  const command = await a.next("click");
  await b.send({ id: command.id, ok: true, result: { browser: "b" } });
  assert.equal(owned.hub.pending.has(command.id), true);
  await a.send({ id: command.id, ok: true, result: { browser: "a" } });
  assert.deepEqual(await pending, { browser: "a" });
});

test("current profile metadata is checked atomically at the selected socket dispatch", async t => {
  const owned = await harness(t);
  const a = await owned.browser("a", WORK);
  await owned.hub.call("hub:select_browser", { threadTitle: "task", deviceId: "a" }, 5000, null, { profileEmail: WORK });
  await a.send({ event: "hello", instanceId: "a", email: OTHER });
  await assert.rejects(owned.hub.call("click", { threadTitle: "task" }, 5000, "a", { profileEmail: WORK }), error => error.code === "PROFILE_MISMATCH");
  assert.equal(a.calls.length, 0);
});

async function legacy(t, { acknowledge = true, hold = false } = {}) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const port = server.address().port;
  assert.notEqual(port, DEFAULT_PORT);
  const profiles = new Map([["a", { deviceId: "a", email: WORK }], ["b", { deviceId: "b", email: OTHER }]]);
  const calls = [];
  const received = new EventEmitter();
  server.on("connection", socket => {
    socket.on("error", () => {});
    socket.on("message", data => {
      const message = JSON.parse(data.toString());
      if (!message.id || !message.method) return; // old hubs do not implement the new cancel frame
      let result;
      let error;
      if (message.method === "hub:list_browsers") result = { browsers: [...profiles.values()] };
      else if (message.method === "hub:select_browser") {
        const selected = profiles.get(message.params.deviceId);
        if (!selected) error = `Browser ${message.params.deviceId} is not connected.`;
        else result = acknowledge ? { selected } : { connected: true };
      } else {
        const selected = profiles.get(message.deviceId);
        if (!selected) error = `Browser ${message.deviceId} is not connected.`;
        else { calls.push(message); received.emit("call", message); result = { browser: message.deviceId }; }
        if (hold && !error) return;
      }
      socket.send(JSON.stringify(error ? { id: message.id, ok: false, error } : { id: message.id, ok: true, result }));
    });
  });
  const relay = new Bridge(port);
  t.after(async () => {
    await relay.stop();
    for (const socket of server.clients) socket.terminate();
    await new Promise(resolve => server.close(resolve));
  });
  await relay.start();
  return { relay, profiles, calls, received };
}

test("an unchanged compatible hub remains usable through acknowledged exact-device routing", async t => {
  const owned = await legacy(t);
  const session = createToolSession(owned.relay, { profileEmail: WORK });
  assert.equal((await session.execute("click", { threadTitle: "task", tabId: 1 })).isError, undefined);
  assert.deepEqual(owned.calls.map(call => call.deviceId), ["a"]);
  owned.profiles.delete("a");
  assert.equal((await session.execute("click", { threadTitle: "task", tabId: 1 })).isError, true);
  assert.deepEqual(owned.calls.map(call => call.deviceId), ["a"]);
});

test("a hub without exact selection acknowledgment is refused before any browser action", async t => {
  const owned = await legacy(t, { acknowledge: false });
  const session = createToolSession(owned.relay, { profileEmail: WORK });
  const result = await session.execute("click", { threadTitle: "task", tabId: 1 });
  assert.equal(result.isError, true);
  assert.equal(owned.calls.length, 0);
});

test("cancellation after forwarding to an older hub is uncertain and never replayed", async t => {
  const owned = await legacy(t, { hold: true });
  const controller = new AbortController();
  const received = once(owned.received, "call");
  const pending = owned.relay.call("click", { threadTitle: "task" }, 5000, "a", { signal: controller.signal, profileEmail: WORK });
  const rejected = assert.rejects(pending, error => error.code === "CANCELLED" && error.outcome === "unknown");
  await received;
  controller.abort();
  await rejected;
  assert.equal(owned.calls.length, 1);
  assert.equal(owned.relay.pending.size, 0);
});
