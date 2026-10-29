// Only trusted process configuration chooses the caller prefix; titles are display suffixes.
import { createHash } from "node:crypto";

export function normalizeRemoteContextId(value) {
  if (value == null) return null;
  if (typeof value !== "string" || !value.trim()) throw new Error("CHROME_AGENT_REMOTE_CONTEXT_ID must be a non-empty opaque identity when configured.");
  return value;
}

export function remoteContextHash(contextId) {
  return createHash("sha256").update(contextId).digest("hex").slice(0, 32);
}

export function namespaceThreadTitle(contextId, title) {
  const prefix = `ctx-${remoteContextHash(contextId)}-`;
  const label = title?.trim().toLowerCase() || "global";
  let suffix = "";
  for (const point of label) {
    if (prefix.length + suffix.length + point.length > 60) break;
    suffix += point;
  }
  return prefix + suffix;
}
