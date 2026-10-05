import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { privateDirectory } from "./app-setup.js";
import { localToolEnvironment, type LocalConfig } from "./config.js";

interface EngineOptions {
  signal: AbortSignal;
  onEvent: (event: Record<string, unknown>) => void;
  onSpawn?: (pid: number) => (() => void) | void;
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
  input: string,
  workRoot: string,
  digest: string,
  signal: AbortSignal,
  options: EngineOptions,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let settled = false,
      accepted = false,
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
            socket.write(
              JSON.stringify({
                operation: "process",
                input,
                work_root: workRoot,
                sha256: digest,
              }) + "\n",
            );
          } else if (
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
          } else if (value.type === "progress") options.onEvent(value);
          else throw new Error();
        } catch {
          finish(new Error("ENGINE_PROTOCOL_INVALID"));
        }
      }
    });
    if (signal.aborted) abort();
  });
}
