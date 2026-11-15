import { MODEL } from "../../../../chrome-extension/src/shared/local-model.js";
import type { ReadyReceipt } from "../prepare/operations.js";
import { PREPARATION_FIXTURE } from "../prepare/fixture.js";
export type InstalledReadyMetadata = Pick<
  ReadyReceipt,
  | "sid"
  | "target"
  | "release"
  | "sequence"
  | "manifestSha256"
  | "modelSha256"
  | "fixtureSha256"
  | "modelFingerprint"
  | "activatedAt"
>;
const SHA = /^[a-f0-9]{64}$/u;
/** Metadata selector only. A legacy/stale receipt can never authorize inference or current Ready. */
export function parseInstalledReadyMetadata(
  value: unknown,
  sid: string,
): InstalledReadyMetadata {
  const fail = (): never => {
    throw new Error("UPDATE_STATE_INVALID");
  };
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return fail();
  const row = value as Record<string, unknown>,
    descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some((d) => !("value" in d))) return fail();
  const keys = [
    "version",
    "sid",
    "target",
    "release",
    "sequence",
    "manifestSha256",
    "modelSha256",
    "fixtureSha256",
    "modelFingerprint",
    "qualification",
    "activatedAt",
    ...(row.version === 2 ? ["bootIdentity"] : []),
  ];
  if (
    Reflect.ownKeys(row).some((k) => typeof k !== "string") ||
    Object.values(Object.getOwnPropertyDescriptors(row)).some(
      (d) => !("value" in d),
    ) ||
    Object.keys(row).sort().join() !== keys.sort().join() ||
    typeof row.version !== "number" ||
    ![1, 2].includes(row.version) ||
    row.sid !== sid ||
    typeof row.target !== "string" ||
    !SHA.test(row.target) ||
    row.release !== row.target ||
    !Number.isSafeInteger(row.sequence) ||
    Number(row.sequence) < 1 ||
    typeof row.manifestSha256 !== "string" ||
    !SHA.test(row.manifestSha256) ||
    row.modelSha256 !== MODEL.sha256 ||
    row.fixtureSha256 !== PREPARATION_FIXTURE.sha256 ||
    typeof row.activatedAt !== "string" ||
    row.activatedAt.length > 40 ||
    !Number.isFinite(Date.parse(row.activatedAt)) ||
    Date.parse(row.activatedAt) > Date.now() ||
    (row.version === 2 &&
      (typeof row.bootIdentity !== "string" || !SHA.test(row.bootIdentity)))
  )
    return fail();
  const p = row.modelFingerprint;
  if (
    !p ||
    typeof p !== "object" ||
    Array.isArray(p) ||
    Object.getPrototypeOf(p) !== Object.prototype
  )
    return fail();
  const fp = p as Record<string, unknown>;
  if (
    Object.keys(fp).sort().join() !==
      "bytes,changedAt,device,fileId,writtenAt" ||
    Object.values(Object.getOwnPropertyDescriptors(fp)).some(
      (d) => !("value" in d),
    ) ||
    fp.bytes !== MODEL.bytes ||
    [fp.device, fp.fileId, fp.writtenAt, fp.changedAt].some(
      (v) => typeof v !== "string" || !/^\d{1,30}$/u.test(v),
    ) ||
    fp.fileId === "0"
  )
    return fail();
  return {
    sid,
    target: row.target,
    release: row.target,
    sequence: row.sequence as number,
    manifestSha256: row.manifestSha256,
    modelSha256: MODEL.sha256,
    fixtureSha256: PREPARATION_FIXTURE.sha256,
    modelFingerprint: structuredClone(
      fp,
    ) as unknown as ReadyReceipt["modelFingerprint"],
    activatedAt: row.activatedAt,
  };
}
