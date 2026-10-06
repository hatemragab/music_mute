import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import {
  DarwinFileLockBusyError,
  withDarwinFileLock,
} from "./darwin-file-lock.js";

const execute = promisify(execFile);
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu;
export interface PersonalEngineEndpoint {
  engine_socket: string;
  engine_id: string;
}
export interface PersonalReservation extends Partial<PersonalEngineEndpoint> {
  request_id: string;
  phase?: "active" | "idle" | "retiring";
  client_pid?: number;
  client_identity?: string;
  engine_pid?: number;
  process_identity?: string;
}
export function validPersonalPid(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    Number(value) > 1 &&
    Number(value) <= 2 ** 31 - 1
  );
}

/** Darwin has a small sockaddr_un path bound. Bind fallback to this exact
 * canonical private state root and UID, never a network port or global socket.
 */
export async function personalAdmissionSocketPath(
  state: string,
): Promise<string> {
  if ((await realpath(state)) !== state)
    throw new Error("WORKER_COORDINATION_UNSAFE");
  const direct = join(state, "personal-admission.sock");
  if (Buffer.byteLength(direct) <= 100) return direct;
  const name = createHash("sha256").update(state).digest("hex").slice(0, 24);
  const directory = join(
    await realpath("/tmp"),
    `mm-admission-${process.getuid?.()}-${name}`,
  );
  await mkdir(directory, { mode: 0o700 }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST")
        throw new Error("WORKER_COORDINATION_UNSAFE");
    },
  );
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o777) !== 0o700 ||
    (await realpath(directory)) !== directory
  )
    throw new Error("WORKER_COORDINATION_UNSAFE");
  return join(directory, "admission.sock");
}
export async function personalProcessIdentity(
  pid: number,
): Promise<string | undefined> {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return undefined;
    throw new Error("WORKER_COORDINATION_UNAVAILABLE");
  }
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
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return undefined;
    }
    throw new Error("WORKER_COORDINATION_UNAVAILABLE");
  }
}
export async function withPersonalAdmissionLock<T>(
  state: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (process.platform !== "darwin") return operation(); // Portable disposable fixtures only.
  const deadline = performance.now() + 5000;
  for (;;) {
    try {
      return await withDarwinFileLock(
        join(state, "app-admission.lock"),
        operation,
      );
    } catch (error) {
      if (
        !(error instanceof DarwinFileLockBusyError) ||
        performance.now() >= deadline
      )
        throw error;
      await delay(25);
    }
  }
}
export async function loadPersonalReservation(
  state: string,
): Promise<PersonalReservation | undefined> {
  const handle = await open(
    join(state, "personal-admission.json"),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw new Error("WORKER_COORDINATION_UNSAFE");
  });
  if (!handle) return undefined;
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o777) !== 0o600 ||
      info.size > 4096
    )
      throw new Error();
    const value = JSON.parse(
      await handle.readFile("utf8"),
    ) as PersonalReservation;
    const validIdentity = (v: unknown) =>
      typeof v === "string" && v.length > 0 && v.length <= 100;
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      typeof value.request_id !== "string" ||
      !UUID.test(value.request_id) ||
      Object.keys(value).some(
        (key) =>
          ![
            "request_id",
            "phase",
            "client_pid",
            "client_identity",
            "engine_pid",
            "process_identity",
            "engine_socket",
            "engine_id",
          ].includes(key),
      ) ||
      (value.phase !== undefined &&
        !["active", "idle", "retiring"].includes(value.phase)) ||
      (value.client_pid !== undefined &&
        (!validPersonalPid(value.client_pid) ||
          !validIdentity(value.client_identity))) ||
      (value.client_pid === undefined && value.client_identity !== undefined) ||
      (value.engine_pid !== undefined &&
        (!validPersonalPid(value.engine_pid) ||
          !validIdentity(value.process_identity))) ||
      (value.engine_pid === undefined &&
        value.process_identity !== undefined) ||
      ((value.engine_socket !== undefined || value.engine_id !== undefined) &&
        (value.engine_pid === undefined ||
          typeof value.engine_socket !== "string" ||
          !/^\/(?:private\/)?tmp\/mm-engine-\d+-[a-f0-9]{24}\/engine\.sock$/u.test(
            value.engine_socket,
          ) ||
          value.engine_socket.length > 256 ||
          typeof value.engine_id !== "string" ||
          !/^[a-f0-9]{64}$/.test(value.engine_id))) ||
      (["idle", "retiring"].includes(value.phase ?? "") &&
        (value.engine_pid === undefined || value.engine_socket === undefined))
    )
      throw new Error();
    return value;
  } catch {
    throw new Error("WORKER_COORDINATION_UNSAFE");
  } finally {
    await handle.close();
  }
}
async function syncDirectory(state: string): Promise<void> {
  const directory = await open(state, constants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
export async function persistPersonalReservation(
  state: string,
  value: PersonalReservation,
): Promise<void> {
  const temporary = join(state, `.personal-admission-${randomUUID()}.tmp`);
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(value) + "\n");
    await file.sync();
    await file.close();
    await rename(temporary, join(state, "personal-admission.json"));
    await syncDirectory(state);
  } finally {
    await file.close();
    await unlink(temporary).catch(() => {});
  }
}
export async function removePersonalReservation(state: string): Promise<void> {
  await unlink(join(state, "personal-admission.json")).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    },
  );
  await syncDirectory(state);
}
export async function validatePersonalEngineEndpoint(
  endpoint: PersonalEngineEndpoint,
): Promise<void> {
  const directory = dirname(endpoint.engine_socket);
  const temporary = await realpath("/tmp");
  if (
    dirname(directory) !== temporary ||
    !new RegExp(`^mm-engine-${process.getuid?.()}-[a-f0-9]{24}$`).test(
      basename(directory),
    ) ||
    basename(endpoint.engine_socket) !== "engine.sock" ||
    (await realpath(directory)) !== directory ||
    !/^[a-f0-9]{64}$/.test(endpoint.engine_id)
  )
    throw new Error("WORKER_COORDINATION_UNSAFE");
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o777) !== 0o700
  )
    throw new Error("WORKER_COORDINATION_UNSAFE");
  const socket = await lstat(endpoint.engine_socket);
  if (
    !socket.isSocket() ||
    socket.isSymbolicLink() ||
    socket.uid !== process.getuid?.() ||
    (socket.mode & 0o777) !== 0o600
  )
    throw new Error("WORKER_COORDINATION_UNSAFE");
}
/** Called only with a durable idle/retiring record. A ready handshake proves the engine is idle. */
export async function verifyIdlePersonalEngine(
  reservation: PersonalReservation,
  retire = false,
): Promise<void> {
  if (
    !validPersonalPid(reservation.engine_pid) ||
    !reservation.process_identity ||
    !reservation.engine_socket ||
    !reservation.engine_id
  )
    throw new Error("WORKER_COORDINATION_UNSAFE");
  const endpoint = {
    engine_socket: reservation.engine_socket,
    engine_id: reservation.engine_id,
  };
  if (
    (await personalProcessIdentity(reservation.engine_pid)) !==
    reservation.process_identity
  ) {
    if (retire) return;
    throw new Error("WORKER_COORDINATION_UNAVAILABLE");
  }
  const signal = AbortSignal.timeout(retire ? 15_000 : 5000);
  let socket: Socket | undefined;
  try {
    await validatePersonalEngineEndpoint(endpoint);
    await new Promise<void>((resolve, reject) => {
      socket = createConnection(endpoint.engine_socket);
      let buffer = "",
        ready = false,
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
        finish(ready ? undefined : new Error("ENGINE_EXIT_UNCONFIRMED")),
      );
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        if (buffer.length > 4096 || ready) return abort();
        const end = buffer.indexOf("\n");
        if (end < 0) return;
        try {
          const value: unknown = JSON.parse(buffer.slice(0, end));
          if (!value || typeof value !== "object" || Array.isArray(value))
            throw new Error();
          const frame = value as Record<string, unknown>;
          if (
            frame.type !== "ready" ||
            frame.pid !== reservation.engine_pid ||
            frame.engine_id !== reservation.engine_id
          )
            throw new Error();
          ready = true;
          if (retire)
            socket!.write(JSON.stringify({ operation: "retire" }) + "\n");
          else finish();
        } catch {
          abort();
        }
      });
      if (signal.aborted) abort();
    });
  } catch (error) {
    socket?.destroy();
    if (!retire) throw error;
    // Missing/unlinked socket cannot end the durable ownership lease. Only
    // positive exit of the exact captured process identity can do so.
  }
  if (retire) {
    while (
      (await personalProcessIdentity(reservation.engine_pid)) ===
      reservation.process_identity
    ) {
      if (signal.aborted) throw new Error("ENGINE_EXIT_UNCONFIRMED");
      await delay(25);
    }
  }
}
/** Caller MUST hold app-admission.lock while publishing its maintenance fence. */
export async function authorizePersonalMaintenanceUnderLock(
  state: string,
): Promise<void> {
  const saved = await loadPersonalReservation(state).catch(() => {
    throw new Error("WORKER_PERSONAL_BUSY");
  });
  if (!saved) return;
  if (!["idle", "retiring"].includes(saved.phase ?? ""))
    throw new Error("WORKER_PERSONAL_BUSY");
  if (saved.phase === "idle") {
    if (
      (await personalProcessIdentity(saved.engine_pid!)) !==
      saved.process_identity
    ) {
      await removePersonalReservation(state);
      return;
    }
    await verifyIdlePersonalEngine(saved).catch(() => {
      throw new Error("WORKER_PERSONAL_BUSY");
    });
    await persistPersonalReservation(state, { ...saved, phase: "retiring" });
  }
}
/** Reclaim only intentional idle ownership, preserving active and unknown owners. */
export async function reclaimIdlePersonalReservation(
  state: string,
): Promise<void> {
  let reservation: PersonalReservation | undefined;
  await withPersonalAdmissionLock(state, async () => {
    await authorizePersonalMaintenanceUnderLock(state);
    reservation = await loadPersonalReservation(state);
  });
  if (!reservation) return;
  await verifyIdlePersonalEngine(reservation, true);
  await withPersonalAdmissionLock(state, async () => {
    const latest = await loadPersonalReservation(state);
    if (!latest) return;
    if (
      latest.phase !== "retiring" ||
      latest.request_id !== reservation!.request_id ||
      latest.engine_pid !== reservation!.engine_pid ||
      latest.process_identity !== reservation!.process_identity
    )
      throw new Error("WORKER_PERSONAL_BUSY");
    if (
      (await personalProcessIdentity(latest.engine_pid!)) ===
      latest.process_identity
    )
      throw new Error("ENGINE_EXIT_UNCONFIRMED");
    await removePersonalReservation(state);
  });
}
