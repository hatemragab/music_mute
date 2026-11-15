import { createHash } from "node:crypto";
import { parseStrictJson } from "../../../chrome-extension/src/shared/strict-json.js";
import { MODEL } from "../../../chrome-extension/src/shared/local-model.js";
import {
  parseQualificationEvidence,
  resolveQualifiedGpuIdentity,
} from "../../../worker/src/enrollment/report-builder.js";
import {
  StoreNodeIssuer,
  StoreFixedToolChild,
} from "../main/session/store-node-issuer.js";
import { HostContext } from "../main/host-context.js";
import { PrepareFailure } from "../main/prepare/controller.js";
import { PREPARATION_FIXTURE } from "../main/prepare/fixture.js";
import { readPrivateBytes } from "../main/prepare/private-files.js";
import { parseStoreQualificationFailure } from "../shared/store-qualification-result.js";
import type { StorePrepareLaunchRequest } from "../shared/store-prepare-contracts.js";
import { STORE_PREPARE_FAILURE_CODES } from "../shared/store-prepare-contracts.js";
import type { WindowsConsumerNative } from "../../../worker/src/platform/windows/consumer-native.js";

const owners = new Set<{
  issuer: StoreNodeIssuer;
  native?: WindowsConsumerNative;
}>();
function failure(error: unknown): (typeof STORE_PREPARE_FAILURE_CODES)[number] {
  return error instanceof PrepareFailure
    ? (STORE_PREPARE_FAILURE_CODES.find((code) => code === error.code) ??
        "OPERATION_FAILED")
    : "OPERATION_FAILED";
}
/** Fixed protected Store Prepare Node entry. The live native Creator admits
 * the real Node/JS role, exact original request and GPU/child Jobs separately;
 * private reports and these receiving parsers cannot construct that authority. */
export async function runStorePreparationChild(
  argv: readonly string[],
): Promise<void> {
  if (
    arguments.length !== 1 ||
    argv.length !== 1 ||
    argv[0] !== "--store-session"
  )
    throw new Error("PREPARE_CONTEXT_INVALID");
  const issuer = await StoreNodeIssuer.open();
  const owner: { issuer: StoreNodeIssuer; native?: WindowsConsumerNative } = {
    issuer,
  };
  owners.add(owner);
  const lifetime = new AbortController();
  const interrupted = () => lifetime.abort();
  process.once("SIGTERM", interrupted);
  process.once("SIGINT", interrupted);
  let native: WindowsConsumerNative | undefined,
    request: StorePrepareLaunchRequest | undefined;
  try {
    if (issuer.nodeRole !== "prepare")
      throw new Error("PREPARE_CONTEXT_INVALID");
    native = await issuer.openNative();
    owner.native = native;
    const host = await HostContext.initialize(native, "0.1.0", 1);
    request = await StoreNodeIssuer.prototype.prepareRequest.call(
      issuer,
      native,
    );
    if (
      request.binding.sid !== host.identity.sid ||
      (await native.bootIdentity()) !== request.binding.bootIdentity
    )
      throw new PrepareFailure("INTEGRITY_INVALID");
    const currentGpus = await native.enumerateGpus();
    try {
      resolveQualifiedGpuIdentity(request.gpu, currentGpus);
    } catch {
      throw new PrepareFailure("GPU_UNSUPPORTED");
    }
    await host.directory(`prepare\\work\\${request.requestId}`);
    await host.directory("prepare\\results");
    const output = `prepare\\results\\${request.requestId}.json`;
    await native.validatePath("personal", output, "absent");
    const signal = AbortSignal.any([
      lifetime.signal,
      AbortSignal.timeout(14 * 60000),
    ]);
    signal.throwIfAborted();
    let bytes: Buffer;
    if (request.operation === "inspect") {
      bytes = Buffer.from(
        JSON.stringify({
          version: 1,
          sid: host.identity.sid,
          gpus: await native.enumerateGpus(),
        }),
      );
    } else {
      const lease = await native.acquireGpuGuard(request.gpu);
      if (!lease) throw new PrepareFailure("BUSY");
      // Native independently holds and compares these exact request bytes to
      // its private original GUI request, then locks model/fixture/ancestry.
      const config = `prepare\\work\\${request.requestId}\\store-qualification-request.json`;
      await native.validatePath("personal", config, "absent");
      await StoreNodeIssuer.prototype.writeNewPrivateFile.call(
        issuer,
        native,
        config,
        Buffer.from(JSON.stringify(request)),
      );
      const child =
        await StoreNodeIssuer.prototype.createQualification.call(issuer);
      const abort = () => {
        void StoreFixedToolChild.prototype.stop.call(child).catch(() => {});
      };
      signal.addEventListener("abort", abort, { once: true });
      const chunks: Buffer[] = [];
      let length = 0;
      try {
        signal.throwIfAborted();
        await child.start();
        for await (const chunk of child.stdout) {
          signal.throwIfAborted();
          if (
            !(chunk instanceof Uint8Array) ||
            (length += chunk.byteLength) > 262144
          )
            throw new PrepareFailure("INTEGRITY_INVALID");
          chunks.push(Buffer.from(chunk));
        }
        const exit = await child.waitForExit();
        signal.throwIfAborted();
        if (exit !== 0)
          throw new PrepareFailure(
            parseStoreQualificationFailure(Buffer.concat(chunks, length)) ??
              "OPERATION_FAILED",
          );
      } finally {
        signal.removeEventListener("abort", abort);
        // This real object remains retained by the issuer if exact cleanup
        // fails. Never publish failure/Ready while child retirement is unknown.
        await child.stop();
      }
      bytes = await readPrivateBytes(
        host,
        `prepare\\results\\${request.requestId}.raw.json`,
        16384,
      );
      const report = parseStrictJson(
        new TextDecoder("utf8", { fatal: true, ignoreBOM: true }).decode(bytes),
        16384,
        2048,
      );
      const fixtureDigest =
        request.fixture.kind === "fixed"
          ? PREPARATION_FIXTURE.sha256
          : request.fixture.sha256;
      const evidence = parseQualificationEvidence(report, {
        runtimeProfile: "windows-user",
        expectedUserSid: host.identity.sid,
        expectedFixtureDigest: fixtureDigest,
      });
      resolveQualifiedGpuIdentity(evidence.gpuIdentity!, [request.gpu]);
      if (
        evidence.modelDigest !== MODEL.sha256 ||
        evidence.releaseManifestDigest !==
          request.binding.runtimeManifestSha256 ||
        evidence.runtimeDiagnostics?.onnxRuntime !== "1.24.4"
      )
        throw new PrepareFailure("INTEGRITY_INVALID");
    }
    signal.throwIfAborted();
    await StoreNodeIssuer.prototype.writeNewPrivateFile.call(
      issuer,
      native,
      output,
      bytes,
    );
    if (!(await readPrivateBytes(host, output, 16384)).equals(bytes))
      throw new PrepareFailure("INTEGRITY_INVALID");
    await StoreNodeIssuer.prototype.publishPrepareResult.call(issuer, native, {
      requestId: request.requestId,
      rawBytes: bytes.length,
      rawSha256: createHash("sha256").update(bytes).digest("hex"),
    });
    // The original physical lease remains live through native publication.
    // Closing its exact SDK releases it only after the original child Job0.
  } catch (error) {
    if (native && request) {
      // The issuer must first retire every original child. Any uncertainty
      // prevents ordinary result publication and remains Creator-owned.
      // A failed native/creator trust check also denies this publication.
      const code = lifetime.signal.aborted
        ? "PREPARE_INTERRUPTED"
        : failure(error);
      StoreNodeIssuer.prototype.assertChildrenRetired.call(issuer, native);
      await StoreNodeIssuer.prototype.publishPrepareResult.call(
        issuer,
        native,
        { requestId: request.requestId, errorCode: code },
      );
    }
    throw error;
  } finally {
    process.off("SIGTERM", interrupted);
    process.off("SIGINT", interrupted);
    await StoreNodeIssuer.prototype.close.call(issuer);
    owners.delete(owner);
  }
}
