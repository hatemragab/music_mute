import { createHash } from "node:crypto";
import { parseStoreBuildDocument } from "./document-json.js";
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { projectStoreEngineSource } from "./engine-profile.js";
import { parseStrictJson } from "../../../chrome-extension/src/shared/strict-json.js";
import {
  WINDOWS_CONSUMER_DOWNLOADER_WHEELS,
  WINDOWS_CONSUMER_PINS,
} from "../../../worker/src/platform/windows/consumer-pins.js";
import { verifyPinnedAcquisitionInventory } from "../../../worker/src/platform/windows/consumer-package.js";
import { packageFile } from "../validate-assets.js";
import {
  assertStorePayloadPath,
  hashStoreFile,
  safeStoreRelativePath,
  type StoreInventoryEntry,
} from "./inventory.js";

export const STORE_DOWNLOADER_ENTRY = "store_downloader_bootstrap.py";
export const STORE_CODE_READER = "store_code_reader.py";
export const STORE_PERSONAL_ENTRY = "store_consumer_personal.py";
export const STORE_QUALIFICATION_ENTRY = "store_qualification.py";
export const STORE_DENO_CACHE = "deno-cache";
/** Derived from the already checksum-verified official 2.9.7 Windows archive
 * and the production-only derived lock qualified by the guarded v17 rehearsal.
 * These are byte pins, not installation/Store authority. */
export const STORE_ACQUISITION_PINS = Object.freeze({
  denoExecutableBytes: 97462048,
  denoExecutableSha256:
    "e020f3e232bd16e33768dee528e5983349c962952051ced0a5d58ad42f5d9b33",
  productionLockSha256:
    "c5df5d573e01674589e6ef8f7f23d86a855e071fa1324660f0a4fb43284d4b62",
  manualHoistedConfigurationSha256:
    "45d56d7afa24ae7ea87e8b21d6592c68bef2b505f7f8911eb9aa7e383c98655f",
});
const EMPTY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
function invalid(): never {
  throw new Error("STORE_ACQUISITION_INVALID");
}
function record(value: unknown, fields: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    invalid();
  const row: Record<string, unknown> = Object.create(null);
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) invalid();
    row[key] = descriptor.value;
  }
  return row;
}
/** Explicit Store receiving format. Legacy downloader admission remains exact
 * and therefore continues rejecting the additional Store-only entry. */
export function parseStoreYoutubeIdentity(bytes: Uint8Array) {
  if (bytes.byteLength < 1 || bytes.byteLength > 8 * 1024 ** 2) invalid();
  const row = record(parseStoreBuildDocument(bytes), [
    "schema_version",
    "platform",
    "arch",
    "deno_version",
    "provider_version",
    "sources",
    "files",
  ]);
  if (
    row.schema_version !== 1 ||
    row.platform !== "win32" ||
    row.arch !== "x64" ||
    row.deno_version !== WINDOWS_CONSUMER_PINS.deno ||
    row.provider_version !== WINDOWS_CONSUMER_PINS.provider ||
    !Array.isArray(row.files) ||
    row.files.length < 10 ||
    row.files.length > 30000 ||
    !row.sources ||
    typeof row.sources !== "object" ||
    Array.isArray(row.sources)
  )
    invalid();
  const entries: StoreInventoryEntry[] = [],
    folded = new Set<string>();
  let previous = "",
    total = 0;
  for (const value of row.files) {
    const item = record(value, ["path", "bytes", "sha256"]),
      path = safeStoreRelativePath(item.path);
    assertStorePayloadPath("worker", `tools/youtube/${path}`);
    if (
      path === "identity.json" ||
      (/\.exe$/iu.test(path) && path !== "bin/deno.exe") ||
      /\.pyd$/iu.test(path) ||
      (path.startsWith(`${STORE_DENO_CACHE}/`) &&
        /\.(?:exe|dll|pyd|node|whl|py)$/iu.test(path)) ||
      path <= previous ||
      folded.has(path.toLowerCase()) ||
      !Number.isSafeInteger(item.bytes) ||
      (item.bytes as number) < 0 ||
      (item.bytes as number) > 512 * 1024 ** 2 ||
      typeof item.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(item.sha256) ||
      (item.bytes === 0 &&
        (item.sha256 !== EMPTY_SHA256 ||
          /\.(?:exe|dll|pyd|node)$/iu.test(path)))
    )
      invalid();
    total += item.bytes as number;
    if (total > 2 * 1024 ** 3) invalid();
    previous = path;
    folded.add(path.toLowerCase());
    entries.push(
      Object.freeze({
        path,
        bytes: item.bytes as number,
        sha256: item.sha256,
      }),
    );
  }
  const inventory = new Map(entries.map((entry) => [entry.path, entry]));
  for (const key of [
    "bin/deno.exe",
    "provider/src/generate_once.ts",
    "provider/src/session_manager.ts",
    "provider/deno.lock",
    "provider/deno.json",
    "provider/LICENSE",
    "licenses/deno/LICENSE",
  ])
    if (!inventory.has(key) || inventory.get(key)!.bytes < 1) invalid();
  if (
    inventory.get("provider/src/generate_once.ts")!.sha256 !==
      WINDOWS_CONSUMER_PINS.providerScriptSha256 ||
    inventory.get("provider/src/session_manager.ts")!.sha256 !==
      WINDOWS_CONSUMER_PINS.providerSessionSha256 ||
    inventory.get("bin/deno.exe")!.bytes !==
      STORE_ACQUISITION_PINS.denoExecutableBytes ||
    inventory.get("bin/deno.exe")!.sha256 !==
      STORE_ACQUISITION_PINS.denoExecutableSha256 ||
    inventory.get("provider/deno.lock")!.sha256 !==
      STORE_ACQUISITION_PINS.productionLockSha256 ||
    inventory.get("provider/deno.json")!.sha256 !==
      STORE_ACQUISITION_PINS.manualHoistedConfigurationSha256 ||
    !entries.some((entry) => entry.path.startsWith(`${STORE_DENO_CACHE}/`))
  )
    invalid();
  return Object.freeze(entries);
}
async function pinnedFile(path: string, bytes: number, sha256: string) {
  const actual = await hashStoreFile(path);
  if (actual.bytes !== bytes || actual.sha256 !== sha256) invalid();
}
/** Fixed protected adapters must match this producer's current source bytes.
 * These copy checks do not confer package or launch authority. */
export async function verifyStoreWorkerProtectedAdapters(
  root: string,
  componentRoot: string,
) {
  for (const [actual, original] of [
    [
      join(root, "tools/downloader", STORE_DOWNLOADER_ENTRY),
      join(componentRoot, "../chrome-extension/engine", STORE_DOWNLOADER_ENTRY),
    ],
    ...[STORE_CODE_READER, STORE_PERSONAL_ENTRY, STORE_QUALIFICATION_ENTRY].map(
      (name) =>
        [
          join(root, "app/engine/musicmute_engine", name),
          join(componentRoot, "../worker/engine/musicmute_engine", name),
        ] as const,
    ),
  ] as const) {
    const before = await hashStoreFile(original),
      source = await packageFile(original, 65536),
      copied = await packageFile(actual, 65536),
      expected = projectStoreEngineSource(basename(original), source);
    if (
      source.length !== before.bytes ||
      hash(source) !== before.sha256 ||
      !expected.equals(copied)
    )
      invalid();
    await pinnedFile(actual, expected.length, hash(expected));
    await pinnedFile(original, before.bytes, before.sha256);
  }
}
/** This checks bytes for a candidate; Native Store signature/current package/
 * creator-role and held full-census proof separately authorize execution. */
export async function verifyStoreWorkerAcquisition(
  root: string,
  componentRoot: string,
) {
  const downloader = join(root, "tools/downloader"),
    youtube = join(root, "tools/youtube"),
    names = [
      "identity.json",
      "downloader_bootstrap.py",
      STORE_DOWNLOADER_ENTRY,
      ...WINDOWS_CONSUMER_DOWNLOADER_WHEELS.map((wheel) => wheel.file),
    ].sort();
  if (
    JSON.stringify((await readdir(downloader)).sort()) !== JSON.stringify(names)
  )
    invalid();
  const identity = record(
    parseStrictJson(
      new TextDecoder("utf-8", { fatal: true }).decode(
        await packageFile(join(downloader, "identity.json"), 65536),
      ),
      65536,
      128,
    ),
    ["schema_version", "source", "asset", "version", "bootstrap", "wheels"],
  );
  if (
    identity.schema_version !== 1 ||
    identity.source !== "yt-dlp/yt-dlp" ||
    identity.asset !== "python-wheels" ||
    identity.version !== WINDOWS_CONSUMER_PINS.downloader ||
    !Array.isArray(identity.wheels) ||
    identity.wheels.length !== WINDOWS_CONSUMER_DOWNLOADER_WHEELS.length
  )
    invalid();
  const bootstrap = record(identity.bootstrap, ["file", "bytes", "sha256"]);
  if (
    bootstrap.file !== "downloader_bootstrap.py" ||
    !Number.isSafeInteger(bootstrap.bytes) ||
    (bootstrap.bytes as number) < 1 ||
    bootstrap.sha256 !== WINDOWS_CONSUMER_PINS.downloaderBootstrapSha256
  )
    invalid();
  await pinnedFile(
    join(downloader, "downloader_bootstrap.py"),
    bootstrap.bytes as number,
    WINDOWS_CONSUMER_PINS.downloaderBootstrapSha256,
  );
  for (const [index, pin] of WINDOWS_CONSUMER_DOWNLOADER_WHEELS.entries()) {
    const value = record(identity.wheels[index], [
      "file",
      "version",
      "bytes",
      "sha256",
    ]);
    if (
      value.file !== pin.file ||
      value.version !== pin.version ||
      value.bytes !== pin.bytes ||
      value.sha256 !== pin.sha256
    )
      invalid();
    await pinnedFile(join(downloader, pin.file), pin.bytes, pin.sha256);
  }
  await verifyStoreWorkerProtectedAdapters(root, componentRoot);
  const entries = parseStoreYoutubeIdentity(
    await packageFile(join(youtube, "identity.json"), 8 * 1024 ** 2),
  );
  await verifyPinnedAcquisitionInventory(
    youtube,
    new Map(entries.map((entry) => [entry.path, entry])),
  );
  const configuration = parseStrictJson(
    new TextDecoder("utf-8", { fatal: true }).decode(
      await packageFile(join(youtube, "provider/deno.json"), 65536),
    ),
    65536,
    256,
  ) as Record<string, unknown>;
  if (
    Object.keys(configuration).sort().join() !==
      "nodeModulesDir,nodeModulesLinker" ||
    configuration.nodeModulesDir !== "manual" ||
    configuration.nodeModulesLinker !== "hoisted"
  )
    invalid();
  return Object.freeze({
    entries,
    protectedCacheFiles: entries.filter((entry) =>
      entry.path.startsWith(`${STORE_DENO_CACHE}/`),
    ).length,
    legacyRecipePreserved: true,
    storeExecutionQualified: false,
  });
}
