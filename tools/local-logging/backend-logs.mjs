import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  createReadStream,
  readFileSync,
  constants as fsConstants,
} from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  unlink,
} from "node:fs/promises";
import http from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createLogProxy } from "./backend-logs-proxy.mjs";

export const LOGDY_VERSION = "0.17.1";
export const VIEWER_URL = "http://127.0.0.1:19742/";
export const GO_TOOLCHAIN = Object.freeze({
  version: "1.27.2",
  platform: "darwin",
  arch: "arm64",
  filename: "go1.27.2.darwin-arm64.tar.gz",
  size: 68195916,
  sha256: "76812b213b1b2302c978d28fa52fa92d541704b9e7d9d5db8002c50e4018c4c5",
  url: "https://go.dev/dl/go1.27.2.darwin-arm64.tar.gz",
});
const defaultRoot = fileURLToPath(new URL("../../", import.meta.url));
const bridgeSourcePath = fileURLToPath(
  new URL("./logdy-bridge.go", import.meta.url),
);
const bridgeSource = readFileSync(bridgeSourcePath, "utf8");
const bridgeSourceDigest = createHash("sha256")
  .update(bridgeSource)
  .digest("hex");
const buildId = bridgeSourceDigest.slice(0, 16);
const installInstruction =
  "Run node tools/local-logging/cli.mjs install first.";
class ViewerError extends Error {}

export function viewerPaths(root = defaultRoot) {
  const installDir = resolve(root, ".runtime", "backend-log-viewer");
  const toolchainDir = join(installDir, `go${GO_TOOLCHAIN.version}`);
  return {
    installDir,
    toolchainDir,
    goBinary: join(toolchainDir, "go", "bin", "go"),
    archive: join(installDir, GO_TOOLCHAIN.filename),
    moduleDir: join(installDir, `bridge-module-${buildId}`),
    binary: join(installDir, `logdy-bridge-${buildId}`),
    manifest: join(installDir, `bridge-${buildId}.json`),
    source: bridgeSourcePath,
    layout: join(
      installDir,
      `layout-${createHash("sha256")
        .update(JSON.stringify(createViewerLayout(root)))
        .digest("hex")
        .slice(0, 16)}.json`,
    ),
    processLog: join(installDir, "process.log"),
    socketDir: resolve(root, ".runtime", "logdy"),
    logFile: resolve(root, ".runtime", "backend-logs", "traffic.jsonl"),
    unifiedFile: resolve(root, ".runtime", "local-logging", "events.jsonl"),
  };
}

export function childEnvironment(inherited = process.env) {
  return Object.fromEntries(
    ["PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TERM"]
      .filter((key) => typeof inherited[key] === "string")
      .map((key) => [key, inherited[key]]),
  );
}

export function createViewerLayout(root = defaultRoot) {
  const fields = [
    ["timestamp", "Cairo time", 120],
    ["level", "Level", 70],
    ["source", "Source", 120],
    ["event", "Operation / event", 190],
    ["result", "Result", 90],
    ["summary", "What happened", 360],
    ["phase", "Phase", 100],
    ["method", "Method", 70],
    ["route", "Route", 200],
    ["status", "Status", 70],
    ["durationMs", "Duration (ms)", 100],
    ["userId", "User", 210],
    ["requestId", "Request ID", 280, true],
    ["jobId", "Job", 200, true],
    ["importId", "Import", 200, true],
    ["category", "Category", 140, true],
    ["instanceId", "Instance", 230, true],
    ["traceId", "Trace ID", 160, true],
    ["spanId", "Span ID", 120, true],
    ["parentSpanId", "Parent span", 120, true],
    ["captureId", "Capture", 230, true],
    ["origin", "Observer", 140, true],
  ];
  return {
    name:
      "MusicMute logs " +
      createHash("sha256").update(root).digest("hex").slice(0, 16),
    settings: {
      maxMessages: 1000,
      entriesOrder: "desc",
      leftColWidth: 240,
      drawerColWidth: 680,
      middlewares: [
        {
          id: "musicmute-context",
          name: "MusicMute context",
          handlerTsCode: `(line: Message): Message => {
  const d = line.json_content || {};
  const timestamp = Date.parse(d.timestamp);
  if (Number.isFinite(timestamp)) { line.ts = timestamp; line.order_key = timestamp; }
  if (typeof d.requestId === 'string') line.correlation_id = d.requestId;
  else if (d.instanceId && d.traceId) line.correlation_id = d.source + '/' + d.instanceId + '/' + d.traceId;
  if (d.level === 'error') line.style = { background: '#3f1720' };
  else if (d.level === 'warn') line.style = { background: '#3a2d14' };
  return line;
}`,
        },
      ],
    },
    columns: fields.map(([field, name, width, hidden = false]) => ({
      id: `musicmute-${field}`,
      name,
      width,
      hidden,
      faceted: field !== "timestamp" && field !== "durationMs",
      handlerTsCode: `(line: Message): CellHandler => {
  const data = line.json_content || {};
  const value = ${field === "event" ? "data.name ?? data.operation ?? data.event" : field === "eventKind" ? "data.event" : field === "channel" ? "data.channel ?? (Array.isArray(data.data?.channels) ? data.data.channels.join(', ') : undefined)" : `data[${JSON.stringify(field)}]`};
${
  field === "timestamp"
    ? `  const timestamp = typeof value === 'string' ? Date.parse(value) : NaN;
  if (Number.isFinite(timestamp)) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Africa/Cairo', day: '2-digit', hour: '2-digit',
      minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(timestamp).map(part => [part.type, part.value]));
    return { text: parts.day + ' ' + parts.hour + ':' + parts.minute + ':' + parts.second };
  }
`
    : ""
}  return { text: value == null ? '—' : String(value) };
}`,
    })),
  };
}

async function privateDirectory(path) {
  await assertNoSymlinkAncestors(path);
  await mkdir(path, { recursive: true, mode: 0o700 });
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new ViewerError(
      "Viewer runtime directories must not be symbolic links.",
    );
  }
  await chmod(path, 0o700);
}

async function assertNoSymlinkAncestors(path) {
  let parent = dirname(path);
  while (true) {
    try {
      const entry = await lstat(parent);
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new ViewerError(
          "Log file directories must not be symbolic links.",
        );
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const next = dirname(parent);
    if (next === parent) break;
    parent = next;
  }
}

async function runtimeDirectories(root, paths) {
  await privateDirectory(resolve(root, ".runtime"));
  await privateDirectory(paths.installDir);
  await privateDirectory(paths.socketDir);
}

export async function ensureLogFile(file, { createParent = true } = {}) {
  if (createParent) await privateDirectory(dirname(file));
  let handle;
  try {
    await assertNoSymlinkAncestors(file);
    try {
      const entry = await lstat(file);
      if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) {
        throw new ViewerError("Choose a regular log file without links.");
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    handle = await open(
      file,
      fsConstants.O_WRONLY |
        fsConstants.O_APPEND |
        fsConstants.O_CREAT |
        fsConstants.O_NOFOLLOW |
        fsConstants.O_NONBLOCK,
      0o600,
    );
    const entry = await handle.stat();
    if (!entry.isFile() || entry.nlink !== 1) {
      throw new ViewerError("Choose a regular log file without links.");
    }
    await handle.chmod(0o600);
  } catch (error) {
    if (error instanceof ViewerError) throw error;
    throw new ViewerError("Could not open the private log file for append.");
  } finally {
    await handle?.close();
  }
  return file;
}

export async function fileDigest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function verifyPinnedFile(path, expectedDigest) {
  try {
    const entry = await lstat(path);
    return (
      entry.isFile() &&
      !entry.isSymbolicLink() &&
      entry.nlink === 1 &&
      (await fileDigest(path)) === expectedDigest
    );
  } catch {
    return false;
  }
}

async function writeNewPrivateFile(path, contents) {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(contents);
  } finally {
    await handle.close();
  }
}

async function exactConfigFile(path, contents) {
  try {
    await writeNewPrivateFile(path, contents);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const entry = await lstat(path);
    if (
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      (await readFile(path, "utf8")) !== contents
    ) {
      throw new ViewerError(
        "Existing viewer configuration differs from the trusted configuration; it was preserved.",
      );
    }
    await chmod(path, 0o600);
  }
}

async function downloadToolchain(paths) {
  try {
    await lstat(paths.archive);
    if (!(await verifyPinnedFile(paths.archive, GO_TOOLCHAIN.sha256))) {
      throw new ViewerError(
        "Existing Go archive failed its checksum; it was preserved.",
      );
    }
    return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const response = await fetch(GO_TOOLCHAIN.url, {
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok || !response.body) {
    throw new ViewerError(
      "Could not download the pinned official Go toolchain.",
    );
  }
  const temporary = `${paths.archive}.${randomBytes(6).toString("hex")}.download`;
  const file = await open(temporary, "wx", 0o600);
  const hash = createHash("sha256");
  let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > GO_TOOLCHAIN.size) throw new Error("Unexpected archive size");
      hash.update(chunk);
      await file.writeFile(chunk);
    }
    if (
      size !== GO_TOOLCHAIN.size ||
      hash.digest("hex") !== GO_TOOLCHAIN.sha256
    ) {
      throw new ViewerError(
        "Official Go toolchain download failed checksum verification.",
      );
    }
    await file.close();
    if (!(await verifyPinnedFile(temporary, GO_TOOLCHAIN.sha256))) {
      throw new ViewerError("Written Go archive failed checksum verification.");
    }
    await link(temporary, paths.archive);
  } finally {
    await file.close().catch(() => {});
    // Only this invocation's generated temporary download is removed.
    await unlink(temporary).catch(() => {});
  }
}

function runCommand(command, args, { cwd, env, log }) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", log, log],
    });
    child.once("error", () =>
      rejectRun(new ViewerError("Viewer installation command failed.")),
    );
    child.once("close", (code) => {
      if (code === 0) resolveRun();
      else
        rejectRun(
          new ViewerError(
            "Viewer installation command failed; inspect the private process log.",
          ),
        );
    });
  });
}

function goEnvironment(paths) {
  return {
    ...childEnvironment(),
    CGO_ENABLED: "0",
    GOENV: "off",
    GOWORK: "off",
    GOTOOLCHAIN: "local",
    GOSUMDB: "sum.golang.org",
    GOPROXY: "https://proxy.golang.org",
    GOPATH: join(paths.installDir, "gopath"),
    GOMODCACHE: join(paths.installDir, "module-cache"),
    GOCACHE: join(paths.installDir, "build-cache"),
    GOTMPDIR: join(paths.installDir, "tmp"),
  };
}

async function verifiedInstallation(paths) {
  try {
    const info = JSON.parse(await readFile(paths.manifest, "utf8"));
    return (
      info.logdyVersion === LOGDY_VERSION &&
      info.goVersion === GO_TOOLCHAIN.version &&
      info.sourceSha256 === bridgeSourceDigest &&
      (await verifyPinnedFile(paths.binary, info.binarySha256))
    );
  } catch {
    return false;
  }
}

export async function verifiedViewer(root = defaultRoot) {
  const paths = viewerPaths(root);
  if (!(await verifiedInstallation(paths)))
    throw new ViewerError("Pinned Logdy is missing or changed.");
  return paths;
}

export async function installViewer(root = defaultRoot) {
  if (
    process.platform !== GO_TOOLCHAIN.platform ||
    process.arch !== GO_TOOLCHAIN.arch
  ) {
    throw new ViewerError(
      "This pinned local viewer installer currently supports macOS ARM64.",
    );
  }
  const paths = viewerPaths(root);
  await runtimeDirectories(root, paths);
  if (await verifiedInstallation(paths)) return paths;
  for (const path of [paths.binary, paths.manifest]) {
    try {
      await lstat(path);
      throw new ViewerError(
        "Existing viewer installation failed verification; files were preserved.",
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const lockPath = join(paths.installDir, ".install.lock");
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch {
    throw new ViewerError(
      "A viewer installation lock exists; inspect it before retrying.",
    );
  }
  await ensureLogFile(paths.processLog, { createParent: false });
  const { createPrivateProcessLog } = await import("./private-process-log.mjs");
  const log = await createPrivateProcessLog(paths.processLog);
  const env = childEnvironment();
  try {
    await downloadToolchain(paths);
    try {
      await lstat(paths.goBinary);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      // A fresh version directory prevents extracting over another install.
      await mkdir(paths.toolchainDir, { mode: 0o700 });
      await runCommand(
        "/usr/bin/tar",
        ["-xzf", paths.archive, "-C", paths.toolchainDir],
        {
          cwd: paths.installDir,
          env,
          log: log.fd,
        },
      );
    }
    await privateDirectory(paths.moduleDir);
    for (const directory of ["gopath", "module-cache", "build-cache", "tmp"]) {
      await privateDirectory(join(paths.installDir, directory));
    }
    await exactConfigFile(
      join(paths.moduleDir, "go.mod"),
      `module chat-workspace-local-log-viewer\n\ngo 1.23.2\n\nrequire github.com/logdyhq/logdy-core v${LOGDY_VERSION}\n`,
    );
    await exactConfigFile(join(paths.moduleDir, "main.go"), bridgeSource);
    const buildPath = `${paths.binary}.${randomBytes(6).toString("hex")}.build`;
    try {
      await runCommand(
        paths.goBinary,
        ["build", "-mod=mod", "-trimpath", "-o", buildPath, "."],
        {
          cwd: paths.moduleDir,
          env: goEnvironment(paths),
          log: log.fd,
        },
      );
      await chmod(buildPath, 0o700);
      const binarySha256 = await fileDigest(buildPath);
      await link(buildPath, paths.binary);
      await writeNewPrivateFile(
        paths.manifest,
        `${JSON.stringify({ logdyVersion: LOGDY_VERSION, goVersion: GO_TOOLCHAIN.version, sourceSha256: bridgeSourceDigest, binarySha256 }, null, 2)}\n`,
      );
    } finally {
      await unlink(buildPath).catch(() => {});
    }
  } finally {
    await log.close();
    await lock.close();
    await unlink(lockPath);
  }
  return paths;
}

function readSocketStatus(socketPath) {
  return new Promise((resolveStatus, rejectStatus) => {
    const request = http.get(
      { socketPath, path: "/api/status", timeout: 500 },
      (response) => {
        response.resume();
        response.once("end", () =>
          response.statusCode === 200
            ? resolveStatus()
            : rejectStatus(new Error()),
        );
      },
    );
    request.once("timeout", () => request.destroy());
    request.once("error", rejectStatus);
  });
}

export async function startLogViewer({
  root = defaultRoot,
  file,
  port = 19742,
} = {}) {
  const paths = viewerPaths(root);
  await runtimeDirectories(root, paths);
  if (!(await verifiedInstallation(paths))) {
    throw new ViewerError(
      `The pinned viewer installation is missing or changed. ${installInstruction}`,
    );
  }
  let logFile = file ? resolve(root, file) : paths.logFile;
  if (!file) {
    try {
      const entry = await lstat(paths.unifiedFile);
      if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1)
        throw new ViewerError(
          "The unified capture must be a regular private file.",
        );
      logFile = paths.unifiedFile;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  await ensureLogFile(logFile, { createParent: !file });
  await exactConfigFile(
    paths.layout,
    `${JSON.stringify(createViewerLayout(root), null, 2)}\n`,
  );
  await ensureLogFile(paths.processLog, { createParent: false });
  const socketPath = join(
    paths.socketDir,
    `${randomBytes(6).toString("hex")}.sock`,
  );
  if (Buffer.byteLength(socketPath) > 103) {
    throw new ViewerError(
      "The workspace path is too long for a private macOS Unix socket.",
    );
  }
  const proxy = await createLogProxy({ upstreamSocketPath: socketPath, port });
  const { createPrivateProcessLog } = await import("./private-process-log.mjs");
  const log = await createPrivateProcessLog(paths.processLog);
  const child = spawn(paths.binary, [], {
    cwd: paths.installDir,
    env: childEnvironment(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => log.append(chunk));
  let childError = false;
  child.once("error", () => {
    childError = true;
  });
  child.stdin.on("error", () => {});
  child.stdin.end(
    JSON.stringify({ socketPath, logFile, layoutFile: paths.layout }),
  );
  let closePromise;
  const close = () => {
    if (!closePromise) {
      closePromise = (async () => {
        await proxy.close();
        if (
          child.exitCode === null &&
          child.signalCode === null &&
          !childError
        ) {
          await new Promise((resolveExit) => {
            const kill = setTimeout(() => child.kill("SIGKILL"), 3000);
            kill.unref();
            child.once("close", () => {
              clearTimeout(kill);
              resolveExit();
            });
            child.kill("SIGTERM");
          });
        }
        await log.close();
      })();
    }
    return closePromise;
  };
  try {
    const deadline = Date.now() + 15_000;
    while (true) {
      if (childError || child.exitCode !== null || child.signalCode !== null)
        throw new Error();
      try {
        await readSocketStatus(socketPath);
        break;
      } catch {
        if (Date.now() > deadline) throw new Error();
        await new Promise((resume) => setTimeout(resume, 100));
      }
    }
  } catch {
    await close();
    throw new ViewerError(
      `Could not start the isolated viewer. Inspect ${paths.processLog}.`,
    );
  }
  child.once("close", () => {
    void close();
  });
  return { url: proxy.url, file: logFile, child, close };
}

export function parseArguments(args) {
  const command = args[0] ?? "start";
  if (!["install", "start", "--help", "-h"].includes(command)) {
    throw new ViewerError(
      "Use node scripts/backend-logs.mjs [install|start [--file PATH]|--help].",
    );
  }
  if (args.length === 1 || args.length === 0) return { command };
  if (
    command === "start" &&
    args.length === 3 &&
    args[1] === "--file" &&
    args[2]
  ) {
    return { command, file: args[2] };
  }
  throw new ViewerError(
    "Use node scripts/backend-logs.mjs [install|start [--file PATH]|--help].",
  );
}

export async function main(args = process.argv.slice(2), root = defaultRoot) {
  const { command, file } = parseArguments(args);
  if (["--help", "-h"].includes(command)) {
    console.log(`Usage: node scripts/backend-logs.mjs [install|start [--file PATH]|--help]
Install builds Apache-2.0 Logdy v${LOGDY_VERSION} with the checksum-pinned official Go ${GO_TOOLCHAIN.version} SDK in ignored .runtime/backend-log-viewer.
Start follows the redacted .runtime/backend-logs/traffic.jsonl at ${VIEWER_URL}
An existing JSONL file can be selected with --file. The API is never started.
The viewer is local, bounded and independent of the API. Ctrl+C stops only this viewer.`);
    return 0;
  }
  if (Number(process.versions.node.split(".")[0]) < 22) {
    throw new ViewerError("The local log viewer requires Node.js >=22.");
  }
  if (command === "install") {
    console.log(
      `Installing isolated Logdy v${LOGDY_VERSION} and pinned Go ${GO_TOOLCHAIN.version}; existing global tools are unchanged.`,
    );
    await installViewer(root);
    console.log(
      "Log viewer installed. Run node scripts/backend-logs.mjs start.",
    );
    return 0;
  }
  const viewer = await startLogViewer({ root, file });
  console.log(
    `Backend log viewer: ${viewer.url}\nFollowing: ${viewer.file}\nThe API stays under your manual control. Ctrl+C stops this viewer.`,
  );
  return new Promise((resolveMain) => {
    const stop = async () => {
      await viewer.close();
      cleanup();
      resolveMain(0);
    };
    const cleanup = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    viewer.child.once("close", (code) => {
      void viewer.close().then(() => {
        cleanup();
        resolveMain(code === 0 || code === null ? 0 : 1);
      });
    });
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(
        error instanceof ViewerError
          ? error.message
          : "Local log viewer failed; inspect the private process log. Existing files were preserved.",
      );
      process.exitCode = 1;
    });
}
