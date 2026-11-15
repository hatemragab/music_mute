/** Isolated installed-Chrome proof; no native registration, account or YouTube. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildSharedExtension } from "./build-extension.mjs";
const root = resolve(import.meta.dirname, "../..");
const output = join(
  root,
  ".runtime/local-logging",
  `extension-smoke-${randomUUID()}`,
);
const profile = join(output, "chrome-profile");
const extension = join(output, "extension");
await mkdir(profile, { recursive: true, mode: 0o700 });
process.env.MUSICMUTE_LOG_ENABLED ??= "1";
process.env.MUSICMUTE_LOG_PAYLOADS ??= "1";
await buildSharedExtension({ output: extension, localDebug: true });
const { chromium } = createRequire(join(root, "web-client/package.json"))(
  "playwright",
);
const chrome = spawn(
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  [
    "--headless=new",
    `--user-data-dir=${profile}`,
    "--remote-debugging-port=0",
    "--enable-unsafe-extension-debugging",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "about:blank",
  ],
  { stdio: "ignore" },
);
let browser, socket;
const pending = new Map();
let sequence = 0;
const command = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Error("EXTENSION_CDP_TIMEOUT"));
    }, 10000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
try {
  let address;
  for (let index = 0; index < 100; index++) {
    try {
      address = (
        await readFile(join(profile, "DevToolsActivePort"), "utf8")
      ).split("\n");
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  assert.ok(address, "CHROME_DEBUG_START_FAILED");
  const endpoint = `http://127.0.0.1:${Number(address[0])}`;
  browser = await chromium.connectOverCDP(endpoint);
  socket = new WebSocket(`ws://127.0.0.1:${Number(address[0])}${address[1]}`);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.addEventListener("message", (event) => {
    const value = JSON.parse(event.data);
    const item = pending.get(value.id);
    if (!item) return;
    pending.delete(value.id);
    clearTimeout(item.timer);
    if (value.error) item.reject(Error("EXTENSION_CDP_FAILED"));
    else item.resolve(value.result);
  });
  const loaded = await command("Extensions.loadUnpacked", { path: extension });
  assert.match(loaded.id, /^[a-p]{32}$/);
  const page = await browser.contexts()[0].newPage();
  await page.goto(`chrome-extension://${loaded.id}/privacy.html`);
  await page.waitForFunction(
    () => globalThis.__MUSICMUTE_LOCAL_LOG_STATUS__?.delivered > 0,
    { timeout: 10000 },
  );
  const status = await page.evaluate(
    () => globalThis.__MUSICMUTE_LOCAL_LOG_STATUS__,
  );
  assert.equal(status.failed, 0);
  const deadline = Date.now() + 3000;
  let found;
  while (!found && Date.now() < deadline) {
    const rows = (
      await readFile(join(root, ".runtime/local-logging/events.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
    found = rows.find(
      (event) =>
        event.source === "chrome-extension" &&
        event.instanceId === status.instanceId &&
        event.name === "lifecycle.started",
    );
    if (!found) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(found, "EXTENSION_UNIFIED_CAPTURE_MISSING");
  const report = {
    success: true,
    fixture: true,
    browser: "installed Chrome",
    extensionId: loaded.id,
    nativeHostRegistered: false,
    youtubeNetwork: false,
    status,
    captureId: found.captureId,
    retainedEvent: found.name,
  };
  await writeFile(
    join(output, "result.json"),
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  );
  console.log(JSON.stringify(report));
} finally {
  for (const item of pending.values()) clearTimeout(item.timer);
  socket?.close();
  await browser?.close().catch(() => {});
  if (chrome.exitCode === null) chrome.kill("SIGTERM");
}
