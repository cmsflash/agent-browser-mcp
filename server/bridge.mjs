// WebSocket bridge between MCP server processes and Chrome extension(s).
//
// Every Claude Cowork / Claude Code thread spawns its own MCP server process
// (stdio). The first process to bind 127.0.0.1:47120 becomes the HUB; later
// processes detect the port is taken and become RELAYS that proxy their
// commands through the hub. If the hub process exits, the extensions and the
// relays both reconnect, and one relay wins the race to become the new hub.
//
// v1.1.0: the hub accepts MULTIPLE extension connections (different Chrome
// profiles/channels each run their own copy of the extension). Each extension
// identifies itself with a persistent instanceId ("deviceId") in its hello
// message; sessions route calls to a selected browser (default: the most
// recently connected). list/select/switch_browser are "hub:*" control ops.

import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";

export const DEFAULT_PORT = 47120;

const log = (m) => process.stderr.write(`[chrome-agent] ${m}\n`);

export class Bridge {
  constructor(port = DEFAULT_PORT) {
    this.port = port;
    this.mode = "starting"; // "hub" | "relay"
    this.browsers = new Map(); // hub mode: deviceId -> {sock, info, connectedAt}
    this.relaySocket = null;   // relay mode: socket to the hub
    this.pending = new Map();  // id -> {resolve, reject, timer}
    this.pairWaiters = [];     // hub mode: switch_browser resolvers
    this.closed = false;
  }

  async start() {
    await this.#tryBecomeHub();
  }

  async stop() {
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("bridge shutting down"));
    }
    this.pending.clear();
    try { this.wss?.close(); } catch {}
    try { this.relaySocket?.close(); } catch {}
    for (const { sock } of this.browsers.values()) {
      try { sock.close(); } catch {}
    }
    this.browsers.clear();
  }

  // ---------- hub mode ----------

  #tryBecomeHub() {
    // Never re-elect while closed or already the hub (a duplicate close/error
    // event could otherwise make a live hub connect to ITSELF as a relay).
    if (this.closed || this.mode === "hub") return Promise.resolve();
    return new Promise((resolve) => {
      const wss = new WebSocketServer({ host: "127.0.0.1", port: this.port });
      wss.once("listening", () => {
        this.wss = wss;
        this.mode = "hub";
        log(`hub listening on ws://127.0.0.1:${this.port}`);
        this.#wireHub(wss);
        resolve();
      });
      wss.once("error", (e) => {
        if (e.code !== "EADDRINUSE") log(`hub error: ${e.message} — running as relay`);
        else log(`port ${this.port} taken — running as relay`);
        this.#connectRelay().then(resolve);
      });
    });
  }

  #wireHub(wss) {
    wss.on("connection", (sock, req) => {
      const path = (req.url || "/").split("?")[0];
      const origin = req.headers.origin || "";
      if (path === "/ext") {
        // Only the Chrome extension may register as a browser: web pages can
        // open ws://127.0.0.1 but cannot fake a chrome-extension:// origin.
        if (!origin.startsWith("chrome-extension://")) {
          log(`rejected /ext connection with origin "${origin}"`);
          sock.close(4003, "extension origin required");
          return;
        }
        this.#wireExtension(sock);
      } else if (path === "/relay") {
        // Browsers cannot set arbitrary headers on WebSocket handshakes, so
        // requiring one shuts out random web pages.
        if (req.headers["x-cab-relay"] !== "1") {
          sock.close(4003, "relay header required");
          return;
        }
        this.#wireRelayClient(sock);
      } else {
        sock.close(4004, "unknown path");
      }
    });

    // keep the extensions' MV3 service workers alive while connected
    this.pingTimer = setInterval(() => {
      for (const { sock } of this.browsers.values()) {
        try {
          if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ method: "ping" }));
        } catch {}
      }
    }, 20000);
    this.pingTimer.unref?.();
  }

  #wireExtension(sock) {
    // The socket is registered once its hello (with instanceId) arrives.
    // Legacy extensions (< 1.1.0) send hello without an instanceId — they get
    // a per-connection id so they still work.
    let deviceId = null;
    sock.on("message", (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.event === "hello") {
        deviceId = msg.instanceId || `legacy-${randomUUID().slice(0, 8)}`;
        const prev = this.browsers.get(deviceId);
        if (prev && prev.sock !== sock) {
          try { prev.sock.close(4000, "replaced by new connection from same browser"); } catch {}
        }
        this.browsers.set(deviceId, {
          sock,
          connectedAt: Date.now(),
          info: {
            deviceId,
            name: msg.name || `Chrome (${deviceId.slice(0, 8)})`,
            platform: msg.platform || "unknown",
            extensionVersion: msg.version || "unknown",
          },
        });
        log(`browser connected: ${deviceId} (v${msg.version || "?"})`);
        return;
      }
      if (msg.event === "pair") {
        // user clicked Connect in this browser's popup/notification
        const entry = deviceId && this.browsers.get(deviceId);
        if (entry) {
          for (const w of this.pairWaiters.splice(0)) w.resolve(entry.info);
        }
        return;
      }
      if (msg.method === "pong" || msg.event) return;
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(msg.error || "extension error"));
      }
    });
    sock.on("close", () => {
      if (deviceId && this.browsers.get(deviceId)?.sock === sock) {
        this.browsers.delete(deviceId);
        log(`browser disconnected: ${deviceId}`);
      }
      // fail fast instead of letting in-flight calls run out their timers
      for (const [id, p] of [...this.pending]) {
        if (p.sock === sock) {
          this.pending.delete(id);
          clearTimeout(p.timer);
          p.reject(new Error("browser disconnected mid-call (extension reloaded or Chrome closed) — retry the call"));
        }
      }
    });
    sock.on("error", () => {});
  }

  #wireRelayClient(sock) {
    log("relay client connected");
    sock.on("message", async (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (!msg.id || !msg.method) return;
      try {
        const result = await this.call(msg.method, msg.params || {}, msg.timeoutMs, msg.deviceId);
        if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ id: msg.id, ok: true, result }));
      } catch (e) {
        if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ id: msg.id, ok: false, error: String(e.message || e) }));
      }
    });
    sock.on("close", () => {});
    sock.on("error", () => {});
  }

  // ---------- relay mode ----------

  #connectRelay() {
    this.mode = "relay";
    return new Promise((resolve) => {
      let settled = false;
      const sock = new WebSocket(`ws://127.0.0.1:${this.port}/relay`, {
        headers: { "x-cab-relay": "1" },
      });
      const settle = () => { if (!settled) { settled = true; resolve(); } };
      sock.on("open", () => {
        this.relaySocket = sock;
        log("connected to hub as relay");
        settle();
      });
      sock.on("message", (data) => {
        let msg;
        try { msg = JSON.parse(data.toString()); } catch { return; }
        if (msg.id && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.ok) p.resolve(msg.result);
          else p.reject(new Error(msg.error || "hub error"));
        }
      });
      let gone = false;
      const onGone = () => {
        if (gone) return; // 'error' + 'close' both fire — run once
        gone = true;
        if (this.relaySocket === sock) this.relaySocket = null;
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error("hub connection lost — retry the call"));
        }
        this.pending.clear();
        settle();
        if (!this.closed) {
          // the hub may have died with its session — try to take over
          setTimeout(() => this.#tryBecomeHub(), 250 + Math.random() * 500);
        }
      };
      sock.on("close", onGone);
      sock.on("error", onGone);
    });
  }

  // ---------- browser selection helpers (hub mode) ----------

  #pickBrowser(deviceId) {
    if (deviceId) {
      const entry = this.browsers.get(deviceId);
      if (!entry || entry.sock.readyState !== WebSocket.OPEN) {
        throw new Error(`Browser ${deviceId} is not connected. Use list_connected_browsers to see current ones.`);
      }
      return entry;
    }
    // default: most recently connected
    let best = null;
    for (const entry of this.browsers.values()) {
      if (entry.sock.readyState !== WebSocket.OPEN) continue;
      if (!best || entry.connectedAt > best.connectedAt) best = entry;
    }
    if (!best) {
      throw new Error(
        "Chrome extension is not connected. Make sure Chrome is running and the 'Chrome Agent Bridge' extension is loaded and enabled (chrome://extensions). Click the extension icon → Reconnect if needed."
      );
    }
    return best;
  }

  async #hubControl(op, params) {
    switch (op) {
      case "list_browsers":
        return {
          browsers: [...this.browsers.values()]
            .filter((b) => b.sock.readyState === WebSocket.OPEN)
            .map((b) => ({ ...b.info, connectedAt: b.connectedAt, thisComputer: true })),
        };
      case "select_browser": {
        const entry = this.browsers.get(params.deviceId);
        if (!entry || entry.sock.readyState !== WebSocket.OPEN) {
          throw new Error(`Browser ${params.deviceId} is not connected. Use list_connected_browsers first.`);
        }
        return { selected: entry.info };
      }
      case "switch_browser": {
        const open = [...this.browsers.values()].filter((b) => b.sock.readyState === WebSocket.OPEN);
        if (open.length === 0) throw new Error("No browsers connected.");
        if (open.length === 1) return { selected: open[0].info, note: "Only one browser connected — selected automatically." };
        // broadcast pairing request; first browser whose user clicks Connect wins
        for (const b of open) {
          try { b.sock.send(JSON.stringify({ method: "pair_request", params: {} })); } catch {}
        }
        const info = await new Promise((resolve, reject) => {
          const waiter = { resolve: (info) => { clearTimeout(timer); resolve(info); } };
          const timer = setTimeout(() => {
            const i = this.pairWaiters.indexOf(waiter);
            if (i >= 0) this.pairWaiters.splice(i, 1);
            reject(new Error("No browser confirmed within 2 minutes. Ask the user to click the extension icon → Connect in the browser they want."));
          }, 120000);
          this.pairWaiters.push(waiter);
        });
        return { selected: info };
      }
      default:
        throw new Error(`unknown hub control op: ${op}`);
    }
  }

  // ---------- unified call API ----------

  // Extensions reconnect with backoff (capped ~3s), so a call issued right
  // after this process becomes hub — i.e. the first tool call of a session —
  // would otherwise fail spuriously. Wait for the link before giving up.
  async #awaitConnection(waitMs = 15000) {
    if (this.connected) return true;
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline && !this.closed) {
      await new Promise((r) => setTimeout(r, 200));
      if (this.connected) return true;
    }
    return this.connected;
  }

  async call(method, params = {}, timeoutMs = 30000, deviceId = null) {
    if (method.startsWith("hub:")) {
      if (this.mode === "hub") return this.#hubControl(method.slice(4), params);
      // relay transport may be mid-re-election — give it the same grace
      if (!this.relaySocket || this.relaySocket.readyState !== 1) await this.#awaitConnection(5000);
      if (this.mode === "hub") return this.#hubControl(method.slice(4), params); // won the election meanwhile
      return this.#callViaRelay(method, params, timeoutMs, deviceId);
    }
    if (!this.connected) await this.#awaitConnection();
    if (this.mode === "hub") return this.#callExtension(method, params, timeoutMs, deviceId);
    return this.#callViaRelay(method, params, timeoutMs, deviceId);
  }

  #callExtension(method, params, timeoutMs, deviceId) {
    return new Promise((resolve, reject) => {
      let entry;
      try {
        entry = this.#pickBrowser(deviceId);
      } catch (e) {
        reject(e);
        return;
      }
      const id = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timed out after ${timeoutMs}ms waiting for the browser extension (method: ${method})`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, sock: entry.sock });
      try {
        entry.sock.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  #callViaRelay(method, params, timeoutMs, deviceId) {
    return new Promise((resolve, reject) => {
      if (!this.relaySocket || this.relaySocket.readyState !== WebSocket.OPEN) {
        reject(new Error("Not connected to the browser hub — is Chrome running with the 'Chrome Agent Bridge' extension enabled?"));
        return;
      }
      const id = randomUUID();
      // hub adds its own extension timeout PLUS up to 15s of link-wait —
      // budget for both so the hub's answer isn't dropped as a relay timeout
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timed out after ${timeoutMs + 18000}ms waiting via hub (method: ${method})`));
      }, timeoutMs + 18000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.relaySocket.send(JSON.stringify({ id, method, params, timeoutMs, deviceId }));
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  get connected() {
    if (this.mode === "hub") {
      for (const { sock } of this.browsers.values()) {
        if (sock.readyState === WebSocket.OPEN) return true;
      }
      return false;
    }
    return this.relaySocket?.readyState === WebSocket.OPEN;
  }
}
