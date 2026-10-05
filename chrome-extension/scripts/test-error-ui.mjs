// Ordinary HTTP UI fixture. No extension loading, native helper, account or media requests.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const root = resolve(import.meta.dirname, "..");
const require = createRequire(join(root, "../web-client/package.json"));
const { chromium } = require("playwright");
const output = join(root, "output", `error-ui-${Date.now()}.noindex`);
await mkdir(output, { recursive: true, mode: 0o700 });
const content = await readFile(join(root, "dist/extension/content.js"));
const css = await readFile(join(root, "dist/extension/content.css"));
const cases = [
  ["SOURCE_CHALLENGE_FAILED", "YouTube challenge failed", "Deno runtime, EJS"],
  [
    "SOURCE_TOKEN_REQUIRED",
    "YouTube playback token required",
    "PO-token provider",
  ],
  ["ACQUISITION_COOLDOWN", "YouTube access paused", "request limit"],
  ["PO_TOKEN_PROVIDER_INVALID", "YouTube tools need repair", "Prepare my Mac"],
  [
    "ACQUISITION_NETWORK_FAILED",
    "Audio connection failed",
    "Check your connection",
  ],
  ["ENOSPC", "Not enough local resources", "Free disk space"],
  ["PROCESSING_QUOTA_EXCEEDED", "Account allowance reached", "reset date"],
  [
    "COMPANION_UNAVAILABLE",
    "Connect the MusicMute app",
    "app window can be closed",
  ],
];
const html = (
  code,
) => `<!doctype html><html><head><meta charset="utf-8"><title>MusicMute error fixture</title><link rel="stylesheet" href="/content.css"><style>body{margin:0;background:#111319;color:#fff;font-family:system-ui;padding:40px}.html5-video-player{position:relative;width:920px;height:560px;background:#1d222b}.ytp-right-controls{position:absolute;bottom:8px;right:8px}video{width:100%;height:100%}h1{font-size:18px}.fixture-note{color:#bbc1cc}</style></head><body><h1>MusicMute — local error fixture</h1><p class="fixture-note">Synthetic UI. No YouTube, audio, account or native-helper requests.</p><ytd-watch-flexy video-id="abcdefghijk"><meta itemprop="duration" content="PT19S"><div class="html5-video-player"><video></video><div class="ytp-right-controls"></div></div></ytd-watch-flexy><script>
const video=document.querySelector('video');let paused=true;
Object.defineProperties(video,{duration:{get:()=>19},readyState:{get:()=>4},paused:{get:()=>paused},currentSrc:{get:()=>""}});
video.pause=()=>{paused=true;video.dispatchEvent(new Event('pause'))};video.play=()=>{paused=false;video.dispatchEvent(new Event('play'));return Promise.resolve()};
window.fixtureMessages=[];const code=${JSON.stringify(code)};const retryAt=Date.now()+65000;
globalThis.chrome={storage:{local:{get:async()=>({}),set:async()=>{}},onChanged:{addListener:()=>{},removeListener:()=>{}}},runtime:{id:'fixture-extension',onMessage:{addListener:()=>{},removeListener:()=>{}},sendMessage:async(message)=>{fixtureMessages.push(message);if(message.type==='MM_START')return {ok:false,error:code,...(code==='ACQUISITION_COOLDOWN'?{error_context:{stage:'metadata',block_reason:'ACQUISITION_RATE_LIMITED',retry_at:retryAt}}:{error_context:{stage:'metadata'}})};if(message.type==='MM_CLOUD_HANDOFF')return {ok:false,error:'APP_UPDATE_REQUIRED'};return {ok:true}}}};
</script><script src="/content.js"></script></body></html>`;
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  if (url.pathname === "/content.js")
    response.writeHead(200, { "Content-Type": "text/javascript" }).end(content);
  else if (url.pathname === "/content.css")
    response.writeHead(200, { "Content-Type": "text/css" }).end(css);
  else if (
    url.pathname === "/watch" &&
    cases.some(([code]) => code === url.searchParams.get("case"))
  )
    response
      .writeHead(200, {
        "Content-Type": "text/html",
        "Cache-Control": "no-store",
      })
      .end(html(url.searchParams.get("case")));
  else response.writeHead(404).end();
});
await new Promise((resolveReady) =>
  server.listen(0, "127.0.0.1", resolveReady),
);
const origin = `http://127.0.0.1:${server.address().port}`;
const report = {
  scope: "ISOLATED_HTTP_COMPILED_CONTENT_UI",
  extension_loaded: false,
  youtube_network: false,
  native_processing: false,
  cloud_requests: false,
  normal_browser_profile_modified: false,
  checks: [],
  errors: [],
};
let context;
try {
  context = await chromium.launchPersistentContext(
    join(output, "chrome-profile"),
    {
      executablePath:
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      headless: true,
      viewport: { width: 1100, height: 800 },
    },
  );
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin,
  });
  const page = await context.newPage();
  page.on("pageerror", () => report.errors.push("PAGE_ERROR"));
  for (const [code, title, guidance] of cases) {
    await page.goto(`${origin}/watch?v=abcdefghijk&case=${code}`);
    await page.locator("#musicmute-local-button").click();
    await page.getByText(title, { exact: true }).waitFor();
    const text = await page.locator(".musicmute-panel-status").textContent();
    assert.ok(text.includes(guidance), `${code}: guidance`);
    assert.ok(
      !(await page.locator("video").evaluate((video) => video.muted)),
      `${code}: original mute restored`,
    );
    await page.screenshot({ path: join(output, `${code.toLowerCase()}.png`) });
    report.checks.push(
      `${code}: rendered guidance and restored original audio`,
    );
    if (code === "ACQUISITION_COOLDOWN") {
      await page.waitForTimeout(1150);
      assert.notEqual(
        await page.locator(".musicmute-panel-status").textContent(),
        text,
        "local countdown advances",
      );
      assert.equal(
        await page.evaluate(
          () =>
            fixtureMessages.filter((message) => message.type === "MM_START")
              .length,
        ),
        1,
        "no retry",
      );
      assert.equal(
        await page.evaluate(
          () =>
            fixtureMessages.filter((message) => message.type === "MM_STATUS")
              .length,
        ),
        0,
        "no polling",
      );
      await page
        .getByRole("button", { name: "Copy error", exact: true })
        .click();
      const copied = await page.evaluate(() => navigator.clipboard.readText());
      assert.ok(
        copied.includes("Stage: metadata") &&
          copied.includes("ACQUISITION_COOLDOWN"),
        "copied failed stage/code",
      );
      assert.ok(
        !/https:|abcdefghijk|secret|cookie=/.test(copied),
        "copied report is private",
      );
      report.checks.push(
        "persisted cooldown countdown without polling or retry; safe clipboard report",
      );
    }
    if (code === "SOURCE_TOKEN_REQUIRED") {
      assert.equal(
        await page.evaluate(
          () =>
            fixtureMessages.filter(
              (message) => message.type === "MM_CLOUD_HANDOFF",
            ).length,
        ),
        0,
        "cloud requires click",
      );
      await page
        .getByRole("link", { name: "Use MusicMute cloud", exact: true })
        .click();
      await page.getByText("Update MusicMute", { exact: true }).waitFor();
      assert.ok(
        (await page.locator(".musicmute-panel-status").textContent()).includes(
          "No cloud request was submitted",
        ),
        "old app upgrade guidance",
      );
      await page.screenshot({
        path: join(output, "cloud-upgrade-guidance.png"),
      });
      report.checks.push(
        "explicit cloud click; old app upgrade guidance; no cloud submission",
      );
    }
  }
  assert.deepEqual(report.errors, [], "no browser fixture errors");
  report.success = true;
} catch (error) {
  report.success = false;
  report.failure = error instanceof Error ? error.message : "ERROR_UI_FAILED";
  process.exitCode = 1;
} finally {
  await context?.close();
  await new Promise((resolveClosed) => server.close(resolveClosed));
  await writeFile(
    join(output, "report.json"),
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  );
  console.log(JSON.stringify({ ...report, output }, null, 2));
}
