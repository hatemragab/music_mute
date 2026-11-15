import { copyFile, lstat, mkdir, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseStrictJson } from "../../../chrome-extension/src/shared/strict-json.js";
import {
  STORE_PRODUCTS,
  parseStoreBuildNumber,
} from "../../src/shared/store-contracts.js";
import { auditStorePayload, StoreInputsMissing } from "./audit.js";
import { STORE_ICON_SOURCE, stageStoreAssets } from "./assets.js";
import { buildStoreAssets } from "./assets.js";
import { auditStoreUploadArchive } from "./archive.js";
import { packageFile } from "../validate-assets.js";
import {
  createStoreCodeInventory,
  hashStoreFile,
  parseStoreCodeInventoryBytes,
  type StoreInventoryEntry,
} from "./inventory.js";
import { renderStoreManifest, type StoreNamespaceProfile } from "./manifest.js";
import { parseStoreBuildDocument } from "./document-json.js";
import {
  WINDOWS_RELEASE_MANIFEST,
  createWindowsReleaseManifest,
  parseWindowsReleaseManifest,
  verifyWindowsRelease,
  writeWindowsReleaseManifest,
} from "../../../worker/src/platform/windows/release-manifest.js";

export const STORE_MAKEAPPX = Object.freeze({
  path: "C:\\Program Files (x86)\\Windows Kits\\10\\bin\\10.0.26100.0\\x64\\MakeAppx.exe",
  bytes: 584024,
  sha256: "00fff202b71c1266b8c3899701e42b5468ea153b2b33a0a47215fe27695f16d0",
  sdkVersion: "10.0.26100.0",
  fileVersion: "10.0.26100.7705",
});
export interface StoreBuildInputs {
  version: 1;
  purpose: "unsigned-store-upload-candidate";
  guiPayloadRoot: string;
  workerPayloadRoot: string;
  guiBuildNumber: number;
  workerBuildNumber: number;
  namespaceProfile: StoreNamespaceProfile;
}
function invalid(): never {
  throw new Error("STORE_BUILD_INPUT_INVALID");
}
function buildPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    resolve(value) !== value ||
    value.length > 4096 ||
    /[\p{Cc}\p{Cf};"$<>|*?]/u.test(value)
  )
    invalid();
  return value;
}
export function parseStoreBuildInputs(value: unknown): StoreBuildInputs {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null) ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string") ||
    Reflect.ownKeys(value).sort().join() !==
      "guiBuildNumber,guiPayloadRoot,namespaceProfile,purpose,version,workerBuildNumber,workerPayloadRoot"
  )
    invalid();
  const row: Record<string, unknown> = Object.create(null);
  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(value),
  )) {
    if (!descriptor.enumerable || !("value" in descriptor)) invalid();
    row[key] = descriptor.value;
  }
  if (
    row.version !== 1 ||
    row.purpose !== "unsigned-store-upload-candidate" ||
    (row.namespaceProfile !== "packaged-classic-v1" &&
      row.namespaceProfile !== "unvirtualized-candidate-v1")
  )
    invalid();
  return Object.freeze({
    version: 1,
    purpose: row.purpose,
    guiPayloadRoot: buildPath(row.guiPayloadRoot),
    workerPayloadRoot: buildPath(row.workerPayloadRoot),
    guiBuildNumber: parseStoreBuildNumber(row.guiBuildNumber),
    workerBuildNumber: parseStoreBuildNumber(row.workerBuildNumber),
    namespaceProfile: row.namespaceProfile,
  });
}
export function parseStoreBuildInputsBytes(bytes: Uint8Array) {
  if (bytes.byteLength < 1 || bytes.byteLength > 16384) invalid();
  try {
    return parseStoreBuildInputs(
      parseStrictJson(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        16384,
        128,
      ),
    );
  } catch {
    return invalid();
  }
}
async function missing(path: string) {
  try {
    await lstat(path);
    invalid();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}
async function copyPinned(
  from: string,
  to: string,
  pin: Omit<StoreInventoryEntry, "path">,
) {
  const before = await hashStoreFile(from);
  if (before.bytes !== pin.bytes || before.sha256 !== pin.sha256) invalid();
  await mkdir(dirname(to), { recursive: true });
  await copyFile(from, to, constants.COPYFILE_EXCL);
  for (const file of [from, to]) {
    const actual = await hashStoreFile(file);
    if (actual.bytes !== pin.bytes || actual.sha256 !== pin.sha256) invalid();
  }
}
/** MSIX retains files and their ancestor directories, not empty directories. */
export async function normalizeStoreWorkerReleaseManifest(
  stagedWorkerRoot: string,
  preservedOriginalManifestPath: string,
) {
  const root = buildPath(stagedWorkerRoot),
    preserved = buildPath(preservedOriginalManifestPath);
  if (preserved === root || preserved.startsWith(root + sep)) invalid();
  await missing(preserved);
  const path = join(root, WINDOWS_RELEASE_MANIFEST),
    bytes = await packageFile(path, 8 * 1024 ** 2),
    originalPin = await hashStoreFile(path);
  if (
    bytes.length !== originalPin.bytes ||
    createHash("sha256").update(bytes).digest("hex") !== originalPin.sha256
  )
    invalid();
  const original = parseWindowsReleaseManifest(parseStoreBuildDocument(bytes));
  if (
    original.releaseVersion !== STORE_PRODUCTS.worker.appVersion ||
    original.installationProfile !== "windows-user" ||
    new Set(original.entries.map((entry) => entry.path.toLowerCase())).size !==
      original.entries.length
  )
    invalid();
  const actual = await createWindowsReleaseManifest(
      root,
      original.releaseVersion,
      original.installationProfile,
    ),
    previous = new Map(original.entries.map((entry) => [entry.path, entry])),
    current = new Set(actual.entries.map((entry) => entry.path)),
    fileParents = new Set<string>();
  let filesUnchanged = 0;
  for (const entry of original.entries) {
    if (entry.kind !== "file") continue;
    const parts = entry.path.split("/");
    while (parts.length > 1) {
      parts.pop();
      fileParents.add(parts.join("/"));
    }
  }
  for (const entry of actual.entries) {
    if (
      JSON.stringify(previous.get(entry.path)) !== JSON.stringify(entry) ||
      (entry.kind === "directory" && !fileParents.has(entry.path))
    )
      invalid();
    if (entry.kind === "file") filesUnchanged++;
  }
  const removed = original.entries.filter((entry) => !current.has(entry.path));
  if (
    removed.some(
      (entry) => entry.kind !== "directory" || fileParents.has(entry.path),
    )
  )
    invalid();
  await copyPinned(path, preserved, originalPin);
  await unlink(path);
  const written = await writeWindowsReleaseManifest(
    root,
    original.releaseVersion,
    original.installationProfile,
  );
  if (JSON.stringify(written) !== JSON.stringify(actual)) invalid();
  await verifyWindowsRelease(root, "windows-user");
  return Object.freeze({
    releaseVersion: written.releaseVersion,
    installationProfile: written.installationProfile,
    filesUnchanged,
    removedDirectories: Object.freeze(removed.map((entry) => entry.path)),
    originalManifest: Object.freeze({ path: preserved, ...originalPin }),
  });
}
/** Stages audited upload inputs. Only the approved QA CMake guard may pack them. */
export async function prepareStorePackages(
  inputsValue: unknown,
  componentRootValue: string,
  newStageRootValue: string,
) {
  if (process.platform !== "win32" || process.arch !== "x64")
    throw new Error("WINDOWS_STORE_BUILD_REQUIRED");
  const inputs = parseStoreBuildInputs(inputsValue),
    componentRoot = buildPath(componentRootValue),
    stage = buildPath(newStageRootValue);
  if (stage === componentRoot || stage.startsWith(componentRoot + sep))
    invalid();
  for (const input of [inputs.guiPayloadRoot, inputs.workerPayloadRoot])
    if (
      stage === input ||
      stage.startsWith(input + sep) ||
      input.startsWith(stage + sep)
    )
      invalid();
  await missing(stage);
  // The actual payload audits run before creating a candidate. Missing complete
  // runtime inputs never produce a thin package mislabeled as a finished app.
  const gui = await auditStorePayload(
    inputs.guiPayloadRoot,
    "gui",
    componentRoot,
    inputs.guiBuildNumber,
  );
  const worker = await auditStorePayload(
    inputs.workerPayloadRoot,
    "worker",
    componentRoot,
    inputs.workerBuildNumber,
  );
  const icon = await packageFile(
    join(componentRoot, "..", ...STORE_ICON_SOURCE.path.split("/")),
    STORE_ICON_SOURCE.bytes,
  );
  await mkdir(stage);
  const projects = [];
  for (const role of ["gui", "worker"] as const) {
    const packageRoot = join(stage, role),
      prefix = role === "gui" ? "app" : "worker",
      payloadRoot = join(packageRoot, prefix);
    await mkdir(payloadRoot, { recursive: true });
    for (const pin of role === "gui" ? gui : worker)
      await copyPinned(
        join(
          role === "gui" ? inputs.guiPayloadRoot : inputs.workerPayloadRoot,
          ...pin.path.split("/"),
        ),
        join(payloadRoot, ...pin.path.split("/")),
        pin,
      );
    if (role === "worker")
      await normalizeStoreWorkerReleaseManifest(
        payloadRoot,
        join(stage, "worker-original-release-manifest.json"),
      );
    const assets = await stageStoreAssets(icon, join(packageRoot, "Assets"));
    const buildNumber =
      role === "gui" ? inputs.guiBuildNumber : inputs.workerBuildNumber;
    const manifest = renderStoreManifest(role, {
      packageVersion: STORE_PRODUCTS[role].packageVersion,
      appBuildNumber: buildNumber,
      namespaceProfile: inputs.namespaceProfile,
    });
    await writeFile(join(packageRoot, "AppxManifest.xml"), manifest, {
      flag: "wx",
    });
    const inventory = await createStoreCodeInventory(
      payloadRoot,
      role,
      STORE_PRODUCTS[role].packageVersion,
      buildNumber,
    );
    const inventoryBytes = Buffer.from(JSON.stringify(inventory) + "\n");
    if (inventoryBytes.length > 8 * 1024 ** 2)
      throw new Error("STORE_INVENTORY_INVALID");
    await writeFile(
      join(packageRoot, "store-code-inventory.json"),
      inventoryBytes,
      { flag: "wx" },
    );
    // Includes manifest/real assets/index as pack-time mutation checks, while
    // the protected code inventory excludes its own circular hash.
    const packRows = [
      ...inventory.entries,
      ...assets.map((row) => ({ ...row, path: `Assets/${row.path}` })),
      {
        path: "AppxManifest.xml",
        ...(await hashStoreFile(join(packageRoot, "AppxManifest.xml"))),
      },
      {
        path: "store-code-inventory.json",
        ...(await hashStoreFile(
          join(packageRoot, "store-code-inventory.json"),
        )),
      },
    ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const project = join(stage, `${role}-pack-project`);
    await mkdir(project);
    const source = dirname(fileURLToPath(import.meta.url));
    for (const name of ["CMakeLists.txt", "pack.cmake"])
      await copyFile(
        join(source, name),
        join(project, name),
        constants.COPYFILE_EXCL,
      );
    const packInputsBytes =
      JSON.stringify({ version: 1, role, entries: packRows }) + "\n";
    if (
      Buffer.byteLength(packInputsBytes) > 8 * 1024 ** 2 ||
      packRows.length > 65542
    )
      invalid();
    await writeFile(join(project, "pack-inputs.json"), packInputsBytes, {
      flag: "wx",
    });
    projects.push({
      role,
      sourceDirectory: project,
      packageDirectory: packageRoot,
      artifact: join(
        stage,
        `MusicMute${role === "worker" ? "Worker" : ""}-${STORE_PRODUCTS[role].packageVersion}-x64.msix`,
      ),
    });
  }
  const receipt = {
    version: 1,
    purpose: inputs.purpose,
    namespaceProfile: inputs.namespaceProfile,
    requestedCapabilities:
      inputs.namespaceProfile === "unvirtualized-candidate-v1"
        ? ["runFullTrust", "unvirtualizedResources"]
        : ["runFullTrust"],
    capabilityApproval: "pending",
    namespaceProof: "pending",
    codeOwnershipAudit: "passed",
    installerAvailable: false,
    installable: false,
    releaseReady: false,
    packed: false,
    storeSubmission: false,
    paidSigning: false,
    makeAppx: STORE_MAKEAPPX,
    projects,
  };
  await writeFile(
    join(stage, "candidate-receipt.json"),
    JSON.stringify(receipt, null, 2) + "\n",
    { flag: "wx" },
  );
  return receipt;
}

/** Verify actual SDK archives against current source/audited payloads, including
 * complete file sets. Generated metadata is not an installation authority. */
export async function verifyPreparedStorePackages(
  inputsValue: unknown,
  componentRootValue: string,
  stageRootValue: string,
) {
  if (process.platform !== "win32" || process.arch !== "x64")
    throw new Error("WINDOWS_STORE_BUILD_REQUIRED");
  const inputs = parseStoreBuildInputs(inputsValue),
    componentRoot = buildPath(componentRootValue),
    stage = buildPath(stageRootValue);
  const artwork = buildStoreAssets(
    await packageFile(
      join(componentRoot, "..", ...STORE_ICON_SOURCE.path.split("/")),
      STORE_ICON_SOURCE.bytes,
    ),
  );
  const packages = [];
  for (const role of ["gui", "worker"] as const) {
    const packageRoot = join(stage, role),
      prefix = role === "gui" ? "app" : "worker",
      buildNumber =
        role === "gui" ? inputs.guiBuildNumber : inputs.workerBuildNumber;
    await auditStorePayload(
      join(packageRoot, prefix),
      role,
      componentRoot,
      buildNumber,
    );
    const expectedInventory = await createStoreCodeInventory(
      join(packageRoot, prefix),
      role,
      STORE_PRODUCTS[role].packageVersion,
      buildNumber,
    );
    const inventoryPath = join(packageRoot, "store-code-inventory.json"),
      indexPin = await hashStoreFile(inventoryPath);
    if (indexPin.bytes > 8 * 1024 ** 2) invalid();
    const inventory = parseStoreCodeInventoryBytes(
      await packageFile(inventoryPath, 8 * 1024 ** 2),
    );
    if (JSON.stringify(inventory) !== JSON.stringify(expectedInventory))
      invalid();
    const expectedManifest = Buffer.from(
      renderStoreManifest(role, {
        packageVersion: STORE_PRODUCTS[role].packageVersion,
        appBuildNumber: buildNumber,
        namespaceProfile: inputs.namespaceProfile,
      }),
    );
    if (
      !(
        await packageFile(
          join(packageRoot, "AppxManifest.xml"),
          expectedManifest.length,
        )
      ).equals(expectedManifest)
    )
      invalid();
    const extras = ["AppxManifest.xml", "store-code-inventory.json"];
    for (const [name, bytes] of Object.entries(artwork)) {
      const path = `Assets/${name}`;
      if (
        !(
          await packageFile(join(packageRoot, "Assets", name), bytes.length)
        ).equals(bytes)
      )
        invalid();
      extras.push(path);
    }
    const rows = [...inventory.entries];
    for (const path of extras)
      rows.push({
        path,
        ...(await hashStoreFile(join(packageRoot, ...path.split("/")))),
      });
    rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const artifact = join(
      stage,
      `MusicMute${role === "worker" ? "Worker" : ""}-${STORE_PRODUCTS[role].packageVersion}-x64.msix`,
    );
    packages.push({
      role,
      artifact,
      ...(await auditStoreUploadArchive(artifact, rows)),
    });
  }
  const receipt = {
    version: 1,
    purpose: inputs.purpose,
    archiveReadback: "passed",
    namespaceProfile: inputs.namespaceProfile,
    namespaceProof: "pending",
    capabilityApproval: "pending",
    signed: false,
    installable: false,
    releaseReady: false,
    published: false,
    packages,
  };
  await writeFile(
    join(stage, "archive-receipt.json"),
    JSON.stringify(receipt, null, 2) + "\n",
    { flag: "wx" },
  );
  return receipt;
}
export async function readStoreBuildInputsFile(path: string) {
  return parseStoreBuildInputsBytes(await packageFile(buildPath(path), 16384));
}
export { StoreInputsMissing };
