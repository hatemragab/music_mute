import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { readPackagedResource } from "../browser/package-trust.js";
import { join } from "node:path";
import {
  verifyUpdateMetadata,
  type UpdateMetadata,
} from "../../../../worker/src/platform/shared/update-metadata.js";
import { MODEL } from "../../../../chrome-extension/src/shared/local-model.js";
import { PREPARATION_FIXTURE } from "./fixture.js";
import { PrepareFailure } from "./controller.js";
import {
  parsePreparationRuntimeSource,
  type PreparationRuntimeSource,
} from "./runtime-source.js";

export interface PreparationBundle {
  metadata: UpdateMetadata;
  archivePath: string;
  targetIdentity: string;
  source?: PreparationRuntimeSource;
  /** Expired metadata permits only exact already-activated offline bytes, never a new download. */
  allowNetwork?: boolean;
}
export interface ExistingActivation {
  target: string;
  sequence: number;
  activatedAt: string;
}
async function json(path: string, limit: number): Promise<unknown> {
  const stat = await lstat(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size > limit ||
    stat.size < 2
  )
    throw new PrepareFailure("INTEGRITY_INVALID");
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        await readPackagedResource(path, limit),
      ),
    );
  } catch {
    throw new PrepareFailure("INTEGRITY_INVALID");
  }
}
export function preparationTargetIdentity(metadata: UpdateMetadata): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        profile: "windows-user",
        archive: metadata.release.sha256,
        version: metadata.releaseVersion,
        sequence: metadata.sequence,
        model: MODEL.sha256,
        fixture: PREPARATION_FIXTURE.sha256,
        qualification: "onnxruntime-disable-cpu-fallback-v1",
      }),
    )
    .digest("hex");
}
/** These public keys and metadata are packaged by the signed app build, never fetched from the artifact. */
export async function loadPreparationBundle(
  resources: string,
  minimumSequence: number,
  now = new Date(),
  existing?: ExistingActivation,
): Promise<PreparationBundle> {
  const keys = await json(join(resources, "runtime-public-keys.json"), 8192);
  if (
    !keys ||
    typeof keys !== "object" ||
    Array.isArray(keys) ||
    Object.keys(keys).length < 1 ||
    Object.keys(keys).length > 4 ||
    Object.entries(keys).some(
      ([id, key]) =>
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id) ||
        typeof key !== "string" ||
        key.length > 1024,
    )
  )
    throw new PrepareFailure("INTEGRITY_INVALID");
  const signed = await json(
    join(resources, "runtime", "runtime-metadata.json"),
    16384,
  );
  let metadata: UpdateMetadata;
  let allowNetwork = true;
  try {
    metadata = verifyUpdateMetadata(signed, {
      platform: "windows-amd64",
      installationProfile: "windows-user",
      publicKeys: keys as Record<string, string>,
      minimumSequence,
      now,
    });
  } catch {
    // Expiry gates new artifacts. An exact DPAPI-bound active artifact may be used offline;
    // its signature must still verify with the app's current trusted keys at activation time.
    const activatedAt = existing ? Date.parse(existing.activatedAt) : NaN;
    if (
      !existing ||
      !Number.isFinite(activatedAt) ||
      activatedAt > now.getTime()
    )
      throw new PrepareFailure("INTEGRITY_INVALID");
    try {
      metadata = verifyUpdateMetadata(signed, {
        platform: "windows-amd64",
        installationProfile: "windows-user",
        publicKeys: keys as Record<string, string>,
        minimumSequence,
        now: new Date(activatedAt),
      });
      if (
        metadata.sequence !== existing.sequence ||
        preparationTargetIdentity(metadata) !== existing.target
      )
        throw new Error("ACTIVATION_MISMATCH");
      allowNetwork = false;
    } catch {
      throw new PrepareFailure("INTEGRITY_INVALID");
    }
  }
  const targetIdentity = preparationTargetIdentity(metadata);
  let source: PreparationRuntimeSource | undefined;
  try {
    source = parsePreparationRuntimeSource(
      await json(join(resources, "runtime", "runtime-source.json"), 4096),
      metadata,
      targetIdentity,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return {
    metadata,
    archivePath: join(resources, "runtime", metadata.release.filename),
    targetIdentity,
    ...(source ? { source } : {}),
    allowNetwork,
  };
}
