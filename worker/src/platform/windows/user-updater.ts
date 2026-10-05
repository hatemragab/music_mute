import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rm, statfs } from "node:fs/promises";
import { join, win32 } from "node:path";
import { downloadVerifiedArtifact } from "../../enrollment/artifact-download.js";
import { prepareInstallationRelease } from "../../enrollment/release-archive.js";
import { WorkerControlPlaneClient } from "../../runtime/control-plane-client.js";
import { readMaintenanceConnection } from "../../runtime/runtime-config.js";
import { compareWorkerReleaseVersions } from "../shared/release-version.js";
import {
  verifyUpdateMetadata,
  type UpdateCandidate,
} from "../shared/update-metadata.js";
import {
  BUILT_IN_UPDATE_TRUST,
  parseUpdateTrust,
} from "../shared/update-trust.js";
import {
  WindowsServiceController,
  type WindowsServiceActions,
} from "./native-service.js";
import {
  assertWindowsAdministratorDataFile,
  assertWindowsPrivateDataFile,
} from "./private-data.js";
import type { WindowsServiceLayout } from "./service-definition.js";
import { readWindowsActiveVersion } from "./active-release.js";
import { executeWindowsServiceManager } from "./cli.js";
import { sha256 } from "../shared/file-benchmark.js";
import { verifyWindowsRelease } from "./release-manifest.js";
import { windowsOperationPending } from "./user-maintenance.js";

export interface WindowsUpdateState {
  schemaVersion: 1;
  highestSequence: number;
  quarantinedVersions: string[];
}
export interface WindowsUpdateCheckOptions {
  layout: WindowsServiceLayout;
  service?: WindowsServiceActions;
  download?: boolean;
  candidate?: () => Promise<UpdateCandidate>;
  connection?: typeof readMaintenanceConnection;
  privateFile?: typeof assertWindowsPrivateDataFile;
  state?: () => Promise<WindowsUpdateState>;
  trust?: () => Promise<Record<string, string>>;
  activeVersion?: typeof readWindowsActiveVersion;
  now?: Date;
}

export async function checkWindowsUserUpdate(
  options: WindowsUpdateCheckOptions,
) {
  const { layout } = options;
  await (
    options.service ?? new WindowsServiceController(layout)
  ).assertPrivateInstallation();
  await (options.privateFile ?? assertWindowsPrivateDataFile)(
    layout.activeReleasePath,
  );
  const currentVersion = await (
    options.activeVersion ?? readWindowsActiveVersion
  )(layout);
  const config = await (options.connection ?? readMaintenanceConnection)(
    layout.configPath,
  );
  const state = await (
    options.state ?? (() => loadWindowsUpdateState(layout))
  )();
  const trust = await (
    options.trust ?? (() => loadWindowsUpdateTrust(layout))
  )();
  const candidate = await (
    options.candidate ??
    (() =>
      new WorkerControlPlaneClient({
        baseUrl: config.backendBaseUrl,
        credential: config.credential,
        allowInsecureLoopback: config.allowInsecureLoopback,
      }).updateCandidate("windows-amd64", options.download === true))
  )();
  const metadata = verifyUpdateMetadata(candidate.signed, {
    platform: "windows-amd64",
    publicKeys: trust,
    minimumSequence: state.highestSequence,
    ...(options.now ? { now: options.now } : {}),
  });
  if (state.quarantinedVersions.includes(metadata.releaseVersion))
    throw new Error("Update candidate is locally quarantined");
  return {
    currentVersion,
    availableVersion: metadata.releaseVersion,
    sequence: metadata.sequence,
    updateAvailable:
      compareWorkerReleaseVersions(metadata.releaseVersion, currentVersion) > 0,
    candidate,
    metadata,
    state,
  };
}

export async function loadWindowsUpdateTrust(
  layout: WindowsServiceLayout,
): Promise<Record<string, string>> {
  const record = await readAdministratorRecord(
    join(layout.serviceRoot, "update-trust.json"),
  );
  return record === null
    ? { ...BUILT_IN_UPDATE_TRUST }
    : parseUpdateTrust(record);
}

export async function loadWindowsUpdateState(
  layout: WindowsServiceLayout,
): Promise<WindowsUpdateState> {
  const record = await readAdministratorRecord(
    join(layout.serviceRoot, "update-state.json"),
  );
  if (record === null)
    return { schemaVersion: 1, highestSequence: 0, quarantinedVersions: [] };
  if (
    Object.keys(record).some(
      (key) =>
        !["schemaVersion", "highestSequence", "quarantinedVersions"].includes(
          key,
        ),
    ) ||
    record.schemaVersion !== 1 ||
    !Number.isSafeInteger(record.highestSequence) ||
    (record.highestSequence as number) < 0 ||
    !Array.isArray(record.quarantinedVersions) ||
    record.quarantinedVersions.length > 100 ||
    record.quarantinedVersions.some(
      (value) =>
        typeof value !== "string" ||
        !/^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/u.test(value),
    )
  )
    throw new TypeError("Windows update state is invalid");
  return {
    schemaVersion: 1,
    highestSequence: record.highestSequence as number,
    quarantinedVersions: record.quarantinedVersions as string[],
  };
}

export async function readAdministratorRecord(
  path: string,
): Promise<Record<string, unknown> | null> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size < 2 ||
    info.size > 64 * 1024
  )
    throw new TypeError("Windows update data is unsafe");
  await assertWindowsAdministratorDataFile(path);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new TypeError("Windows update data is invalid");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Windows update data is invalid");
  return value as Record<string, unknown>;
}

export async function writeWindowsUpdateRecord(
  path: string,
  value: unknown,
): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await assertWindowsAdministratorDataFile(path);
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function updateWindowsUserWorker(
  options: WindowsUpdateCheckOptions & {
    force?: boolean;
    fetch?: typeof fetch;
    check?: typeof checkWindowsUserUpdate;
    downloadArtifact?: typeof downloadVerifiedArtifact;
    prepareRelease?: typeof prepareInstallationRelease;
    verifyRelease?: typeof verifyWindowsRelease;
    manager?: typeof executeWindowsServiceManager;
    writeRecord?: typeof writeWindowsUpdateRecord;
    digest?: typeof sha256;
    pending?: typeof windowsOperationPending;
    availableDiskBytes?: () => Promise<number>;
    removeTransaction?: (path: string) => Promise<void>;
  },
): Promise<{
  status: "current" | "updated";
  releaseVersion: string;
  sequence: number;
  capacityRequalificationRequired?: boolean;
  cleanupWarning?: string;
}> {
  const { layout } = options;
  const pending = options.pending ?? windowsOperationPending;
  if (await pending(layout))
    throw new Error("Recover interrupted maintenance before updating");
  const checked = await (options.check ?? checkWindowsUserUpdate)({
    ...options,
    download: true,
  });
  if (!checked.updateAvailable)
    return {
      status: "current",
      releaseVersion: checked.currentVersion,
      sequence: checked.sequence,
    };
  const grant = checked.candidate.grant;
  if (
    !grant ||
    !Number.isFinite(Date.parse(grant.expiresAt)) ||
    Date.parse(grant.expiresAt) <= Date.now()
  )
    throw new TypeError("Update download grant is missing or expired");
  for (const path of [layout.configPath, layout.credentialPath])
    await (options.privateFile ?? assertWindowsPrivateDataFile)(path);
  const digest = options.digest ?? sha256;
  const configSha256 = await digest(layout.configPath);
  const credentialSha256 = await digest(layout.credentialPath);
  const transaction = join(layout.serviceRoot, `update-${randomUUID()}`);
  await mkdir(transaction, { mode: 0o700 });
  let result:
    | {
        status: "updated";
        releaseVersion: string;
        sequence: number;
        capacityRequalificationRequired: boolean;
        cleanupWarning?: string;
      }
    | undefined;
  try {
    const diskBytes = options.availableDiskBytes
      ? await options.availableDiskBytes()
      : await statfs(transaction).then((s) => s.bavail * s.bsize);
    if (
      !Number.isFinite(diskBytes) ||
      diskBytes < checked.metadata.release.bytes * 4 + 2 * 1024 ** 3
    )
      throw new Error(
        "Insufficient disk space to download, extract and stage the update",
      );
    // No signed URL or credential is persisted in the request or printed by the CLI.
    const request = join(transaction, "request.json");
    await (options.writeRecord ?? writeWindowsUpdateRecord)(request, {
      schemaVersion: 1,
      signed: checked.candidate.signed,
      previousVersion: checked.currentVersion,
      configSha256,
      credentialSha256,
      force: options.force === true,
    });
    const archivePath = join(transaction, checked.metadata.release.filename);
    await (options.downloadArtifact ?? downloadVerifiedArtifact)({
      url: grant.url,
      outputPath: archivePath,
      expectedBytes: checked.metadata.release.bytes,
      expectedSha256: checked.metadata.release.sha256,
      expectedContentType: "application/zip",
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    const prepared = await (
      options.prepareRelease ?? prepareInstallationRelease
    )({
      archivePath,
      outputRoot: transaction,
      platform: "windows-amd64",
      releaseVersion: checked.availableVersion,
    });
    const manifest = await (options.verifyRelease ?? verifyWindowsRelease)(
      prepared.path,
    );
    if (manifest.releaseVersion !== checked.availableVersion)
      throw new TypeError("Update release identity is invalid");
    await (options.manager ?? executeWindowsServiceManager)(
      win32.join(prepared.path, "installer", "manage-windows-service.ps1"),
      [
        "-Action",
        "Update",
        "-InstallRoot",
        layout.installRoot,
        "-Release",
        prepared.path,
        "-UpdateRequest",
        request,
      ],
    );
    const activeVersion = await (
      options.activeVersion ?? readWindowsActiveVersion
    )(layout);
    const state = await (
      options.state ?? (() => loadWindowsUpdateState(layout))
    )();
    if (
      (await pending(layout)) ||
      activeVersion !== checked.availableVersion ||
      state.highestSequence < checked.sequence
    )
      throw new Error(
        "Update transaction did not commit the expected release and sequence",
      );
    result = {
      status: "updated",
      releaseVersion: activeVersion,
      sequence: state.highestSequence,
      capacityRequalificationRequired: true,
    };
    return result;
  } finally {
    // Recovery uses the installed immutable release and journal snapshots, not
    // downloaded scratch. Keep scratch while recovery is pending for diagnosis.
    try {
      if (!(await pending(layout))) {
        await (
          options.service ?? new WindowsServiceController(layout)
        ).assertPrivateInstallation();
        await assertUpdateTransactionDirectory(transaction);
        await (
          options.removeTransaction ??
          ((path: string) => rm(path, { recursive: true, force: true }))
        )(transaction);
      }
    } catch {
      // Cleanup cannot change a committed update into a reported failure or
      // replace the original update error. Leave it for safe maintenance retry.
      const warning = "Update scratch cleanup deferred; run mw cleanup --apply";
      if (result !== undefined) result.cleanupWarning = warning;
      else process.emitWarning(warning, { code: "WORKER_CLEANUP_DEFERRED" });
    }
  }
}

async function assertUpdateTransactionDirectory(path: string): Promise<void> {
  const directory = await lstat(path);
  if (!directory.isDirectory() || directory.isSymbolicLink())
    throw new TypeError("Update transaction directory is unsafe");
}
