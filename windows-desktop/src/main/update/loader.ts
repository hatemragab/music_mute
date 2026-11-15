import { join, win32 } from "node:path";
import { MODEL } from "../../../../chrome-extension/src/shared/local-model.js";
import {
  verifyUpdateMetadata,
  type UpdateMetadata,
} from "../../../../worker/src/platform/shared/update-metadata.js";
import type { HostContext } from "../host-context.js";
import {
  preparationTargetIdentity,
  type PreparationBundle,
} from "../prepare/bundle.js";
import type { ReadyReceipt } from "../prepare/operations.js";
import {
  consumerUpdateIdentity,
  loadConsumerUpdateTrust,
  verifyConsumerUpdate,
  consumerUpdateSourceDescriptor,
} from "./metadata.js";
import { parseConsumerUpdateState } from "./controller.js";
import type {
  ConsumerUpdateMetadata,
  ConsumerUpdateSource,
} from "../../shared/update-contracts.js";
import { readPackagedResource } from "../browser/package-trust.js";
import { parseStrictJson } from "../../../../chrome-extension/src/shared/strict-json.js";
import { parseInstalledReadyMetadata } from "./installed-runtime.js";
import { loadPreparationBundle } from "../prepare/bundle.js";
import type { ConsumerUpdateTrust } from "./metadata.js";

export interface ActiveConsumerUpdate {
  version: 1;
  kind: "consumer" | "worker";
  signed: unknown;
  target: string;
  activatedAt: string;
  recoveryOf: string | null;
  source?: ConsumerUpdateSource;
  sourceDescriptor?: string;
}
export function consumerPreparationBundle(
  host: HostContext,
  metadata: ConsumerUpdateMetadata,
  trust?: ConsumerUpdateTrust,
): PreparationBundle {
  if (
    metadata.model.artifact.sha256 !== MODEL.sha256 ||
    metadata.model.artifact.bytes !== MODEL.bytes
  )
    throw new Error("UPDATE_INCOMPATIBLE");
  const runtime: UpdateMetadata = {
    schemaVersion: 1,
    installationProfile: "windows-user",
    platform: "windows-amd64",
    sequence: metadata.sequence,
    releaseVersion: metadata.runtime.version,
    publishedAt: metadata.publishedAt,
    expiresAt: metadata.expiresAt,
    release: {
      filename: metadata.runtime.artifact.filename,
      bytes: metadata.runtime.artifact.bytes,
      sha256: metadata.runtime.artifact.sha256,
      contentType: "application/zip",
    },
  };
  return {
    metadata: runtime,
    archivePath: win32.join(
      host.personalRoot,
      "updates",
      "staging",
      consumerUpdateIdentity(metadata),
      "runtime.zip",
    ),
    targetIdentity: preparationTargetIdentity(runtime),
    ...(trust
      ? {
          source: {
            version: 1 as const,
            platform: "windows-amd64" as const,
            installationProfile: "windows-user" as const,
            targetIdentity: preparationTargetIdentity(runtime),
            filename: runtime.release.filename,
            bytes: runtime.release.bytes,
            sha256: runtime.release.sha256,
            // Consumer metadata attests archive bytes, not expanded size. The
            // existing ZIP ceiling bounds planning until its actual scan.
            unpackedBytes: null,
            url: metadata.runtime.artifact.url,
            allowedOrigins: [...trust.allowedOrigins],
          },
          allowNetwork: Date.parse(metadata.expiresAt) > Date.now(),
        }
      : {}),
  };
}
/** Metadata selection only: operational Ready still verifies current boot,
 * model/file identity and full installed inventory in Operations. A protected
 * active record never silently falls back to another packaged runtime. */
export async function loadInstalledPreparationBundle(
  host: HostContext,
  resourcesRoot: string,
  minimumSequence: number,
): Promise<PreparationBundle> {
  const bytes = await host.native.vaultRead("account", "ready_receipt");
  let installed: ReturnType<typeof parseInstalledReadyMetadata> | undefined;
  if (bytes)
    try {
      installed = parseInstalledReadyMetadata(
        parseStrictJson(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
          32768,
        ),
        host.identity.sid,
      );
    } finally {
      bytes.fill(0);
    }
  const active = await loadActiveConsumerPreparationBundle(
    host,
    resourcesRoot,
    minimumSequence,
    installed,
  );
  return (
    active ??
    loadPreparationBundle(resourcesRoot, minimumSequence, new Date(), installed)
  );
}
/** Only the exact DPAPI active target can use recorded-time expiry or recovery exceptions. */
export async function loadActiveConsumerPreparationBundle(
  host: HostContext,
  resourcesRoot: string,
  minimumSequence: number,
  existing?: Pick<
    ReadyReceipt,
    "target" | "activatedAt" | "sequence" | "manifestSha256" | "modelSha256"
  >,
): Promise<PreparationBundle | undefined> {
  const bytes = await host.native.vaultRead(
    "account",
    "consumer_update_active",
  );
  if (!bytes) return undefined;
  try {
    const row = parseStrictJson(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      32768,
    ) as ActiveConsumerUpdate;
    if (
      Object.keys(row).some(
        (key) =>
          ![
            "activatedAt",
            "kind",
            "recoveryOf",
            "signed",
            "target",
            "version",
            "source",
            "sourceDescriptor",
          ].includes(key),
      ) ||
      ["activatedAt", "kind", "recoveryOf", "signed", "target", "version"].some(
        (key) => !Object.hasOwn(row, key),
      ) ||
      Object.hasOwn(row, "source") !== Object.hasOwn(row, "sourceDescriptor") ||
      (Object.hasOwn(row, "source") &&
        (row.kind !== "consumer" ||
          row.source !== "catalog" ||
          typeof row.sourceDescriptor !== "string" ||
          !/^[a-f0-9]{64}$/u.test(row.sourceDescriptor))) ||
      row.version !== 1 ||
      !["consumer", "worker"].includes(row.kind) ||
      !existing ||
      row.target !== existing.target ||
      row.activatedAt !== existing.activatedAt ||
      !Number.isFinite(Date.parse(row.activatedAt)) ||
      Date.parse(row.activatedAt) > Date.now() ||
      (row.recoveryOf !== null && !/^[a-f0-9]{64}$/u.test(row.recoveryOf))
    )
      throw new Error("UPDATE_ACTIVE_INVALID");
    let minimum = minimumSequence,
      recoveryRuntime: string | undefined;
    if (row.recoveryOf) {
      const stateBytes = await host.native.vaultRead(
        "account",
        "consumer_update_state",
      );
      if (!stateBytes) throw new Error("UPDATE_ACTIVE_INVALID");
      try {
        const state = parseConsumerUpdateState(
          JSON.parse(stateBytes.toString("utf8")),
        );
        if (
          state.journal?.identity !== row.recoveryOf ||
          !["rolling-back", "rolled-back"].includes(state.journal.phase) ||
          state.journal.previous.model?.sha256 !== existing.modelSha256 ||
          !state.journal.previous.runtime
        )
          throw new Error("UPDATE_ACTIVE_INVALID");
        minimum = existing.sequence;
        recoveryRuntime = state.journal.previous.runtime.sha256;
      } finally {
        stateBytes.fill(0);
      }
    }
    let bundle: PreparationBundle;
    if (row.kind === "consumer") {
      const trust = await loadConsumerUpdateTrust(
        resourcesRoot,
        row.source ?? "app",
      );
      if (
        row.sourceDescriptor &&
        row.sourceDescriptor !== consumerUpdateSourceDescriptor(trust)
      )
        throw new Error("UPDATE_SOURCE_CHANGED");
      bundle = consumerPreparationBundle(
        host,
        verifyConsumerUpdate(
          row.signed,
          trust,
          minimum,
          new Date(row.activatedAt),
        ),
        trust,
      );
    } else {
      const keys = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          await readPackagedResource(
            join(resourcesRoot, "runtime-public-keys.json"),
            16384,
          ),
        ),
      ) as Record<string, string>;
      const metadata = verifyUpdateMetadata(row.signed, {
        platform: "windows-amd64",
        installationProfile: "windows-user",
        minimumSequence: minimum,
        publicKeys: keys,
        now: new Date(row.activatedAt),
      });
      bundle = {
        metadata,
        targetIdentity: preparationTargetIdentity(metadata),
        archivePath: join(resourcesRoot, "runtime", metadata.release.filename),
      };
    }
    if (
      bundle.targetIdentity !== row.target ||
      bundle.metadata.sequence !== existing.sequence ||
      (recoveryRuntime && bundle.metadata.release.sha256 !== recoveryRuntime)
    )
      throw new Error("UPDATE_ACTIVE_INVALID");
    return bundle;
  } finally {
    bytes.fill(0);
  }
}
