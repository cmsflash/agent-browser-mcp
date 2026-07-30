// Screenshots via CDP Page.captureScreenshot — works on BACKGROUND tabs
// (no activation, no window focus), unlike chrome.tabs.captureVisibleTab.
//
// Images are scaled to CSS-pixel dimensions (scale = 1/devicePixelRatio), so
// pixel coordinates measured on a screenshot can be passed directly to the
// `computer` tool's coordinate actions.

import { cdp, ensureAttached, resumePage } from "./cdp.js";
import { locate } from "./reading.js";

const MAX_FULLPAGE_CSS_HEIGHT = 8000;

export async function screenshot(tabId, { fullPage = false, ref, selector, region, format = "jpeg", quality = 85 } = {}) {
  await ensureAttached(tabId);
  const metrics = await cdp(tabId, "Page.getLayoutMetrics");
  const vv = metrics.cssVisualViewport || {};
  const content = metrics.cssContentSize || {};
  const vw = Math.round(vv.clientWidth || 0);
  const vh = Math.round(vv.clientHeight || 0);
  const dpr = (metrics.visualViewport && vv.clientWidth)
    ? (metrics.visualViewport.clientWidth / vv.clientWidth)
    : (globalThis.devicePixelRatio || 1);
  const scale = dpr > 0 ? 1 / dpr : 1;

  // Page.captureScreenshot's clip is in PAGE-absolute CSS pixels, while
  // getBoundingClientRect (and our input coordinates) are viewport-relative —
  // translate by the current scroll offset.
  const pageX = Math.round(vv.pageX || 0);
  const pageY = Math.round(vv.pageY || 0);

  const params = {
    format,
    ...(format === "jpeg" ? { quality } : {}),
    fromSurface: true,
    captureBeyondViewport: false,
  };
  let meta = { viewportWidth: vw, viewportHeight: vh, devicePixelRatio: dpr, scrollX: pageX, scrollY: pageY };

  if (region) {
    // zoom: capture a viewport region, magnified for close inspection
    const [x0, y0, x1, y1] = region.map(Number);
    const w = Math.max(1, Math.min(x1, vw) - Math.max(x0, 0));
    const h = Math.max(1, Math.min(y1, vh) - Math.max(y0, 0));
    if (!(x1 > x0 && y1 > y0)) throw new Error("zoom region must be [x0, y0, x1, y1] with x1 > x0 and y1 > y0");
    const magnification = Math.max(1, Math.min(3, 1400 / Math.max(w, h)));
    params.clip = {
      x: pageX + Math.max(x0, 0),
      y: pageY + Math.max(y0, 0),
      width: w,
      height: h,
      scale: magnification / dpr,
    };
    meta.zoom = { region: [x0, y0, x1, y1], magnification: Math.round(magnification * 100) / 100 };
  } else if (ref || selector) {
    const loc = await locate(tabId, { ref, selector, scrollIntoView: true });
    const r = loc.rect; // viewport-relative
    // intersect with the viewport, then translate to page coordinates
    const x0 = Math.max(r.x, 0);
    const y0 = Math.max(r.y, 0);
    const x1 = Math.min(r.x + r.width, vw);
    const y1 = Math.min(r.y + r.height, vh);
    if (x1 - x0 < 1 || y1 - y0 < 1) {
      throw new Error("Element has no visible area inside the viewport — cannot screenshot it.");
    }
    params.clip = { x: pageX + x0, y: pageY + y0, width: x1 - x0, height: y1 - y0, scale };
    meta.element = { ref, selector, rect: r };
  } else if (fullPage) {
    const h = Math.min(Math.round(content.height || vh), MAX_FULLPAGE_CSS_HEIGHT);
    params.clip = { x: 0, y: 0, width: Math.round(content.width || vw), height: h, scale };
    params.captureBeyondViewport = true;
    meta.fullPage = true;
    meta.pageHeight = Math.round(content.height || vh);
    meta.capturedHeight = h;
    meta.truncated = (content.height || 0) > MAX_FULLPAGE_CSS_HEIGHT;
  } else {
    // current visual viewport, in page coordinates
    params.clip = { x: pageX, y: pageY, width: vw, height: vh, scale };
  }

  let result;
  try {
    result = await cdp(tabId, "Page.captureScreenshot", params);
  } catch (e) {
    const timedOut = /timed out/i.test(String(e.message || e));
    if (timedOut) {
      // Under heavy machine load a background tab's compositor can miss the
      // 20s budget. Nudge it awake and retry once with a longer budget before
      // failing the tool call.
      await resumePage(tabId).catch(() => {});
      result = await cdp(tabId, "Page.captureScreenshot", params, { timeoutMs: 45000 });
      meta.retriedAfterTimeout = true;
    } else if (!params.captureBeyondViewport) {
      // Fallback: some pages/GPU states reject surface capture for background
      // tabs — capture beyond viewport instead, which forces a renderer paint.
      params.captureBeyondViewport = true;
      result = await cdp(tabId, "Page.captureScreenshot", params);
      meta.fallback = "captureBeyondViewport";
    } else {
      throw e;
    }
  }

  return {
    data: result.data,
    mimeType: format === "png" ? "image/png" : "image/jpeg",
    ...meta,
  };
}

export async function setViewport(tabId, { width, height, deviceScaleFactor = 1, mobile = false, clear = false }) {
  await ensureAttached(tabId);
  if (clear) {
    await cdp(tabId, "Emulation.clearDeviceMetricsOverride");
    return { cleared: true };
  }
  if (!width || !height) throw new Error("width and height are required (or pass clear:true)");
  await cdp(tabId, "Emulation.setDeviceMetricsOverride", {
    width: Math.round(width),
    height: Math.round(height),
    deviceScaleFactor,
    mobile,
  });
  return { width, height, deviceScaleFactor, mobile };
}
