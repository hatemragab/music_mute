import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { privateDirectory } from "./app-setup.js";
import { localToolEnvironment, type LocalConfig } from "./config.js";
import type { PersonalEngineEndpoint } from "../../../worker/src/runtime/personal-reservation.js";

interface EngineOptions {
  signal: AbortSignal;
  onEvent: (event: Record<string, unknown>) => void;
  onSpawn?: (pid: number) => (() => void) | void;
  beforeProcess?: (
    pid: number,
    endpoint: PersonalEngineEndpoint,
  ) => Promise<void>;
}

const execute = promisify(execFile);

interface IdleEngineOptions {
  timeoutMs?: number;
  /** Disposable fixture seam; production queries executable metadata, never argv. */
  findProcesses?: () => Promise<readonly number[]>;
}

async function ownedIdentity(pid: number): Promise<string | undefined> {
  if (!processExists(pid)) return undefined;
  try {
    const { stdout } = await execute(
      "/bin/ps",
      ["-p", String(pid), "-o", "uid=", "-o", "lstart="],
      {
        timeout: 2000,
        maxBuffer: 4096,
        env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
      },
    );
    const match = stdout.trim().match(/^(\d+)\s+(.{10,100})$/u);
    if (!match || Number(match[1]) !== process.getuid?.()) throw new Error();
    return match[2]!;
  } catch {
    if (!processExists(pid)) return undefined;
    throw new Error("ENGINE_EXIT_UNCONFIRMED");
  }
}

async function preparedPythonProcesses(config: LocalConfig): Promise<number[]> {
  const executable = await realpath(config.python_path);
  const { stdout } = await execute(
    "/bin/ps",
    ["-ww", "-U", String(process.getuid?.()), "-o", "pid=", "-o", "comm="],
    {
      timeout: 2000,
      maxBuffer: 1024 * 1024,
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
    },
  ).catch(() => {
    throw new Error("ENGINE_EXIT_UNCONFIRMED");
  });
  const matches: number[] = [];
  for (const line of stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/u);
    if (!match || Number(match[1]) === process.pid) continue;
    const command = match[2]!;
    if (
      command === config.python_path ||
      command === executable ||
      (command.startsWith(join(config.root, "runtime", "releases") + "/") &&
        /^(?:Python|python[0-9.]*)$/u.test(basename(command)))
    )
      matches.push(Number(match[1]));
  }
  return matches;
}

/** Retire historical idle app models under the worker preparation fence.
 * This never starts an engine or signals an accepted personal job. An absent
 * socket is insufficient: an owned prepared-Python process must also be gone.
 */
export async function retireIdleLocalEngine(
  config: LocalConfig,
  options: IdleEngineOptions = {},
): Promise<void> {
  const timeout = options.timeoutMs ?? 15_000;
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 30_000)
    throw new Error("ENGINE_PROTOCOL_INVALID");
  const signal = AbortSignal.timeout(timeout);
  const target = await endpoint(config);
  const known = new Map<number, string>();
  for (const pid of await (options.findProcesses?.() ??
    preparedPythonProcesses(config))) {
    if (signal.aborted) throw new Error("ENGINE_EXIT_UNCONFIRMED");
    if (
      !Number.isSafeInteger(pid) ||
      pid <= 1 ||
      pid > 2 ** 31 - 1 ||
      pid === process.pid
    )
      throw new Error("ENGINE_EXIT_UNCONFIRMED");
    const identity = await ownedIdentity(pid);
    if (identity) known.set(pid, identity);
  }
  const info = await lstat(target.path).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw new Error("ENGINE_SOCKET_UNSAFE");
    },
  );
  if (info) {
    if (
      !info.isSocket() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o777) !== 0o600
    )
      throw new Error("ENGINE_SOCKET_UNSAFE");
    let socket: Socket | undefined;
    try {
      socket = await connect(target.path, signal);
    } catch {
      if (signal.aborted) throw new Error("ENGINE_EXIT_UNCONFIRMED");
    }
    if (socket)
      await new Promise<void>((resolve, reject) => {
        let buffer = "",
          received = false,
          retireSent = false,
          settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", abort);
          socket!.destroy();
          if (error) reject(error);
          else resolve();
        };
        const abort = () => finish(new Error("ENGINE_EXIT_UNCONFIRMED"));
        signal.addEventListener("abort", abort, { once: true });
        socket.once("error", abort);
        socket.once("close", () =>
          finish(
            received && !retireSent
              ? new Error("ENGINE_EXIT_UNCONFIRMED")
              : undefined,
          ),
        );
        socket.setEncoding("utf8");
        socket.on("data", (chunk: string) => {
          buffer += chunk;
          if (buffer.length > 4096 || received) return abort();
          const end = buffer.indexOf("\n");
          if (end < 0) return;
          received = true;
          void (async () => {
            const value: unknown = JSON.parse(buffer.slice(0, end));
            if (!value || typeof value !== "object" || Array.isArray(value))
              throw new Error();
            const ready = value as Record<string, unknown>;
            if (
              ready.type !== "ready" ||
              typeof ready.engine_id !== "string" ||
              !/^[a-f0-9]{64}$/.test(ready.engine_id) ||
              !Number.isSafeInteger(ready.pid) ||
              Number(ready.pid) <= 1 ||
              Number(ready.pid) > 2 ** 31 - 1 ||
              ready.pid === process.pid
            )
              throw new Error();
            const identity = await ownedIdentity(Number(ready.pid));
            if (!identity || signal.aborted || socket!.destroyed)
              throw new Error();
            known.set(Number(ready.pid), identity);
            // A prior app identity may be retired through this owned idle endpoint;
            // it is never permitted to process work for the current identity.
            retireSent = true;
            socket!.write(JSON.stringify({ operation: "retire" }) + "\n");
          })().catch(abort);
        });
        if (signal.aborted) abort();
      });
  }
  while (known.size > 0) {
    for (const [pid, identity] of known) {
      if (signal.aborted) throw new Error("ENGINE_EXIT_UNCONFIRMED");
      if ((await ownedIdentity(pid)) !== identity) known.delete(pid);
    }
    if (known.size === 0) return;
    if (signal.aborted) throw new Error("ENGINE_EXIT_UNCONFIRMED");
    await delay(25);
  }
}

/** App-owned socket; no fleet configuration, credentials, network or browser data. */
async function endpoint(config: LocalConfig) {
  const service = join(dirname(config.runner_path), "local_engine_service.py");
  const root = await realpath(config.root);
  const name = createHash("sha256").update(root).digest("hex").slice(0, 24);
  const directory = join(
    await realpath("/tmp"),
    `mm-engine-${process.getuid?.()}-${name}`,
  );
  await privateDirectory(directory);
  const id = createHash("sha256")
    .update(await readFile(config.runner_path))
    .update(await readFile(service))
    .update(
      JSON.stringify([
        root,
        config.runtime_id,
        config.runtime_root,
        config.python_path,
        config.engine_root,
        config.models_root,
        config.ffmpeg_path,
        config.ffprobe_path,
      ]),
    )
    .digest("hex");
  return { path: join(directory, "engine.sock"), id, root };
}

export async function supportsLocalEngine(
  config: LocalConfig,
): Promise<boolean> {
  // Custom developer/test runners retain their explicit one-shot contract.
  return (
    (
      await lstat(
        join(dirname(config.runner_path), "local_engine_service.py"),
      ).catch(() => undefined)
    )?.isFile() === true
  );
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw new Error("ENGINE_EXIT_UNCONFIRMED");
  }
}

/** Unload the owned idle model before handing the GPU back to the fleet. */
export async function retireLocalEngine(
  config: LocalConfig,
  pid: number,
): Promise<void> {
  if (
    !Number.isSafeInteger(pid) ||
    pid < 1 ||
    pid > 2 ** 31 - 1 ||
    pid === process.pid
  )
    throw new Error("ENGINE_PROTOCOL_INVALID");
  if (!processExists(pid)) return;
  const target = await endpoint(config);
  const signal = AbortSignal.timeout(15_000);
  const info = await lstat(target.path).catch(() => undefined);
  if (
    info &&
    (!info.isSocket() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      info.mode & 0o077)
  )
    throw new Error("ENGINE_SOCKET_UNSAFE");
  let socket: Socket;
  try {
    socket = await connect(target.path, signal);
  } catch {
    // EOF cancellation can kill the engine between the PID probe and connect.
    // Positive OS exit remains sufficient; an unavailable pipe alone is not.
    while (processExists(pid)) {
      if (signal.aborted) throw new Error("ENGINE_EXIT_UNCONFIRMED");
      await delay(25);
    }
    return;
  }
  await new Promise<void>((resolve, reject) => {
    let buffer = "",
      requested = false;
    const fail = () => {
      socket.destroy();
      reject(new Error("ENGINE_EXIT_UNCONFIRMED"));
    };
    signal.addEventListener("abort", fail, { once: true });
    socket.once("error", fail);
    socket.once("close", () => {
      signal.removeEventListener("abort", fail);
      if (requested) resolve();
      else reject(new Error("ENGINE_EXIT_UNCONFIRMED"));
    });
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 4096 || requested) return fail();
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      try {
        const value = JSON.parse(buffer.slice(0, end)) as Record<
          string,
          unknown
        >;
        if (
          value.type !== "ready" ||
          value.engine_id !== target.id ||
          value.pid !== pid
        )
          return fail();
        requested = true;
        socket.write(JSON.stringify({ operation: "retire" }) + "\n");
      } catch {
        fail();
      }
    });
  });
  while (processExists(pid)) {
    if (signal.aborted) throw new Error("ENGINE_EXIT_UNCONFIRMED");
    await delay(25);
  }
}

export async function runLocalEngine(
  config: LocalConfig,
  input: string,
  workRoot: string,
  digest: string,
  options: EngineOptions,
): Promise<Record<string, unknown>> {
  const target = await endpoint(config);
  const signal = AbortSignal.any([
    options.signal,
    AbortSignal.timeout(900_000),
  ]);
  let nextSpawnAt = 0;
  // Retrying a connection/identity negotiation is safe. Once work is sent it
  // is never replayed, even if the response is lost or the engine dies.
  for (let attempt = 0; attempt < 150; attempt++) {
    if (signal.aborted)
      throw new Error(options.signal.aborted ? "CANCELLED" : "TOOL_TIMEOUT");
    let socket: Socket | undefined;
    try {
      const info = await lstat(target.path).catch(() => undefined);
      if (
        info &&
        (!info.isSocket() ||
          info.isSymbolicLink() ||
          info.uid !== process.getuid?.() ||
          info.mode & 0o077)
      )
        throw new Error("ENGINE_SOCKET_UNSAFE");
      socket = await connect(target.path, signal);
      return await exchange(
        socket,
        target.id,
        target.path,
        input,
        workRoot,
        digest,
        signal,
        options,
      );
    } catch (error) {
      socket?.destroy();
      const code =
        error instanceof Error ? error.message : "ENGINE_UNAVAILABLE";
      if (
        !["ENGINE_CONNECT_UNAVAILABLE", "ENGINE_IDENTITY_CHANGED"].includes(
          code,
        )
      )
        throw error;
      if (code === "ENGINE_IDENTITY_CHANGED") nextSpawnAt = 0;
      if (performance.now() >= nextSpawnAt) {
        nextSpawnAt = performance.now() + 1000;
        const env = localToolEnvironment(config);
        // The daemon owns an update lease only while processing; an idle model
        // must not hold an app update open. Its identity is rechecked per request.
        delete env.MUSICMUTE_LOCAL_PARENT_PID;
        const child = spawn(
          config.python_path,
          [
            config.runner_path,
            "--serve",
            "--service-root",
            target.root,
            "--socket",
            target.path,
            "--engine-id",
            target.id,
            "--model-cache",
            config.models_root,
            "--ffmpeg",
            config.ffmpeg_path,
            "--ffprobe",
            config.ffprobe_path,
          ],
          { detached: true, stdio: "ignore", env, cwd: target.root },
        );
        await new Promise<void>((resolve, reject) => {
          child.once("error", () => reject(new Error("ENGINE_UNAVAILABLE")));
          child.once("spawn", () => {
            child.unref();
            resolve();
          });
        });
      }
      await delay(100, undefined, { signal }).catch(() => {});
    }
  }
  throw new Error("ENGINE_UNAVAILABLE");
}

function connect(path: string, signal: AbortSignal): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path });
    const abort = () => socket.destroy(new Error("CANCELLED"));
    const timeout = setTimeout(
      () => socket.destroy(new Error("ENGINE_CONNECT_UNAVAILABLE")),
      5000,
    );
    signal.addEventListener("abort", abort, { once: true });
    const cleanup = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
    };
    socket.once("error", () => {
      cleanup();
      reject(
        new Error(signal.aborted ? "CANCELLED" : "ENGINE_CONNECT_UNAVAILABLE"),
      );
    });
    socket.once("connect", () => {
      cleanup();
      resolve(socket);
    });
    if (signal.aborted) abort();
  });
}

function exchange(
  socket: Socket,
  id: string,
  socketPath: string,
  input: string,
  workRoot: string,
  digest: string,
  signal: AbortSignal,
  options: EngineOptions,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let settled = false,
      accepted = false,
      workSent = false,
      buffer = "",
      bytes = 0;
    let stopSample: (() => void) | void;
    const finish = (error?: Error, result?: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      clearTimeout(handshake);
      stopSample?.();
      socket.destroy();
      if (error) reject(error);
      else resolve(result!);
    };
    const abort = () =>
      finish(new Error(options.signal.aborted ? "CANCELLED" : "TOOL_TIMEOUT"));
    const handshake = setTimeout(() => {
      if (!accepted) finish(new Error("ENGINE_UNAVAILABLE"));
    }, 15_000);
    signal.addEventListener("abort", abort, { once: true });
    socket.on("error", () =>
      finish(
        new Error(
          accepted ? "ENGINE_UNAVAILABLE" : "ENGINE_CONNECT_UNAVAILABLE",
        ),
      ),
    );
    socket.on("close", () =>
      finish(
        new Error(
          accepted ? "ENGINE_UNAVAILABLE" : "ENGINE_CONNECT_UNAVAILABLE",
        ),
      ),
    );
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      buffer += chunk;
      if (bytes > 4 * 1024 * 1024 || buffer.length > 128 * 1024)
        return finish(new Error("ENGINE_PROTOCOL_INVALID"));
      let end: number;
      while (!settled && (end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          const event: unknown = JSON.parse(line);
          if (!event || typeof event !== "object" || Array.isArray(event))
            throw new Error();
          const value = event as Record<string, unknown>;
          if (!accepted) {
            if (
              value.type !== "ready" ||
              value.engine_id !== id ||
              !Number.isSafeInteger(value.pid) ||
              Number(value.pid) < 1
            ) {
              if (value.type === "ready" && value.engine_id !== id) {
                // Only an idle engine sends this handshake; no accepted work is killed.
                socket.end(JSON.stringify({ operation: "retire" }) + "\n", () =>
                  finish(new Error("ENGINE_IDENTITY_CHANGED")),
                );
                return;
              }
              throw new Error();
            }
            accepted = true;
            clearTimeout(handshake);
            stopSample = options.onSpawn?.(Number(value.pid));
            void Promise.resolve(
              options.beforeProcess?.(Number(value.pid), {
                engine_socket: socketPath,
                engine_id: id,
              }),
            )
              .then(() => {
                if (settled || signal.aborted) return;
                workSent = true;
                socket.write(
                  JSON.stringify({
                    operation: "process",
                    input,
                    work_root: workRoot,
                    sha256: digest,
                  }) + "\n",
                );
              })
              .catch((error: unknown) =>
                finish(
                  new Error(
                    error instanceof Error &&
                      /^[A-Z_]{1,60}$/.test(error.message)
                      ? error.message
                      : "ENGINE_UNAVAILABLE",
                  ),
                ),
              );
          } else if (
            workSent &&
            value.type === "result" &&
            value.result &&
            typeof value.result === "object" &&
            !Array.isArray(value.result)
          ) {
            finish(undefined, value.result as Record<string, unknown>);
          } else if (
            value.type === "error" &&
            typeof value.code === "string" &&
            /^[A-Z_]{1,60}$/.test(value.code)
          ) {
            finish(new Error(value.code));
          } else if (workSent && value.type === "progress")
            options.onEvent(value);
          else throw new Error();
        } catch {
          finish(new Error("ENGINE_PROTOCOL_INVALID"));
        }
      }
    });
    if (signal.aborted) abort();
  });
}
