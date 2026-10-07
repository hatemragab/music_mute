import { createHash } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import {
  mkdir,
  chmod,
  readFile,
  writeFile,
  unlink,
  readdir,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { resolve, join } from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import assert from "node:assert/strict";
import { startFixtureServer } from "./fixture-server.mjs";
import { packageChrome } from "./package-chrome.mjs";
import { createStoreAssets } from "./store-assets.mjs";
import { resolveE2ERuntime } from "./e2e-runtime.mjs";

const root = resolve(import.meta.dirname, "..");
const storePackage = process.argv.includes("--store");
const longRun = process.argv.includes("--long-run");
const fixtureDuration = longRun ? 480 : 60;
let extensionPath = join(root, "dist/extension");
const require = createRequire(join(root, "../web-client/package.json"));
const { chromium } = require("playwright");
const execute = promisify(execFile);
const chromePath =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const output = join(root, "output", `e2e-${Date.now()}`);
const profile = join(output, "chrome-profile");
const localRoot = join(output, "companion");
// Chrome resolves the user native-host directory under --user-data-dir. The
// harness never changes the user's normal Chrome registration or profile.
const nativeDirectory = join(profile, "NativeMessagingHosts");
const nativePath = join(nativeDirectory, "com.musicmute.local.json");
const results = {
  fixture: true,
  model_inference: false,
  youtube_network: false,
  checks: [],
  errors: [],
};
let browser;
let chrome;
let server;
let page;
let raw;
let nativeRegistered = false;
function quote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
function check(name, condition) {
  assert.ok(condition, name);
  results.checks.push(name);
}
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function waitForFile(path) {
  for (let i = 0; i < 100; i++) {
    try {
      return await readFile(path, "utf8");
    } catch {
      await delay(100);
    }
  }
  throw new Error("CHROME_DEBUG_PORT_TIMEOUT");
}
async function poll(read, accept, label, timeout = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await read();
    if (accept(value)) return value;
    await delay(100);
  }
  throw new Error(label);
}
class DebugClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = [];
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const entry = this.pending.get(message.id);
        if (!entry) return;
        this.pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) entry.reject(new Error(message.error.message));
        else entry.resolve(message.result);
      } else for (const listener of this.listeners) listener(message);
    });
  }
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    return new DebugClient(socket);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("DEBUG_COMMAND_TIMEOUT"));
      }, 10_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        }),
      );
    });
  }
  close() {
    this.socket.close();
  }
}
async function targetEvaluator(targetId) {
  const { sessionId } = await raw.send("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  return async (expression) => {
    const reply = await raw.send(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      sessionId,
    );
    if (reply.exceptionDetails) throw new Error("TARGET_EVALUATION_FAILED");
    return reply.result?.value;
  };
}

try {
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw new Error("MVP_E2E_REQUIRES_MAC_ARM64");
  await mkdir(output, { recursive: true, mode: 0o700 });
  await mkdir(localRoot, { recursive: true, mode: 0o700 });
  // Reuse the app's validated, token-free active descriptor. A fleet service
  // artifact need not contain the local Python/Node tools used by this fixture.
  const resolverModule = join(output, "runtime-resolver.mjs");
  await build({
    stdin: {
      contents:
        'export { resolvePackagedRuntime } from "./src/companion/config.ts";',
      resolveDir: root,
    },
    outfile: resolverModule,
    bundle: true,
    platform: "node",
    format: "esm",
  });
  const { resolvePackagedRuntime } = await import(
    pathToFileURL(resolverModule).href
  );
  const { runtime, node, python } = await resolveE2ERuntime({
    resolvePackagedRuntime,
  });
  results.runtime_selection = process.env.MUSICMUTE_LOCAL_RUNTIME
    ? "EXPLICIT_EXECUTABLE_RUNTIME"
    : "VALIDATED_INSTALLED_APP_RUNTIME";
  // Worker FFmpeg is intentionally audio-only. Fixture video needs a developer
  // FFmpeg with H.264 encoding; it is never used by the shipped companion.
  const ffmpeg =
    process.env.MUSICMUTE_TEST_FFMPEG ?? "/opt/homebrew/bin/ffmpeg";
  const video = join(output, "fixture.mp4");
  const vocals = join(output, "fixture.mp3");
  await execute(
    ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      `color=c=0x263544:s=640x360:r=15:d=${fixtureDuration}`,
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=330:sample_rate=44100:duration=${fixtureDuration}`,
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-movflags",
      "+faststart",
      "-y",
      video,
    ],
    { timeout: 30_000, maxBuffer: 128 * 1024 },
  );
  await execute(
    ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=660:sample_rate=44100:duration=${fixtureDuration}`,
      "-c:a",
      "libmp3lame",
      "-b:a",
      "128k",
      "-y",
      vocals,
    ],
    { timeout: 30_000, maxBuffer: 128 * 1024 },
  );
  await chmod(vocals, 0o600);
  await execute(
    process.execPath,
    [join(root, "scripts/build.mjs"), ...(storePackage ? [] : ["--fixture"])],
    // Build includes two native Swift compilations with their own 60s/120s limits.
    { timeout: 210_000, maxBuffer: 128 * 1024 },
  );
  if (storePackage) {
    const packaged = await packageChrome();
    extensionPath = join(output, "store-extension");
    await execute("python3", [
      "-c",
      "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; z.extractall(sys.argv[2])",
      join(packaged.output, packaged.archive),
      extensionPath,
    ]);
    results.store_archive = join(packaged.output, packaged.archive);
    results.store_archive_sha256 = packaged.sha256;
  }
  const manifest = JSON.parse(
    await readFile(join(extensionPath, "manifest.json"), "utf8"),
  );
  if (storePackage)
    check(
      "Store archive omits local identity key",
      !Object.hasOwn(manifest, "key"),
    );
  server = await startFixtureServer(video);
  // No flags that bypass autoplay, CORS, Local Network Access, or media security.
  chrome = spawn(
    chromePath,
    [
      ...(longRun ? [] : ["--headless=new"]),
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
  const debugAddress = (
    await waitForFile(join(profile, "DevToolsActivePort"))
  ).split("\n");
  const debugPort = Number(debugAddress[0]);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`, {
    noDefaults: longRun,
  });
  raw = await DebugClient.connect(
    `ws://127.0.0.1:${debugPort}${debugAddress[1]}`,
  );
  const loaded = await raw.send("Extensions.loadUnpacked", {
    path: extensionPath,
  });
  const extensionId = loaded.id;
  check("loaded extension id is valid", /^[a-p]{32}$/.test(extensionId));
  if (!storePackage) {
    const hash = createHash("sha256")
      .update(Buffer.from(manifest.key, "base64"))
      .digest("hex")
      .slice(0, 32);
    const keyedId = [...hash]
      .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
      .join("");
    check("stable local extension id", extensionId === keyedId);
  }
  // The Store ZIP must stay byte-for-byte unchanged. Its unpacked test ID is
  // path-derived, whereas Google signs the published CRX with the Store identity.
  // Bind only this isolated profile's fixture host to Chrome's actual loaded ID.
  results.extension_id = extensionId;
  results.extension_identity = storePackage ? "UNPACKED_PATH" : "MANIFEST_KEY";
  results.signed_store_identity_verified = false;
  await mkdir(nativeDirectory, { recursive: true, mode: 0o700 });
  const launcher = join(output, "fixture-native-launcher.sh");
  await writeFile(
    launcher,
    `#!/bin/sh\n# MusicMute Local MVP isolated browser fixture\nexec /usr/bin/env -i HOME=${quote(homedir())} PATH='/usr/bin:/bin' LANG='en_US.UTF-8' MUSICMUTE_LOCAL_ROOT=${quote(localRoot)} MUSICMUTE_LOCAL_RUNTIME=${quote(runtime)} MUSICMUTE_LOCAL_TEST_MODE=1 MUSICMUTE_LOCAL_FIXTURE_AUDIO=${quote(vocals)} ${quote(python)} -I -B -S ${quote(join(root, "scripts/native-lock.py"))} ${quote(node)} ${quote(join(root, "dist/companion/host.js"))} "$@"\n`,
    { mode: 0o700 },
  );
  await writeFile(
    nativePath,
    JSON.stringify(
      {
        name: "com.musicmute.local",
        description: "MusicMute Local MVP isolated browser fixture",
        path: launcher,
        type: "stdio",
        allowed_origins: [`chrome-extension://${extensionId}/`],
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  nativeRegistered = true;
  raw.listeners.push((message) => {
    if (message.method === "Target.attachedToTarget")
      void raw
        .send("Network.enable", {}, message.params.sessionId)
        .then(() =>
          raw.send(
            "Runtime.runIfWaitingForDebugger",
            {},
            message.params.sessionId,
          ),
        )
        .catch(() => undefined);
    if (
      message.method === "Network.requestWillBeSent" &&
      message.params.request.url.startsWith("http://127.0.0.1:")
    )
      results.audio_request_origin =
        message.params.request.headers.Origin ?? "absent";
    if (message.method === "Network.responseReceived")
      results.audio_response_status = message.params.response.status;
    if (message.method === "Network.loadingFailed")
      results.audio_network_failure = message.params.errorText;
  });
  await raw.send("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
  });
  const context = browser.contexts()[0];
  if (storePackage) {
    // Fulfill every YouTube request with owned fixture bytes. The production
    // manifest and bundles are unmodified; no YouTube network access occurs.
    await context.route("https://www.youtube.com/**", async (route) => {
      const url = new URL(route.request().url());
      const response = await context.request.get(
        server.url + url.pathname + url.search,
        { headers: route.request().headers() },
      );
      await route.fulfill({ response });
    });
  }
  const watchOrigin = storePackage ? "https://www.youtube.com" : server.url;
  page = await context.newPage();
  page.on("pageerror", () => results.errors.push("PAGE_ERROR"));
  await page.goto(`${watchOrigin}/watch?v=11111111111`);
  await page.locator("#musicmute-local-button").waitFor();
  await poll(
    () => page.locator("video").evaluate((v) => v.readyState),
    (value) => value >= 3,
    "VIDEO_NOT_READY",
  );
  check(
    "one accessible injected player control",
    (await page.locator("#musicmute-local-button[aria-label]").count()) === 1,
  );
  await page.locator("#play").click();
  await page.locator("#musicmute-local-button").click();
  await page.waitForFunction(
    () =>
      document
        .querySelector("#musicmute-local-panel")
        ?.textContent.includes("Voice-only playback"),
    undefined,
    { timeout: 20_000 },
  );
  const workerTarget = (await raw.send("Target.getTargets")).targetInfos.find(
    (t) =>
      t.type === "service_worker" &&
      t.url.startsWith(`chrome-extension://${extensionId}/`),
  );
  check("native messaging companion bridge", !!workerTarget);
  // Runtime messages are not delivered to their sending context. Use the real
  // popup as a client, rather than sending a service worker a message to itself.
  const worker = await context.newPage();
  await worker.goto(`chrome-extension://${extensionId}/popup.html`);
  const sourceSuppressed = () =>
    worker.evaluate(
      async (origin) =>
        (await chrome.tabs.query({})).some(
          (tab) =>
            tab.url?.startsWith(origin + "/watch?") && tab.mutedInfo?.muted,
        ),
      watchOrigin,
    );
  const status = await worker.evaluate(
    () =>
      new Promise((resolve) =>
        chrome.runtime.sendMessage({ type: "MM_STATUS" }, resolve),
      ),
  );
  check(
    "fixture result prepared locally",
    status.job?.state === "READY" && status.hello?.ready,
  );
  const offscreen = await poll(
    async () =>
      (await raw.send("Target.getTargets")).targetInfos.find(
        (t) => t.url === `chrome-extension://${extensionId}/offscreen.html`,
      ),
    (value) => !!value,
    "OFFSCREEN_MISSING",
  );
  let audioEval = await targetEvaluator(offscreen.targetId);
  const audio = {
    evaluate: (fn) =>
      audioEval(`(${fn.toString()})(document.querySelector('audio'))`),
  };
  const playingAudio = await poll(
    () =>
      audio.evaluate(
        (a) => !a.paused && a.currentTime > 0 && a.readyState >= 3,
      ),
    Boolean,
    "OFFSCREEN_PLAYBACK_DID_NOT_ADVANCE",
  );
  check("real offscreen audio plays without autoplay bypass", playingAudio);
  check(
    "original source suppressed at tab level",
    await worker.evaluate(async () =>
      (await chrome.tabs.query({})).some(
        (t) => t.url?.includes("/watch?") && t.mutedInfo?.muted,
      ),
    ),
  );
  await page.screenshot({
    path: join(output, "fixture-active.png"),
    fullPage: true,
  });
  await worker.screenshot({
    path: join(output, "fixture-popup.png"),
    fullPage: true,
  });
  if (storePackage)
    results.store_assets = await createStoreAssets(context, worker, output);
  await page.bringToFront();
  // Measure steady synchronization after browser decode/output startup and
  // its bounded first alignment, rather than sampling during that handoff.
  await poll(
    () => audio.evaluate((a) => a.currentTime),
    (time) => time >= 3,
    "AUDIO_STARTUP_DID_NOT_ADVANCE",
  );
  const drift = [];
  const driftSamples = [];
  for (let sample = 0; sample < 6; sample++) {
    const audioSample = await audio.evaluate((a) => ({
      time: a.currentTime,
      at: Date.now(),
      rate: a.paused ? 0 : a.playbackRate,
    }));
    const videoSample = await page.locator("video").evaluate((v) => ({
      time: v.currentTime,
      at: Date.now(),
      rate: v.paused ? 0 : v.playbackRate,
    }));
    const now = Math.max(audioSample.at, videoSample.at);
    drift.push(
      Math.abs(
        audioSample.time +
          ((now - audioSample.at) / 1000) * audioSample.rate -
          videoSample.time -
          ((now - videoSample.at) / 1000) * videoSample.rate,
      ),
    );
    driftSamples.push({ audio: audioSample, video: videoSample });
    await delay(200);
  }
  results.drift_samples = driftSamples;
  results.max_observed_drift_ms = Math.round(Math.max(...drift) * 1000);
  check(
    "settled synthetic playback clocks stay within 250ms",
    results.max_observed_drift_ms <= 250,
  );
  await page.bringToFront();
  // Auto-start may already own playback before the initial waveform click,
  // making that click a dismissal. Establish the visible-panel precondition.
  if (await page.locator("#musicmute-local-panel").isHidden())
    await page.locator("#musicmute-local-button").click();
  check(
    "replacement begins with visible controls",
    await page.locator("#musicmute-local-panel").isVisible(),
  );
  await page.locator("#replace").click();
  await poll(
    () => page.locator("video").evaluate((v) => v.readyState >= 3 && !v.muted),
    Boolean,
    "ACTIVE_REPLACEMENT_NOT_REBOUND",
  );
  check(
    "active same-video replacement keeps the panel visible",
    await page.locator("#musicmute-local-panel").isVisible(),
  );
  check(
    "replacement preserves the new player's paused state",
    await page.locator("video").evaluate((v) => v.paused),
  );
  const rebound = await worker.evaluate(() =>
    chrome.runtime.sendMessage({ type: "MM_STATUS" }),
  );
  check(
    "replacement reuses the same prepared job",
    rebound.job?.job_id === status.job.job_id,
  );
  await page.locator("#play").click();
  await poll(
    () => audio.evaluate((a) => !a.paused),
    Boolean,
    "REBOUND_AUDIO_NOT_PLAYING",
  );
  check("replacement resumes vocals without processing again", true);
  if (longRun) {
    const pageSession = await context.newCDPSession(page);
    await pageSession.send("Emulation.setFocusEmulationEnabled", {
      enabled: false,
    });
    const { targetInfo } = await pageSession.send("Target.getTargetInfo");
    const { windowId } = await raw.send("Browser.getWindowForTarget", {
      targetId: targetInfo.targetId,
    });
    await raw.send("Browser.setWindowBounds", {
      windowId,
      bounds: { windowState: "minimized" },
    });
    await poll(
      () => page.evaluate(() => document.visibilityState),
      (state) => state === "hidden",
      "PLAYER_NOT_HIDDEN",
    );
    check(
      "long-run player is hidden",
      await page.evaluate(() => document.visibilityState === "hidden"),
    );
    const samples = [];
    // Cross Chrome's five-minute hidden-tab threshold without executing page code.
    for (let sample = 0; sample < 24; sample++) {
      await delay(15_000);
      samples.push(
        await audio.evaluate((a) => ({
          playing: !a.paused,
          time: a.currentTime,
        })),
      );
      if ((sample + 1) % 4 === 0)
        console.log(`Hidden playback: ${(sample + 1) * 15}s`);
    }
    results.hidden_playback_samples = samples;
    check(
      "six minutes of hidden playback continue advancing",
      samples.every((s) => s.playing) &&
        samples.at(-1).time - samples[0].time > 330,
    );
    await raw.send("Browser.setWindowBounds", {
      windowId,
      bounds: { windowState: "normal" },
    });
    await page.bringToFront();
    await page.locator("video").evaluate((v) => {
      v.currentTime = 10;
    });
  }
  await page.locator("#play").click();
  await poll(
    () => audio.evaluate((a) => a.paused),
    Boolean,
    "AUDIO_PAUSE_FAILED",
  );
  check("pause follows video", true);
  if (longRun) {
    await delay(40_000);
    await page.locator("#play").click();
    const resumedTarget = await poll(
      async () =>
        (await raw.send("Target.getTargets")).targetInfos.find(
          (t) => t.url === `chrome-extension://${extensionId}/offscreen.html`,
        ),
      Boolean,
      "LONG_PAUSE_CONTEXT_MISSING",
    );
    audioEval = await targetEvaluator(resumedTarget.targetId);
    await poll(
      () => audio.evaluate((a) => a && !a.paused),
      Boolean,
      "LONG_PAUSE_RESUME_FAILED",
    );
    check("resumes after forty seconds of silent offscreen lifetime", true);
    await page.locator("#play").click();
    await poll(
      () => audio.evaluate((a) => a.paused),
      Boolean,
      "LONG_PAUSE_REPAUSE_FAILED",
    );
  }

  await page.locator("video").evaluate((v) => {
    v.currentTime = 20;
    v.playbackRate = 1.5;
    v.volume = 0.4;
  });
  await poll(
    () =>
      audio.evaluate((a) => ({
        time: a.currentTime,
        rate: a.playbackRate,
        volume: a.volume,
      })),
    (v) =>
      Math.abs(v.time - 20) < 0.2 &&
      v.rate === 1.5 &&
      Math.abs(v.volume - 0.4) < 0.01,
    "SEEK_RATE_VOLUME_FAILED",
  );
  check("seek rate and volume follow video", true);
  results.player_mute_before = {
    video: await page.locator("video").evaluate((v) => ({
      muted: v.muted,
      volume: v.volume,
      paused: v.paused,
      time: v.currentTime,
    })),
    audio: await audio.evaluate((a) => ({
      muted: a.muted,
      volume: a.volume,
      paused: a.paused,
      time: a.currentTime,
    })),
  };
  await page.locator(".ytp-mute-button").click();
  results.player_mute_after_click = await page
    .locator("video")
    .evaluate((v) => ({
      muted: v.muted,
      volume: v.volume,
      paused: v.paused,
      time: v.currentTime,
    }));
  await poll(
    () => audio.evaluate((a) => a.volume === 0),
    Boolean,
    "PLAYER_MUTE_FAILED",
  );
  check("YouTube mute control silences vocals", true);
  await page.locator("video").click();
  await page.keyboard.press("m");
  await poll(
    () => audio.evaluate((a) => Math.abs(a.volume - 0.4) < 0.01),
    Boolean,
    "KEYBOARD_UNMUTE_FAILED",
  );
  check("YouTube M shortcut restores vocals", true);

  // Clicking the video dismisses the popover; reopen it before testing its actions.
  if (!(await page.locator("#musicmute-local-panel").isVisible()))
    await page.locator("#musicmute-local-button").click();
  check(
    "sound toggle and separate Stop action",
    (await page.locator(".musicmute-panel-actions button:visible").count()) ===
      2,
  );
  await page
    .getByRole("button", { name: "Show original sound", exact: true })
    .click();
  await poll(
    async () =>
      (await audio.evaluate((a) => !a || a.paused)) &&
      (await page.locator("video").evaluate((v) => !v.muted)),
    Boolean,
    "ORIGINAL_SOUND_SWITCH_FAILED",
  );
  check(
    "single sound action restores original audio",
    !(await sourceSuppressed()),
  );
  await page
    .getByRole("button", { name: "Remove background music", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Show original sound", exact: true })
    .waitFor();
  await poll(
    () => audio.evaluate((a) => a.volume),
    (volume) => Math.abs(volume - 0.4) < 0.01,
    "VOCALS_RESTORE_FAILED",
  );
  check("single sound action returns to vocals with selected volume", true);
  const control = await targetEvaluator(workerTarget.targetId);
  await control("chrome.offscreen.closeDocument()");
  await page.locator("#play").click();
  const replacementOffscreen = await poll(
    async () =>
      (await raw.send("Target.getTargets")).targetInfos.find(
        (t) => t.url === `chrome-extension://${extensionId}/offscreen.html`,
      ),
    Boolean,
    "OFFSCREEN_RECREATION_FAILED",
  );
  audioEval = await targetEvaluator(replacementOffscreen.targetId);
  await poll(
    () => audio.evaluate((a) => !a.paused),
    Boolean,
    "AUDIO_RESUME_FAILED",
  );
  check(
    "closed offscreen context is recreated and reseeked",
    Math.abs(
      (await audio.evaluate((a) => a.currentTime)) -
        (await page.locator("video").evaluate((v) => v.currentTime)),
    ) < 0.3,
  );
  await page.locator("#ads").click();
  await poll(
    () => audio.evaluate((a) => a.paused),
    Boolean,
    "AD_GATING_FAILED",
  );
  await poll(sourceSuppressed, (muted) => !muted, "AD_SOURCE_STILL_SUPPRESSED");
  check("ads suspend vocals and restore original tab audio", true);
  await page.locator("#ads").click();
  await poll(
    () => audio.evaluate((a) => !a.paused),
    Boolean,
    "AD_RECOVERY_FAILED",
  );
  await page
    .getByRole("button", { name: "Stop MusicMute", exact: true })
    .click();
  await poll(
    () => page.locator("video").evaluate((v) => !v.muted),
    Boolean,
    "MUTE_RESTORE_FAILED",
  );
  check("stop restores original mute setting", !(await sourceSuppressed()));
  check(
    "Stop hides the MusicMute dialog",
    await page.locator("#musicmute-local-panel").isHidden(),
  );
  await page.locator("#replace").click();
  await poll(
    () => page.locator("video").evaluate((v) => v.readyState),
    (value) => value >= 3,
    "REPLACED_VIDEO_NOT_READY",
  );
  check(
    "video replacement keeps one control",
    (await page.locator("#musicmute-local-button").count()) === 1,
  );
  await page.locator("#play").click();
  await page.locator("#musicmute-local-button").click();
  await page.waitForFunction(() =>
    document
      .querySelector("#musicmute-local-panel")
      ?.textContent.includes("Voice-only playback"),
  );
  const second = await context.newPage();
  await second.goto(`${watchOrigin}/watch?v=11111111111`);
  await second.locator("#musicmute-local-button").waitFor();
  await poll(
    () => second.locator("video").evaluate((v) => v.readyState),
    (value) => value >= 3,
    "SECOND_VIDEO_NOT_READY",
  );
  await second.locator("#play").click();
  await second.locator("#musicmute-local-button").click();
  await second.waitForFunction(() =>
    document
      .querySelector("#musicmute-local-panel")
      ?.textContent.includes("Voice-only playback"),
  );
  await poll(
    () => page.locator("video").evaluate((v) => !v.muted && v.paused),
    Boolean,
    "AUDIBLE_OWNER_NOT_REPLACED",
  );
  check(
    "second tab takes exclusive playback ownership",
    await second.locator("video").evaluate((v) => !v.muted && !v.paused),
  );
  await second
    .getByRole("button", { name: "Stop MusicMute", exact: true })
    .click();
  await second.close();
  await page.bringToFront();
  await page.locator("#play").click();
  await page.locator("#musicmute-local-button").click();
  await page.waitForFunction(() =>
    document
      .querySelector("#musicmute-local-panel")
      ?.textContent.includes("Voice-only playback"),
  );
  await page.locator("#navigate").click();
  await poll(
    () => page.locator("video").evaluate((v) => !v.muted && v.paused),
    Boolean,
    "SPA_SESSION_TEARDOWN_FAILED",
  );
  check("SPA navigation fences previous playback", true);
  await worker.evaluate(() =>
    chrome.storage.local.set({
      "musicmute.settings.v1": { version: 1 },
      "musicmute.settings.v1.autoStartEnabled": true,
      "musicmute.settings.v1.maxDurationMinutes": 10,
    }),
  );
  await delay(200);
  for (const nextId of ["33333333333", "44444444444"]) {
    await page.evaluate((id) => {
      document.dispatchEvent(new Event("yt-navigate-start"));
      history.pushState({}, "", "/watch?v=" + id);
      document.querySelector("ytd-watch-flexy").setAttribute("video-id", id);
      const video = document.querySelector("video");
      video.load();
      document.dispatchEvent(new Event("yt-navigate-finish"));
    }, nextId);
    await page.waitForFunction(
      () => document.querySelector("video").readyState >= 3,
    );
    await page.locator("#play").click();
    await page.waitForFunction(
      () =>
        document
          .querySelector("#musicmute-local-panel")
          ?.textContent.includes("Voice-only playback"),
      undefined,
      { timeout: 20000 },
    );
    await poll(
      () => page.locator("video").evaluate((v) => !v.muted && !v.paused),
      Boolean,
      "AUTO_NEXT_NOT_PLAYING",
      20000,
    );
    check("automatic next-video vocals " + nextId, true);
  }
  await page
    .getByRole("button", { name: "Stop MusicMute", exact: true })
    .click();
  await poll(
    () => page.locator("video").evaluate((v) => !v.muted),
    Boolean,
    "AUTOMATIC_STOP_FAILED",
  );
  await delay(500);
  const afterAutoStop = await worker.evaluate(() =>
    chrome.runtime.sendMessage({ type: "MM_STATUS" }),
  );
  check(
    "Stop suppresses automatic restart on same video",
    afterAutoStop.job === null && !(await sourceSuppressed()),
  );
  check("no page errors", results.errors.length === 0);
  await page.screenshot({ path: join(output, "fixture.png"), fullPage: true });
  const report = await worker.evaluate(
    () =>
      new Promise((resolve) =>
        chrome.runtime.sendMessage({ type: "MM_DIAGNOSTICS" }, resolve),
      ),
  );
  check(
    "diagnostics exported locally",
    report.type === "REPORT" &&
      typeof report.payload.path === "string" &&
      report.payload.path.startsWith(localRoot),
  );
  await worker.bringToFront();
  await worker.locator(".tools > summary").click();
  await worker.locator("#clear").click();
  await worker.waitForFunction(() =>
    document
      .querySelector("#details")
      ?.textContent.includes("Local vocals cache cleared"),
  );
  check(
    "explicit cache clear removes managed results",
    (await readdir(join(localRoot, "cache/vocals"))).length === 0,
  );
  results.success = true;
} catch (error) {
  results.success = false;
  results.failure = error instanceof Error ? error.message : "E2E_FAILED";
  if (page) {
    results.video_state = await page
      .locator("video")
      .evaluate((v) => ({
        muted: v.muted,
        volume: v.volume,
        paused: v.paused,
        time: v.currentTime,
        rate: v.playbackRate,
      }))
      .catch(() => "unavailable");
    results.page_status = await page
      .locator("#musicmute-local-panel")
      .textContent()
      .catch(() => "missing panel");
    await page
      .screenshot({ path: join(output, "failure.png"), fullPage: true })
      .catch(() => undefined);
  }
  if (browser) {
    const targets = (await raw.send("Target.getTargets")).targetInfos;
    results.targets = targets.map((target) => ({
      type: target.type,
      url: target.url,
    }));
    for (const target of targets.filter((target) =>
      target.url.endsWith("/offscreen.html"),
    )) {
      const evaluate = await targetEvaluator(target.targetId);
      results.audio_state = await evaluate(
        '(()=>{const a=document.querySelector("audio");return a?{error:a.error?.code,paused:a.paused,muted:a.muted,volume:a.volume,time:a.currentTime,ready:a.readyState,network:a.networkState,duration:Number.isFinite(a.duration)?a.duration:null}:null})()',
      ).catch(() => "unavailable");
    }
    for (const worker of browser.contexts()[0]?.serviceWorkers() ?? []) {
      results.extension_status = await worker
        .evaluate(
          () =>
            new Promise((resolve) =>
              chrome.runtime.sendMessage({ type: "MM_STATUS" }, resolve),
            ),
        )
        .catch(() => "unavailable");
    }
  }
  process.exitCode = 1;
} finally {
  raw?.close();
  if (browser) await browser.close().catch(() => undefined);
  if (chrome && chrome.exitCode === null) chrome.kill("SIGTERM");
  if (server) await server.close();
  if (nativeRegistered) {
    await unlink(nativePath);
  }
  await mkdir(output, { recursive: true, mode: 0o700 });
  await writeFile(
    join(output, "results.json"),
    JSON.stringify(results, null, 2),
  );
  // Restore release manifests after fixture build, including on failure.
  await execute(process.execPath, [join(root, "scripts/build.mjs")], {
    timeout: 210_000,
    maxBuffer: 128 * 1024,
  }).catch(() => undefined);
  console.log(
    JSON.stringify(
      {
        success: results.success,
        checks: results.checks,
        failure: results.failure,
        output,
      },
      null,
      2,
    ),
  );
}
