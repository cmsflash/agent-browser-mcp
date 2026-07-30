// Shared test harness: isolates automated tests from the user's real browser.
//
// The production extension always dials ws://127.0.0.1:47120. If the user has
// it loaded in their everyday Chrome, a test server binding that port would
// find the REAL extension connecting to it — and the suite would drive the
// user's actual tabs. So every test:
//   * runs its servers on a dedicated port (CHROME_AGENT_PORT), and
//   * loads a COPY of the extension whose WS_URL points at that port,
// which makes it impossible for the two to meet.

import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, globSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const root = join(here, "..");

export const TEST_PORT = Number(process.env.CHROME_AGENT_TEST_PORT || 47999);

export function findChrome() {
  const cft = globSync(
    join(here, "browsers", "chrome", "*", "chrome-mac-*", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing")
  );
  if (cft.length) return cft.sort().at(-1);
  throw new Error(
    "Chrome for Testing not found. Run:\n  npx @puppeteer/browsers install chrome@stable --path ./browsers\n" +
    "(Branded Chrome >=137 ignores --load-extension, and tests must never load into your real browser.)"
  );
}

// Copy the extension and repoint its WebSocket URL at the test port.
export function makeTestExtension() {
  const dir = mkdtempSync(join(tmpdir(), "cab-ext-"));
  cpSync(join(root, "extension"), dir, { recursive: true });
  const bgPath = join(dir, "background.js");
  const bg = readFileSync(bgPath, "utf8");
  const patched = bg.replace(
    /const WS_URL = "ws:\/\/127\.0\.0\.1:\d+\/ext";/,
    `const WS_URL = "ws://127.0.0.1:${TEST_PORT}/ext";`
  );
  if (patched === bg) throw new Error("could not patch WS_URL in the extension copy");
  writeFileSync(bgPath, patched);
  return dir;
}

export function launchChrome({ extensionDir, profileDir, args = [] }) {
  return spawn(findChrome(), [
    `--user-data-dir=${profileDir}`,
    `--load-extension=${extensionDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-session-crashed-bubble",
    "--silent-debugger-extension-api",
    ...args,
  ], { stdio: "ignore" });
}

// Env for spawned MCP servers so they bind the test port, not the real one.
export const serverEnv = { ...process.env, CHROME_AGENT_PORT: String(TEST_PORT) };

export function cleanup(paths) {
  for (const p of paths) {
    try { rmSync(p, { recursive: true, force: true }); } catch {}
  }
}
