// Compiled UI fixtures in an isolated Chrome context; no helper, account or YouTube requests.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
const root = resolve(import.meta.dirname, "..");
const require = createRequire(join(root, "../web-client/package.json"));
const { chromium } = require("playwright");
const output = join(root, "output", `language-ui-${Date.now()}.noindex`);
await mkdir(output, { recursive: true, mode: 0o700 });
const assets = new Map();
for (const name of [
  "popup.html",
  "popup.js",
  "popup.css",
  "privacy.html",
  "privacy.js",
  "privacy.css",
  "content.js",
  "content.css",
  "musicmute-mark.svg",
])
  assets.set(`/${name}`, await readFile(join(root, "dist/extension", name)));
const watch = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><link rel="stylesheet" href="/content.css"><style>body{background:#101115;color:white;font-family:system-ui}.html5-video-player{position:relative;width:920px;height:700px;background:#20232a}.ytp-right-controls{position:absolute;bottom:8px;right:8px}video{width:100%;height:100%}</style></head><body><ytd-watch-flexy video-id="abcdefghijk"><meta itemprop="duration" content="PT19S"><div class="html5-video-player"><video></video><div class="ytp-right-controls"></div></div></ytd-watch-flexy><script>const video=document.querySelector('video');Object.defineProperties(video,{duration:{get:()=>19},readyState:{get:()=>4},paused:{get:()=>true},currentSrc:{get:()=>''}});video.pause=()=>{};</script><script src="/content.js"></script></body></html>`;
const server = createServer((request, response) => {
  const path = new URL(request.url, "http://127.0.0.1").pathname;
  const content = path === "/watch" ? watch : assets.get(path);
  const type = path.endsWith(".js")
    ? "text/javascript"
    : path.endsWith(".css")
      ? "text/css"
      : path.endsWith(".svg")
        ? "image/svg+xml"
        : "text/html";
  response
    .writeHead(content ? 200 : 404, { "Content-Type": `${type};charset=utf-8` })
    .end(content);
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
const report = {
  scope: "ISOLATED_COMPILED_UI_WITH_MOCK_CHROME_APIS",
  checks: [],
  errors: [],
  youtube_network: false,
  native_processing: false,
  normal_profile_modified: false,
};
let browser;
function check(name, value) {
  assert.ok(value, name);
  report.checks.push(name);
}
try {
  browser = await chromium.launch({
    executablePath:
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
  const context = await browser.newContext({
    viewport: { width: 1100, height: 850 },
  });
  await context.addInitScript(() => {
    const storageKey = "fixture-settings";
    const read = () =>
      JSON.parse(
        localStorage.getItem(storageKey) ??
          '{"musicmute.settings.v1":{"version":1},"musicmute.settings.v1.autoStartEnabled":false}',
      );
    const listeners = new Set();
    window.fixtureMessages = [];
    window.fixtureFailSave = false;
    const notify = (before, after) => {
      const changes = {};
      for (const key of new Set([
        ...Object.keys(before),
        ...Object.keys(after),
      ]))
        if (JSON.stringify(before[key]) !== JSON.stringify(after[key]))
          changes[key] = { oldValue: before[key], newValue: after[key] };
      for (const listener of listeners) listener(changes, "local");
    };
    window.addEventListener("storage", (event) => {
      if (event.key === storageKey)
        notify(JSON.parse(event.oldValue ?? "{}"), read());
    });
    window.chrome = {
      i18n: {
        getUILanguage: () =>
          new URL(location.href).searchParams.get("ui") ?? "ar-EG",
      },
      storage: {
        local: {
          get: async () => read(),
          set: async (patch) => {
            if (window.fixtureFailSave) throw new Error("FIXTURE_SAVE_FAILED");
            const before = read();
            const after = { ...before, ...patch };
            localStorage.setItem(storageKey, JSON.stringify(after));
            notify(before, after);
          },
        },
        onChanged: {
          addListener: (listener) => listeners.add(listener),
          removeListener: (listener) => listeners.delete(listener),
        },
      },
      runtime: {
        id: "fixture-extension",
        onMessage: { addListener: () => {}, removeListener: () => {} },
        sendMessage: async (message) => {
          window.fixtureMessages.push(message);
          if (message.type === "MM_STATUS")
            return {
              hello: {
                ready: true,
                platform: "darwin",
                arch: "arm64",
                version: "0.1.0",
              },
              job: null,
              diagnostics: [],
              installation_check: {
                installation_id: "a".repeat(64),
                state: "passed",
                started_at: 1,
                completed_at: 2,
                checks: ["runtime", "model", "youtube_tools"].map(
                  (component) => ({
                    component,
                    state: "passed",
                    duration_ms: 100,
                  }),
                ),
              },
            };
          if (message.type === "MM_START")
            return {
              ok: false,
              error: "ACQUISITION_COOLDOWN",
              error_context: {
                stage: "metadata",
                retry_at: Date.now() + 65_000,
                block_reason: "ACQUISITION_RATE_LIMITED",
              },
            };
          return { ok: true };
        },
      },
    };
  });
  const popup = await context.newPage();
  popup.on("pageerror", (error) => report.errors.push(error.message));
  await popup.goto(`${origin}/popup.html`);
  await popup.getByText("MusicMute متصل", { exact: true }).waitFor();
  check(
    "automatic Chrome Arabic uses RTL",
    (await popup.locator("html").getAttribute("dir")) === "rtl",
  );
  check(
    "installation check renders translated passed state",
    (await popup.locator("#check-summary").textContent()).includes("نجح"),
  );
  check(
    "check component names translated",
    (await popup.locator("#check-results").textContent()).includes(
      "الأدوات المثبتة: نجح",
    ),
  );
  check(
    "privacy link is translated",
    (await popup
      .getByRole("link", { name: "الخصوصية واستخدام البيانات", exact: true })
      .count()) === 1,
  );
  await popup.screenshot({ path: join(output, "popup-ar.png") });
  const page = await context.newPage();
  page.on("pageerror", (error) => report.errors.push(error.message));
  await page.goto(`${origin}/watch?v=abcdefghijk`);
  await page.locator("#musicmute-local-button").click();
  await page.getByText("الوصول إلى YouTube معلّق", { exact: true }).waitFor();
  const panel = page.locator("#musicmute-local-panel");
  check(
    "panel follows Chrome rather than YouTube page language",
    (await panel.getAttribute("dir")) === "rtl" &&
      (await page.locator("html").getAttribute("lang")) === "fr",
  );
  await page
    .getByRole("button", { name: "إعدادات الإضافة", exact: true })
    .click();
  await page.locator("#musicmute-setting-language").selectOption("en");
  await popup.getByText("MusicMute is connected", { exact: true }).waitFor();
  await page.getByText("YouTube access paused", { exact: true }).waitFor();
  check(
    "cross-tab language change preserves the active failure and cooldown",
    await page
      .getByRole("button", { name: "Remove background music", exact: true })
      .isDisabled(),
  );
  check(
    "language change leaves YouTube page direction unchanged",
    (await page.locator("html").getAttribute("lang")) === "fr",
  );
  await popup.locator("#language").selectOption("ar");
  await page.getByText("الوصول إلى YouTube معلّق", { exact: true }).waitFor();
  check(
    "transparency output survives language changes",
    (await page
      .locator("label[for='musicmute-setting-transparency'] output")
      .count()) === 1,
  );
  check(
    "language switching submits no additional processing",
    (await page.evaluate(
      () => fixtureMessages.filter((m) => m.type === "MM_START").length,
    )) === 1,
  );
  check(
    "only initial popup status read",
    (await popup.evaluate(
      () => fixtureMessages.filter((m) => m.type === "MM_STATUS").length,
    )) === 1,
  );
  await page.screenshot({ path: join(output, "panel-ar.png") });
  await popup.evaluate(() => {
    window.fixtureFailSave = true;
  });
  await popup.locator("#language").selectOption("en");
  await popup
    .getByText("تعذّر حفظ اللغة. ما زالت لغتك السابقة مفعّلة.")
    .waitFor();
  check(
    "failed save keeps Arabic and restores selector",
    (await popup.locator("#language").inputValue()) === "ar" &&
      (await popup.locator("html").getAttribute("dir")) === "rtl",
  );
  await popup.evaluate(() => {
    window.fixtureFailSave = false;
  });
  await popup.reload();
  await popup.getByText("MusicMute متصل", { exact: true }).waitFor();
  check(
    "saved language survives reopening",
    (await popup.locator("#language").inputValue()) === "ar",
  );
  const privacy = await context.newPage();
  await privacy.goto(`${origin}/privacy.html`);
  await privacy
    .getByRole("heading", { name: "الخصوصية واستخدام البيانات", exact: true })
    .waitFor();
  check(
    "privacy page localized with RTL",
    (await privacy.locator("html").getAttribute("dir")) === "rtl",
  );
  await popup.goto(`${origin}/popup.html?ui=fr`);
  await popup.locator("#language").selectOption("auto");
  await popup.getByText("MusicMute is connected", { exact: true }).waitFor();
  check(
    "unsupported Chrome language falls back to English",
    (await popup.locator("html").getAttribute("dir")) === "ltr",
  );
  check("no page errors", report.errors.length === 0);
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
  await writeFile(join(output, "result.json"), JSON.stringify(report, null, 2));
}
console.log(
  JSON.stringify({
    output,
    checks: report.checks.length,
    errors: report.errors.length,
  }),
);
