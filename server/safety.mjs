// Server-side guarantees. A sent browser command is not revoked by cancellation.
export const SAFETY_CAPABILITIES = Object.freeze({
  version: 1,
  stickyDevicePin: true,
  exactProfileEmail: true,
  callerNamespace: 1,
  cancellation: "server-boundaries",
  inFlightOutcome: "unknown",
  extensionAbort: false,
  shortcuts: "submission-only",
});

export class BridgeError extends Error {
  constructor(code, message, { outcome = "not-dispatched", method, deviceId, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "BridgeError";
    this.code = code;
    this.outcome = outcome;
    if (method !== undefined) this.method = method;
    if (deviceId !== undefined) this.deviceId = deviceId;
  }
}

export function normalizeProfileEmail(value) {
  if (value == null) return null;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("CHROME_AGENT_PROFILE_EMAIL must be a non-empty exact profile email when configured.");
  }
  return value.trim().toLowerCase();
}

export function profileMatches(info, email) {
  return email == null || (typeof info.email === "string" && info.email.trim().toLowerCase() === email);
}

export function cancelled(signal, detail = {}) {
  return new BridgeError("CANCELLED", detail.outcome === "unknown"
    ? "Request cancelled after dispatch. The browser action may still finish; cancellation is not rollback. Inspect its effects before deciding whether to issue new work."
    : "Request cancelled before browser dispatch.", { ...detail, cause: signal?.reason });
}

export function checkCancelled(signal, detail) {
  if (signal?.aborted) throw cancelled(signal, detail);
}

export function uncertain(code, message, detail = {}) {
  return new BridgeError(code,
    `${message} The outcome is unknown; inspect effects before deciding whether to issue new work. Do not replay automatically.`,
    { ...detail, outcome: "unknown" });
}

export function failureMetadata(error, dispatched = false) {
  return {
    code: error?.code || "TOOL_ERROR",
    outcome: dispatched || error?.outcome === "unknown" ? "unknown" : "not-dispatched",
    ...(typeof error?.method === "string" ? { method: error.method } : {}),
    ...(typeof error?.deviceId === "string" ? { deviceId: error.deviceId } : {}),
  };
}
