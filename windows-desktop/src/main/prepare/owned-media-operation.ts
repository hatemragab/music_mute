import { win32 } from "node:path";
import {
  createConsumerNativeTransport,
  sameConsumerProcess,
  WindowsConsumerNative,
  type ConsumerOwnedProcess,
} from "../../../../worker/src/platform/windows/consumer-native.js";
import type { HostContext } from "../host-context.js";
import type { WindowsPreparationOperations } from "./operations.js";
import { readPrivateBytes, writePrivateAtomic } from "./private-files.js";
import { StoreMediaTools } from "./store-media-tools.js";
import { StoreMediaExecution } from "../session/store-media-runner.js";
import { StoreGuiMediaExecution } from "../session/store-gui-media.js";
import {
  assertStoreCpuOwnerHost,
  type StoreCpuOwner,
} from "../session/store-cpu-owner.js";
type Tools = Pick<WindowsPreparationOperations, "snapshotMediaTools">;
export type MediaTools = Awaited<ReturnType<Tools["snapshotMediaTools"]>> & {
  readonly releaseIdentity?: string;
};
/** Store's protected package path has a fixed worker leaf. Its inventory,
 * rather than that leaf, identifies the code generation in receiving data. */
export function mediaToolRelease(tools: MediaTools): string {
  if (tools.releaseIdentity === undefined)
    return win32.basename(tools.releaseRoot);
  if (
    typeof tools.releaseIdentity !== "string" ||
    !/^[a-f0-9]{64}$/u.test(tools.releaseIdentity)
  )
    throw new Error("MEDIA_TOOLS_REQUIRED");
  return tools.releaseIdentity;
}
export class MediaShutdownPending extends Error {
  readonly code = "MEDIA_SHUTDOWN_PENDING";
  constructor(cause?: unknown) {
    super(
      "MEDIA_SHUTDOWN_PENDING",
      cause === undefined ? undefined : { cause },
    );
  }
}
/** CPU media utilities run only through the fixed signed Prepare role and its whole-tree native Job. */
export async function runOwnedMediaOperation<C, T>(options: {
  host: HostContext;
  tools: Tools;
  signal: AbortSignal;
  configuration(verified: MediaTools): C;
  resultRelative(config: C): string;
  parse(value: unknown, config: C): T;
  maxResultBytes: number;
  timeoutMs?: number;
  beforeLaunch?(): Promise<void>;
  onOwner?(owner: ConsumerOwnedProcess | StoreCpuOwner): Promise<void>;
}): Promise<T> {
  const { host, tools, signal } = options;
  signal.throwIfAborted();
  if (tools instanceof StoreMediaTools || host.storeAuthority) {
    if (!(tools instanceof StoreMediaTools))
      throw new Error("MEDIA_TOOLS_REQUIRED");
    StoreMediaTools.prototype.assertHost.call(tools, host);
    const timeout = options.timeoutMs ?? 5 * 60000;
    if (
      !Number.isSafeInteger(timeout) ||
      timeout < 1 ||
      timeout > 10 * 60000 ||
      !Number.isSafeInteger(options.maxResultBytes) ||
      options.maxResultBytes < 1 ||
      options.maxResultBytes > 1024 ** 2
    )
      throw new Error("MEDIA_TOOLS_REQUIRED");
    const operationSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(timeout),
      ]),
      verified = await StoreMediaTools.prototype.snapshotMediaTools.call(
        tools,
        operationSignal,
      ),
      configuration = options.configuration(verified);
    let execution: StoreMediaExecution | StoreGuiMediaExecution | undefined,
      result: T | undefined,
      failure: unknown,
      failed = false;
    try {
      execution = await StoreMediaTools.prototype.openMedia.call(
        tools,
        configuration,
      );
      // beforeLaunch checks the existing workspace reservation. The same
      // actual CPU operation is handed off before any fixed child is launched.
      await options.beforeLaunch?.();
      const owner =
        execution instanceof StoreMediaExecution
          ? await StoreMediaExecution.prototype.prepare.call(
              execution,
              operationSignal,
            )
          : await StoreGuiMediaExecution.prototype.prepare.call(
              execution,
              operationSignal,
            );
      assertStoreCpuOwnerHost(owner, host);
      await options.onOwner?.(owner);
      operationSignal.throwIfAborted();
      if (execution instanceof StoreMediaExecution)
        await StoreMediaExecution.prototype.run.call(
          execution,
          operationSignal,
        );
      else
        await StoreGuiMediaExecution.prototype.run.call(
          execution,
          operationSignal,
        );
      const bytes =
        execution instanceof StoreMediaExecution
          ? await StoreMediaExecution.prototype.readResult.call(execution)
          : await StoreGuiMediaExecution.prototype.readResult.call(execution);
      try {
        if (bytes.length < 1 || bytes.length > options.maxResultBytes)
          throw new Error("MEDIA_UNAVAILABLE");
        result = options.parse(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
          configuration,
        );
      } finally {
        bytes.fill(0);
      }
      StoreMediaTools.prototype.assertHost.call(tools, host);
      operationSignal.throwIfAborted();
    } catch (error) {
      failed = true;
      failure = error;
    }
    if (execution) {
      try {
        if (execution instanceof StoreMediaExecution)
          await StoreMediaExecution.prototype.close.call(execution);
        else await StoreGuiMediaExecution.prototype.close.call(execution);
      } catch (error) {
        throw new MediaShutdownPending(
          new AggregateError(
            failed ? [failure, error] : [error],
            "STORE_MEDIA_CLEANUP_UNCONFIRMED",
          ),
        );
      }
    }
    if (failed) throw failure;
    return result as T;
  }
  const verified = await tools.snapshotMediaTools(signal),
    release = win32.basename(verified.releaseRoot);
  const lease = await host.prepareLease({
    sid: host.identity.sid,
    identity: release,
  });
  if (!lease) throw new Error("MEDIA_BUSY");
  let guardian: WindowsConsumerNative | undefined,
    owner: ConsumerOwnedProcess | undefined;
  let launchAttempted = false;
  let result!: T,
    failure: unknown,
    failed = false,
    confirmed = true,
    closeFailed = false;
  let off = () => {},
    closed = () => {},
    abort = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const configuration = options.configuration(verified);
    await writePrivateAtomic(
      host,
      "prepare-config.json",
      Buffer.from(JSON.stringify(configuration)),
    );
    guardian = new WindowsConsumerNative(
      await createConsumerNativeTransport(
        win32.join(
          verified.releaseRoot,
          "runtime",
          "native",
          "musicmute-native.exe",
        ),
        verified.nativeSha256,
      ),
      {
        verify: async (role, target) => {
          if (role !== "prepare" || target !== release)
            throw new Error("MEDIA_TOOLS_REQUIRED");
          const check = await tools.snapshotMediaTools(signal);
          if (
            check.releaseRoot !== verified.releaseRoot ||
            check.manifestSha256 !== verified.manifestSha256 ||
            check.nativeSha256 !== verified.nativeSha256
          )
            throw new Error("MEDIA_TOOLS_REQUIRED");
          await host.native.validatePath(
            "personal",
            "prepare-config.json",
            "file",
          );
        },
      },
    );
    const identity = await guardian.identity();
    if (
      identity.sid !== host.identity.sid ||
      identity.sessionId !== host.identity.sessionId
    )
      throw new Error("MEDIA_TOOLS_REQUIRED");
    let complete!: () => void, reject!: (error: Error) => void;
    const exited = new Promise<void>((resolve, fail) => {
      complete = resolve;
      reject = fail;
    });
    void exited.catch(() => {});
    const early: ConsumerOwnedProcess[] = [];
    off = guardian.onEvent((event) => {
      if (event.kind !== "child_exit") return;
      if (!owner) {
        if (early.length < 16) early.push(event.owner);
      } else if (
        event.owner.nonce === owner.nonce &&
        sameConsumerProcess(event.owner.identity, owner.identity)
      )
        complete();
    });
    closed = guardian.onClosed(() => reject(new Error("MEDIA_TOOLS_REQUIRED")));
    const timeout = options.timeoutMs ?? 5 * 60000;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 10 * 60000)
      throw new Error("MEDIA_TOOLS_REQUIRED");
    timer = setTimeout(() => reject(new Error("MEDIA_UNAVAILABLE")), timeout);
    abort = () => reject(new Error("CANCELLED"));
    signal.addEventListener("abort", abort, { once: true });
    signal.throwIfAborted();
    await options.beforeLaunch?.();
    launchAttempted = true;
    owner = await guardian.launchOwned("prepare", release);
    await options.onOwner?.(owner);
    if (
      early.some(
        (event) =>
          event.nonce === owner!.nonce &&
          sameConsumerProcess(event.identity, owner!.identity),
      )
    )
      complete();
    await exited;
    signal.throwIfAborted();
    const bytes = await readPrivateBytes(
      host,
      options.resultRelative(configuration),
      options.maxResultBytes,
    );
    result = options.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      configuration,
    );
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    if (timer) clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    off();
    closed();
    confirmed = !launchAttempted;
    try {
      if (guardian && owner) {
        await guardian.stopOwned(owner);
        confirmed = true;
      }
    } catch {
      confirmed = false;
    }
    try {
      await guardian?.close();
    } catch {
      closeFailed = true;
    }
    try {
      await lease.release();
    } catch {
      closeFailed = true;
    }
  }
  if (!confirmed) throw new MediaShutdownPending();
  if (closeFailed) throw new Error("MEDIA_TOOLS_REQUIRED");
  if (failed) throw failure;
  return result;
}
