import { chmod, lstat, realpath, unlink } from "node:fs/promises";
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import { isAbsolute, join, resolve } from "node:path";
import {
  DarwinFileLockBusyError,
  withDarwinFileLock,
} from "./darwin-file-lock.js";

import {
  loadPersonalReservation,
  persistPersonalReservation,
  removePersonalReservation,
  withPersonalAdmissionLock,
  reclaimIdlePersonalReservation,
  personalProcessIdentity,
  personalAdmissionSocketPath,
  type PersonalReservation,
} from "./personal-reservation.js";
export {
  authorizePersonalMaintenanceUnderLock,
  reclaimIdlePersonalReservation,
} from "./personal-reservation.js";
export const personalEngineIdentity = personalProcessIdentity;

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu;
const MAX_FRAME_BYTES = 4096;
const MAX_CLIENTS = 16;

/** The serialized claim loop grants only after all fleet children have exited. */
export interface PersonalAdmission {
  start(wake: () => void): Promise<void>;
  pending(): boolean;
  grant(): Promise<void>;
  stop(): Promise<void>;
}

type Reservation = PersonalReservation;

interface Client {
  socket: Socket;
  buffer: string;
  bytes: number;
  requestId?: string;
  clientPid?: number;
  clientIdentity?: string;
  granted: boolean;
  timer: ReturnType<typeof setTimeout>;
  operations: Promise<void>;
}

/** Per-user socket plus a durable reservation survives supervisor crashes. */
export class MacPersonalAdmission implements PersonalAdmission {
  private server: Server | undefined;
  private readonly clients = new Set<Client>();
  private readonly queue: Client[] = [];
  private reservation: Reservation | undefined;
  private owner: Client | undefined;
  private wake = () => {};
  private poll: ReturnType<typeof setInterval> | undefined;
  private checking = false;
  private granting = false;
  private closed = false;
  private socketIdentity: { ino: number; dev: number } | undefined;
  private endpoint: string;
  get socketPath(): string {
    return this.endpoint;
  }

  constructor(
    private readonly stateRoot: string,
    private readonly identify = personalEngineIdentity,
  ) {
    this.endpoint = join(stateRoot, "personal-admission.sock");
  }

  async start(wake: () => void): Promise<void> {
    if (this.server) throw new Error("PERSONAL_ADMISSION_ALREADY_STARTED");
    if (
      !isAbsolute(this.stateRoot) ||
      (await realpath(this.stateRoot)) !== resolve(this.stateRoot)
    )
      throw new Error("PERSONAL_ADMISSION_UNSAFE");
    const root = await lstat(this.stateRoot);
    if (
      !root.isDirectory() ||
      root.isSymbolicLink() ||
      root.uid !== process.getuid?.() ||
      (root.mode & 0o777) !== 0o700
    )
      throw new Error("PERSONAL_ADMISSION_UNSAFE");
    this.wake = wake;
    this.endpoint = await personalAdmissionSocketPath(this.stateRoot);
    const prior = await lstat(this.socketPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (prior) {
      if (
        !prior.isSocket() ||
        prior.uid !== process.getuid?.() ||
        (prior.mode & 0o777) !== 0o600
      )
        throw new Error("PERSONAL_ADMISSION_UNSAFE");
      await new Promise<void>((done, fail) => {
        const probe = createConnection(this.socketPath);
        probe.once("connect", () => {
          probe.destroy();
          fail(new Error("PERSONAL_ADMISSION_ALREADY_STARTED"));
        });
        probe.once("error", (error: NodeJS.ErrnoException) => {
          probe.destroy();
          if (error.code === "ECONNREFUSED") done();
          else fail(new Error("PERSONAL_ADMISSION_UNSAFE"));
        });
        probe.setTimeout(500, () => {
          probe.destroy();
          fail(new Error("PERSONAL_ADMISSION_UNSAFE"));
        });
      });
      const named = await lstat(this.socketPath);
      if (named.ino !== prior.ino || named.dev !== prior.dev)
        throw new Error("PERSONAL_ADMISSION_UNSAFE");
      await unlink(this.socketPath);
    }
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    await new Promise<void>((done, fail) => {
      server.once("error", fail);
      server.listen(this.socketPath, () => {
        server.removeListener("error", fail);
        done();
      });
    });
    await chmod(this.socketPath, 0o600);
    const named = await lstat(this.socketPath);
    this.socketIdentity = { ino: named.ino, dev: named.dev };
    // Publish the endpoint before the locked snapshot: a stopped-worker client
    // rechecks this endpoint while holding the same lock before reserving itself.
    try {
      await this.withAdmissionLock(async () => {
        this.reservation = await this.loadReservation();
      });
    } catch (error) {
      await this.stop();
      throw error;
    }
    await this.reap().catch(() => {});
    server.on("error", () => {
      this.closed = true;
      this.wake();
    });
    this.poll = setInterval(() => {
      void this.reap().catch(() => {});
      if (this.queue.length > 0 && !this.reservation) this.wake();
    }, 250);
    this.poll.unref();
  }

  pending(): boolean {
    return (
      this.closed ||
      this.granting ||
      !!this.reservation ||
      this.queue.length > 0
    );
  }

  async grant(): Promise<void> {
    if (this.closed || this.reservation || this.granting) return;
    const client = this.queue.shift();
    if (!client || client.socket.destroyed) return;
    this.granting = true;
    try {
      const publish = async () => {
        const saved = await this.loadReservation();
        if (saved) {
          this.reservation = saved;
          if (!client.socket.destroyed) this.queue.unshift(client);
          return;
        }
        const maintenance = (
          await Promise.all(
            ["app-maintenance.json", "app-preparation.json"].map((name) =>
              lstat(join(this.stateRoot, name)).catch((error: unknown) => {
                if ((error as NodeJS.ErrnoException).code === "ENOENT")
                  return undefined;
                throw error;
              }),
            ),
          )
        ).some(Boolean);
        if (maintenance) {
          if (!client.socket.destroyed) this.queue.unshift(client);
          return;
        }
        if ((await this.identify(client.clientPid!)) !== client.clientIdentity)
          return;
        const reservation = {
          request_id: client.requestId!,
          phase: "active" as const,
          client_pid: client.clientPid!,
          client_identity: client.clientIdentity!,
        };
        await this.persist(reservation);
        if (client.socket.destroyed) {
          await removePersonalReservation(this.stateRoot);
          this.wake();
          return;
        }
        this.reservation = reservation;
        this.owner = client;
        client.granted = true;
        this.send(client, "GRANTED");
      };
      if (process.platform === "darwin")
        await withDarwinFileLock(
          join(this.stateRoot, "app-admission.lock"),
          publish,
        );
      else await publish(); // Portable synthetic fixtures; production is macOS only.
    } catch (error) {
      if (!(error instanceof DarwinFileLockBusyError)) throw error;
      if (!client.socket.destroyed) this.queue.unshift(client);
    } finally {
      this.granting = false;
    }
  }

  async stop(): Promise<void> {
    this.closed = true;
    if (this.poll) clearInterval(this.poll);
    for (const client of this.clients) client.socket.destroy();
    this.queue.length = 0;
    if (this.server)
      await new Promise<void>((done) => this.server!.close(() => done()));
    const named = await lstat(this.socketPath).catch(() => undefined);
    if (
      named &&
      this.socketIdentity?.ino === named.ino &&
      this.socketIdentity.dev === named.dev
    )
      await unlink(this.socketPath);
    this.server = undefined;
  }

  private accept(socket: Socket): void {
    if (this.closed || this.clients.size >= MAX_CLIENTS) {
      socket.destroy();
      return;
    }
    const client: Client = {
      socket,
      buffer: "",
      bytes: 0,
      granted: false,
      operations: Promise.resolve(),
      timer: setTimeout(() => socket.destroy(), 10_000),
    };
    this.clients.add(client);
    socket.on("error", () => {});
    socket.on("close", () => {
      clearTimeout(client.timer);
      this.clients.delete(client);
      const index = this.queue.indexOf(client);
      if (index >= 0) this.queue.splice(index, 1);
      if (this.owner === client) this.owner = undefined;
      this.wake();
    });
    socket.on("data", (chunk: Buffer) => {
      client.bytes += chunk.length;
      client.buffer += chunk.toString("utf8");
      if (client.bytes > MAX_FRAME_BYTES) {
        socket.destroy();
        return;
      }
      let newline;
      while ((newline = client.buffer.indexOf("\n")) >= 0) {
        const line = client.buffer.slice(0, newline);
        client.buffer = client.buffer.slice(newline + 1);
        client.operations = client.operations
          .then(() => this.frame(client, line))
          .catch(() => {
            this.send(client, "ERROR", "PERSONAL_ADMISSION_INVALID");
            socket.destroy();
          });
      }
    });
  }

  private async frame(client: Client, line: string): Promise<void> {
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error();
    const message = value as Record<string, unknown>;
    const keys = Object.keys(message).sort().join(",");
    if (
      message.protocol_version !== 1 ||
      typeof message.request_id !== "string" ||
      !UUID.test(message.request_id)
    )
      throw new Error();
    if (!client.requestId) {
      if (
        keys !== "client_pid,protocol_version,request_id,type" ||
        message.type !== "PERSONAL"
      )
        throw new Error();
      if (
        this.clients.size > MAX_CLIENTS ||
        [...this.clients].some(
          (other) => other !== client && other.requestId === message.request_id,
        )
      )
        throw new Error();
      if (!validPid(message.client_pid)) throw new Error();
      const identity = await this.identify(Number(message.client_pid));
      if (!identity) throw new Error();
      client.requestId = message.request_id;
      client.clientPid = Number(message.client_pid);
      client.clientIdentity = identity;
      clearTimeout(client.timer);
      if (
        this.reservation &&
        this.reservation.engine_pid === undefined &&
        this.reservation.client_pid === undefined
      ) {
        this.send(client, "ERROR", "WORKER_RECOVERY_REQUIRED");
        client.socket.end();
        return;
      }
      this.queue.push(client);
      this.send(client, "WAITING");
      this.wake();
      return;
    }
    if (message.request_id !== client.requestId) throw new Error();
    if (
      message.type === "RELEASE" &&
      keys === "protocol_version,request_id,type" &&
      !client.granted
    ) {
      const index = this.queue.indexOf(client);
      if (index < 0) throw new Error();
      this.queue.splice(index, 1);
      this.send(client, "RELEASED");
      client.socket.end();
      this.wake();
      return;
    }
    if (this.owner !== client || !client.granted || !this.reservation)
      throw new Error();
    if (
      message.type === "ENGINE" &&
      keys === "engine_pid,protocol_version,request_id,type"
    ) {
      const pid = message.engine_pid;
      if (
        !Number.isSafeInteger(pid) ||
        Number(pid) <= 1 ||
        Number(pid) > 2_147_483_647 ||
        pid === process.pid ||
        this.reservation.engine_pid !== undefined
      )
        throw new Error();
      const identity = await this.identify(Number(pid));
      if (!identity) throw new Error();
      const reservation = {
        ...this.reservation,
        engine_pid: Number(pid),
        process_identity: identity,
      };
      await this.withAdmissionLock(async () => {
        const saved = await this.loadReservation();
        if (
          !saved ||
          saved.request_id !== client.requestId ||
          saved.engine_pid !== undefined
        )
          throw new Error();
        await this.persist(reservation);
        this.reservation = reservation;
      });
      this.send(client, "REGISTERED");
    } else if (
      message.type === "RELEASE" &&
      keys === "protocol_version,request_id,type"
    ) {
      if (this.reservation.engine_pid !== undefined) {
        await this.reap();
        if (this.reservation) {
          this.send(client, "WAITING");
          return;
        }
      } else {
        await this.withAdmissionLock(() => this.clearReservation());
      }
      this.send(client, "RELEASED");
      client.socket.end();
    } else throw new Error();
  }

  private send(client: Client, type: string, error_code?: string): void {
    if (!client.requestId || client.socket.destroyed) return;
    if (client.socket.writableLength > 16_384) {
      client.socket.destroy();
      return;
    }
    client.socket.write(
      JSON.stringify({
        protocol_version: 1,
        request_id: client.requestId,
        type,
        ...(error_code ? { error_code } : {}),
      }) + "\n",
    );
  }

  private async reap(): Promise<void> {
    if (this.checking || !this.reservation) return;
    this.checking = true;
    let reclaimIdle = false;
    try {
      await this.withAdmissionLock(async () => {
        // A stopped-worker client can own and register this same durable journal.
        // Always reload under the shared lock before deciding that an orphan died.
        const reservation = await this.loadReservation();
        if (!reservation) {
          this.reservation = undefined;
          this.owner = undefined;
          this.wake();
          return;
        }
        this.reservation = reservation;
        if (reservation.phase === "idle" || reservation.phase === "retiring") {
          reclaimIdle = true;
          return;
        }
        const pid = reservation.engine_pid ?? reservation.client_pid;
        const expected =
          reservation.engine_pid !== undefined
            ? reservation.process_identity
            : reservation.client_identity;
        // Pre-upgrade journals lacking both identities are deliberately blocked.
        if (pid === undefined || expected === undefined) return;
        const identity = await this.identify(pid);
        if (identity !== expected) {
          const owner = this.owner;
          await this.clearReservation();
          if (owner) {
            this.send(owner, "RELEASED");
            owner.socket.end();
          }
        }
      });
      if (reclaimIdle) {
        await reclaimIdlePersonalReservation(this.stateRoot);
        await this.withAdmissionLock(async () => {
          this.reservation = await this.loadReservation();
        });
        this.wake();
      }
    } finally {
      this.checking = false;
    }
  }

  private async clearReservation(): Promise<void> {
    await removePersonalReservation(this.stateRoot);
    this.reservation = undefined;
    this.owner = undefined;
    this.wake();
  }

  private loadReservation(): Promise<Reservation | undefined> {
    return loadPersonalReservation(this.stateRoot);
  }
  private persist(value: Reservation): Promise<void> {
    return persistPersonalReservation(this.stateRoot, value);
  }
  private withAdmissionLock<T>(operation: () => Promise<T>): Promise<T> {
    return withPersonalAdmissionLock(this.stateRoot, operation);
  }
}

function validPid(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    Number(value) > 1 &&
    Number(value) <= 2_147_483_647
  );
}
