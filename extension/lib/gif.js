// gif_creator: frame recording + overlay compositing (extension side).
//
// While recording is on for a tab group, dispatch calls recordAction() after
// every page-affecting action: we grab a small JPEG frame via the existing
// CDP screenshot path and remember the action annotation. On export we
// composite overlays (click circles, drag arrows, action labels, progress
// bar, watermark) onto each frame with OffscreenCanvas and hand PNG frames
// to the server, which does the actual GIF encoding.

import { screenshot } from "./screenshot.js";

const MAX_FRAMES = 150;
const FRAME_QUALITY = 55;

// chromeGroupId -> { recording, frames: [{data, ts, annotation}], startedAt }
const recordings = new Map();

async function groupOfTab(tabId) {
  const t = await chrome.tabs.get(tabId).catch(() => null);
  if (!t) throw new Error(`Tab ${tabId} does not exist.`);
  if (t.groupId == null || t.groupId === -1) {
    throw new Error("gif_creator operations need a tab that belongs to a tab group.");
  }
  return t.groupId;
}

export async function gifCreator(params) {
  const { action, tabId } = params;
  const gid = await groupOfTab(tabId);
  const rec = recordings.get(gid);

  switch (action) {
    case "start_recording": {
      // a new recording always starts FRESH — leftover frames from an earlier
      // recording in the same group (possibly another session's) are dropped
      recordings.set(gid, { recording: true, frames: [], startedAt: Date.now() });
      await chrome.storage.session.set({ ["gifRec_" + gid]: Date.now() }).catch?.(() => {});
      // capture an initial frame so the GIF starts from the current state
      await captureFrame(gid, tabId, { type: "start", label: "recording started" }).catch(() => {});
      return { recording: true, frames: recordings.get(gid).frames.length, note: "Recording. Frames are captured automatically after each browser action in this tab group." };
    }
    case "stop_recording": {
      if (!rec) {
        const flag = await chrome.storage.session.get("gifRec_" + gid);
        if (flag["gifRec_" + gid]) {
          await chrome.storage.session.remove("gifRec_" + gid);
          return { recording: false, frames: 0, note: "The extension's service worker restarted during recording — the captured frames were lost. Start a new recording." };
        }
        return { recording: false, frames: 0, note: "Nothing was recorded." };
      }
      await chrome.storage.session.remove("gifRec_" + gid);
      await captureFrame(gid, tabId, { type: "stop", label: "recording stopped" }).catch(() => {});
      rec.recording = false;
      return { recording: false, frames: rec.frames.length };
    }
    case "clear": {
      recordings.delete(gid);
      await chrome.storage.session.remove("gifRec_" + gid);
      return { cleared: true };
    }
    case "export_frames": {
      if (!rec || !rec.frames.length) return { frames: [], delays: [] };
      return await composite(rec, params.options || {});
    }
    default:
      throw new Error(`unknown gif action: ${action}`);
  }
}

// Called from dispatch after each successful page action.
export async function recordAction(tabId, annotation) {
  try {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t || t.groupId == null || t.groupId === -1) return;
    let rec = recordings.get(t.groupId);
    if (!rec) {
      // SW may have restarted mid-recording: the flag survives in
      // storage.session, so resume capturing (earlier frames are lost)
      const flag = await chrome.storage.session.get("gifRec_" + t.groupId);
      if (!flag["gifRec_" + t.groupId]) return;
      rec = { recording: true, frames: [], startedAt: flag["gifRec_" + t.groupId], resumed: true };
      recordings.set(t.groupId, rec);
    }
    if (!rec.recording) return;
    await captureFrame(t.groupId, tabId, annotation);
  } catch (_) {
    // recording must never break the action itself
  }
}

async function captureFrame(gid, tabId, annotation) {
  const rec = recordings.get(gid);
  if (!rec) return;
  const shot = await screenshot(tabId, { format: "jpeg", quality: FRAME_QUALITY });
  rec.frames.push({
    data: shot.data,
    ts: Date.now(),
    width: shot.viewportWidth,
    height: shot.viewportHeight,
    annotation: annotation || null,
  });
  if (rec.frames.length > MAX_FRAMES) rec.frames.splice(0, rec.frames.length - MAX_FRAMES);
}

// ---------- overlay compositing ----------

async function composite(rec, options) {
  const {
    showClickIndicators = true,
    showDragPaths = true,
    showActionLabels = true,
    showProgressBar = true,
    showWatermark = true,
  } = options;

  const frames = [];
  const delays = [];
  const n = rec.frames.length;
  let canvas = null;
  let ctx = null;

  for (let i = 0; i < n; i++) {
    const f = rec.frames[i];
    const bytes = Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
    if (!canvas) {
      canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      ctx = canvas.getContext("2d");
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();

    const a = f.annotation;
    const sx = canvas.width / (f.width || canvas.width);
    const sy = canvas.height / (f.height || canvas.height);

    if (a && showClickIndicators && a.coordinate && /click/.test(a.type || "")) {
      const [x, y] = a.coordinate;
      ctx.beginPath();
      ctx.arc(x * sx, y * sy, 18, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(255,140,0,0.95)";
      ctx.lineWidth = 4;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x * sx, y * sy, 5, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,140,0,0.9)";
      ctx.fill();
    }

    if (a && showDragPaths && a.from && a.to) {
      const [x1, y1] = a.from;
      const [x2, y2] = a.to;
      ctx.beginPath();
      ctx.moveTo(x1 * sx, y1 * sy);
      ctx.lineTo(x2 * sx, y2 * sy);
      ctx.strokeStyle = "rgba(220,40,40,0.9)";
      ctx.lineWidth = 4;
      ctx.stroke();
      const angle = Math.atan2(y2 - y1, x2 - x1);
      ctx.beginPath();
      ctx.moveTo(x2 * sx, y2 * sy);
      ctx.lineTo(x2 * sx - 14 * Math.cos(angle - 0.4), y2 * sy - 14 * Math.sin(angle - 0.4));
      ctx.lineTo(x2 * sx - 14 * Math.cos(angle + 0.4), y2 * sy - 14 * Math.sin(angle + 0.4));
      ctx.closePath();
      ctx.fillStyle = "rgba(220,40,40,0.9)";
      ctx.fill();
    }

    if (a && showActionLabels && a.label) {
      ctx.font = "600 15px system-ui, sans-serif";
      const label = String(a.label).slice(0, 80);
      const w = ctx.measureText(label).width + 16;
      ctx.fillStyle = "rgba(0,0,0,0.75)";
      ctx.fillRect(10, 10, w, 28);
      ctx.fillStyle = "#fff";
      ctx.fillText(label, 18, 29);
    }

    if (showProgressBar && n > 1) {
      ctx.fillStyle = "rgba(255,140,0,0.9)";
      ctx.fillRect(0, canvas.height - 5, (canvas.width * (i + 1)) / n, 5);
    }

    if (showWatermark) {
      ctx.font = "600 12px system-ui, sans-serif";
      const wm = "chrome-agent";
      const w = ctx.measureText(wm).width;
      ctx.fillStyle = "rgba(0,0,0,0.45)";
      ctx.fillRect(canvas.width - w - 18, canvas.height - 26, w + 12, 18);
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.fillText(wm, canvas.width - w - 12, canvas.height - 12);
    }

    const blob = await canvas.convertToBlob({ type: "image/png" });
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = "";
    const CHUNK = 0x8000;
    for (let o = 0; o < buf.length; o += CHUNK) {
      bin += String.fromCharCode.apply(null, buf.subarray(o, o + CHUNK));
    }
    frames.push(btoa(bin));

    const next = rec.frames[i + 1];
    delays.push(next ? Math.min(Math.max(next.ts - f.ts, 300), 2000) : 1200);
  }

  return { frames, delays, width: canvas?.width || 0, height: canvas?.height || 0 };
}
