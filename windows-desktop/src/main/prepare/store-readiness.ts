import { MODEL } from "../../../../chrome-extension/src/shared/local-model.js";
import { resolveQualifiedGpuIdentity } from "../../../../worker/src/enrollment/report-builder.js";
import { StoreWorkerCodeAuthority } from "../browser/store-native.js";
import type { HostContext } from "../host-context.js";
import { StoreNodeIssuer } from "../session/store-node-issuer.js";
import { PrepareFailure } from "./controller.js";
import { PREPARATION_FIXTURE } from "./fixture.js";
import { verifyPrivateFile } from "./private-files.js";
import {
  STORE_MODEL_READY_KEY,
  parseStoreModelReady,
  type StorePreparationBinding,
} from "./store-model-ready.js";

/** Readonly readiness for admission/display. A stored receipt still grants no
 * processing role, retained model or physical GPU lease. Every read uses living
 * package code, the same genuine GUI data helper and held private file hashes. */
export async function readStoreReadiness(
  host: HostContext,
  code: StoreWorkerCodeAuthority,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  StoreWorkerCodeAuthority.prototype.assertDataNative.call(code, host.native);
  const binding =
    await StoreWorkerCodeAuthority.prototype.preparationBinding.call(code);
  if (binding.sid !== host.identity.sid)
    throw new PrepareFailure("INTEGRITY_INVALID");
  const parsed = await readBoundStoreReadiness(host, binding, signal);
  if (!parsed) return null;
  const current: StorePreparationBinding =
    await StoreWorkerCodeAuthority.prototype.preparationBinding.call(code);
  if (JSON.stringify(current) !== JSON.stringify(binding))
    throw new PrepareFailure("INTEGRITY_INVALID");
  StoreWorkerCodeAuthority.prototype.assertDataNative.call(code, host.native);
  signal.throwIfAborted();
  return Object.freeze({ binding, ...parsed });
}

/** A Worker role reads the same record through its own actual Creator-bound
 * helper. Neither a configuration file nor an imported code-view observation
 * can substitute for this live private-branded issuer. */
export async function readStoreRoleReadiness(
  host: HostContext,
  issuer: StoreNodeIssuer,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  StoreNodeIssuer.prototype.assertNative.call(issuer, host.native);
  const { binding } = await StoreNodeIssuer.prototype.codeView.call(issuer);
  StoreNodeIssuer.prototype.assertNative.call(issuer, host.native);
  if (binding.sid !== host.identity.sid)
    throw new PrepareFailure("INTEGRITY_INVALID");
  const parsed = await readBoundStoreReadiness(host, binding, signal);
  if (!parsed) return null;
  const current = await StoreNodeIssuer.prototype.codeView.call(issuer);
  if (JSON.stringify(current.binding) !== JSON.stringify(binding))
    throw new PrepareFailure("INTEGRITY_INVALID");
  StoreNodeIssuer.prototype.assertNative.call(issuer, host.native);
  signal.throwIfAborted();
  return Object.freeze({ binding, ...parsed });
}

// Record/file observations only. Both callers above retain and revalidate
// their genuine code owners before returning; this is not a role/GPU grant.
async function readBoundStoreReadiness(
  host: HostContext,
  binding: StorePreparationBinding,
  signal: AbortSignal,
) {
  const bytes = await host.native.vaultRead("account", STORE_MODEL_READY_KEY);
  if (!bytes) {
    signal.throwIfAborted();
    return null;
  }
  let parsed: ReturnType<typeof parseStoreModelReady>;
  try {
    parsed = parseStoreModelReady(bytes, binding);
  } finally {
    bytes.fill(0);
  }
  const model = await verifyPrivateFile(
    host,
    `models\\${MODEL.filename}`,
    MODEL.bytes,
    signal,
  );
  if (
    model.sha256 !== MODEL.sha256 ||
    JSON.stringify(model.fingerprint) !==
      JSON.stringify(parsed.receipt.modelFingerprint)
  )
    throw new PrepareFailure("INTEGRITY_INVALID", "model");
  const fixture = await verifyPrivateFile(
    host,
    `fixtures\\${PREPARATION_FIXTURE.filename}`,
    PREPARATION_FIXTURE.bytes,
    signal,
  );
  if (fixture.sha256 !== PREPARATION_FIXTURE.sha256)
    throw new PrepareFailure("INTEGRITY_INVALID");
  try {
    if (!parsed.evidence.gpuIdentity) throw new Error("GPU_UNSUPPORTED");
    resolveQualifiedGpuIdentity(
      parsed.evidence.gpuIdentity,
      await host.native.enumerateGpus(),
    );
  } catch {
    throw new PrepareFailure("GPU_UNSUPPORTED");
  }
  signal.throwIfAborted();
  return { receipt: parsed.receipt, evidence: parsed.evidence };
}
