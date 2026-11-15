import {
  resolveQualifiedGpuIdentity,
  type DirectmlGpuIdentity,
} from "../../../../worker/src/enrollment/report-builder.js";
import type { WindowsConsumerNative } from "../../../../worker/src/platform/windows/consumer-native.js";
import { MODEL } from "../../../../chrome-extension/src/shared/local-model.js";
import { parseReadyReceipt } from "../prepare/operations.js";
import { parseFleetRecord } from "../fleet/store.js";
import { readOperationalFleetIdentity } from "../fleet/active-runtime.js";
import { readStoreFleetRuntimeIdentity } from "../fleet/store-active-runtime.js";
import { StoreNodeIssuer } from "../session/store-node-issuer.js";
import { HostContext } from "../host-context.js";
import { readStoreRoleReadiness } from "../prepare/store-readiness.js";

type Native = Pick<
  WindowsConsumerNative,
  "identity" | "vaultRead" | "bootIdentity" | "enumerateGpus"
>;
async function currentStoreReady(
  native: Native,
  release: string,
  issuer: StoreNodeIssuer,
) {
  StoreNodeIssuer.prototype.assertNative.call(issuer, native);
  if (release !== issuer.inventorySha256) throw new Error("GPU_OWNER_DENIED");
  const helper = await StoreNodeIssuer.prototype.openNative.call(issuer);
  try {
    const host = await HostContext.initialize(helper, "0.1.0", 1),
      ready = await readStoreRoleReadiness(
        host,
        issuer,
        new AbortController().signal,
      );
    if (!ready || ready.binding.inventorySha256 !== release)
      throw new Error("PREPARE_REQUIRED");
    StoreNodeIssuer.prototype.assertNative.call(issuer, native);
    if ((await native.bootIdentity()) !== ready.binding.bootIdentity)
      throw new Error("PREPARE_REQUIRED");
    return ready;
  } finally {
    await helper.close();
  }
}
async function currentReady(native: Native, release: string) {
  if (!/^[a-f0-9]{64}$/u.test(release)) throw new Error("GPU_OWNER_DENIED");
  const identity = await native.identity(),
    boot = await native.bootIdentity(),
    bytes = await native.vaultRead("account", "ready_receipt");
  if (!bytes || bytes.length > 65536) throw new Error("PREPARE_REQUIRED");
  try {
    const ready = parseReadyReceipt(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      { sid: identity.sid, identity: release },
      boot,
    );
    if (
      ready.receipt.release !== release ||
      (await native.bootIdentity()) !== boot
    )
      throw new Error("PREPARE_REQUIRED");
    return { ...ready, sid: identity.sid, boot };
  } finally {
    bytes.fill(0);
  }
}
/** Admission authority is the current qualified runtime, never a preference or
 * the immutable enrollment's former boot/LUID. Execution still verifies bytes. */
export async function readCurrentFleetGpu(
  native: Native,
  release: string,
  issuer?: StoreNodeIssuer,
): Promise<DirectmlGpuIdentity> {
  const store = issuer
      ? await currentStoreReady(native, release, issuer)
      : undefined,
    ready = store ? undefined : await currentReady(native, release),
    sid = store ? store.binding.sid : ready!.sid,
    boot = store ? store.binding.bootIdentity : ready!.boot,
    bytes = await native.vaultRead("fleet", "enrollment");
  if (!bytes || bytes.length > 16384) throw new Error("FLEET_NOT_ENROLLED");
  let record;
  try {
    record = parseFleetRecord(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      sid,
    );
  } finally {
    bytes.fill(0);
  }
  if (record.phase !== "complete") throw new Error("FLEET_NOT_ENROLLED");
  if (issuer) {
    const active = await readStoreFleetRuntimeIdentity(
      issuer,
      record,
      new AbortController().signal,
    );
    StoreNodeIssuer.prototype.assertNative.call(issuer, native);
    if (
      active.release !== release ||
      active.bootIdentity !== boot ||
      (await native.bootIdentity()) !== boot
    )
      throw new Error("FLEET_PREPARE_REQUIRED");
    return active.gpu;
  }
  const active = await readOperationalFleetIdentity(native, record, {
    release,
    manifestDigest: store
      ? store.binding.runtimeManifestSha256
      : ready!.receipt.manifestSha256,
    modelDigest: MODEL.sha256,
  });
  if ((await native.bootIdentity()) !== boot)
    throw new Error("FLEET_PREPARE_REQUIRED");
  return active.gpu;
}
export async function readCurrentPersonalGpu(
  native: Native,
  release: string,
  issuer?: StoreNodeIssuer,
): Promise<DirectmlGpuIdentity> {
  if (issuer) {
    const ready = await currentStoreReady(native, release, issuer);
    if (!ready.evidence.gpuIdentity) throw new Error("PREPARE_REQUIRED");
    const gpu = resolveQualifiedGpuIdentity(
      ready.evidence.gpuIdentity,
      await native.enumerateGpus(),
    );
    StoreNodeIssuer.prototype.assertNative.call(issuer, native);
    if ((await native.bootIdentity()) !== ready.binding.bootIdentity)
      throw new Error("PREPARE_REQUIRED");
    return gpu;
  }
  const ready = await currentReady(native, release);
  if (!ready.evidence.gpuIdentity) throw new Error("PREPARE_REQUIRED");
  const gpu = resolveQualifiedGpuIdentity(
    ready.evidence.gpuIdentity,
    await native.enumerateGpus(),
  );
  if ((await native.bootIdentity()) !== ready.boot)
    throw new Error("PREPARE_REQUIRED");
  return gpu;
}
