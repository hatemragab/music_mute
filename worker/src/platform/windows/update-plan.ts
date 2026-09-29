import { randomUUID } from "node:crypto";
import { retainSlotIdentities } from "../shared/slot-identities.js";
import { lstat, readFile, readdir, rename, rm } from "node:fs/promises";
import { win32 } from "node:path";
import { readMaintenanceConnection } from "../../runtime/runtime-config.js";
import { sha256 } from "../shared/file-benchmark.js";
import { compareWorkerReleaseVersions } from "../shared/release-version.js";
import { verifyUpdateMetadata } from "../shared/update-metadata.js";
import { WindowsServiceController } from "./native-service.js";
import { assertWindowsPrivateDataFile } from "./private-data.js";
import { verifyWindowsRelease } from "./release-manifest.js";
import {
  createWindowsReleaseLayout,
  type WindowsServiceLayout,
} from "./service-definition.js";
import { readWindowsActiveVersion } from "./active-release.js";
import { preservedWindowsRelease } from "./user-installation.js";
import {
  loadWindowsUpdateState,
  loadWindowsUpdateTrust,
  readAdministratorRecord,
  writeWindowsUpdateRecord,
} from "./user-updater.js";

const MODEL_DIGEST =
  "ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b";

/** Internal recovery operation; the native manager owns both operation locks. */
export async function quarantineWindowsUpdate(
  layout: WindowsServiceLayout,
  version: string,
) {
  if (!/^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/u.test(version))
    throw new TypeError("Quarantined release version is invalid");
  await new WindowsServiceController(layout).assertPrivateInstallation();
  const state = await loadWindowsUpdateState(layout);
  const path = win32.join(layout.serviceRoot, "update-state.json");
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeWindowsUpdateRecord(temporary, {
      ...state,
      quarantinedVersions: [
        ...new Set([...state.quarantinedVersions, version]),
      ].slice(-100),
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function assertWindowsUpdateRequestPath(
  layout: WindowsServiceLayout,
  path: string,
): string {
  const relative = win32.relative(layout.serviceRoot, path);
  if (
    win32.normalize(path) !== path ||
    !/^update-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\\request\.json$/u.test(
      relative,
    )
  )
    throw new TypeError(
      "Update request must belong to a private installation transaction",
    );
  return win32.dirname(path);
}

export function windowsUpdatedConfig(
  layout: WindowsServiceLayout,
  previous: Record<string, unknown>,
  version: string,
) {
  preservedWindowsRelease(layout, previous);
  if (
    !Array.isArray(previous.slots) ||
    previous.slots.length < 1 ||
    previous.slots.length > 2
  )
    throw new TypeError("Installed slot configuration is invalid");
  const release = createWindowsReleaseLayout(layout, version);
  return {
    ...retainSlotIdentities(previous, [previous.slots[0]]),
    engineRoot: release.engineRoot,
    pythonPath: release.pythonPath,
    ffmpegPath: release.ffmpegPath,
    ffprobePath: release.ffprobePath,
    validatedMaxWorkersPerGpu: 1,
  };
}

/** Called by the verified manager while it owns the installer and operator locks.
 * Only prepares new private files; it cannot activate a service or alter config.
 */
export async function prepareWindowsUpdatePlan(
  layout: WindowsServiceLayout,
  requestPath: string,
  releasePath: string,
) {
  await new WindowsServiceController(layout).assertPrivateInstallation();
  const transaction = assertWindowsUpdateRequestPath(layout, requestPath);
  const request = await readAdministratorRecord(requestPath);
  if (
    !request ||
    Object.keys(request).sort().join(",") !==
      "configSha256,credentialSha256,force,previousVersion,schemaVersion,signed" ||
    request.schemaVersion !== 1 ||
    typeof request.force !== "boolean" ||
    typeof request.previousVersion !== "string" ||
    typeof request.configSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(request.configSha256) ||
    typeof request.credentialSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(request.credentialSha256)
  )
    throw new TypeError("Windows update request is invalid");
  const state = await loadWindowsUpdateState(layout);
  const metadata = verifyUpdateMetadata(request.signed, {
    platform: "windows-amd64",
    publicKeys: await loadWindowsUpdateTrust(layout),
    minimumSequence: state.highestSequence,
  });
  if (state.quarantinedVersions.includes(metadata.releaseVersion))
    throw new Error("Update candidate is locally quarantined");
  if (
    releasePath !==
    win32.join(transaction, `release-${metadata.releaseVersion}`)
  )
    throw new TypeError("Update release does not match its signed transaction");
  const currentVersion = await readWindowsActiveVersion(layout);
  if (
    currentVersion !== request.previousVersion ||
    compareWorkerReleaseVersions(metadata.releaseVersion, currentVersion) <= 0
  )
    throw new Error(
      "Installed release changed during update preparation; retry the update",
    );
  for (const path of [
    layout.configPath,
    layout.credentialPath,
    layout.lifecyclePath,
  ])
    await assertWindowsPrivateDataFile(path);
  const configInfo = await lstat(layout.configPath);
  if (configInfo.size < 2 || configInfo.size > 65536)
    throw new TypeError("Installed config size is invalid");
  if (
    (await sha256(layout.configPath)) !== request.configSha256 ||
    (await sha256(layout.credentialPath)) !== request.credentialSha256
  )
    throw new Error(
      "Installation pairing or settings changed during update preparation; retry the update",
    );
  let decoded: unknown;
  try {
    decoded = JSON.parse(await readFile(layout.configPath, "utf8"));
  } catch {
    throw new TypeError("Installed runtime configuration is invalid");
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded))
    throw new TypeError("Installed runtime configuration is invalid");
  const config = decoded as Record<string, unknown>;
  const current = preservedWindowsRelease(layout, config);
  if (current.version !== currentVersion)
    throw new Error("Active and configured releases disagree");
  // Validate the complete config/credential without accepting expired capacity
  // evidence as runtime admission. Update explicitly selects one slot.
  await readMaintenanceConnection(layout.configPath);
  const oldManifest = await verifyWindowsRelease(current.release.releaseRoot);
  const manifest = await verifyWindowsRelease(releasePath);
  if (
    oldManifest.releaseVersion !== currentVersion ||
    manifest.releaseVersion !== metadata.releaseVersion
  )
    throw new TypeError("Update release inventory identity is invalid");
  const modelPath = win32.join(
    layout.modelCacheRoot,
    MODEL_DIGEST,
    "Kim_Vocal_2.onnx",
  );
  await assertWindowsPrivateDataFile(modelPath);
  if ((await sha256(modelPath)) !== MODEL_DIGEST)
    throw new TypeError("Installed model checksum is invalid");
  const fixtures = (await readdir(layout.stateRoot))
    .filter((name) => /^qualification-fixture-[a-f0-9]{64}\.wav$/u.test(name))
    .sort();
  if (fixtures.length === 0)
    throw new Error("Installed qualification fixture is missing");
  const fixturePath = win32.join(layout.stateRoot, fixtures[0]!);
  await assertWindowsPrivateDataFile(fixturePath);
  const fixtureInfo = await lstat(fixturePath);
  if (fixtureInfo.size < 1 || fixtureInfo.size > 64 * 1024 ** 2)
    throw new TypeError("Installed qualification fixture size is invalid");
  const fixtureSha256 = fixtures[0]!.slice("qualification-fixture-".length, -4);
  if ((await sha256(fixturePath)) !== fixtureSha256)
    throw new TypeError("Installed qualification fixture checksum is invalid");
  const configPath = win32.join(transaction, "prepared-config.json");
  const statePath = win32.join(transaction, "prepared-state.json");
  await writeWindowsUpdateRecord(
    configPath,
    windowsUpdatedConfig(layout, config, metadata.releaseVersion),
  );
  await writeWindowsUpdateRecord(statePath, {
    ...state,
    highestSequence: metadata.sequence,
  });
  return {
    schemaVersion: 1,
    releaseVersion: metadata.releaseVersion,
    previousVersion: currentVersion,
    configPath,
    credentialPath: layout.credentialPath,
    modelPath,
    fixturePath,
    fixtureSha256,
    statePath,
    force: request.force,
    capacityRequalificationRequired: config.validatedMaxWorkersPerGpu === 2,
  };
}
