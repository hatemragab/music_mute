import { PACKAGE_DATA_ROOT_NAMES } from "../../shared/package-build-profile.js";
import { randomUUID } from "node:crypto";
import { win32 } from "node:path";
import { Readable } from "node:stream";
import { isDeepStrictEqual, types } from "node:util";
import {
  parseStoreTransferReply,
  snapshotStoreTransferBytes,
  snapshotStoreTransferRequest,
  STORE_TRANSFER_REPLY_MAX_BYTES,
  type StoreTransferRequest,
  type StoreTransferOperation,
} from "../../../../worker/src/runtime/store-transfer-contracts.js";
import {
  TransferError,
  TransferOwnershipError,
  type WorkerTransferClient,
} from "../../../../worker/src/runtime/transfers.js";
import type { ConsumerOwnedProcess } from "../../../../worker/src/platform/windows/consumer-native.js";
import type { HostContext, HostNativePort } from "../host-context.js";
import {
  StoreNodeIssuer,
  StoreFleetTransferChild,
  type StoreNodeCodeView,
} from "../session/store-node-issuer.js";

const TOKEN = Symbol("store-fleet-transfers"),
  DENIED = "STORE_FLEET_TRANSFER_DENIED",
  UUID =
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u,
  TOTAL_TIMEOUT_MS = 7_200_000;
type CreateRequest = Parameters<StoreNodeIssuer["createFleetTransfer"]>[0];
interface OriginalTransfer {
  readonly request: StoreTransferRequest;
  readonly create: CreateRequest;
  task?: Promise<null | string>;
  construction?: Promise<StoreFleetTransferChild>;
  child?: StoreFleetTransferChild;
  retirement?: Promise<void>;
  recovery?: Promise<void> | undefined;
  reading?: Promise<Buffer>;
  exiting?: Promise<number>;
  stopAttempted: boolean;
  retired: boolean;
  finished: boolean;
  readonly failures: Promise<unknown>[];
}
function deny(): never {
  throw new Error(DENIED);
}
function actualRole(issuer: StoreNodeIssuer) {
  return Object.getOwnPropertyDescriptor(
    StoreNodeIssuer.prototype,
    "nodeRole",
  )!.get!.call(issuer);
}
function actualOwner(issuer: StoreNodeIssuer): ConsumerOwnedProcess {
  return Object.getOwnPropertyDescriptor(
    StoreNodeIssuer.prototype,
    "owner",
  )!.get!.call(issuer);
}
function actualNative(
  host: HostContext,
  issuer: StoreNodeIssuer,
): HostNativePort {
  if (!host || typeof host !== "object" || types.isProxy(host)) deny();
  const native = Object.getOwnPropertyDescriptor(host, "native");
  if (!native || !("value" in native) || actualRole(issuer) !== "fleet") deny();
  StoreNodeIssuer.prototype.assertNative.call(issuer, native.value);
  // The real issuer has proved the private helper association; this is its
  // existing HostContext port, never a caller-injected transfer implementation.
  return native.value;
}
function code(operation: StoreTransferOperation) {
  return operation === "download"
    ? ("DOWNLOAD_FAILED" as const)
    : ("OUTPUT_UPLOAD_FAILED" as const);
}
function uncertain(
  record: OriginalTransfer,
  error: unknown,
  cleanup: unknown,
): TransferOwnershipError {
  const result = new TransferOwnershipError(code(record.request.operation));
  Object.defineProperty(result, "cause", {
    value: new AggregateError(
      [error, cleanup],
      "STORE_TRANSFER_CLEANUP_PENDING",
    ),
  });
  return result;
}
async function replyBytes(
  stream: Readable,
  signal: AbortSignal,
): Promise<Buffer> {
  if (!(stream instanceof Readable)) deny();
  signal.throwIfAborted();
  const chunks: Buffer[] = [];
  let total = 0;
  const abort = () => stream.destroy(new Error("STORE_TRANSFER_INTERRUPTED"));
  signal.addEventListener("abort", abort, { once: true });
  try {
    for await (const raw of stream) {
      signal.throwIfAborted();
      const copied = snapshotStoreTransferBytes(
        raw,
        STORE_TRANSFER_REPLY_MAX_BYTES - total,
      );
      if (!copied.length) continue;
      total += copied.length;
      chunks.push(Buffer.from(copied));
    }
    signal.throwIfAborted();
    return Buffer.concat(chunks, total);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/** Real Creator-owned Fleet transfers. Data replies cannot retire an attempt or
 * confer a code, launch, Job, account or Ready capability. */
export class StoreFleetTransfers {
  #host: HostContext;
  #native: HostNativePort;
  #issuer: StoreNodeIssuer;
  #view: StoreNodeCodeView;
  #owner: ConsumerOwnedProcess;
  #workRoot: string;
  #records = new Map<string, OriginalTransfer>();
  #tasks = new Set<Promise<unknown>>();
  #attempts = new Set<string>();
  #ending = false;
  #closed = false;
  #interrupt = new AbortController();
  #closing?: Promise<void>;
  #recovering: Promise<void> | undefined;
  #closeFailures: Promise<void>[] = [];
  private constructor(
    token: symbol,
    host: HostContext,
    native: HostNativePort,
    issuer: StoreNodeIssuer,
    view: StoreNodeCodeView,
    owner: ConsumerOwnedProcess,
    workRoot: string,
  ) {
    if (token !== TOKEN) deny();
    this.#host = host;
    this.#native = native;
    this.#issuer = issuer;
    this.#view = view;
    this.#owner = owner;
    this.#workRoot = workRoot;
    Object.freeze(this);
  }
  static async open(
    host: HostContext,
    issuer: StoreNodeIssuer,
  ): Promise<StoreFleetTransfers> {
    if (arguments.length !== 2) deny();
    const native = actualNative(host, issuer),
      view = await StoreNodeIssuer.prototype.codeView.call(issuer),
      identity = await native.identity(),
      owner = actualOwner(issuer);
    actualNative(host, issuer);
    if (
      owner.role !== "fleet" ||
      identity.sid !== view.binding.sid ||
      identity.sessionId !== owner.identity.sessionId ||
      identity.sid !== owner.identity.sid ||
      view.binding.inventorySha256 !== issuer.inventorySha256 ||
      (await native.bootIdentity()) !== view.binding.bootIdentity ||
      host.identity.sid !== identity.sid ||
      host.identity.sessionId !== identity.sessionId ||
      host.identity.localAppData !== identity.localAppData
    )
      deny();
    const result = new StoreFleetTransfers(
      TOKEN,
      host,
      native,
      issuer,
      view,
      owner,
      win32.join(identity.localAppData, PACKAGE_DATA_ROOT_NAMES.fleet, "work"),
    );
    await result.#current();
    return result;
  }
  async #current(): Promise<void> {
    if (
      actualNative(this.#host, this.#issuer) !== this.#native ||
      !isDeepStrictEqual(actualOwner(this.#issuer), this.#owner)
    )
      deny();
    const identity = await this.#native.identity(),
      view = await StoreNodeIssuer.prototype.codeView.call(this.#issuer);
    actualNative(this.#host, this.#issuer);
    if (
      identity.sid !== this.#view.binding.sid ||
      identity.sessionId !== this.#owner.identity.sessionId ||
      win32.join(
        identity.localAppData,
        PACKAGE_DATA_ROOT_NAMES.fleet,
        "work",
      ) !== this.#workRoot ||
      !isDeepStrictEqual(view.binding, this.#view.binding) ||
      (await this.#native.bootIdentity()) !== this.#view.binding.bootIdentity
    )
      deny();
  }
  download: WorkerTransferClient["download"] = (
    grant,
    expected,
    path,
    signal,
  ) => {
    try {
      return this.#retainTask(
        this.#begin("download", grant, expected, path, signal).then(() => {}),
      );
    } catch (error) {
      return Promise.reject(error);
    }
  };
  upload: WorkerTransferClient["upload"] = (grant, path, expected, signal) => {
    try {
      return this.#retainTask(
        this.#begin("upload", grant, expected, path, signal).then((result) => {
          if (typeof result !== "string") deny();
          return result;
        }),
      );
    } catch (error) {
      return Promise.reject(error);
    }
  };
  #retainTask<T>(task: Promise<T>): Promise<T> {
    // Track the exact returned public promise, including the final promise
    // adoption after #run's finally has already pruned its retired record.
    this.#tasks.add(task);
    void task.then(
      () => {
        this.#tasks.delete(task);
      },
      () => {
        this.#tasks.delete(task);
      },
    );
    return task;
  }
  #begin(
    operation: StoreTransferOperation,
    grant: StoreTransferRequest["grant"],
    expected: StoreTransferRequest["expected"],
    path: string,
    signal?: AbortSignal,
  ): Promise<null | string> {
    if (this.#ending || this.#closed)
      throw new TransferError(
        code(operation),
        false,
        "transfer-process-closed",
      );
    if (
      typeof path !== "string" ||
      (signal !== undefined &&
        (!(signal instanceof AbortSignal) || types.isProxy(signal)))
    )
      deny();
    signal?.throwIfAborted();
    const local = win32.relative(this.#workRoot, path).split("\\"),
      attemptId = local[0];
    if (typeof attemptId !== "string" || !UUID.test(attemptId)) deny();
    const request = snapshotStoreTransferRequest(
      {
        version: 1,
        requestId: randomUUID(),
        operation,
        attemptId,
        workspace: win32.join(this.#workRoot, attemptId),
        path,
        grant,
        expected,
        options: {},
      },
      win32.join(this.#workRoot, attemptId),
    );
    if (this.#attempts.has(attemptId))
      throw new TransferOwnershipError(code(operation));
    const record: OriginalTransfer = {
      request,
      create: Object.freeze({
        requestId: request.requestId,
        operation,
        attemptId,
        relativePath: win32.relative(win32.dirname(this.#workRoot), path),
      }),
      stopAttempted: false,
      retired: false,
      finished: false,
      failures: [],
    };
    this.#records.set(request.requestId, record);
    this.#attempts.add(attemptId);
    // Reserve the original task before any reentrant native/factory IO begins.
    record.task = Promise.resolve().then(() => this.#run(record, signal));
    return record.task;
  }
  async #run(
    record: OriginalTransfer,
    caller?: AbortSignal,
  ): Promise<null | string> {
    const timeout = AbortSignal.timeout(TOTAL_TIMEOUT_MS),
      signal = AbortSignal.any([
        timeout,
        this.#interrupt.signal,
        ...(caller ? [caller] : []),
      ]);
    const stop = () => {
      void this.#retire(record).catch(() => {});
    };
    signal.addEventListener("abort", stop, { once: true });
    try {
      signal.throwIfAborted();
      await this.#current();
      signal.throwIfAborted();
      record.construction = Promise.resolve().then(() =>
        StoreNodeIssuer.prototype.createFleetTransfer.call(
          this.#issuer,
          record.create,
        ),
      );
      record.child = await record.construction;
      if (
        StoreFleetTransferChild.prototype.closedForIssuer.call(
          record.child,
          this.#issuer,
        )
      )
        deny();
      signal.throwIfAborted();
      await this.#current();
      signal.throwIfAborted();
      const child = record.child,
        stream = Object.getOwnPropertyDescriptor(
          StoreFleetTransferChild.prototype,
          "stdout",
        )!.get!.call(child) as Readable;
      const output = (record.reading = replyBytes(stream, signal));
      void output.catch(() => {});
      await StoreFleetTransferChild.prototype.start.call(child);
      signal.throwIfAborted();
      await StoreFleetTransferChild.prototype.write.call(
        child,
        Buffer.from(`${JSON.stringify(record.request)}\n`),
      );
      signal.throwIfAborted();
      const exiting = (record.exiting =
        StoreFleetTransferChild.prototype.waitForExit.call(child));
      void exiting.catch(() => {});
      const [bytes, exit] = await Promise.all([output, exiting]);
      signal.throwIfAborted();
      let reply: ReturnType<typeof parseStoreTransferReply>;
      try {
        reply = parseStoreTransferReply(
          bytes,
          record.request.requestId,
          record.request.operation,
        );
      } catch {
        throw new TransferError(
          code(record.request.operation),
          false,
          "transfer-process-protocol",
        );
      }
      if (exit !== 0)
        throw new TransferError(
          code(record.request.operation),
          true,
          "transfer-process-failed",
        );
      await this.#retire(record);
      signal.throwIfAborted();
      await this.#current();
      signal.throwIfAborted();
      if (!reply.ok)
        throw new TransferError(
          code(record.request.operation),
          reply.retryable,
          reply.diagnostic,
        );
      return reply.result;
    } catch (error) {
      try {
        await this.#retire(record);
      } catch (cleanup) {
        throw uncertain(record, error, cleanup);
      }
      if (caller?.aborted) throw caller.reason;
      if (timeout.aborted)
        throw new TransferError(
          code(record.request.operation),
          true,
          "transfer-process-timeout",
        );
      if (error instanceof TransferError) throw error;
      throw new TransferError(
        code(record.request.operation),
        true,
        "transfer-process-failed",
      );
    } finally {
      signal.removeEventListener("abort", stop);
      record.finished = true;
      if (record.retired) this.#forget(record);
    }
  }
  #forget(record: OriginalTransfer) {
    this.#records.delete(record.request.requestId);
    this.#attempts.delete(record.request.attemptId);
  }
  #retired(record: OriginalTransfer) {
    record.retired = true;
    if (record.finished) this.#forget(record);
  }
  #retire(record: OriginalTransfer): Promise<void> {
    return (record.retirement ??= Promise.resolve().then(async () => {
      if (!record.construction) {
        this.#retired(record);
        return;
      }
      record.child ??= await record.construction;
      if (
        !StoreFleetTransferChild.prototype.closedForIssuer.call(
          record.child,
          this.#issuer,
        )
      ) {
        record.stopAttempted = true;
        await StoreFleetTransferChild.prototype.stop.call(record.child);
      }
      if (
        !StoreFleetTransferChild.prototype.closedForIssuer.call(
          record.child,
          this.#issuer,
        )
      )
        deny();
      await Promise.allSettled([record.reading, record.exiting]);
      this.#retired(record);
    }));
  }
  #recover(record: OriginalTransfer): Promise<void> {
    record.recovery ??= Promise.resolve()
      .then(async () => {
        if (record.retirement) {
          record.failures.push(record.retirement);
          await record.retirement.catch(() => {});
        }
        if (!this.#records.has(record.request.requestId)) return;
        if (!record.child) {
          if (record.construction) {
            record.failures.push(record.construction);
            await record.construction.catch(() => {});
          }
          // The real issuer recovers its exact retained factory tuple/object;
          // no replacement path/token/helper is chosen by this client.
          record.construction = Promise.resolve().then(() =>
            StoreNodeIssuer.prototype.createFleetTransfer.call(
              this.#issuer,
              record.create,
            ),
          );
          record.child = await record.construction;
        }
        if (
          !StoreFleetTransferChild.prototype.closedForIssuer.call(
            record.child,
            this.#issuer,
          )
        ) {
          if (record.stopAttempted)
            await StoreFleetTransferChild.prototype.recoverStop.call(
              record.child,
            );
          else {
            record.stopAttempted = true;
            await StoreFleetTransferChild.prototype.stop.call(record.child);
          }
        }
        if (
          !StoreFleetTransferChild.prototype.closedForIssuer.call(
            record.child,
            this.#issuer,
          )
        )
          deny();
        await Promise.allSettled([record.reading, record.exiting]);
        this.#retired(record);
      })
      .finally(() => {
        record.recovery = undefined;
      });
    void record.recovery.catch(() => {});
    return record.recovery;
  }
  close(): Promise<void> {
    if (arguments.length) return Promise.reject(new Error(DENIED));
    if (this.#closed) return Promise.resolve();
    this.#ending = true;
    this.#interrupt.abort(new Error("STORE_TRANSFER_CLOSED"));
    return (this.#closing ??= Promise.resolve().then(() => this.#close(false)));
  }
  recoverClose(): Promise<void> {
    if (arguments.length) return Promise.reject(new Error(DENIED));
    if (this.#closed) return Promise.resolve();
    this.#ending = true;
    this.#interrupt.abort(new Error("STORE_TRANSFER_CLOSED"));
    this.#recovering ??= Promise.resolve()
      .then(async () => {
        if (this.#closing) {
          this.#closeFailures.push(this.#closing);
          await this.#closing.catch(() => {});
        }
        await this.#close(true);
      })
      .finally(() => {
        this.#recovering = undefined;
      });
    void this.#recovering.catch(() => {});
    return this.#recovering;
  }
  async #close(recovery: boolean): Promise<void> {
    const tasks = [...this.#tasks],
      originals = [...this.#records.values()];
    const retired = await Promise.allSettled(
      originals.map((record) =>
        recovery ? this.#recover(record) : this.#retire(record),
      ),
    );
    await Promise.allSettled(tasks);
    const failures = retired
      .filter(
        (value): value is PromiseRejectedResult => value.status === "rejected",
      )
      .map((value) => value.reason);
    if (failures.length || this.#records.size)
      throw new AggregateError(failures, "STORE_TRANSFER_CLEANUP_PENDING");
    this.#closed = true;
  }
}
