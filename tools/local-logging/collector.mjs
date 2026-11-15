import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { lstat, readFile, open, chmod, unlink } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureLogFile, childEnvironment } from "./backend-logs.mjs";
import { verifiedVector } from "./vector-tool.mjs";
import { createPrivateProcessLog } from "./private-process-log.mjs";
import {
  archiveCapture,
  pruneArchives,
  retentionPolicy,
} from "./log-retention.mjs";
import {
  InputLogRetentionError,
  pruneConsumedInputArchives,
} from "./input-log-retention.mjs";
import { startIngress } from "./ingress.mjs";
import {
  addNativeJournalSources,
  discoverMusicMuteJournals,
} from "./native-journals.mjs";
export const root = fileURLToPath(new URL("../../", import.meta.url));
export const workspaceIdFor = (directory) =>
  createHash("sha256").update(directory).digest("hex").slice(0, 16);
const maintenanceErrorCodes = new Set([
  "ENOENT",
  "EACCES",
  "EPERM",
  "EIO",
  "ENOSPC",
  "EROFS",
  "EMFILE",
  "ENFILE",
  "EBUSY",
  "ELOOP",
  "UNSAFE_INPUT_LOG_FILES",
  "VECTOR_EXITED",
]);
export function pathsFor(directory = root) {
  const directoryPath = join(directory, ".runtime/local-logging");
  return {
    directory: directoryPath,
    input: join(directoryPath, "inputs/application.jsonl"),
    events: join(directoryPath, "events.jsonl"),
    state: join(directoryPath, "vector-state"),
    config: join(directoryPath, "vector.json"),
    processLog: join(directoryPath, "vector-process.jsonl"),
  };
}
function fileSource(file, owned = true) {
  return {
    type: "file",
    include: owned
      ? [file, join(dirname(file), "archives", "application.*.jsonl")]
      : [file],
    read_from: owned ? "beginning" : "end",
    max_line_bytes: 131072,
    max_read_bytes: 262144,
    glob_minimum_cooldown_ms: 250,
    ignore_checkpoints: false,
    fingerprint: { strategy: "checksum", lines: 1 },
  };
}
export function configuration(
  paths,
  captureId,
  nativeFiles = {},
  journalFiles = {},
) {
  const sources = { application: fileSource(paths.input) },
    transforms = {
      normalize: {
        type: "remap",
        inputs: ["application"],
        drop_on_error: true,
        source:
          "record = parse_json!(string!(.message))\n. = object!(record)\n.collectedAt = now()\n",
      },
    };
  for (const [name, file] of Object.entries(nativeFiles)) {
    sources[`native_${name}`] = fileSource(file, false);
    // Existing server-owned logs are read only. Unbounded native messages/attrs may
    // contain auth commands or user data: retain only safe server event metadata.
    transforms[`normalize_native_${name}`] = {
      type: "remap",
      inputs: [`native_${name}`],
      drop_on_error: true,
      source: `parsed, err = parse_json(string!(.message))
collected = now()
severity = "info"
component = "server"
event_code = null
source_time = null
if err == null && is_object(parsed) {
 if parsed.s == "E" || parsed.s == "F" || parsed.level == "error" { severity = "error" }
 if parsed.s == "W" || parsed.level == "warn" { severity = "warn" }
 if is_string(parsed.c) && match(string!(parsed.c), r'^[A-Za-z0-9_.-]{1,64}$') { component = string!(parsed.c) }
 if is_integer(parsed.id) { event_code = parsed.id }
 candidate = parsed.timestamp
 if is_string(parsed.t."$date") { candidate = parsed.t."$date" }
 if is_string(candidate) { source_time, time_error = parse_timestamp(string!(candidate), format: "%+") }
}
. = { "timestamp": collected, "timestampSource": "collection", "receivedAt": collected, "collectedAt": collected, "level": severity, "source": ${JSON.stringify(name)}, "origin": "server_log", "category": "server", "name": "native_server_event", "event": "native_server_event", "summary": "Native server diagnostic; arbitrary text omitted", "instanceId": ${JSON.stringify(name + "-local-server")}, "captureId": ${JSON.stringify(captureId)}, "requestId": null, "userId": null, "component": component, "sourceEventCode": event_code, "data": { "omitted": "native_unstructured_message_and_sensitive_attributes" } }
if is_timestamp(source_time) { .timestamp = source_time; .sourceTimestamp = source_time; .timestampSource = "service" }
`,
    };
  }
  addNativeJournalSources(sources, transforms, captureId, journalFiles);
  return {
    data_dir: paths.state,
    sources,
    transforms,
    sinks: {
      capture: {
        type: "file",
        inputs: Object.keys(transforms),
        path: paths.events,
        acknowledgements: { enabled: true },
        encoding: { codec: "json", timestamp_format: "rfc3339" },
        framing: { method: "newline_delimited" },
        buffer: { type: "memory", max_events: 1000, when_full: "block" },
      },
    },
  };
}
export async function captureSnapshot(paths) {
  try {
    const entry = await lstat(paths.events);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1)
      throw Error();
    const handle = await open(
      paths.events,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1) throw Error();
      const size = Math.min(stat.size, 262144),
        buf = Buffer.alloc(size);
      await handle.read(buf, 0, size, stat.size - size);
      const lines = buf.toString().trim().split("\n");
      const records = lines.slice(stat.size > size ? 1 : 0).flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
      return {
        bytes: stat.size,
        lastModifiedAt: new Date(stat.mtimeMs).toISOString(),
        lastCollectedAt: records.at(-1)?.collectedAt,
        sourcesInRecentWindow: [...new Set(records.map((r) => r.source))],
        recentRecords: records.length,
        latestIngressByCapture: Object.fromEntries(
          [
            ...new Set(records.map((r) => r.ingressInstanceId).filter(Boolean)),
          ].map((id) => [
            id,
            Math.max(
              0,
              ...records
                .filter((r) => r.ingressInstanceId === id)
                .map((r) => r.ingressSequence ?? 0),
            ),
          ]),
        ),
      };
    } finally {
      await handle.close();
    }
  } catch {
    return { missing: true };
  }
}
export async function discoverNativeFiles(env = process.env) {
  const files = {},
    missing = [];
  for (const [source, key, fallback] of [
    [
      "mongodb",
      "MUSICMUTE_MONGODB_LOG_FILE",
      "/opt/homebrew/var/log/mongodb/mongod.log",
    ],
    ["redis", "MUSICMUTE_REDIS_LOG_FILE", "/opt/homebrew/var/log/redis.log"],
  ]) {
    const file = env[key] ?? fallback;
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink()) throw Error();
      files[source] = file;
    } catch {
      missing.push(source);
    }
  }
  return { files, missing };
}
const exited = (child) =>
  new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              "Owned Vector process failed; inspect private diagnostics.",
            ),
          ),
    );
  });
export async function startCollector({
  directory = root,
  toolsRoot = root,
  nativeFiles,
  journalFiles,
  keys,
  extensionOrigins = [],
  port = 19740,
  retention = retentionPolicy(),
  interval = 2000,
} = {}) {
  const paths = pathsFor(directory),
    tool = await verifiedVector(toolsRoot),
    captureId = randomUUID();
  let lock,
    child,
    ingress,
    processLog,
    timer,
    maintaining,
    closing = false,
    intentional = false,
    lastHealth = {},
    maintenanceFailure = false,
    lastProgressAt = Date.now(),
    lastSequence = 0;
  const maintenance = {
    failures: 0,
    consecutiveFailures: 0,
    lastFailureAt: null,
    lastFailurePhase: null,
    lastFailureCode: null,
    lastSuccessAt: null,
  };
  const recordMaintenanceFailure = (phase, error) => {
    maintenanceFailure = true;
    maintenance.failures++;
    maintenance.consecutiveFailures++;
    maintenance.lastFailureAt = new Date().toISOString();
    maintenance.lastFailurePhase = phase;
    maintenance.lastFailureCode = maintenanceErrorCodes.has(error?.code)
      ? error.code
      : "MAINTENANCE_FAILED";
  };
  let completeLifetime;
  const done = new Promise((resolve) => {
    completeLifetime = resolve;
  });
  const oldMask = process.umask(0o077);
  try {
    for (const path of [
      paths.input,
      paths.events,
      paths.processLog,
      join(paths.state, ".private"),
    ])
      await ensureLogFile(path);
    const lockPath = join(paths.directory, "collector.lock");
    try {
      lock = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const info = await lstat(lockPath);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
        throw Error("Unsafe collector lock");
      const pid = Number(await readFile(lockPath, "utf8"));
      if (!Number.isInteger(pid) || pid <= 1)
        throw Error("Invalid collector lock; inspect before starting");
      try {
        process.kill(pid, 0);
        throw Error("Collector lock belongs to a running process");
      } catch (probeError) {
        if (probeError.code !== "ESRCH") throw probeError;
      }
      await unlink(lockPath);
      lock = await open(lockPath, "wx", 0o600);
    }
    await lock.writeFile(String(process.pid));
    const native = nativeFiles
      ? { files: nativeFiles, missing: [] }
      : await discoverNativeFiles();
    const journals = journalFiles
      ? { files: journalFiles, missing: [] }
      : nativeFiles
        ? { files: {}, missing: [] }
        : await discoverMusicMuteJournals();
    await ensureLogFile(paths.config);
    await chmod(paths.state, 0o700);
    const configHandle = await open(paths.config, "w", 0o600);
    await configHandle.writeFile(
      JSON.stringify(
        configuration(paths, captureId, native.files, journals.files),
      ),
    );
    await configHandle.close();
    processLog = await createPrivateProcessLog(paths.processLog, {
      policy: retention,
    });
    const launch = (args) => {
      const next = spawn(tool.binary, args, {
        env: { ...childEnvironment(), VECTOR_LOG: "warn", VECTOR_THREADS: "2" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      for (const stream of [next.stdout, next.stderr])
        stream.on("data", (chunk) => processLog.append(chunk));
      return next;
    };
    await exited(
      launch([
        "validate",
        "--no-environment",
        "--skip-healthchecks",
        paths.config,
      ]),
    );
    const launchVector = async () => {
      const next = launch(["--config", paths.config]);
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(resolve, 700);
        next.once("error", () => {
          clearTimeout(timeout);
          reject(Error("Vector start failed"));
        });
        next.once("exit", () => {
          clearTimeout(timeout);
          reject(Error("Vector exited on startup"));
        });
      });
      next.once("close", () => {
        if (!intentional && !closing) {
          recordMaintenanceFailure("vector_lifetime", {
            code: "VECTOR_EXITED",
          });
          completeLifetime();
        }
      });
      return next;
    };
    child = await launchVector();
    ingress = await startIngress({
      file: paths.input,
      keys,
      port,
      captureId,
      extensionOrigins,
      healthDetails: () => ({
        workspaceId: workspaceIdFor(directory),
        vectorDiagnostics: processLog.stats(),
        freshness: {
          healthy:
            ingress.stats.lastWrittenSequence <= lastSequence ||
            Date.now() - lastProgressAt < 5000,
          outstanding: Math.max(
            0,
            ingress.stats.lastWrittenSequence - lastSequence,
          ),
          lastProgressAt: new Date(lastProgressAt).toISOString(),
        },
        vectorAlive: child?.exitCode === null && child?.signalCode === null,
        maintenanceFailure,
        maintenance: { ...maintenance },
        capture: lastHealth,
        nativeSources: Object.keys(native.files),
        missingNativeSources: native.missing,
        journalSources: Object.keys(journals.files),
        missingJournalSources: journals.missing,
      }),
    });
    let openedAt = Date.now();
    const stopVector = async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      intentional = true;
      const done = exited(child);
      child.kill("SIGTERM");
      await done;
    };
    async function maintain() {
      if (maintaining || closing) return maintaining;
      let phase = "capture_snapshot";
      maintaining = (async () => {
        lastHealth = await captureSnapshot(paths);
        const observed = lastHealth.latestIngressByCapture?.[captureId] ?? 0;
        const confirmed = Math.max(lastSequence, observed);
        if (
          confirmed > lastSequence ||
          ingress.stats.lastWrittenSequence <= confirmed
        ) {
          lastProgressAt = Date.now();
        }
        // Native-only traffic can evict an already confirmed ingress sequence
        // from this bounded tail. Confirmation remains valid for this capture.
        lastSequence = confirmed;
        phase = "capture_stat";
        const info = await lstat(paths.events);
        if (
          info.size &&
          (info.size >= retention.maxBytes ||
            Date.now() - openedAt >= retention.rotateAfterMs)
        ) {
          phase = "vector_stop";
          await stopVector();
          phase = "capture_rotate";
          await archiveCapture(paths.events);
          openedAt = Date.now();
          phase = "vector_start";
          child = await launchVector();
          intentional = false;
        }
        phase = "capture_prune";
        await pruneArchives(paths.events, retention);
        phase = "input_prune";
        lastHealth.inputRetention = await pruneConsumedInputArchives(
          paths.input,
          join(paths.state, "application/checkpoints.json"),
          { ...retention, maxArchives: 16 },
        );
        if (lastHealth.inputRetention.unsafeArchives)
          throw new InputLogRetentionError();
        phase = "vector_lifetime";
        if (child.exitCode !== null || child.signalCode !== null)
          throw Object.assign(new Error("Owned Vector is unavailable."), {
            code: "VECTOR_EXITED",
          });
        maintenanceFailure = false;
        maintenance.consecutiveFailures = 0;
        maintenance.lastSuccessAt = new Date().toISOString();
      })()
        .catch((error) => {
          recordMaintenanceFailure(phase, error);
        })
        .finally(() => {
          maintaining = undefined;
        });
      return maintaining;
    }
    timer = setInterval(() => void maintain(), interval);
    timer.unref();
    await maintain();
    let closePromise;
    const close = () =>
      (closePromise ??= (async () => {
        closing = true;
        clearInterval(timer);
        await maintaining;
        await ingress.close();
        await stopVector();
        await processLog.close();
        await lock.close();
        await unlink(join(paths.directory, "collector.lock"));
      })());
    return {
      paths,
      captureId,
      ingress,
      done,
      get child() {
        return child;
      },
      close,
      maintain,
    };
  } catch (error) {
    clearInterval(timer);
    await ingress?.close();
    child?.kill("SIGTERM");
    await processLog?.close();
    if (lock) {
      await lock.close();
      await unlink(join(paths.directory, "collector.lock")).catch(() => {});
    }
    throw error;
  } finally {
    process.umask(oldMask);
  }
}
