import { createHash } from "node:crypto";
import { types } from "node:util";
import { parseStrictJson } from "../../../chrome-extension/src/shared/strict-json.js";
import { resolveQualifiedGpuIdentity } from "../../../worker/src/enrollment/report-builder.js";
import type { WindowsConsumerNative } from "../../../worker/src/platform/windows/consumer-native.js";
import { HostContext } from "../main/host-context.js";
import { validateAdvancedBenchmarkReport } from "../main/fleet/advanced/benchmark-child.js";
import { PrepareFailure } from "../main/prepare/controller.js";
import { readPrivateBytes } from "../main/prepare/private-files.js";
import { parseStorePreparationBinding } from "../main/prepare/store-model-ready.js";
import {
  StoreFixedToolChild,
  StoreNodeIssuer,
} from "../main/session/store-node-issuer.js";
import {
  storeBenchmarkConfigurationSha256,
  type StoreBenchmarkRequest,
} from "../shared/store-benchmark-contracts.js";
import { STORE_PREPARE_FAILURE_CODES } from "../shared/store-prepare-contracts.js";

interface BenchmarkNodeOwner {
  opening?: Promise<StoreNodeIssuer>;
  issuer?: StoreNodeIssuer;
  native?: WindowsConsumerNative;
  request?: StoreBenchmarkRequest;
  childOpening?: Promise<StoreFixedToolChild>;
  child?: StoreFixedToolChild;
  childClosing?: Promise<void>;
  issuerClosing?: Promise<void>;
  failedOpenClosing?: Promise<void>;
  readonly failures: unknown[];
}

// Every original construction and retirement remains reachable on failure.
// Neither a report nor a missing process can substitute for its real owner.
const owners = new Set<BenchmarkNodeOwner>();

function deny(): never {
  throw new Error("PREPARE_CONTEXT_INVALID");
}

function assertEntry(argv: readonly string[]): void {
  if (
    types.isProxy(argv) ||
    !Array.isArray(argv) ||
    Object.getPrototypeOf(argv) !== Array.prototype
  )
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
    item.value !== "--store-benchmark" ||
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

function closeChild(owner: BenchmarkNodeOwner): Promise<void> {
  if (!owner.childOpening) return Promise.resolve();
  owner.childClosing ??= (async () => {
    await owner.childOpening!.catch(() => {});
    if (owner.child) await StoreFixedToolChild.prototype.stop.call(owner.child);
  })();
  void owner.childClosing.catch(() => {});
  return owner.childClosing;
}

async function currentBinding(
  issuer: StoreNodeIssuer,
  request: StoreBenchmarkRequest,
): Promise<void> {
  const view = await StoreNodeIssuer.prototype.codeView.call(issuer);
  if (
    JSON.stringify(parseStorePreparationBinding(view.binding)) !==
    JSON.stringify(parseStorePreparationBinding(request.binding))
  )
    throw new PrepareFailure("INTEGRITY_INVALID");
}

/** Fixed protected Prepare Node benchmark entry. Its genuine Creator owns the
 * original request, fixed executable, held model/fixture and actual GPU/Job.
 * This entry accepts no paths, launchers, candidate code or cleanup receipts. */
export async function runStoreBenchmarkChild(
  argv: readonly string[],
): Promise<void> {
  if (arguments.length !== 1) deny();
  assertEntry(argv);
  const owner: BenchmarkNodeOwner = { failures: [] };
  owners.add(owner);
  const lifetime = new AbortController(),
    signal = AbortSignal.any([
      lifetime.signal,
      AbortSignal.timeout(119 * 60_000),
    ]),
    interrupted = () => lifetime.abort(),
    cancelChild = () => {
      if (owner.childOpening) void closeChild(owner).catch(() => {});
    };
  process.once("SIGTERM", interrupted);
  process.once("SIGINT", interrupted);
  signal.addEventListener("abort", cancelChild, { once: true });

  let configBytes: Buffer | undefined,
    rawBytes: Buffer | undefined,
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
      request = await StoreNodeIssuer.prototype.benchmarkRequest.call(
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
    try {
      resolveQualifiedGpuIdentity(
        request.configuration.gpu,
        await native.enumerateGpus(),
      );
    } catch {
      throw new PrepareFailure("GPU_UNSUPPORTED");
    }
    StoreNodeIssuer.prototype.assertNative.call(issuer, native);
    await currentBinding(issuer, request);
    signal.throwIfAborted();
    if (!(await native.acquireGpuGuard(request.configuration.gpu)))
      throw new PrepareFailure("BUSY");
    StoreNodeIssuer.prototype.assertNative.call(issuer, native);
    signal.throwIfAborted();

    await host.directory(`prepare\\work\\${request.requestId}`);
    await host.directory(`prepare\\work\\${request.requestId}\\engine`);
    if (request.configuration.saveAudio === true)
      await host.directory(`prepare\\work\\${request.requestId}\\saved-audio`);
    await host.directory("prepare\\results");
    const config = `prepare\\work\\${request.requestId}\\store-benchmark-config.json`,
      report = `prepare\\results\\${request.requestId}.benchmark.raw.json`;
    await native.validatePath("personal", config, "absent");
    await native.validatePath("personal", report, "absent");
    configBytes = Buffer.from(JSON.stringify(request.configuration));
    const configurationSha256 = storeBenchmarkConfigurationSha256(
      request.configuration,
    );
    if (
      createHash("sha256").update(configBytes).digest("hex") !==
      configurationSha256
    )
      throw new PrepareFailure("INTEGRITY_INVALID");
    await StoreNodeIssuer.prototype.writeNewPrivateFile.call(
      issuer,
      native,
      config,
      configBytes,
    );
    signal.throwIfAborted();
    owner.childOpening = StoreNodeIssuer.prototype.createBenchmark.call(issuer);
    owner.child = await owner.childOpening;
    signal.throwIfAborted();
    const clock = performance.now(),
      chunks: Buffer[] = [];
    let length = 0,
      wallSeconds = 0;
    try {
      await StoreFixedToolChild.prototype.start.call(owner.child);
      for await (const chunk of owner.child.stdout) {
        signal.throwIfAborted();
        if (
          !(chunk instanceof Uint8Array) ||
          (length += chunk.byteLength) > 262144
        )
          throw new PrepareFailure("INTEGRITY_INVALID");
        chunks.push(Buffer.from(chunk));
      }
      const exit = await StoreFixedToolChild.prototype.waitForExit.call(
        owner.child,
      );
      signal.throwIfAborted();
      if (exit !== 0) throw new PrepareFailure("OPERATION_FAILED");
      wallSeconds = (performance.now() - clock) / 1000;
    } finally {
      try {
        await closeChild(owner);
      } finally {
        for (const chunk of chunks) chunk.fill(0);
      }
    }
    if (
      !Number.isFinite(wallSeconds) ||
      wallSeconds <= 0 ||
      wallSeconds > 86400
    )
      throw new PrepareFailure("INTEGRITY_INVALID");
    StoreNodeIssuer.prototype.assertChildrenRetired.call(issuer, native);
    signal.throwIfAborted();
    rawBytes = await readPrivateBytes(host, report, 8 * 1024 ** 2);
    const raw = parseStrictJson(
      new TextDecoder("utf8", { fatal: true, ignoreBOM: true }).decode(
        rawBytes,
      ),
      8 * 1024 ** 2,
      16384,
    );
    validateAdvancedBenchmarkReport(raw, request.configuration, wallSeconds);
    StoreNodeIssuer.prototype.assertNative.call(issuer, native);
    await currentBinding(issuer, request);
    signal.throwIfAborted();
    await StoreNodeIssuer.prototype.publishBenchmarkResult.call(
      issuer,
      native,
      {
        requestId: request.requestId,
        configurationSha256,
        rawBytes: rawBytes.length,
        rawSha256: createHash("sha256").update(rawBytes).digest("hex"),
        wallSeconds_json: JSON.stringify(wallSeconds),
      },
    );
  } catch (error) {
    workFailed = true;
    workError = error;
    owner.failures.push(error);
    try {
      await closeChild(owner);
      if (owner.issuer && owner.native && owner.request) {
        StoreNodeIssuer.prototype.assertChildrenRetired.call(
          owner.issuer,
          owner.native,
        );
        await StoreNodeIssuer.prototype.publishBenchmarkResult.call(
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
    signal.removeEventListener("abort", cancelChild);
    process.off("SIGTERM", interrupted);
    process.off("SIGINT", interrupted);
    configBytes?.fill(0);
    rawBytes?.fill(0);
    try {
      if (owner.issuer) {
        owner.issuerClosing ??= StoreNodeIssuer.prototype.close.call(
          owner.issuer,
        );
        await owner.issuerClosing;
      } else {
        owner.failedOpenClosing ??= StoreNodeIssuer.retireFailedOpen();
        await owner.failedOpenClosing;
      }
      owners.delete(owner);
    } catch (cleanupError) {
      owner.failures.push(cleanupError);
      finalFailures.push(cleanupError);
    }
  }
  if (finalFailures.length)
    throw new AggregateError(
      [...(workFailed ? [workError] : []), ...finalFailures],
      "STORE_BENCHMARK_NODE_FAILED",
    );
  if (workFailed) throw workError;
}
