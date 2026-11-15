#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  copyFile,
  unlink,
  chmod,
  lstat,
  readFile,
  open,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  root,
  pathsFor,
  workspaceIdFor,
  startCollector,
} from "./collector.mjs";
import { sources } from "./ingress.mjs";
import { processObserver } from "./process-observer.mjs";
import { redact } from "./redact.mjs";
import {
  ensureLogFile,
  startLogViewer,
  installViewer,
  verifiedViewer,
  viewerPaths,
  createViewerLayout,
  verifyPinnedFile,
} from "./backend-logs.mjs";
import { verifiedVector, installVector, vectorPaths } from "./vector-tool.mjs";
import { patchedVectorPaths } from "./vector-source-build.mjs";
const endpoint = "http://127.0.0.1:19740";
export async function settings(directory = root) {
  const file = join(pathsFor(directory).directory, "keys.json");
  await ensureLogFile(file);
  let lock;
  const lockPath = file + ".init-lock";
  const deadline = Date.now() + 2000;
  while (!lock) {
    try {
      lock = await open(lockPath, "wx", 0o600);
      await lock.writeFile(String(process.pid));
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() > deadline)
        throw Error(
          "Logging settings are busy; inspect the private init lock before retrying",
        );
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.nlink !== 1 || info.isSymbolicLink())
      throw Error("Unsafe logging settings");
    const raw = await readFile(file, "utf8");
    if (raw) {
      const config = JSON.parse(raw);
      if (
        !config.keys ||
        !sources.every((source) => /^[a-f0-9]{64}$/.test(config.keys[source]))
      )
        throw Error("Invalid logging keys");
      return config;
    }
    const config = {
      keys: Object.fromEntries(
        sources.map((source) => [source, randomBytes(32).toString("hex")]),
      ),
      extensionOrigins: [],
    };
    const handle = await open(file, "w", 0o600);
    try {
      await handle.writeFile(JSON.stringify(config));
    } finally {
      await handle.close();
    }
    return config;
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

async function reuseTools() {
  const previous = join(dirname(root), "chat-workspace");
  try {
    const vector = await verifiedVector(previous);
    const viewer = viewerPaths(previous);
    const manifest = JSON.parse(await readFile(viewer.manifest, "utf8"));
    if (
      manifest.logdyVersion !== "0.17.1" ||
      manifest.goVersion !== "1.27.2" ||
      manifest.sourceSha256 !==
        "0e8ac3bfe79bfb161e31e42fb2094f17e9a2e1583b698860abadd32731a3e87d" ||
      !(await verifyPinnedFile(viewer.binary, manifest.binarySha256))
    )
      return false;
    const official = vectorPaths(root),
      patched = patchedVectorPaths(root),
      targetViewer = viewerPaths(root);
    for (const [src, dst] of [
      [vector.archive, official.archive],
      [patchedVectorPaths(previous).archive, patched.archive],
      [vector.officialBinary, official.binary],
      [vector.manifest, official.manifest],
      [vector.binary, patched.binary],
      [patchedVectorPaths(previous).manifest, patched.manifest],
      [viewer.binary, targetViewer.binary],
      [viewer.manifest, targetViewer.manifest],
    ]) {
      try {
        await lstat(dst);
        continue;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await ensureLogFile(dst);
      await copyFile(src, dst);
      await chmod(
        dst,
        dst === official.binary ||
          dst === patched.binary ||
          dst === targetViewer.binary
          ? 0o700
          : 0o600,
      );
    }
    await verifiedVector(root);
    return true;
  } catch {
    return false;
  }
}
async function healthy() {
  try {
    const res = await fetch(endpoint + "/health", {
      signal: AbortSignal.timeout(1000),
    });
    if (!res.ok) return null;
    const result = await res.json();
    return typeof result.captureId === "string" &&
      result.stats &&
      result.workspaceId === workspaceIdFor(root)
      ? result
      : null;
  } catch {
    return null;
  }
}
const wait = (child) =>
  new Promise((resolve, reject) => {
    child.once("error", () =>
      reject(Error("Could not start the selected local command")),
    );
    child.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(Error(`Local command exited with status ${code}`)),
    );
  });
const commands = {
  provider: ["python3", ["service.py"]],
  backend: ["pnpm", ["run", "start:dev"]],
  "web-client": [
    "npm",
    [
      "run",
      "dev",
      "--",
      "--host",
      "127.0.0.1",
      "--port",
      "5173",
      "--strictPort",
    ],
  ],
  dashboard: [
    "npm",
    [
      "run",
      "dev",
      "--",
      "--host",
      "127.0.0.1",
      "--port",
      "5174",
      "--strictPort",
    ],
  ],
  "landing-page": [
    "npm",
    [
      "run",
      "dev",
      "--",
      "--host",
      "127.0.0.1",
      "--port",
      "5175",
      "--strictPort",
    ],
  ],
  worker: ["node", ["dist/src/cli/main.js"]],
  macos: ["node", ["dist/companion/cli.js"]],
  "chrome-extension": ["npm", ["run", "build:debug"]],
  "windows-desktop": ["npm", ["run", "build:debug"]],
};
const directories = {
  macos: "chrome-extension",
  "landing-page": "landing_page",
};
export async function main(args = process.argv.slice(2)) {
  const [command, ...rest] = args;
  if (command === "provider") return main(["run", "provider", ...rest]);
  if (command === "install") {
    if (!(await reuseTools())) {
      await installVector(root);
      await installViewer(root);
    }
    console.log(
      "Verified pinned Vector 0.59.0 (file-readiness patch) and Logdy 0.17.1.",
    );
    return;
  }
  if (command === "verify-tools") {
    await verifiedVector(root);
    await verifiedViewer(root);
    console.log("Pinned logging tools verified.");
    return;
  }
  if (command === "allow-extension") {
    if (rest.length !== 1 || !/^[a-p]{32}$/.test(rest[0]))
      throw Error(
        "Expected a Chrome extension ID (32 lowercase a-p characters)",
      );
    const config = await settings();
    const origin = `chrome-extension://${rest[0]}`;
    config.extensionOrigins = [
      ...new Set([...config.extensionOrigins, origin]),
    ].slice(0, 8);
    const file = join(pathsFor().directory, "keys.json");
    const handle = await open(file, "w", 0o600);
    await handle.writeFile(JSON.stringify(config));
    await handle.close();
    console.log(
      "Extension origin registered. Restart the owned collector to apply.",
    );
    return;
  }
  if (command === "health") {
    const health = await healthy();
    if (!health) throw Error("Collector unavailable on " + endpoint);
    console.log(JSON.stringify(health, null, 2));
    if (
      !health.vectorAlive ||
      health.maintenanceFailure ||
      health.freshness?.healthy === false
    )
      process.exitCode = 1;
    return;
  }
  if (command === "run") {
    const [component, ...extra] = rest;
    let componentDirectory = directories[component] ?? component;
    if (component === "provider") {
      const adapter = extra.shift();
      if (
        !["router", "videoscale", "tunelio", "jojapi", "ytdlp"].includes(
          adapter,
        )
      )
        throw Error("Unknown acquisition adapter");
      componentDirectory = "video_providers/" + adapter;
    }
    if (!commands[component]) throw Error("Unknown component");
    const health = await healthy();
    if (
      !health ||
      !health.vectorAlive ||
      health.maintenanceFailure ||
      health.freshness?.healthy === false
    )
      throw Error(
        "Start a healthy collector first: node tools/local-logging/cli.mjs start",
      );
    if (
      ["production", "release"].includes(process.env.NODE_ENV) ||
      ["production", "staging"].includes(process.env.APP_ENV)
    )
      throw Error("Full logging cannot run in production/release.");
    const config = await settings();
    const defaults = {
      NODE_ENV: "development",
      APP_ENV: "local",
      MUSICMUTE_LOG_ENABLED: "1",
      MUSICMUTE_LOG_PAYLOADS: "1",
      MUSICMUTE_LOG_CONSOLE: "0",
      MUSICMUTE_LOG_ENDPOINT: endpoint + "/ingest/" + component,
      MUSICMUTE_LOG_KEY: config.keys[component],
      MUSICMUTE_LOG_CAPTURE_ID: health.captureId,
      VITE_MUSICMUTE_LOG_ENABLED: "1",
      VITE_MUSICMUTE_LOG_PAYLOADS: "1",
      VITE_MUSICMUTE_LOG_CONSOLE: "0",
    };
    const env = { ...defaults, ...process.env };
    const [bin, base] = commands[component];
    const child = spawn(bin, [...base, ...extra], {
      cwd: join(root, componentDirectory),
      env,
      stdio: ["inherit", "pipe", "pipe"],
    });
    // Never let arbitrary child stderr bypass local redaction into the console.
    const observer = processObserver({
      endpoint: defaults.MUSICMUTE_LOG_ENDPOINT,
      key: config.keys[component],
      enabled: env.MUSICMUTE_LOG_ENABLED === "1",
    });
    for (const [stream, streamName] of [
      [child.stdout, "stdout"],
      [child.stderr, "stderr"],
    ]) {
      let pending = "",
        privateKey = false;
      const consume = (line) => {
        if (!line) return;
        observer.emit(streamName, line);
        if (/-----BEGIN.*PRIVATE KEY-----/.test(line)) {
          privateKey = true;
          console.log("[private key block omitted]");
        }
        if (privateKey) {
          if (/-----END.*PRIVATE KEY-----/.test(line)) privateKey = false;
          return;
        }
        const safe = redact(line);
        if (
          safe &&
          typeof safe === "object" &&
          ["info", "warn", "error", "debug"].includes(safe.level) &&
          typeof safe.name === "string" &&
          /^[A-Za-z0-9_.-]{1,128}$/.test(safe.name)
        ) {
          console.log(`[${component}] ${safe.level} ${safe.name}`);
        } else {
          const severity = /\b(error|fatal|exception|failed)\b/i.test(line)
            ? "error"
            : /\bwarn(?:ing)?\b/i.test(line)
              ? "warn"
              : "info";
          console.log(
            `[${component}] ${severity} ${streamName} (${Buffer.byteLength(line)} bytes; unstructured text omitted)`,
          );
        }
      };
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        pending += chunk;
        const lines = pending.split("\n");
        pending = lines.pop();
        if (pending.length > 16384)
          pending = "[oversized process line omitted]";
        for (const line of lines) consume(line);
      });
      stream.on("end", () => {
        consume(pending);
        pending = "";
      });
    }
    const stop = () => child.kill("SIGTERM");
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      await wait(child);
    } finally {
      await observer.close();
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
    return;
  }
  if (command === "start" || command === "up" || command === "viewer") {
    const current = await healthy();
    if (
      current &&
      (!current.vectorAlive ||
        current.maintenanceFailure ||
        current.freshness?.healthy === false)
    )
      throw Error(
        "Existing collector is unhealthy; inspect health before restarting the owned command",
      );
    let viewerExists = false;
    try {
      const response = await fetch("http://127.0.0.1:19742/api/status", {
        signal: AbortSignal.timeout(700),
      });
      const status = await response.json();
      viewerExists =
        response.ok &&
        JSON.parse(status.configStr).name === createViewerLayout(root).name;
    } catch {
      /* A missing or unrelated viewer is never stopped. */
    }
    if (
      (command === "start" && current) ||
      (command === "viewer" && viewerExists) ||
      (command === "up" && current && viewerExists)
    ) {
      console.log(
        "Existing healthy local logging processes reused. Logdy: http://127.0.0.1:19742/",
      );
      return;
    }
    let collector, viewer;
    try {
      if (command !== "viewer" && !current)
        collector = await startCollector({ ...(await settings()) });
      if (command !== "start" && !viewerExists)
        viewer = await startLogViewer({
          root,
          file: pathsFor().events,
          port: 19742,
        });
      if (collector || current) console.log("Collector: " + endpoint);
      if (viewer || viewerExists) console.log("Logdy: http://127.0.0.1:19742/");
      console.log("Ctrl-C stops only this command’s owned processes.");
      await new Promise((resolve) => {
        process.once("SIGINT", resolve);
        process.once("SIGTERM", resolve);
        collector?.done.then(resolve);
        viewer?.child.once("close", resolve);
      });
    } finally {
      await viewer?.close();
      await collector?.close();
    }
    return;
  }

  console.log(
    "Usage: node tools/local-logging/cli.mjs install|verify-tools|start|viewer|up|health|run <backend|web-client|dashboard|landing-page|worker|macos|chrome-extension|windows-desktop> [arguments]|allow-extension <id>",
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    console.error(
      "Local logging command failed. Check tool installation, occupied ports and private Vector diagnostics. No unrelated service was stopped.",
    );
    process.exitCode = 1;
  });
