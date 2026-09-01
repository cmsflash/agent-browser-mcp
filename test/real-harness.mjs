// Shared harness for tests against the user's REAL Chrome (production port).
//
// Real-profile tests face a choice isolated ones never do: WHICH Chrome
// profile to drive. The product refuses to guess (several profiles connected
// and nothing selected is an error, not a default), and the tests must not
// guess either. Policy: one connected browser → use it. More than one →
// CAB_TEST_BROWSER (a deviceId or email substring) must name one, or the
// test fails loudly with the candidates listed.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export async function connect(name) {
  const transport = new StdioClientTransport({ command: "node", args: ["../server/index.mjs"], stderr: "ignore" });
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(transport);
  return client;
}

// threadTitle is stamped from the client object — the surface's identity
// model — so call sites never repeat it and can't drift mid-test.
export function mkCall(client, threadTitle) {
  return async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: { threadTitle, ...args } });
    const x = (r.content || []).find((y) => y.type === "text");
    const img = (r.content || []).find((y) => y.type === "image");
    let json = null;
    try { json = JSON.parse(x?.text || "null"); } catch { json = { _raw: x?.text }; }
    return { isError: !!r.isError, json, img, text: x?.text || "", content: r.content || [] };
  };
}

// Resolve which browser to drive and select it for this thread. Throws (with
// the candidates) when the choice is ambiguous and CAB_TEST_BROWSER is unset.
export async function selectTargetBrowser(call) {
  const r = await call("list_connected_browsers");
  const browsers = r.json?.browsers || [];
  if (!browsers.length) {
    throw new Error("No browsers connected. Start Chrome with the Chrome Agent Bridge extension enabled.");
  }
  let chosen = null;
  if (browsers.length === 1) {
    chosen = browsers[0];
  } else {
    const want = process.env.CAB_TEST_BROWSER;
    if (want) chosen = browsers.find((b) => b.deviceId === want || (b.email || "").includes(want)) || null;
    if (!chosen) {
      throw new Error(
        `${browsers.length} Chrome profiles are connected; real-profile tests refuse to guess which to drive.\n` +
        `  candidates: ${browsers.map((b) => `${b.email || b.name} (${b.deviceId})`).join(", ")}\n` +
        `  set CAB_TEST_BROWSER to a deviceId or email substring and re-run, e.g.:\n` +
        `    CAB_TEST_BROWSER=${browsers[0].email || browsers[0].deviceId} node ${process.argv[1]}`
      );
    }
  }
  const sel = await call("select_browser", { deviceId: chosen.deviceId });
  if (sel.isError || sel.json?.selected?.deviceId !== chosen.deviceId) {
    throw new Error("select_browser failed: " + (sel.text || "").slice(0, 200));
  }
  return chosen;
}

// Warn (not fail) when the loaded extension predates what the test expects.
export async function requireVersion(call, want) {
  const r = await call("get_status");
  const v = r.json?.extensionVersion;
  if (v !== want) {
    console.log(`\n⚠ Loaded extension is v${v}, expected v${want}.\n  Reload it: chrome://extensions → Chrome Agent Bridge → ↻\n`);
  }
  return v;
}
