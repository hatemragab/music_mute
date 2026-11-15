import { createHash } from "node:crypto";
import type { WindowsConsumerNative } from "../../../worker/src/platform/windows/consumer-native.js";
import { HostContext } from "../main/host-context.js";
import { PrepareFailure } from "../main/prepare/controller.js";
import { StoreCpuOperation } from "../main/session/store-cpu-operation.js";
import { StoreMediaExecution } from "../main/session/store-media-runner.js";
import { StoreNodeIssuer } from "../main/session/store-node-issuer.js";
import type { StoreMediaRequest } from "../shared/store-media-request.js";
import { STORE_PREPARE_FAILURE_CODES } from "../shared/store-prepare-contracts.js";

interface CpuPreparationOwner {
  opening?: Promise<StoreNodeIssuer>;
  issuer?: StoreNodeIssuer;
  native?: WindowsConsumerNative;
  request?: StoreMediaRequest;
  executionOpening?: Promise<StoreMediaExecution>;
  execution?: StoreMediaExecution;
  executionClosing?: Promise<void>;
  issuerClosing?: Promise<void>;
  failedOpenClosing?: Promise<void>;
  readonly failures: unknown[];
}

// Construction, work and retirement promises remain reachable if any original
// helper or Job cannot be positively retired. A receiving report is not an owner.
const owners = new Set<CpuPreparationOwner>();

function deny(): never {
  throw new Error("PREPARE_CONTEXT_INVALID");
}

function assertEntry(argv: readonly string[]): void {
  if (!Array.isArray(argv) || Object.getPrototypeOf(argv) !== Array.prototype)
    deny();
  const keys = Reflect.ownKeys(argv),
    item = Object.getOwnPropertyDescriptor(argv, "0"),
    length = Object.getOwnPropertyDescriptor(argv, "length");
  if (
    keys.length !== 2 ||
    !keys.includes("0") ||
    !keys.includes("length") ||
    !item?.enumerable ||
    !("value" in item) ||
    item.value !== "--store-cpu" ||
    !length ||
    !("value" in length) ||
    length.value !== 1
  )
    deny();
}

function failure(error: unknown): (typeof STORE_PREPARE_FAILURE_CODES)[number] {
  return error instanceof PrepareFailure
    ? (STORE_PREPARE_FAILURE_CODES.find((code) => code === error.code) ??
        "OPERATION_FAILED")
    : "OPERATION_FAILED";
}

function closeExecution(owner: CpuPreparationOwner): Promise<void> {
  if (!owner.executionOpening) return Promise.resolve();
  owner.executionClosing ??= (async () => {
    await owner.executionOpening!.catch(() => {});
    if (owner.execution)
      await StoreMediaExecution.prototype.close.call(owner.execution);
  })();
  void owner.executionClosing.catch(() => {});
  return owner.executionClosing;
}

/** Fixed protected Prepare Node entry for the five existing CPU utilities.
 * The genuine issuer and Creator independently bind the dedicated role and
 * original request. This entry accepts no paths, launchers, GPU or Ready data. */
export async function runStoreCpuPreparationChild(
  argv: readonly string[],
): Promise<void> {
  if (arguments.length !== 1) deny();
  assertEntry(argv);

  const owner: CpuPreparationOwner = { failures: [] };
  owners.add(owner); // retained before the original issuer's first factory IO
  const lifetime = new AbortController(),
    signal = AbortSignal.any([
      lifetime.signal,
      AbortSignal.timeout(14 * 60_000),
    ]),
    interrupted = () => lifetime.abort(),
    cancelExecution = () => {
      if (owner.executionOpening) void closeExecution(owner).catch(() => {});
    };
  process.once("SIGTERM", interrupted);
  process.once("SIGINT", interrupted);
  signal.addEventListener("abort", cancelExecution, { once: true });

  let result: Buffer | undefined,
    workFailed = false,
    workError: unknown;
  const finalFailures: unknown[] = [];
  try {
    owner.opening = StoreNodeIssuer.open();
    const issuer = await owner.opening;
    owner.issuer = issuer;
    signal.throwIfAborted();
    if (
      Reflect.get(StoreNodeIssuer.prototype, "nodeRole", issuer) !== "prepare"
    )
      deny();
    const native = await StoreNodeIssuer.prototype.openNative.call(issuer);
    owner.native = native;
    signal.throwIfAborted();
    const host = await HostContext.initialize(native, "0.1.0", 1),
      request = await StoreNodeIssuer.prototype.cpuPrepareRequest.call(
        issuer,
        native,
      );
    owner.request = request;
    StoreNodeIssuer.prototype.assertNative.call(issuer, native);
    if (
      request.binding.sid !== host.identity.sid ||
      (await native.bootIdentity()) !== request.binding.bootIdentity
    )
      throw new PrepareFailure("INTEGRITY_INVALID");
    StoreNodeIssuer.prototype.assertNative.call(issuer, native);
    signal.throwIfAborted();

    owner.executionOpening = StoreNodeIssuer.prototype.openMedia.call(
      issuer,
      host,
      request.configuration,
    );
    owner.execution = await owner.executionOpening;
    signal.throwIfAborted();
    const operation = await StoreMediaExecution.prototype.prepare.call(
      owner.execution,
      signal,
    );
    signal.throwIfAborted();
    await StoreNodeIssuer.prototype.publishCpuPrepareReady.call(
      issuer,
      native,
      {
        requestId: request.requestId,
        expectation: StoreCpuOperation.prototype.expectation.call(operation),
      },
    );

    // Each false response is only the genuine bounded kernel wait's timeout.
    // No tool starts until that exact original GUI request is explicitly started.
    for (;;) {
      signal.throwIfAborted();
      const started = await StoreNodeIssuer.prototype.waitCpuPrepareStart.call(
        issuer,
        native,
      );
      StoreNodeIssuer.prototype.assertNative.call(issuer, native);
      signal.throwIfAborted();
      if (started === true) break;
      if (started !== false) deny();
    }

    await StoreMediaExecution.prototype.run.call(owner.execution, signal);
    signal.throwIfAborted();
    result = await StoreMediaExecution.prototype.readResult.call(
      owner.execution,
    );
    signal.throwIfAborted();
    const publication = {
      requestId: request.requestId,
      bytes: result.length,
      sha256: createHash("sha256").update(result).digest("hex"),
    };
    await closeExecution(owner);
    signal.throwIfAborted();
    StoreNodeIssuer.prototype.assertChildrenRetired.call(issuer, native);
    await StoreNodeIssuer.prototype.publishCpuPrepareResult.call(
      issuer,
      native,
      publication,
    );
  } catch (error) {
    workFailed = true;
    workError = error;
    owner.failures.push(error);
    try {
      // A failed close cannot be translated into an ordinary result. Both the
      // exact execution and its original rejected retirement stay retained.
      await closeExecution(owner);
      if (owner.issuer && owner.native && owner.request) {
        StoreNodeIssuer.prototype.assertChildrenRetired.call(
          owner.issuer,
          owner.native,
        );
        await StoreNodeIssuer.prototype.publishCpuPrepareResult.call(
          owner.issuer,
          owner.native,
          {
            requestId: owner.request.requestId,
            errorCode: signal.aborted ? "PREPARE_INTERRUPTED" : failure(error),
          },
        );
      }
    } catch (publicationOrCleanupError) {
      owner.failures.push(publicationOrCleanupError);
      finalFailures.push(publicationOrCleanupError);
    }
  } finally {
    signal.removeEventListener("abort", cancelExecution);
    process.off("SIGTERM", interrupted);
    process.off("SIGINT", interrupted);
    result?.fill(0);
    if (owner.issuer) {
      try {
        owner.issuerClosing ??= StoreNodeIssuer.prototype.close.call(
          owner.issuer,
        );
        await owner.issuerClosing;
        owners.delete(owner);
      } catch (cleanupError) {
        owner.failures.push(cleanupError);
        finalFailures.push(cleanupError);
      }
    } else {
      try {
        owner.failedOpenClosing ??= StoreNodeIssuer.retireFailedOpen();
        await owner.failedOpenClosing;
        owners.delete(owner);
      } catch (cleanupError) {
        owner.failures.push(cleanupError);
        finalFailures.push(cleanupError);
      }
    }
  }

  if (finalFailures.length)
    throw new AggregateError(
      [...(workFailed ? [workError] : []), ...finalFailures],
      "STORE_CPU_PREPARE_FAILED",
    );
  if (workFailed) throw workError;
}
