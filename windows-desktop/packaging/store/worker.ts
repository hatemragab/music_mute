import { createHash } from "node:crypto";
import { parseStoreBuildDocument } from "./document-json.js";
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { packageFile } from "../validate-assets.js";
import { parseStrictJson } from "../../../chrome-extension/src/shared/strict-json.js";
import {
  buildWindowsConsumerPackage,
  STORE_KIM_MDX_PYTHON_PROFILE,
  verifyWindowsConsumerAcquisition,
} from "../../../worker/src/platform/windows/consumer-package.js";
import { WINDOWS_CONSUMER_PINS } from "../../../worker/src/platform/windows/consumer-pins.js";
import {
  createWindowsReleaseManifest,
  writeWindowsReleaseManifest,
  type WindowsReleaseEntry,
} from "../../../worker/src/platform/windows/release-manifest.js";
import {
  STORE_PRODUCTS,
  parseStoreBuildNumber,
} from "../../src/shared/store-contracts.js";
import {
  parseStoreNativeBuildInputs,
  verifyStoreNativeProvenance,
  type StoreNativeBuildInputs,
  type StoreNativeFilePin,
} from "./native-provenance.js";
import {
  hashStoreFile,
  listStorePayload,
  safeStoreRelativePath,
  type StoreInventoryEntry,
} from "./inventory.js";
import {
  STORE_CODE_READER,
  STORE_DENO_CACHE,
  STORE_DOWNLOADER_ENTRY,
  parseStoreYoutubeIdentity,
  verifyStoreWorkerAcquisition,
} from "./acquisition.js";
import {
  installStoreProductionDependencies,
  verifyStorePnpmTool,
} from "./pnpm.js";
import { auditStoreWorker } from "./audit.js";
import { verifyStorePythonProjection } from "./python-projection.js";
import {
  copyStoreWorkerAgentInputs,
  stageStoreAgentNotices,
} from "./agent-notices.js";
import { stageStorePythonNotices } from "./python-notices.js";
import { stageStoreEngineAuthorityProfile } from "./engine-profile.js";

const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const emptySha =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
/** Exact development leaves from the qualified dependency inputs. Receiving
 * audits still reject these paths; only the fresh Store assembler preserves
 * these pinned bytes outside its runtime before the relocated runtime probe. */
export const STORE_WORKER_DEVELOPMENT_OMISSIONS = Object.freeze(
  [
    {
      path: "app/node_modules/gensync/test/.babelrc",
      bytes: 68,
      sha256:
        "27064c2840500bf100d82ea6e584d8f065ddb360a7a574b555a0b6c882af2fa2",
    },
    {
      path: "app/node_modules/gensync/test/index.test.js",
      bytes: 11019,
      sha256:
        "2787927b0f01763f77587babe1d85b68b1630c60a946ce54679d56aab3efdf10",
    },
    {
      path: "runtime/python/Lib/ensurepip/_bundled/pip-25.0.1-py3-none-any.whl",
      bytes: 1841526,
      sha256:
        "c46efd13b6aa8279f33f2864459c8ce587ea6a1a59ee20de055868d8f7688f7f",
    },
    {
      path: "runtime/python/Lib/site-packages/ml_collections/config_dict/examples/config.py",
      bytes: 4374,
      sha256:
        "059c4ae2645e34708955a3bc52c043e2f7ea88ef25e66ddb0745fcbfdc49c166",
    },
    {
      path: "runtime/python/Lib/site-packages/ml_collections/config_dict/examples/config_dict_advanced.py",
      bytes: 3977,
      sha256:
        "de57b6354c1cb19a33bf19903aac92539200ac9888933aa3a57d81ca868b2188",
    },
    {
      path: "runtime/python/Lib/site-packages/ml_collections/config_dict/examples/config_dict_basic.py",
      bytes: 1469,
      sha256:
        "f27d68edd1565d780c3bc11f14bc4017fe57e8f5d7de6e1d609544efa4c4e25e",
    },
    {
      path: "runtime/python/Lib/site-packages/ml_collections/config_dict/examples/config_dict_initialization.py",
      bytes: 3247,
      sha256:
        "3a9de800fd3e6aa3c54bfbd66ad3173160f48627e40119ea733f32e53ff1d608",
    },
    {
      path: "runtime/python/Lib/site-packages/ml_collections/config_dict/examples/config_dict_lock.py",
      bytes: 1322,
      sha256:
        "b87e929bee7e263fbd53e8d5a0ab1b31d62fc8ffe66ef7c154df00339adb9343",
    },
    {
      path: "runtime/python/Lib/site-packages/ml_collections/config_dict/examples/config_dict_placeholder.py",
      bytes: 1751,
      sha256:
        "8de4aaac956517cf6591a9486e01ad9a82de0f6d1276356ba170647b24251fe5",
    },
    {
      path: "runtime/python/Lib/site-packages/ml_collections/config_dict/examples/field_reference.py",
      bytes: 4749,
      sha256:
        "21c78f38cceed8abd8557b7bb729c42aafec3bd531719fc6038c0c34dd4c22f0",
    },
    {
      path: "runtime/python/Lib/site-packages/ml_collections/config_dict/examples/frozen_config_dict.py",
      bytes: 3052,
      sha256:
        "5b6d4ca1c5c6ff8227efe1183d47dfe2ecbd1adae0f31918a91ff41ec956dd81",
    },
    {
      path: "runtime/python/Lib/site-packages/ml_collections/config_flags/examples/config.py",
      bytes: 911,
      sha256:
        "50d3447d30c95b6d0c2e826ee2c91615bc274dd36bbc79179ca8e10011ea16bf",
    },
    {
      path: "runtime/python/Lib/site-packages/ml_collections/config_flags/examples/define_config_dataclass_basic.py",
      bytes: 1302,
      sha256:
        "a5e2ba3fd5ce280d99b7cb93d6e591d90707733383ec1d0e7b084d8a79ddacab",
    },
    {
      path: "runtime/python/Lib/site-packages/ml_collections/config_flags/examples/define_config_dict_basic.py",
      bytes: 1229,
      sha256:
        "dbda8d90bc740e110d7974af97c8c28535bb7b87f0af2e102140c82e3c91bb8e",
    },
    {
      path: "runtime/python/Lib/site-packages/ml_collections/config_flags/examples/define_config_file_basic.py",
      bytes: 1370,
      sha256:
        "7fcc7256d03a34282d50af89264e8b5b23011e03de5b12a25cfaf46392d92659",
    },
    {
      path: "runtime/python/Lib/site-packages/ml_collections/config_flags/examples/parameterised_config.py",
      bytes: 1333,
      sha256:
        "482bd79708b9e89d83ab6d1e642e276ef633ca5bd504c53de881f767433acbaf",
    },
    {
      path: "runtime/python/Lib/site-packages/scipy-1.18.1-cp312-cp312-win_amd64.whl",
      bytes: 0,
      sha256:
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    },
    {
      path: "runtime/python/Lib/site-packages/torch/testing/_internal/distributed/rpc/examples/__init__.py",
      bytes: 0,
      sha256:
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    },
    {
      path: "runtime/python/Lib/site-packages/torch/testing/_internal/distributed/rpc/examples/parameter_server_test.py",
      bytes: 4704,
      sha256:
        "1c41c5003a9d4136ceb2dc4b1a3dcc4808284f66b9475284c1ad8a5c5cef4512",
    },
    {
      path: "runtime/python/Lib/site-packages/torch/testing/_internal/distributed/rpc/examples/reinforcement_learning_rpc_test.py",
      bytes: 9591,
      sha256:
        "a70e6e48e758685a9c433a153e656e0f203c2855c39b51484e987cab9604d101",
    },
    {
      path: "runtime/python/Lib/site-packages/torch/utils/benchmark/examples/__init__.py",
      bytes: 0,
      sha256:
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    },
    {
      path: "runtime/python/Lib/site-packages/torch/utils/benchmark/examples/blas_compare_setup.py",
      bytes: 7397,
      sha256:
        "61da745f997db32ae26ed444d0cd34fdfbe6cb0c3ed6dde7bf649cae423d7693",
    },
    {
      path: "runtime/python/Lib/site-packages/torch/utils/benchmark/examples/compare.py",
      bytes: 3014,
      sha256:
        "94c805998b94bae75f59e6019816e17132428afcef5f8f06d3c57a2305db20b5",
    },
    {
      path: "runtime/python/Lib/site-packages/torch/utils/benchmark/examples/fuzzer.py",
      bytes: 2736,
      sha256:
        "e388b7d2b575648d97be38e6810c0a9fdb911e13cccd6bbdfb9abaaa4888edf2",
    },
    {
      path: "runtime/python/Lib/site-packages/torch/utils/benchmark/examples/op_benchmark.py",
      bytes: 4332,
      sha256:
        "8cbeaf95bdc2290b2b7491ed20fca61d7a1595303dd081acf55cd9f966eff78b",
    },
    {
      path: "runtime/python/Lib/site-packages/torch/utils/benchmark/examples/simple_timeit.py",
      bytes: 586,
      sha256:
        "64349f85afde4420306350853d6cf381246eb7725d5cd207764511e6fb91b8df",
    },
    {
      path: "runtime/python/Lib/site-packages/torch/utils/benchmark/examples/spectral_ops_fuzz_test.py",
      bytes: 4893,
      sha256:
        "eac767996ae970f55915f97b071cc838216b085afc6d55d334622913d6de6625",
    },
  ].map((row) => Object.freeze(row)),
);
export interface StoreWorkerBuildInputs {
  readonly version: 1;
  readonly purpose: "unsigned-store-worker-directory";
  readonly appBuildNumber: number;
  readonly nodeRoot: string;
  readonly pythonRoot: string;
  readonly pythonProjection: StoreNativeFilePin;
  readonly mediaRoot: string;
  readonly pnpmToolRoot: string;
  readonly pnpmStoreRoot: string;
  readonly nativeBuild: StoreNativeBuildInputs;
  readonly acquisition: {
    readonly root: string;
    readonly qualification: StoreNativeFilePin;
    readonly guardianReceipt: StoreNativeFilePin;
    readonly readonlyReceipt: StoreNativeFilePin;
    readonly codePins: StoreNativeFilePin;
    readonly cachePins: StoreNativeFilePin;
  };
}
function invalid(code = "STORE_WORKER_INPUT_INVALID"): never {
  throw new Error(code);
}
export function assertStoreWorkerDevelopmentOmission(value: unknown) {
  const row = record(value, ["path", "bytes", "sha256"]),
    known = STORE_WORKER_DEVELOPMENT_OMISSIONS.find(
      (pin) => pin.path === row.path,
    );
  if (!known || known.bytes !== row.bytes || known.sha256 !== row.sha256)
    invalid("STORE_WORKER_DEVELOPMENT_PIN_INVALID");
  return known;
}
/** Every other file and directory must remain exactly as received. */
export function assertStoreWorkerDevelopmentCurationCensus(
  before: readonly WindowsReleaseEntry[],
  after: readonly WindowsReleaseEntry[],
) {
  const removed = new Set(
    STORE_WORKER_DEVELOPMENT_OMISSIONS.map((pin) => pin.path),
  );
  for (const known of STORE_WORKER_DEVELOPMENT_OMISSIONS) {
    const entry = before.find((row) => row.path === known.path);
    if (
      !entry ||
      entry.kind !== "file" ||
      entry.bytes !== known.bytes ||
      entry.sha256 !== known.sha256
    )
      invalid("STORE_WORKER_DEVELOPMENT_PIN_INVALID");
  }
  if (
    JSON.stringify(before.filter((row) => !removed.has(row.path))) !==
    JSON.stringify(after)
  )
    invalid("STORE_WORKER_DEVELOPMENT_CENSUS_CHANGED");
}
/** The caller owns this new consumer assembly and external build-work root.
 * Never curate an existing release or mutate the source Python/dependency roots. */
async function curateStoreWorkerDevelopmentInputs(root: string, work: string) {
  await physical(root, true);
  await physical(work, true);
  const inside = (a: string, b: string) =>
    a.toLowerCase() === b.toLowerCase() ||
    b.toLowerCase().startsWith(a.toLowerCase() + sep);
  if (inside(root, work) || inside(work, root)) invalid();
  for (const path of [
    join(root, "release-manifest.json"),
    join(work, "preserved-development-inputs"),
  ]) {
    try {
      await lstat(path);
      invalid("STORE_WORKER_DEVELOPMENT_STAGE_NOT_FRESH");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const before = await createWindowsReleaseManifest(
      root,
      STORE_PRODUCTS.worker.appVersion,
      "windows-user",
    ),
    beforeBytes = Buffer.from(JSON.stringify(before) + "\n");
  // Validate all27 leaves before moving the first one; zero-byte wheel/init
  // leaves remain independently pinned with the actual empty SHA.
  for (const known of STORE_WORKER_DEVELOPMENT_OMISSIONS) {
    const actual = await hashStoreFile(join(root, ...known.path.split("/")));
    assertStoreWorkerDevelopmentOmission({ path: known.path, ...actual });
    const entry = before.entries.find((row) => row.path === known.path);
    if (
      !entry ||
      entry.kind !== "file" ||
      entry.bytes !== known.bytes ||
      entry.sha256 !== known.sha256
    )
      invalid();
  }
  const preservedRoot = join(work, "preserved-development-inputs");
  await mkdir(preservedRoot);
  for (const known of STORE_WORKER_DEVELOPMENT_OMISSIONS) {
    const source = join(root, ...known.path.split("/")),
      destination = join(preservedRoot, ...known.path.split("/"));
    await mkdir(dirname(destination), { recursive: true });
    await physical(dirname(destination), true);
    await physical(dirname(source), true);
    try {
      await lstat(destination);
      invalid("STORE_WORKER_DEVELOPMENT_PRESERVED_EXISTS");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    assertStoreWorkerDevelopmentOmission({
      path: known.path,
      ...(await hashStoreFile(source)),
    });
    await rename(source, destination);
    assertStoreWorkerDevelopmentOmission({
      path: known.path,
      ...(await hashStoreFile(destination)),
    });
  }
  const after = await createWindowsReleaseManifest(
      root,
      STORE_PRODUCTS.worker.appVersion,
      "windows-user",
    ),
    afterBytes = Buffer.from(JSON.stringify(after) + "\n");
  assertStoreWorkerDevelopmentCurationCensus(before.entries, after.entries);
  await writeFile(
    join(work, "developer-input-source-census.json"),
    beforeBytes,
    { flag: "wx" },
  );
  await writeFile(
    join(work, "developer-input-curated-census.json"),
    afterBytes,
    { flag: "wx" },
  );
  const receipt = {
    version: 1,
    purpose: "fresh-store-worker-finite-development-input-curation",
    omissions: STORE_WORKER_DEVELOPMENT_OMISSIONS,
    sourceCensus: {
      file: "developer-input-source-census.json",
      bytes: beforeBytes.length,
      sha256: hash(beforeBytes),
    },
    curatedCensus: {
      file: "developer-input-curated-census.json",
      bytes: afterBytes.length,
      sha256: hash(afterBytes),
    },
    preservedDirectory: "preserved-development-inputs",
    retainedRuntimeBytesUnchanged: true,
    sourceRuntimeChanged: false,
    existingReleaseChanged: false,
    relocatedConsumerProbesStillRequired: true,
    signed: false,
    installed: false,
    published: false,
  };
  await writeFile(
    join(work, "developer-input-curation-receipt.json"),
    JSON.stringify(receipt, null, 2) + "\n",
    { flag: "wx" },
  );
  return Object.freeze(receipt);
}
function record(value: unknown, fields: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value),
    keys = Reflect.ownKeys(value);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    invalid();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of fields) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d?.enumerable || !("value" in d)) invalid();
    result[key] = d.value;
  }
  return result;
}
function absolute(value: unknown) {
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    resolve(value) !== value ||
    value === dirname(value) ||
    value.length > 4096 ||
    /[\p{Cc}\p{Cf};"$<>|*?]/u.test(value)
  )
    invalid();
  return value;
}
function pin(
  value: unknown,
  expected: string,
  maximum: number,
): StoreNativeFilePin {
  const row = record(value, ["path", "bytes", "sha256"]);
  if (
    row.path !== expected ||
    !Number.isSafeInteger(row.bytes) ||
    (row.bytes as number) < 1 ||
    (row.bytes as number) > maximum ||
    typeof row.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(row.sha256)
  )
    invalid();
  return Object.freeze({
    path: expected,
    bytes: row.bytes as number,
    sha256: row.sha256,
  });
}
export function parseStoreWorkerBuildInputs(
  value: unknown,
): StoreWorkerBuildInputs {
  const row = record(value, [
    "version",
    "purpose",
    "appBuildNumber",
    "nodeRoot",
    "pythonRoot",
    "pythonProjection",
    "mediaRoot",
    "pnpmToolRoot",
    "pnpmStoreRoot",
    "nativeBuild",
    "acquisition",
  ]);
  if (row.version !== 1 || row.purpose !== "unsigned-store-worker-directory")
    invalid();
  const pythonRoot = absolute(row.pythonRoot),
    acq = record(row.acquisition, [
      "root",
      "qualification",
      "guardianReceipt",
      "readonlyReceipt",
      "codePins",
      "cachePins",
    ]),
    root = absolute(acq.root);
  return Object.freeze({
    version: 1,
    purpose: row.purpose,
    appBuildNumber: parseStoreBuildNumber(row.appBuildNumber),
    nodeRoot: absolute(row.nodeRoot),
    pythonRoot,
    pythonProjection: pin(
      row.pythonProjection,
      join(
        dirname(pythonRoot),
        "python-build-work/python-projection-receipt.json",
      ),
      65536,
    ),
    mediaRoot: absolute(row.mediaRoot),
    pnpmToolRoot: absolute(row.pnpmToolRoot),
    pnpmStoreRoot: absolute(row.pnpmStoreRoot),
    nativeBuild: parseStoreNativeBuildInputs(row.nativeBuild, "worker"),
    acquisition: Object.freeze({
      root,
      qualification: pin(
        acq.qualification,
        join(root, "qualification.json"),
        4 * 1024 ** 2,
      ),
      guardianReceipt: pin(
        acq.guardianReceipt,
        join(root, "guarded-build-receipt.json"),
        65536,
      ),
      readonlyReceipt: pin(
        acq.readonlyReceipt,
        join(root, "build-work/readonly-code-rehearsal.json"),
        65536,
      ),
      codePins: pin(
        acq.codePins,
        join(root, "build-work/relocated-before-pins.json"),
        8 * 1024 ** 2,
      ),
      cachePins: pin(
        acq.cachePins,
        join(root, "build-work/fixed-deno-cache-before-pins.json"),
        8 * 1024 ** 2,
      ),
    }),
  });
}
export function parseStoreWorkerBuildInputsBytes(bytes: Uint8Array) {
  if (bytes.byteLength < 1 || bytes.byteLength > 16384) invalid();
  return parseStoreWorkerBuildInputs(
    parseStrictJson(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      16384,
      512,
    ),
  );
}
async function physical(path: string, directory: boolean) {
  if ((await realpath(path)) !== path) invalid();
  for (let cursor = path; ; cursor = dirname(cursor)) {
    const s = await lstat(cursor);
    if (
      s.isSymbolicLink() ||
      ((directory || cursor !== path) && !s.isDirectory())
    )
      invalid();
    if (cursor === dirname(cursor)) break;
  }
}
async function pinned(value: StoreNativeFilePin) {
  await physical(value.path, false);
  const before = await hashStoreFile(value.path);
  if (before.bytes !== value.bytes || before.sha256 !== value.sha256)
    invalid("STORE_WORKER_INPUT_CHANGED");
  const bytes = await packageFile(value.path, 8 * 1024 ** 2);
  if (
    bytes.length !== value.bytes ||
    hash(bytes) !== value.sha256 ||
    JSON.stringify(await hashStoreFile(value.path)) !== JSON.stringify(before)
  )
    invalid("STORE_WORKER_INPUT_CHANGED");
  return bytes;
}
function json(bytes: Uint8Array, maximum = 4 * 1024 ** 2) {
  return parseStoreBuildDocument(bytes, maximum);
}
export function parseStoreAcquisitionPins(
  bytes: Uint8Array,
): readonly StoreInventoryEntry[] {
  const value = json(bytes, 8 * 1024 ** 2);
  if (!Array.isArray(value) || value.length < 1 || value.length > 30000)
    invalid();
  let previous = "",
    total = 0;
  const folded = new Set<string>();
  const result = value.map((raw) => {
    const row = record(raw, ["path", "bytes", "sha256"]),
      path = safeStoreRelativePath(row.path);
    if (
      path <= previous ||
      folded.has(path.toLowerCase()) ||
      !Number.isSafeInteger(row.bytes) ||
      (row.bytes as number) < 0 ||
      (row.bytes as number) > 512 * 1024 ** 2 ||
      typeof row.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(row.sha256) ||
      (row.bytes === 0 &&
        (row.sha256 !== emptySha || /\.(?:exe|dll|pyd|node)$/iu.test(path)))
    )
      invalid();
    previous = path;
    folded.add(path.toLowerCase());
    total += row.bytes as number;
    if (total > 2 * 1024 ** 3) invalid();
    return Object.freeze({
      path,
      bytes: row.bytes as number,
      sha256: row.sha256,
    });
  });
  return Object.freeze(result);
}
async function treePins(root: string) {
  const files: StoreInventoryEntry[] = [];
  async function visit(path: string, depth = 0) {
    if (depth > 32 || files.length > 30000) invalid();
    await physical(path, true);
    for (const name of (await readdir(path)).sort()) {
      const absolutePath = join(path, name),
        s = await lstat(absolutePath);
      if (s.isSymbolicLink()) invalid();
      if (s.isDirectory()) await visit(absolutePath, depth + 1);
      else {
        const key = absolutePath
          .slice(root.length + 1)
          .split(sep)
          .join("/");
        safeStoreRelativePath(key);
        files.push({ path: key, ...(await hashStoreFile(absolutePath)) });
      }
    }
  }
  await visit(root);
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
async function verifyTree(
  root: string,
  pins: readonly StoreInventoryEntry[],
  allowGeneratedIdentity = false,
) {
  const actual = (await treePins(root)).filter(
    (row) => !allowGeneratedIdentity || row.path !== "identity.json",
  );
  if (JSON.stringify(actual) !== JSON.stringify(pins))
    invalid("STORE_WORKER_ACQUISITION_CHANGED");
}
/** Actual prior guardian and functional DACL observations are admission inputs,
 * not OS Store authority. Relocation still needs its own readonly rehearsal. */
export async function verifyStoreWorkerAcquisitionInputs(
  inputs: StoreWorkerBuildInputs,
) {
  const acq = inputs.acquisition;
  const qualification = record(json(await pinned(acq.qualification)), [
      "version",
      "purpose",
      "platform",
      "architecture",
      "denoVersion",
      "providerVersion",
      "downloaderVersion",
      "canvasVersion",
      "offlineQualified",
      "consumerReady",
      "qualificationScope",
      "realYouTubeRequests",
      "paidServiceRequests",
      "licenseApproval",
      "storePolicyApproval",
      "guardianAuthority",
      "membershipObservationScope",
      "qaReadonlyCodeRehearsal",
      "qaCodeAclRestored",
      "sealedStoreNamespace",
      "steps",
      "files",
      "nativeImports",
    ]),
    guardian = record(json(await pinned(acq.guardianReceipt), 65536), [
      "version",
      "purpose",
      "fixed",
      "steps",
      "actualGuardJobsZero",
      "sourcePreserved",
      "offlineQualified",
      "qualificationScope",
      "qaReadonlyCodeRehearsal",
      "actualRootDaclRestorationVerified",
      "deniedCodeLeaves",
      "sealedStoreNamespace",
      "consumerReady",
      "licenseApproval",
      "storePolicyApproval",
      "realYouTubeRequests",
      "paidServiceRequests",
      "qualifiedFiles",
    ]),
    readonly = record(json(await pinned(acq.readonlyReceipt), 65536), [
      "version",
      "scope",
      "passed",
      "codeRoots",
      "codeBefore",
      "codeAfter",
      "cacheBefore",
      "cacheAfter",
      "deniedLeaves",
      "codeChanges",
      "cacheChanges",
      "privateDataPins",
      "aclRestored",
      "ownerMayRestoreDacl",
      "storeNamespaceProven",
      "writableCacheCodeCopied",
    ]);
  if (
    qualification.version !== 1 ||
    qualification.purpose !== "windows-acquisition-build-inputs" ||
    qualification.platform !== "win32" ||
    qualification.architecture !== "x64" ||
    qualification.denoVersion !== WINDOWS_CONSUMER_PINS.deno ||
    qualification.providerVersion !== WINDOWS_CONSUMER_PINS.provider ||
    qualification.downloaderVersion !== WINDOWS_CONSUMER_PINS.downloader ||
    qualification.canvasVersion !== "3.2.3" ||
    qualification.offlineQualified !== true ||
    qualification.consumerReady !== false ||
    qualification.qualificationScope !==
      "relocated-offline-canvas-provider-only" ||
    qualification.qaReadonlyCodeRehearsal !==
      "passed-functional-owned-projection-only" ||
    qualification.qaCodeAclRestored !== true ||
    qualification.sealedStoreNamespace !== "pending" ||
    qualification.realYouTubeRequests !== false ||
    qualification.paidServiceRequests !== false ||
    qualification.licenseApproval !== "pending" ||
    qualification.storePolicyApproval !== "pending"
  )
    invalid();
  const fixed = guardian.fixed as Record<string, unknown>,
    steps = guardian.steps;
  if (
    guardian.version !== 1 ||
    guardian.purpose !== "windows-acquisition-build-inputs" ||
    !fixed ||
    fixed.cohort !== acq.root ||
    fixed.remote !== acq.root ||
    guardian.actualGuardJobsZero !== 2 ||
    guardian.sourcePreserved !== true ||
    guardian.offlineQualified !== true ||
    guardian.actualRootDaclRestorationVerified !== true ||
    guardian.consumerReady !== false ||
    guardian.qualificationScope !== qualification.qualificationScope ||
    guardian.sealedStoreNamespace !== "pending" ||
    guardian.realYouTubeRequests !== false ||
    guardian.paidServiceRequests !== false ||
    guardian.licenseApproval !== "pending" ||
    guardian.storePolicyApproval !== "pending" ||
    !Array.isArray(steps) ||
    steps.length !== 2
  )
    invalid();
  for (const [index, value] of steps.entries()) {
    const step = record(value, [
      "step",
      "code",
      "toolExitCode",
      "reason",
      "wholeJobZero",
      "log",
      "bytes",
      "sha256",
    ]);
    if (
      step.step !== ["configure", "compile"][index] ||
      step.code !== 0 ||
      step.toolExitCode !== 0 ||
      step.reason !== "completed" ||
      step.wholeJobZero !== true ||
      step.log !== ["configure-guard.log", "compile-guard.log"][index]
    )
      invalid();
    await pinned(
      pin(
        {
          path: join(acq.root, step.log as string),
          bytes: step.bytes,
          sha256: step.sha256,
        },
        join(acq.root, step.log as string),
        2 * 1024 ** 2,
      ),
    );
  }
  if (
    readonly.version !== 1 ||
    readonly.scope !== "own-qa-functional-dacl-rehearsal-only" ||
    readonly.passed !== true ||
    readonly.aclRestored !== true ||
    readonly.ownerMayRestoreDacl !== true ||
    readonly.storeNamespaceProven !== false ||
    readonly.writableCacheCodeCopied !== false ||
    JSON.stringify(readonly.codeRoots) !==
      JSON.stringify([
        "inputs/youtube",
        "build-work/offline-check/deno-cache",
      ]) ||
    JSON.stringify(readonly.codeChanges) !== "[]" ||
    JSON.stringify(readonly.cacheChanges) !== "[]"
  )
    invalid();
  const code = record(readonly.codeBefore, ["file", "bytes", "sha256"]),
    after = record(readonly.codeAfter, ["file", "bytes", "sha256"]),
    cache = record(readonly.cacheBefore, ["file", "bytes", "sha256"]),
    cacheAfter = record(readonly.cacheAfter, ["file", "bytes", "sha256"]);
  if (
    code.file !== "relocated-before-pins.json" ||
    after.file !== "readonly-code-after-pins.json" ||
    cache.file !== "fixed-deno-cache-before-pins.json" ||
    cacheAfter.file !== "readonly-deno-cache-after-pins.json" ||
    code.bytes !== after.bytes ||
    code.sha256 !== after.sha256 ||
    cache.bytes !== cacheAfter.bytes ||
    cache.sha256 !== cacheAfter.sha256 ||
    code.sha256 !== acq.codePins.sha256 ||
    cache.sha256 !== acq.cachePins.sha256 ||
    code.bytes !== acq.codePins.bytes ||
    cache.bytes !== acq.cachePins.bytes
  )
    invalid();
  const codePins = parseStoreAcquisitionPins(await pinned(acq.codePins)),
    cachePins = parseStoreAcquisitionPins(await pinned(acq.cachePins));
  if (
    qualification.files !== codePins.length ||
    guardian.qualifiedFiles !== codePins.length ||
    readonly.deniedLeaves !== codePins.length + cachePins.length ||
    guardian.deniedCodeLeaves !== readonly.deniedLeaves
  )
    invalid();
  await pinned(
    pin(
      {
        path: join(acq.root, "build-work", after.file as string),
        bytes: after.bytes,
        sha256: after.sha256,
      },
      join(acq.root, "build-work/readonly-code-after-pins.json"),
      8 * 1024 ** 2,
    ),
  );
  await pinned(
    pin(
      {
        path: join(acq.root, "build-work", cacheAfter.file as string),
        bytes: cacheAfter.bytes,
        sha256: cacheAfter.sha256,
      },
      join(acq.root, "build-work/readonly-deno-cache-after-pins.json"),
      8 * 1024 ** 2,
    ),
  );
  await verifyTree(join(acq.root, "inputs/youtube"), codePins, true);
  await verifyTree(
    join(acq.root, "build-work/offline-check/deno-cache"),
    cachePins,
  );
  await verifyWindowsConsumerAcquisition(
    join(acq.root, "inputs/downloader"),
    join(acq.root, "inputs/youtube"),
  );
  return Object.freeze({
    codePins,
    cachePins,
    relocatedStoreReadonlyExecution: false,
  });
}
export async function copyStorePinnedFile(
  source: string,
  destination: string,
  pin: Pick<StoreInventoryEntry, "bytes" | "sha256">,
) {
  const matches = (actual: Pick<StoreInventoryEntry, "bytes" | "sha256">) =>
    actual.bytes === pin.bytes && actual.sha256 === pin.sha256;
  await physical(source, false);
  if (!matches(await hashStoreFile(source)))
    invalid("STORE_WORKER_INPUT_CHANGED");
  await mkdir(dirname(destination), { recursive: true });
  await physical(dirname(destination), true);
  await copyFile(source, destination, constants.COPYFILE_EXCL);
  if (
    !matches(await hashStoreFile(destination)) ||
    !matches(await hashStoreFile(source))
  )
    invalid("STORE_WORKER_INPUT_CHANGED");
}
/** A fresh real consumer assembly, then explicit Store additions. This function
 * must run inside the original approved QA Job; it never signs or installs. */
export async function buildStoreWorkerDirectory(
  inputsValue: unknown,
  componentRootValue: string,
  stageValue: string,
) {
  const inputs = parseStoreWorkerBuildInputs(inputsValue),
    componentRoot = absolute(componentRootValue),
    stage = absolute(stageValue);
  if (process.platform !== "win32" || process.arch !== "x64")
    invalid("STORE_WORKER_WINDOWS_REQUIRED");
  await physical(componentRoot, true);
  await physical(dirname(stage), true);
  const roots = [
    resolve(componentRoot, ".."),
    inputs.nodeRoot,
    inputs.pythonRoot,
    inputs.mediaRoot,
    inputs.pnpmToolRoot,
    inputs.pnpmStoreRoot,
    inputs.nativeBuild.directory,
    inputs.acquisition.root,
  ];
  const inside = (a: string, b: string) =>
    a.toLowerCase() === b.toLowerCase() ||
    b.toLowerCase().startsWith(a.toLowerCase() + sep);
  for (const root of roots) {
    await physical(root, true);
    if (inside(root, stage) || inside(stage, root)) invalid();
  }
  try {
    await lstat(stage);
    invalid("STORE_WORKER_STAGE_EXISTS");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const native = await verifyStoreNativeProvenance(
      inputs.nativeBuild,
      "worker",
      componentRoot,
    ),
    acquisition = await verifyStoreWorkerAcquisitionInputs(inputs),
    tool = await verifyStorePnpmTool(inputs.pnpmToolRoot, componentRoot),
    requirements = await packageFile(
      resolve(
        componentRoot,
        "../tools/worker-gpu-feasibility/requirements-directml.lock.txt",
      ),
      65536,
    ),
    pythonProjection = await verifyStorePythonProjection(
      inputs.pythonRoot,
      dirname(inputs.pythonProjection.path),
      await pinned(inputs.pythonProjection),
      requirements,
    );
  if (
    pythonProjection.pythonDistributionProfile !== STORE_KIM_MDX_PYTHON_PROFILE
  )
    invalid("STORE_WORKER_MDX_PROJECTION_REQUIRED");
  const workerRoot = resolve(componentRoot, "../worker"),
    work = stage + "-build-work";
  await mkdir(work);
  const agentRoot = await copyStoreWorkerAgentInputs(
    componentRoot,
    join(work, "worker-agents"),
  );
  const options = {
    workerRoot,
    outputRoot: stage,
    releaseVersion: STORE_PRODUCTS.worker.appVersion,
    nodeRoot: inputs.nodeRoot,
    pythonRoot: inputs.pythonRoot,
    pythonDistributionProfile: STORE_KIM_MDX_PYTHON_PROFILE,
    mediaRoot: inputs.mediaRoot,
    nativeBinary: join(inputs.nativeBuild.directory, "musicmute-native.exe"),
    agentRoot,
    downloaderRoot: join(inputs.acquisition.root, "inputs/downloader"),
    youtubeRoot: join(inputs.acquisition.root, "inputs/youtube"),
    requirementsLockPath: resolve(
      componentRoot,
      "../tools/worker-gpu-feasibility/requirements-directml.lock.txt",
    ),
  };
  // Only the real tool-bound installer is adapted. All native/host/acquisition
  // and relocated Python/DirectML probes retain the production defaults.
  let developmentCuration:
    Awaited<ReturnType<typeof curateStoreWorkerDevelopmentInputs>> | undefined;
  await buildWindowsConsumerPackage(options, {
    productionDependencies: async (workerRoot, appRoot) => {
      await installStoreProductionDependencies({
        workerRoot,
        appRoot,
        componentRoot,
        nodeRoot: inputs.nodeRoot,
        toolRoot: inputs.pnpmToolRoot,
        storeRoot: inputs.pnpmStoreRoot,
        dataRoot: join(work, "pnpm-private"),
      });
      developmentCuration = await curateStoreWorkerDevelopmentInputs(
        dirname(appRoot),
        work,
      );
    },
  });
  if (!developmentCuration)
    invalid("STORE_WORKER_DEVELOPMENT_CURATION_REQUIRED");
  const engineAuthorityProfile = await stageStoreEngineAuthorityProfile(
    stage,
    workerRoot,
  );
  for (const name of ["MusicMuteWorker.exe", "MusicMuteSession.exe"]) {
    const pin = inputs.nativeBuild.executables.find(
      (row) => row.path === name,
    )!;
    await copyStorePinnedFile(
      join(inputs.nativeBuild.directory, name),
      join(stage, name),
      { bytes: pin.bytes, sha256: pin.sha256 },
    );
  }
  const entrySource = join(
      componentRoot,
      "../chrome-extension/engine",
      STORE_DOWNLOADER_ENTRY,
    ),
    entryPin = await hashStoreFile(entrySource);
  await copyStorePinnedFile(
    entrySource,
    join(stage, "tools/downloader", STORE_DOWNLOADER_ENTRY),
    entryPin,
  );
  for (const row of acquisition.cachePins)
    await copyStorePinnedFile(
      join(
        inputs.acquisition.root,
        "build-work/offline-check/deno-cache",
        ...row.path.split("/"),
      ),
      join(stage, "tools/youtube", STORE_DENO_CACHE, ...row.path.split("/")),
      row,
    );
  const youtubeRoot = join(stage, "tools/youtube"),
    originalIdentity = json(
      await packageFile(join(youtubeRoot, "identity.json"), 8 * 1024 ** 2),
      8 * 1024 ** 2,
    ) as Record<string, unknown>,
    files = (await treePins(youtubeRoot)).filter(
      (row) => row.path !== "identity.json",
    );
  const identity = Buffer.from(
    JSON.stringify({ ...originalIdentity, files }) + "\n",
  );
  parseStoreYoutubeIdentity(identity);
  const identityStage = join(youtubeRoot, "identity.store-staging.json");
  await writeFile(identityStage, identity, { flag: "wx" });
  await rename(identityStage, join(youtubeRoot, "identity.json"));
  await verifyStoreWorkerAcquisition(stage, componentRoot);
  await stageStoreAgentNotices(stage, componentRoot);
  const pythonNotices = await stageStorePythonNotices(stage, componentRoot);
  // Consumer manifest was written before the two genuine main-package entry
  // executables/cache/Store adapter were added; regenerate it over final bytes.
  const manifestPath = join(stage, "release-manifest.json"),
    old = await packageFile(manifestPath, 8 * 1024 ** 2);
  await writeFile(join(work, "pre-store-release-manifest.json"), old, {
    flag: "wx",
  });
  await rename(
    manifestPath,
    join(work, "pre-store-release-manifest-source.json"),
  );
  await writeWindowsReleaseManifest(
    stage,
    STORE_PRODUCTS.worker.appVersion,
    "windows-user",
  );
  await auditStoreWorker(stage, workerRoot);
  const final = await listStorePayload(stage, "worker");
  await verifyStoreNativeProvenance(
    inputs.nativeBuild,
    "worker",
    componentRoot,
  );
  await verifyStoreWorkerAcquisitionInputs(inputs);
  const afterTool = await verifyStorePnpmTool(
    inputs.pnpmToolRoot,
    componentRoot,
  );
  await verifyStorePythonProjection(
    inputs.pythonRoot,
    dirname(inputs.pythonProjection.path),
    await pinned(inputs.pythonProjection),
    requirements,
  );
  if (afterTool.censusSha256 !== tool.censusSha256) invalid();
  const reader = final.find(
    (row) => row.path === `app/engine/musicmute_engine/${STORE_CODE_READER}`,
  );
  if (!reader) invalid();
  const receipt = {
    version: 1,
    purpose: "unsigned-store-worker-directory",
    appVersion: STORE_PRODUCTS.worker.appVersion,
    appBuildNumber: inputs.appBuildNumber,
    native,
    pythonProjection,
    developmentCuration,
    pythonNotices,
    engineAuthorityProfile,
    officialPnpmToolCensusSha256: tool.censusSha256,
    reader,
    files: final.length,
    releaseManifestSha256: (await hashStoreFile(manifestPath)).sha256,
    legacyQualityPreserved: true,
    originalGuardianReceiptRequired: true,
    relocatedStoreReadonlyExecution: "pending",
    storeExecutionQualified: false,
    gpuInferenceTested: false,
    signed: false,
    installable: false,
    releaseReady: false,
    published: false,
    licenseApproval: "pending",
    storePolicyApproval: "pending",
  };
  await writeFile(
    join(work, "worker-staging-receipt.json"),
    JSON.stringify(receipt, null, 2) + "\n",
    { flag: "wx" },
  );
  return Object.freeze({
    stage,
    work,
    files: Object.freeze(final),
    receipt: Object.freeze(receipt),
  });
}
