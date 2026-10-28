// Shared loopback hub/relay transport. Device routing never substitutes a lost pin.
import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { BridgeError, SAFETY_CAPABILITIES, cancelled, checkCancelled, failureMetadata, normalizeProfileEmail, profileMatches, uncertain } from "./safety.mjs";

export const DEFAULT_PORT = 47120;
const MAX_PINS = 200;
const log = (message) => process.stderr.write(`[chrome-agent] ${message}\n`);
const scopeKey = (params) => {
  if (params.threadTitle != null && typeof params.threadTitle !== "string") throw new BridgeError("INVALID_THREAD", "threadTitle must be a string.");
  return params.threadTitle ?? null;
};

export function describeBrowser(info) {
  return `${info.email || info.name || "unknown profile"} — deviceId ${info.deviceId}`;
}

function pause(ms, signals) {
  return new Promise((resolve, reject) => {
    const listeners = [];
    const finish = (error) => {
      clearTimeout(timer);
      for (const [signal, listener] of listeners) signal.removeEventListener("abort", listener);
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => finish(), ms);
    for (const signal of signals.filter(Boolean)) {
      const listener = () => finish(cancelled(signal));
      listeners.push([signal, listener]);
      signal.addEventListener("abort", listener, { once: true });
      if (signal.aborted) { listener(); break; }
    }
  });
}

export class Bridge {
  constructor(port = DEFAULT_PORT) {
    this.port = port;
    this.mode = "starting";
    this.browsers = new Map();
    this.relaySocket = null;
    this.pending = new Map();
    this.pairWaiters = new Set();
    this.localPins = new Map();
    this.sockets = new Set();
    this.lifecycle = new AbortController();
    this.closed = false;
    this.stopping = null;
  }

  start() {
    this.starting ??= this.#tryBecomeHub();
    return this.starting;
  }

  stop() {
    if (this.stopping) return this.stopping;
    let finish;
    this.stopping = new Promise((resolve) => { finish = resolve; });
    this.closed = true;
    this.lifecycle.abort();
    clearTimeout(this.reconnectTimer);
    clearInterval(this.pingTimer);
    for (const pending of [...this.pending.values()]) {
      pending.reject(pending.sent && pending.browserCommand
        ? uncertain("BRIDGE_CLOSED", "The bridge stopped while awaiting a browser command.", pending.detail)
        : new BridgeError("BRIDGE_CLOSED", "The bridge is shutting down.", pending.detail));
    }
    for (const waiter of [...this.pairWaiters]) waiter.reject(new BridgeError("BRIDGE_CLOSED", "The bridge is shutting down."));
    const sockets = new Set([...this.sockets, ...[this.relaySocket].filter(Boolean)]);
    const closed = [...sockets].map((socket) => new Promise((resolve) => {
      if (socket.readyState === WebSocket.CLOSED) { resolve(); return; }
      socket.once("close", resolve);
      socket.terminate();
    }));
    const serverClosed = new Promise((resolve) => {
      if (!this.wss) { resolve(); return; }
      this.wss.close(() => resolve());
    });
    void Promise.all([...closed, serverClosed]).then(() => {
      this.browsers.clear();
      this.sockets.clear();
      finish();
    });
    return this.stopping;
  }

  #tryBecomeHub() {
    if (this.closed || this.mode === "hub") return Promise.resolve();
    return new Promise((resolve) => {
      const wss = new WebSocketServer({ host: "127.0.0.1", port: this.port });
      this.wss = wss;
      wss.once("close", resolve);
      wss.once("listening", () => {
        this.wss = wss;
        this.port = wss.address().port;
        this.mode = "hub";
        this.#wireHub(wss);
        log(`hub listening on ws://127.0.0.1:${this.port}`);
        if (this.closed) wss.close();
        resolve();
      });
      wss.once("error", (error) => {
        log(error.code === "EADDRINUSE" ? `port ${this.port} taken — running as relay` : `hub error: ${error.message}`);
        if (this.closed) { resolve(); return; }
        this.#connectRelay().then(resolve);
      });
    });
  }

  #wireHub(wss) {
    wss.on("connection", (socket, request) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
      const path = (request.url || "/").split("?")[0];
      if (path === "/ext" && (request.headers.origin || "").startsWith("chrome-extension://")) this.#wireExtension(socket);
      else if (path === "/relay" && request.headers["x-cab-relay"] === "1") this.#wireRelayClient(socket);
      else socket.close(4003, "permitted bridge origin and path required");
    });
    this.pingTimer = setInterval(() => {
      for (const { sock } of this.browsers.values()) {
        if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ method: "ping" }), () => {});
      }
    }, 20000);
    this.pingTimer.unref?.();
  }

  #wireExtension(socket) {
    let deviceId = null;
    socket.on("message", (data) => {
      let message;
      try { message = JSON.parse(data.toString()); } catch { return; }
      if (!message || typeof message !== "object" || Array.isArray(message)) return;
      if (message.event === "hello") {
        const id = message.instanceId ?? deviceId ?? `legacy-${randomUUID().slice(0, 8)}`;
        if (typeof id !== "string" || !id || (deviceId && deviceId !== id)) {
          socket.close(4002, "browser identity cannot change on a connection");
          return;
        }
        deviceId = id;
        const previous = this.browsers.get(id);
        if (previous && previous.sock !== socket) previous.sock.close(4000, "replaced by same browser connection");
        this.browsers.set(id, {
          sock: socket,
          connectedAt: previous?.connectedAt ?? Date.now(),
          info: {
            deviceId: id,
            name: typeof message.name === "string" ? message.name : typeof message.email === "string" ? message.email : `Chrome (${id.slice(0, 8)})`,
            ...(typeof message.email === "string" && message.email ? { email: message.email } : {}),
            platform: typeof message.platform === "string" ? message.platform : "unknown",
            extensionVersion: typeof message.version === "string" ? message.version : "unknown",
          },
        });
        log(`browser connected: ${id}`);
        return;
      }
      if (message.event === "pair") {
        const entry = deviceId && this.browsers.get(deviceId);
        if (entry?.sock === socket) {
          for (const waiter of [...this.pairWaiters]) {
            if (waiter.devices.has(deviceId) && profileMatches(entry.info, waiter.profileEmail)) waiter.resolve(entry.info);
          }
        }
        return;
      }
      if (message.method === "pong" || message.event) return;
      const pending = this.pending.get(message.id);
      if (!pending || pending.sock !== socket) return;
      if (message.ok) pending.resolve(message.result);
      else pending.reject(uncertain("EXTENSION_ERROR", message.error || "The extension returned an error.", pending.detail));
    });
    socket.on("close", () => {
      if (deviceId && this.browsers.get(deviceId)?.sock === socket) this.browsers.delete(deviceId);
      for (const pending of [...this.pending.values()]) {
        if (pending.sock === socket) pending.reject(uncertain("BROWSER_DISCONNECTED", "The selected browser disconnected mid-call.", pending.detail));
      }
    });
    socket.on("error", () => {});
  }

  #wireRelayClient(socket) {
    const chosen = new Map();
    const active = new Map();
    socket.on("message", async (data) => {
      let message;
      try { message = JSON.parse(data.toString()); } catch { return; }
      if (!message || typeof message !== "object" || Array.isArray(message)) return;
      if (typeof message.cancel === "string") {
        active.get(message.cancel)?.abort();
        return;
      }
      if (!message.id || typeof message.method !== "string") return;
      if (active.has(message.id)) return;
      const control = new AbortController();
      active.set(message.id, control);
      try {
        const profileEmail = normalizeProfileEmail(message.profileEmail);
        const deviceId = this.#authorizeRelayDevice(message, chosen, profileEmail);
        const result = await this.call(message.method, message.params || {}, message.timeoutMs, deviceId, {
          signal: control.signal, profileEmail, pins: chosen,
        });
        if (message.method === "hub:select_browser" || message.method === "hub:switch_browser") {
          checkCancelled(control.signal);
          this.#rememberPin(chosen, scopeKey(message.params || {}), result.selected.deviceId);
        }
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ id: message.id, ok: true, result }));
      } catch (error) {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({
          id: message.id, ok: false, error: String(error.message || error), failure: failureMetadata(error),
        }));
      } finally { active.delete(message.id); }
    });
    socket.on("close", () => { for (const control of active.values()) control.abort(); });
    socket.on("error", () => {});
  }

  #rememberPin(pins, key, deviceId) {
    if (!pins.has(key) && pins.size >= MAX_PINS) throw new BridgeError("PIN_LIMIT", "Browser selection capacity reached; existing pins are retained.");
    pins.set(key, deviceId);
  }

  #authorizeRelayDevice(message, chosen, profileEmail) {
    if (message.method.startsWith("hub:")) return message.deviceId;
    const key = scopeKey(message.params || {});
    const selected = chosen.get(key);
    if (selected && message.deviceId && selected !== message.deviceId) {
      throw new BridgeError("PROFILE_PIN_CONFLICT", "This thread has a different pinned browser. Use explicit select_browser to change it.", { deviceId: selected });
    }
    if (selected) return selected;
    const open = this.#openBrowsers(profileEmail);
    // Old relays may guess by connection order. Only a sole candidate or a hub selection establishes a pin.
    if (message.deviceId && open.length > 1) throw this.#ambiguous(open);
    const target = message.deviceId || (open.length === 1 ? open[0].info.deviceId : null);
    if (target) this.#rememberPin(chosen, key, target);
    return target;
  }

  #connectRelay() {
    this.mode = "relay";
    return new Promise((resolve) => {
      let settled = false;
      const socket = new WebSocket(`ws://127.0.0.1:${this.port}/relay`, { headers: { "x-cab-relay": "1" } });
      this.relaySocket = socket;
      const settle = () => { if (!settled) { settled = true; resolve(); } };
      socket.on("open", () => {
        if (this.closed) socket.terminate();
        else log("connected to hub as relay");
        settle();
      });
      socket.on("message", (data) => {
        let message;
        try { message = JSON.parse(data.toString()); } catch { return; }
      if (!message || typeof message !== "object" || Array.isArray(message)) return;
        const pending = this.pending.get(message.id);
        if (!pending || pending.sock !== socket) return;
        if (message.ok) pending.resolve(message.result);
        else {
          const detail = message.failure;
          const text = String(message.error || "Browser hub returned an error").replace(/\s*[—-]\s*retry the call\.?/gi, "");
          pending.reject(detail?.code && (detail.outcome === "unknown" || detail.outcome === "not-dispatched")
            ? new BridgeError(detail.code, text, detail)
            : pending.browserCommand ? uncertain("HUB_ERROR", text, pending.detail) : new BridgeError("HUB_ERROR", text, pending.detail));
        }
      });
      let gone = false;
      const onGone = () => {
        if (gone) return;
        gone = true;
        if (this.relaySocket === socket) this.relaySocket = null;
        for (const pending of [...this.pending.values()]) {
          if (pending.sock === socket) pending.reject(pending.browserCommand
            ? uncertain("HUB_DISCONNECTED", "The browser hub connection was lost.", pending.detail)
            : new BridgeError("HUB_DISCONNECTED", "The browser hub connection was lost.", pending.detail));
        }
        settle();
        if (!this.closed) this.reconnectTimer = setTimeout(() => this.#tryBecomeHub(), 250 + Math.random() * 500);
      };
      socket.on("close", onGone);
      socket.on("error", onGone);
    });
  }

  #openBrowsers(profileEmail = null) {
    return [...this.browsers.values()].filter(entry => entry.sock.readyState === WebSocket.OPEN && profileMatches(entry.info, profileEmail));
  }

  #ambiguous(open) {
    return new BridgeError("PROFILE_SELECTION_REQUIRED",
      `${open.length} Chrome profiles are eligible and none is selected — refusing to guess.\n` +
      open.map(entry => `  • ${describeBrowser(entry.info)}`).join("\n") +
      "\nAsk the user which profile to use, then call select_browser with its deviceId.");
  }

  #pickBrowser(deviceId, profileEmail) {
    if (deviceId) {
      const entry = this.browsers.get(deviceId);
      if (!entry || entry.sock.readyState !== WebSocket.OPEN) {
        throw new BridgeError("PROFILE_UNAVAILABLE", `Pinned browser ${deviceId} is not connected. Its selection was retained; reconnect it or explicitly select another permitted browser.`, { deviceId });
      }
      if (!profileMatches(entry.info, profileEmail)) {
        throw new BridgeError("PROFILE_MISMATCH", "The selected browser does not match CHROME_AGENT_PROFILE_EMAIL; no browser command was dispatched.", { deviceId });
      }
      return entry;
    }
    const open = this.#openBrowsers(profileEmail);
    if (!open.length) throw new BridgeError("PROFILE_UNAVAILABLE", profileEmail
      ? "No connected browser matches CHROME_AGENT_PROFILE_EMAIL. Other profiles will not be used."
      : "Chrome extension is not connected. Reconnect the intended browser before issuing new work.");
    if (open.length > 1) throw this.#ambiguous(open);
    return open[0];
  }

  async #hubControl(operation, params, signal, profileEmail) {
    checkCancelled(signal);
    switch (operation) {
      case "safety": return { safety: SAFETY_CAPABILITIES, relayCancellation: true };
      case "list_browsers": return {
        browsers: this.#openBrowsers().map(browser => ({ ...browser.info, connectedAt: browser.connectedAt, thisComputer: true })),
      };
      case "select_browser": {
        if (typeof params.deviceId !== "string" || !params.deviceId) throw new BridgeError("INVALID_SELECTION", "select_browser requires an exact deviceId.");
        return { selected: this.#pickBrowser(params.deviceId, profileEmail).info };
      }
      case "switch_browser": {
        const open = this.#openBrowsers(profileEmail);
        if (!open.length) throw new BridgeError("PROFILE_UNAVAILABLE", "No permitted browser is connected.");
        if (open.length === 1) return { selected: open[0].info, note: "Only one permitted browser connected — selected automatically." };
        return new Promise((resolve, reject) => {
          const cleanup = () => { clearTimeout(timer); this.pairWaiters.delete(waiter); signal?.removeEventListener("abort", abort); };
          const waiter = {
            devices: new Set(open.map(entry => entry.info.deviceId)), profileEmail,
            resolve: info => { cleanup(); resolve({ selected: info }); },
            reject: error => { cleanup(); reject(error); },
          };
          const abort = () => waiter.reject(cancelled(signal, { method: "hub:switch_browser" }));
          const timer = setTimeout(() => waiter.reject(new BridgeError("PAIR_TIMEOUT", "No permitted browser confirmed within 2 minutes.")), 120000);
          this.pairWaiters.add(waiter);
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) { abort(); return; }
          for (const entry of open) entry.sock.send(JSON.stringify({ method: "pair_request", params: {} }), () => {});
        });
      }
      default: throw new BridgeError("UNKNOWN_HUB_OPERATION", `Unknown hub control operation: ${operation}`);
    }
  }

  async #awaitConnection(waitMs, signal) {
    const until = Date.now() + waitMs;
    while (!this.connected && !this.closed && Date.now() < until) {
      checkCancelled(signal);
      await pause(Math.min(200, Math.max(1, until - Date.now())), [signal, this.lifecycle.signal]);
    }
    checkCancelled(signal);
    if (this.closed) throw new BridgeError("BRIDGE_CLOSED", "The bridge is shutting down.");
  }

  async call(method, params = {}, timeoutMs = 30000, deviceId = null, options = {}) {
    const { signal, onDispatch } = options;
    const profileEmail = normalizeProfileEmail(options.profileEmail);
    checkCancelled(signal, { method, deviceId });
    if (this.closed) throw new BridgeError("BRIDGE_CLOSED", "The bridge is shutting down.");
    if (method.startsWith("hub:")) {
      if (this.mode !== "hub" && !this.connected) await this.#awaitConnection(5000, signal);
      if (this.mode !== "hub") {
        if (profileEmail && (method === "hub:select_browser" || method === "hub:switch_browser")) {
          const listed = await this.#callViaRelay("hub:list_browsers", {}, 10000, null, { signal, profileEmail });
          const eligible = (listed?.browsers || []).filter(info => profileMatches(info, profileEmail));
          const candidate = method === "hub:select_browser" ? eligible.find(info => info.deviceId === params.deviceId)
            : eligible.length === 1 ? eligible[0] : null;
          if (!candidate) throw new BridgeError("PROFILE_SELECTION_REQUIRED", "Choose an exact connected device matching CHROME_AGENT_PROFILE_EMAIL. No pairing request was broadcast to other profiles.");
          const selected = await this.#callViaRelay("hub:select_browser", { ...params, deviceId: candidate.deviceId }, timeoutMs, candidate.deviceId, { signal, profileEmail });
          if (selected?.selected?.deviceId !== candidate.deviceId || !profileMatches(selected.selected, profileEmail)) {
            throw new BridgeError("PROFILE_MISMATCH", "The hub did not confirm the required device and profile.");
          }
          return selected;
        }
        return this.#callViaRelay(method, params, timeoutMs, deviceId, { signal, profileEmail });
      }
      const result = await this.#hubControl(method.slice(4), params, signal, profileEmail);
      checkCancelled(signal, { method, deviceId });
      if (!options.pins && result?.selected?.deviceId) this.#rememberPin(this.localPins, scopeKey(params), result.selected.deviceId);
      return result;
    }
    if (!this.connected) await this.#awaitConnection(15000, signal);
    checkCancelled(signal, { method, deviceId });
    if (this.mode === "hub") {
      const pins = options.pins || this.localPins;
      const key = scopeKey(params);
      const selected = pins.get(key);
      if (selected && deviceId && selected !== deviceId) throw new BridgeError("PROFILE_PIN_CONFLICT", "Explicit selection is required to change this thread's browser.", { deviceId: selected });
      const entry = this.#pickBrowser(selected || deviceId, profileEmail);
      this.#rememberPin(pins, key, entry.info.deviceId);
      return this.#send(entry.sock, method, params, timeoutMs, entry.info.deviceId, { signal, onDispatch });
    }
    if (!deviceId) throw new BridgeError("PROFILE_SELECTION_REQUIRED", "Select an exact deviceId before dispatching through a relay.");
    // Existing hubs support this acknowledgment and exact device routing. A missing or
    // mismatched acknowledgment is not permission to fall back to another browser.
    const selected = await this.#callViaRelay("hub:select_browser", { threadTitle: params.threadTitle, deviceId }, 10000, deviceId, { signal, profileEmail });
    if (selected?.selected?.deviceId !== deviceId || !profileMatches(selected.selected, profileEmail)) {
      throw new BridgeError("PROFILE_MISMATCH", "The hub did not confirm the pinned device and required profile. Upgrade or inspect the hub; no browser command was sent.", { deviceId });
    }
    checkCancelled(signal, { method, deviceId });
    return this.#callViaRelay(method, params, timeoutMs, deviceId, { signal, profileEmail, onDispatch });
  }

  #send(socket, method, params, timeoutMs, deviceId, { signal, onDispatch, relay = false, profileEmail } = {}) {
    return new Promise((resolve, reject) => {
      checkCancelled(signal, { method, deviceId });
      if (socket?.readyState !== WebSocket.OPEN) {
        reject(new BridgeError("BRIDGE_DISCONNECTED", "The selected bridge connection is not open.", { method, deviceId }));
        return;
      }
      const id = randomUUID();
      const browserCommand = !method.startsWith("hub:");
      const detail = { method, ...(deviceId ? { deviceId } : {}) };
      const cleanup = () => { this.pending.delete(id); clearTimeout(timer); signal?.removeEventListener("abort", abort); };
      const pending = {
        sock: socket, sent: false, browserCommand, detail,
        resolve: value => { cleanup(); resolve(value); },
        reject: error => { cleanup(); reject(error); },
      };
      const abort = () => {
        if (relay && pending.sent && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ cancel: id }), () => {});
        pending.reject(cancelled(signal, { ...detail, outcome: pending.sent && browserCommand ? "unknown" : "not-dispatched" }));
      };
      const timer = setTimeout(() => {
        if (relay && pending.sent && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ cancel: id }), () => {});
        pending.reject(browserCommand ? uncertain("BRIDGE_TIMEOUT", `Timed out waiting for ${method}.`, detail)
          : new BridgeError("BRIDGE_TIMEOUT", `Timed out waiting for ${method}.`, detail));
      }, timeoutMs);
      this.pending.set(id, pending);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      try {
        if (browserCommand) onDispatch?.();
        pending.sent = true;
        const message = relay ? { id, method, params, timeoutMs: Math.max(1, timeoutMs - 18000), deviceId, profileEmail } : { id, method, params };
        socket.send(JSON.stringify(message), (error) => {
          if (error && this.pending.get(id) === pending) pending.reject(browserCommand
            ? uncertain("BRIDGE_SEND_FAILED", "The bridge could not confirm delivery.", { ...detail, cause: error })
            : new BridgeError("BRIDGE_SEND_FAILED", "The bridge could not confirm delivery.", { ...detail, cause: error }));
        });
      } catch (error) {
        pending.reject(pending.sent && browserCommand ? uncertain("BRIDGE_SEND_FAILED", "The bridge could not confirm delivery.", { ...detail, cause: error }) : error);
      }
    });
  }

  #callViaRelay(method, params, timeoutMs, deviceId, options) {
    return this.#send(this.relaySocket, method, params, timeoutMs + 18000, deviceId, { ...options, relay: true });
  }

  get connected() {
    return this.mode === "hub" ? this.#openBrowsers().length > 0 : this.relaySocket?.readyState === WebSocket.OPEN;
  }
}
