import { execFile } from "node:child_process";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign,
  type KeyObject,
} from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { installProductionDependencies } from "../production-dependencies.js";
import { shouldCopyReleaseTreeEntry } from "../release-tree-filter.js";
import {
  canonicalUpdateMetadata,
  verifyUpdateMetadata,
  type SignedUpdateMetadata,
  type UpdateMetadata,
} from "../shared/update-metadata.js";
import { auditWindowsX64Binary } from "./pe-audit.js";
import { auditWindowsConsumerDlls } from "./consumer-dlls.js";
import {
  verifyWindowsRelease,
  writeWindowsReleaseManifest,
  type WindowsReleaseManifest,
} from "./release-manifest.js";

const execute = promisify(execFile);
const SHA256 = /^[a-f0-9]{64}$/u;
const EMPTY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const VERSION = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/u;
const MAX_IDENTITY_BYTES = 8 * 1024 * 1024;
const MAX_SCAN_BYTES = 8 * 1024 * 1024;
// Vendor examples, the macOS library and the unavailable optional TBB pool are
// not Windows runtime inputs. Numba retains its verified existing OpenMP backend.
// Keep the receiving audit strict for every other model/binary.
const WINDOWS_PYTHON_NON_RUNTIME_LEAVES = new Set([
  "Lib/site-packages/onnxruntime/datasets/logreg_iris.onnx",
  "Lib/site-packages/onnxruntime/datasets/mul_1.onnx",
  "Lib/site-packages/onnxruntime/datasets/sigmoid.onnx",
  "Lib/site-packages/samplerate/_samplerate_data/libsamplerate.dylib",
  "Lib/site-packages/numba/np/ufunc/tbbpool.cp312-win_amd64.pyd",
]);
const CONSUMER_PYTHON_PROBE = `
import sys, json, platform, importlib.metadata as m, importlib.util
from pathlib import Path
engine = Path(sys.argv[1]).resolve()
prefix = Path(sys.prefix).resolve()
sys.path.insert(0, str(engine))
from musicmute_engine.windows_gpu import require_native_x64
require_native_x64()
import onnxruntime as ort
import numpy, scipy, soundfile, torch, torch_directml
from audio_separator.separator import Separator
if sys.argv[2] == 'store-kim-mdx-v1':
    from audio_separator.separator.architectures.mdx_separator import MDXSeparator
    assert importlib.util.find_spec('diffq') is None, 'Store MDX projection contains omitted Demucs dependency'
    assert not any(name == 'diffq' or name.startswith('diffq.') for name in sys.modules), 'Store MDX imports omitted Demucs dependency'
assert 'DmlExecutionProvider' in ort.get_available_providers()
def private(path):
    actual = Path(path).resolve()
    return actual.is_relative_to(prefix) or actual.is_relative_to(engine)
assert all(private(path) for path in sys.path), 'Runtime Python path escapes its private payload'
for module in tuple(sys.modules.values()):
    path = getattr(module, '__file__', None)
    if path:
        assert private(path), 'Runtime Python import escapes its private payload'
packages = {}
for distribution in m.distributions():
    assert Path(distribution.locate_file('')).resolve().is_relative_to(prefix), 'Runtime package metadata escapes private payload'
    name = distribution.metadata['Name'].lower().replace('_', '-')
    assert name not in packages, 'Runtime contains duplicate distribution metadata'
    packages[name] = distribution.version
print(json.dumps({'python':platform.python_version(),'onnxRuntime':m.version('onnxruntime-directml'),'audioSeparator':m.version('audio-separator'),'packages':packages}))
`;

import {
  WINDOWS_CONSUMER_PINS,
  WINDOWS_CONSUMER_DOWNLOADER_WHEELS as WHEELS,
} from "./consumer-pins.js";
export { WINDOWS_CONSUMER_PINS } from "./consumer-pins.js";

/** Product-specific runtime projection, not the upstream pip dependency closure.
 * Its full source lock remains mandatory and unmodified. The Store assembler
 * separately verifies every source/retained/omitted file before selecting it. */
export const STORE_KIM_MDX_PYTHON_PROFILE = "store-kim-mdx-v1" as const;
export const STORE_KIM_MDX_SOURCE_LOCK_SHA256 =
  "503abcc0af29235b6122b9b8749c23d6778d4a61ae11c01c06303fce87b47b4c";

export interface WindowsConsumerPackageOptions {
  workerRoot: string;
  outputRoot: string;
  releaseVersion: string;
  nodeRoot: string;
  pythonRoot: string;
  mediaRoot: string;
  nativeBinary: string;
  agentRoot: string;
  downloaderRoot: string;
  youtubeRoot: string;
  requirementsLockPath: string;
  pythonDistributionProfile?: typeof STORE_KIM_MDX_PYTHON_PROFILE;
}
export interface WindowsConsumerRuntimeProbe {
  nativeArchitecture: "x64";
  node: string;
  python: string;
  onnxRuntime: string;
  audioSeparator: string;
  ffmpeg: string;
  deno: string;
  packages: Record<string, string>;
}
/** Dependency injection is for code fixtures; production callers use native checks. */
export interface WindowsConsumerPackageChecks {
  host?: { platform: NodeJS.Platform; arch: string };
  probe?: (
    options: WindowsConsumerPackageOptions,
  ) => Promise<WindowsConsumerRuntimeProbe>;
  acquisition?: (downloader: string, youtube: string) => Promise<void>;
  productionDependencies?: (worker: string, app: string) => Promise<void>;
}

export async function buildWindowsConsumerPackage(
  options: WindowsConsumerPackageOptions,
  checks: WindowsConsumerPackageChecks = {},
): Promise<WindowsReleaseManifest> {
  const host = checks.host ?? process;
  if (host.platform !== "win32" || host.arch !== "x64")
    throw new TypeError(
      "Consumer runtime assembly requires native Windows x64",
    );
  if (!VERSION.test(options.releaseVersion))
    throw new TypeError("Consumer runtime release version is invalid");
  for (const [key, value] of Object.entries(options))
    if (
      key !== "releaseVersion" &&
      key !== "pythonDistributionProfile" &&
      (typeof value !== "string" || !isAbsolute(value))
    )
      throw new TypeError(`Consumer runtime ${key} must be absolute`);
  const output = resolve(options.outputRoot);
  await assertMissing(output);
  for (const root of [
    options.workerRoot,
    options.nodeRoot,
    options.pythonRoot,
    options.mediaRoot,
    options.agentRoot,
    options.downloaderRoot,
    options.youtubeRoot,
  ]) {
    await requireDirectory(root);
    if (
      output === resolve(root) ||
      output.startsWith(`${resolve(root)}${sep}`) ||
      resolve(root).startsWith(`${output}${sep}`)
    )
      throw new TypeError("Consumer output must be separate from input roots");
  }
  await requireFile(options.nativeBinary);
  try {
    await lstat(join(options.pythonRoot, "pyvenv.cfg"));
    throw new TypeError(
      "Consumer Python must be a relocatable private runtime, not a virtual environment",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const packageValue = object(
    JSON.parse(await boundedText(join(options.workerRoot, "package.json"))),
    "Worker package",
  );
  if (packageValue.version !== options.releaseVersion)
    throw new TypeError("Worker package and consumer release versions differ");
  const lock = await boundedText(options.requirementsLockPath);
  const expectedPackages = windowsConsumerPackagesForProfile(
    lock,
    options.pythonDistributionProfile,
  );
  const probe = await (checks.probe ?? probeNativeRuntime)(options);
  assertProbe(probe, expectedPackages, options.pythonDistributionProfile);
  await (checks.acquisition ?? verifyWindowsConsumerAcquisition)(
    options.downloaderRoot,
    options.youtubeRoot,
  );

  const stage = join(
    dirname(output),
    `.${basename(output)}.${randomUUID()}.building`,
  );
  await mkdir(stage);
  try {
    for (const [source, destination, filter] of [
      [join(options.workerRoot, "dist"), join(stage, "app", "dist"), true],
      [join(options.workerRoot, "engine"), join(stage, "app", "engine"), true],
      [options.pythonRoot, join(stage, "runtime", "python"), "windows-python"],
      [
        join(options.mediaRoot, "licenses"),
        join(stage, "runtime", "licenses"),
        false,
      ],
      [options.agentRoot, join(stage, "agent"), false],
      [options.downloaderRoot, join(stage, "tools", "downloader"), false],
      [options.youtubeRoot, join(stage, "tools", "youtube"), false],
    ] as const)
      await copyTree(source, destination, filter);
    for (const [source, destination] of [
      [
        join(options.workerRoot, "package.json"),
        join(stage, "app", "package.json"),
      ],
      [
        join(options.workerRoot, "LICENSE"),
        join(stage, "runtime", "licenses", "musicmute", "LICENSE"),
      ],
      [
        join(options.nodeRoot, "node.exe"),
        join(stage, "runtime", "node", "node.exe"),
      ],
      [
        join(options.nodeRoot, "LICENSE"),
        join(stage, "runtime", "node", "LICENSE"),
      ],
      [
        join(options.pythonRoot, "LICENSE.txt"),
        join(stage, "runtime", "licenses", "python", "LICENSE.txt"),
      ],
      [
        join(options.mediaRoot, "bin", "ffmpeg.exe"),
        join(stage, "runtime", "bin", "ffmpeg.exe"),
      ],
      [
        join(options.mediaRoot, "bin", "ffprobe.exe"),
        join(stage, "runtime", "bin", "ffprobe.exe"),
      ],
      [
        join(options.mediaRoot, "SOURCE-MANIFEST.json"),
        join(stage, "runtime", "media-source-manifest.json"),
      ],
      [
        options.nativeBinary,
        join(stage, "runtime", "native", "musicmute-native.exe"),
      ],
      [
        options.requirementsLockPath,
        join(stage, "runtime", "requirements-directml.lock.txt"),
      ],
    ] as const)
      await copyFile(source, destination);
    await (checks.productionDependencies ?? installProductionDependencies)(
      options.workerRoot,
      join(stage, "app"),
    );
    // Source maps are development artifacts, removed only from owned staging.
    for (const path of await listFiles(stage))
      if (path.endsWith(".map")) await rm(path);
    await auditConsumerTree(stage);
    const dllAudit = await auditWindowsConsumerDlls(
      stage,
      await listFiles(stage),
    );
    // Probe the relocated payload too. A passing source venv is not proof that
    // a fresh user's copied DLL/package closure can load independently.
    const installedProbe = await (checks.probe ?? probeNativeRuntime)({
      ...options,
      workerRoot: join(stage, "app"),
      nodeRoot: join(stage, "runtime", "node"),
      pythonRoot: join(stage, "runtime", "python"),
      mediaRoot: join(stage, "runtime"),
      youtubeRoot: join(stage, "tools", "youtube"),
    });
    assertProbe(
      installedProbe,
      expectedPackages,
      options.pythonDistributionProfile,
    );
    await writeFile(
      join(stage, "runtime", "consumer-source-manifest.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          installationProfile: "windows-user",
          pins: WINDOWS_CONSUMER_PINS,
          requirementsLockSha256: createHash("sha256")
            .update(lock)
            .digest("hex"),
          observed: installedProbe,
          ...(options.pythonDistributionProfile === undefined
            ? {}
            : {
                pythonDistributionProfile: options.pythonDistributionProfile,
                pythonDependencyClosure: "product-specific-not-full-upstream",
                sourcePackages: parsePackageLock(lock),
                omittedDistributions: { "diffq-fixed": "0.2.4" },
              }),
          dllAudit,
        },
        null,
        2,
      ) + "\n",
      { flag: "wx" },
    );
    const manifest = await writeWindowsReleaseManifest(
      stage,
      options.releaseVersion,
      "windows-user",
    );
    await rename(stage, output);
    return manifest;
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

/** Pinned bootstrap/wheels + complete Windows provider inventory, no ambient installs. */
export async function verifyWindowsConsumerAcquisition(
  downloader: string,
  youtube: string,
): Promise<void> {
  const identity = object(
    JSON.parse(await boundedText(join(downloader, "identity.json"))),
    "Downloader identity",
  );
  if (
    identity.schema_version !== 1 ||
    identity.source !== "yt-dlp/yt-dlp" ||
    identity.asset !== "python-wheels" ||
    identity.version !== WINDOWS_CONSUMER_PINS.downloader
  )
    throw new TypeError("Downloader identity target is invalid");
  const names = [
    "identity.json",
    "downloader_bootstrap.py",
    ...WHEELS.map((wheel) => wheel.file),
  ].sort();
  if (
    JSON.stringify((await readdir(downloader)).sort()) !== JSON.stringify(names)
  )
    throw new TypeError("Downloader contains unexpected files");
  const bootstrap = await digest(join(downloader, "downloader_bootstrap.py"));
  if (bootstrap.sha256 !== WINDOWS_CONSUMER_PINS.downloaderBootstrapSha256)
    throw new TypeError("Downloader bootstrap digest differs");
  if (
    !Array.isArray(identity.wheels) ||
    identity.wheels.length !== WHEELS.length
  )
    throw new TypeError("Downloader wheel inventory is incomplete");
  for (const [index, pin] of WHEELS.entries()) {
    const recorded = object(identity.wheels[index], "Downloader wheel");
    const actual = await digest(join(downloader, pin.file));
    if (
      recorded.file !== pin.file ||
      recorded.version !== pin.version ||
      recorded.bytes !== pin.bytes ||
      recorded.sha256 !== pin.sha256 ||
      actual.bytes !== pin.bytes ||
      actual.sha256 !== pin.sha256
    )
      throw new TypeError("Downloader wheel digest differs");
  }
  const provider = object(
    JSON.parse(
      await boundedText(join(youtube, "identity.json"), MAX_IDENTITY_BYTES),
    ),
    "YouTube identity",
  );
  if (
    provider.schema_version !== 1 ||
    provider.platform !== "win32" ||
    provider.arch !== "x64" ||
    provider.deno_version !== WINDOWS_CONSUMER_PINS.deno ||
    provider.provider_version !== WINDOWS_CONSUMER_PINS.provider ||
    !Array.isArray(provider.files) ||
    provider.files.length < 10 ||
    provider.files.length > 30000
  )
    throw new TypeError("YouTube identity target is invalid");
  const inventory = new Map<string, { bytes: number; sha256: string }>();
  for (const raw of provider.files) {
    const entry = object(raw, "YouTube inventory entry");
    if (
      typeof entry.path !== "string" ||
      entry.link !== undefined ||
      inventory.has(entry.path)
    )
      throw new TypeError("YouTube inventory entry is unsafe");
    safeRelativePath(entry.path);
    if (
      !Number.isSafeInteger(entry.bytes) ||
      (entry.bytes as number) < 0 ||
      typeof entry.sha256 !== "string" ||
      !SHA256.test(entry.sha256) ||
      (entry.bytes === 0 &&
        (entry.sha256 !== EMPTY_SHA256 ||
          /\.(?:exe|dll|pyd|node)$/iu.test(entry.path)))
    )
      throw new TypeError("YouTube inventory digest is invalid");
    inventory.set(entry.path, {
      bytes: entry.bytes as number,
      sha256: entry.sha256,
    });
  }
  for (const required of [
    "bin/deno.exe",
    "provider/src/generate_once.ts",
    "provider/src/session_manager.ts",
    "provider/deno.lock",
    "provider/deno.json",
    "provider/LICENSE",
    "licenses/deno/LICENSE",
  ])
    if (!inventory.has(required) || inventory.get(required)!.bytes < 1)
      throw new TypeError(`YouTube runtime file is missing: ${required}`);
  if (
    inventory.get("provider/src/generate_once.ts")!.sha256 !==
      WINDOWS_CONSUMER_PINS.providerScriptSha256 ||
    inventory.get("provider/src/session_manager.ts")!.sha256 !==
      WINDOWS_CONSUMER_PINS.providerSessionSha256
  )
    throw new TypeError("YouTube provider source differs from its pin");
  await verifyPinnedAcquisitionInventory(youtube, inventory);
}

/** Byte-integrity primitive; the caller above separately checks approved pins. */
export async function verifyPinnedAcquisitionInventory(
  root: string,
  inventory: ReadonlyMap<string, { bytes: number; sha256: string }>,
): Promise<void> {
  const files = await listFiles(root);
  if (
    files.filter(
      (path) => relative(root, path).split(sep).join("/") !== "identity.json",
    ).length !== inventory.size
  )
    throw new TypeError("YouTube runtime inventory does not cover its files");
  for (const path of files) {
    const key = relative(root, path).split(sep).join("/");
    if (key === "identity.json") continue;
    const pin = inventory.get(key);
    if (
      !pin ||
      !Number.isSafeInteger(pin.bytes) ||
      pin.bytes < 0 ||
      !SHA256.test(pin.sha256) ||
      (pin.bytes === 0 &&
        (pin.sha256 !== EMPTY_SHA256 || /\.(?:exe|dll|pyd|node)$/iu.test(key)))
    )
      throw new TypeError("YouTube runtime inventory digest is invalid");
    const actual = await digestAcquisitionLeaf(path);
    if (pin.bytes !== actual.bytes || pin.sha256 !== actual.sha256)
      throw new TypeError("YouTube runtime inventory digest differs");
  }
  const after = await listFiles(root);
  if (
    after.length !== files.length ||
    after.some((path, index) => path !== files[index])
  )
    throw new TypeError(
      "YouTube runtime inventory changed during verification",
    );
}

/** Empty package/bookkeeping leaves still need a held, independent file and SHA. */
async function digestAcquisitionLeaf(
  path: string,
): Promise<{ bytes: number; sha256: string }> {
  const named = await lstat(path, { bigint: true });
  if (
    !named.isFile() ||
    named.isSymbolicLink() ||
    named.nlink !== 1n ||
    named.size < 0n ||
    named.size > 512n * 1024n ** 2n ||
    (named.size === 0n && /\.(?:exe|dll|pyd|node)$/iu.test(path))
  )
    throw new TypeError("YouTube runtime inventory leaf is unsafe");
  const file = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = await file.stat({ bigint: true });
    const same = (state: typeof named) =>
      state.isFile() &&
      !state.isSymbolicLink() &&
      state.nlink === before.nlink &&
      state.dev === before.dev &&
      state.ino === before.ino &&
      state.size === before.size &&
      state.mtimeNs === before.mtimeNs &&
      state.ctimeNs === before.ctimeNs &&
      state.birthtimeNs === before.birthtimeNs;
    if (!same(named))
      throw new TypeError("YouTube runtime inventory leaf changed");
    const hash = createHash("sha256");
    let bytes = 0n;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      bytes += BigInt(chunk.length);
      if (bytes > before.size)
        throw new TypeError("YouTube runtime inventory leaf changed");
      hash.update(chunk);
    }
    if (
      bytes !== before.size ||
      !same(await file.stat({ bigint: true })) ||
      !same(await lstat(path, { bigint: true }))
    )
      throw new TypeError("YouTube runtime inventory leaf changed");
    return { bytes: Number(bytes), sha256: hash.digest("hex") };
  } finally {
    await file.close();
  }
}

export async function auditConsumerTree(root: string): Promise<void> {
  for (const path of await listFiles(root)) {
    const key = relative(root, path).split(sep).join("/");
    if (!/^(?:app|runtime|agent|tools)\//u.test(key))
      throw new TypeError(
        "Consumer runtime contains an unexpected top-level file",
      );
    const name = basename(path).toLowerCase();
    if (
      name === ".npmrc" ||
      name.startsWith(".env") ||
      new Set([
        "credential",
        "credentials.json",
        "machine-credentials.json",
        "runtime-status.json",
        "lifecycle.json",
        "enrollment.json",
        "machine-state.json",
        "worker-config.json",
      ]).has(name) ||
      /\.(?:onnx|pfx|p12|key|dylib|so|map)$/iu.test(name) ||
      key.toLowerCase().includes("winsw") ||
      key.startsWith("runtime/service/") ||
      key.startsWith("installer/")
    )
      throw new TypeError(
        "Consumer runtime contains private, service or unsupported payload",
      );
    if (/\.(?:exe|dll|pyd|node)$/iu.test(name))
      await auditWindowsX64Binary(path);
    else if (/\.(?:json|js|cjs|mjs|py|txt|yaml|pem)$/iu.test(name)) {
      const info = await lstat(path);
      if (info.size > MAX_SCAN_BYTES)
        throw new TypeError("Consumer text payload exceeds audit limit");
      const text = await readFile(path, "utf8");
      if (
        // Access key IDs are complete tokens, not substrings of encoded assets.
        /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?<![A-Za-z0-9])AKIA[A-Z0-9]{16}(?![A-Za-z0-9])/u.test(
          text,
        ) ||
        containsEmbeddedMongoUri(text, /\.(?:js|cjs|mjs)$/iu.test(name))
      )
        throw new TypeError("Consumer runtime contains credential material");
    }
  }
}

function containsEmbeddedMongoUri(
  text: string,
  javaScriptSource: boolean,
): boolean {
  const dynamicStarts = new Set<number>();
  if (javaScriptSource) {
    // Only complete source templates with no embedded connection data qualify.
    // Quoted strings, comments and partially static templates stay in the scan.
    const tokens =
      /\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`/gu;
    const dynamic =
      /^`mongodb(?:\+srv)?:\/\/\$\{[A-Za-z_$][A-Za-z0-9_$]*\}:\$\{[A-Za-z_$][A-Za-z0-9_$]*\}\/\$\{[A-Za-z_$][A-Za-z0-9_$]*\}`$/u;
    for (const token of text.matchAll(tokens))
      if (dynamic.test(token[0])) dynamicStarts.add(token.index + 1);
  }
  for (const uri of text.matchAll(/mongodb(?:\+srv)?:\/\//gu)) {
    const next = text[uri.index + uri[0].length];
    if (
      next !== undefined &&
      !/[\s"']/u.test(next) &&
      !dynamicStarts.has(uri.index)
    )
      return true;
  }
  return false;
}

export async function createWindowsConsumerArchive(
  releaseRoot: string,
  outputPath: string,
): Promise<{
  filename: string;
  bytes: number;
  sha256: string;
  contentType: "application/zip";
}> {
  if (process.platform !== "win32" || process.arch !== "x64")
    throw new TypeError(
      "Consumer ZIP construction requires native Windows x64",
    );
  if (
    !isAbsolute(outputPath) ||
    !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,119}\.zip$/u.test(basename(outputPath))
  )
    throw new TypeError("Consumer archive output is invalid");
  await verifyWindowsRelease(releaseRoot, "windows-user");
  await assertMissing(outputPath);
  const temporary = `${outputPath}.${randomUUID()}.tmp`;
  try {
    const command = join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "tar.exe",
    );
    await execute(
      command,
      ["-cf", temporary, "--format", "zip", "-C", releaseRoot, "."],
      { timeout: 20 * 60_000, maxBuffer: 1024 * 1024, windowsHide: true },
    );
    const identity = await digest(temporary);
    await rename(temporary, outputPath);
    return {
      filename: basename(outputPath),
      ...identity,
      contentType: "application/zip",
    };
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export function signWindowsConsumerArtifact(
  metadata: UpdateMetadata,
  keyId: string,
  privateKey: KeyObject,
): SignedUpdateMetadata {
  if (
    privateKey.type !== "private" ||
    privateKey.asymmetricKeyType !== "ed25519" ||
    metadata.platform !== "windows-amd64" ||
    metadata.installationProfile !== "windows-user"
  )
    throw new TypeError(
      "Consumer artifact requires an external Ed25519 signing key and user profile",
    );
  const envelope: SignedUpdateMetadata = {
    keyId,
    metadata,
    signature: sign(
      null,
      Buffer.from(canonicalUpdateMetadata(metadata)),
      privateKey,
    ).toString("base64url"),
  };
  verifyUpdateMetadata(envelope, {
    platform: "windows-amd64",
    installationProfile: "windows-user",
    publicKeys: {
      [keyId]: createPublicKey(privateKey)
        .export({ type: "spki", format: "pem" })
        .toString(),
    },
    minimumSequence: metadata.sequence,
  });
  return envelope;
}

function normalizePackage(name: string): string {
  return name.toLowerCase().replaceAll(/[-_.]+/gu, "-");
}
export function parsePackageLock(text: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Za-z0-9._-]+)==([A-Za-z0-9.+_-]+)$/u.exec(line);
    if (!match || entries[normalizePackage(match[1]!)] !== undefined)
      throw new TypeError(
        "DirectML requirement lock must contain unique exact pins",
      );
    entries[normalizePackage(match[1]!)] = match[2]!;
  }
  if (
    entries["onnxruntime-directml"] !== WINDOWS_CONSUMER_PINS.onnxRuntime ||
    entries["audio-separator"] !== WINDOWS_CONSUMER_PINS.audioSeparator ||
    entries["onnxruntime"] !== undefined ||
    entries["onnxruntime-gpu"] !== undefined
  )
    throw new TypeError(
      "DirectML lock contains unsupported runtime distributions",
    );
  return entries;
}
export function windowsConsumerPackagesForProfile(
  lock: string,
  profile?: typeof STORE_KIM_MDX_PYTHON_PROFILE,
): Record<string, string> {
  const packages = parsePackageLock(lock);
  if (profile === undefined) return packages;
  if (
    profile !== STORE_KIM_MDX_PYTHON_PROFILE ||
    createHash("sha256").update(lock).digest("hex") !==
      STORE_KIM_MDX_SOURCE_LOCK_SHA256 ||
    Object.keys(packages).length !== 63 ||
    packages["diffq-fixed"] !== "0.2.4"
  )
    throw new TypeError(
      "Store MDX projection requires its exact full source lock",
    );
  const { "diffq-fixed": omitted, ...retained } = packages;
  void omitted;
  return retained;
}
function assertProbe(
  probe: WindowsConsumerRuntimeProbe,
  packages: Record<string, string>,
  profile?: typeof STORE_KIM_MDX_PYTHON_PROFILE,
): void {
  if (
    probe.nativeArchitecture !== "x64" ||
    Object.entries({
      node: WINDOWS_CONSUMER_PINS.node,
      python: WINDOWS_CONSUMER_PINS.python,
      onnxRuntime: WINDOWS_CONSUMER_PINS.onnxRuntime,
      audioSeparator: WINDOWS_CONSUMER_PINS.audioSeparator,
      ffmpeg: WINDOWS_CONSUMER_PINS.ffmpeg,
      deno: WINDOWS_CONSUMER_PINS.deno,
    }).some(
      ([key, version]) =>
        probe[key as keyof WindowsConsumerRuntimeProbe] !== version,
    )
  )
    throw new TypeError(
      "Consumer runtime does not match native architecture or pinned versions",
    );
  for (const [name, version] of Object.entries(packages))
    if (probe.packages[name] !== version)
      throw new TypeError(`Consumer Python package is not pinned: ${name}`);
  if (Object.keys(probe.packages).length !== Object.keys(packages).length)
    throw new TypeError(
      profile === STORE_KIM_MDX_PYTHON_PROFILE
        ? "Consumer Python distribution inventory differs from its exact Store MDX product census"
        : "Consumer Python distribution inventory differs from its complete lock",
    );
  for (const name of ["onnxruntime", "onnxruntime-gpu", "onnxruntime-silicon"])
    if (probe.packages[name] !== undefined)
      throw new TypeError(
        "Consumer Python contains a conflicting ONNX distribution",
      );
}
async function probeNativeRuntime(
  options: WindowsConsumerPackageOptions,
): Promise<WindowsConsumerRuntimeProbe> {
  const temporary = await mkdtemp(
    join(dirname(options.outputRoot), ".musicmute-private-probe-"),
  );
  try {
    const environment = windowsConsumerProbeEnvironment(process.env, temporary);
    const run = async (
      binary: string,
      arguments_: string[],
      timeout = 30_000,
    ) =>
      (
        await execute(binary, arguments_, {
          timeout,
          maxBuffer: 2 * 1024 * 1024,
          windowsHide: true,
          env: environment,
          cwd: dirname(binary),
        })
      ).stdout.trim();
    const node = object(
      JSON.parse(
        await run(join(options.nodeRoot, "node.exe"), [
          "-p",
          "JSON.stringify({version:process.versions.node,arch:process.arch})",
        ]),
      ),
      "Node probe",
    );
    if (node.arch !== "x64") throw new TypeError("Consumer Node is not x64");
    const python = object(
      JSON.parse(
        await run(
          join(options.pythonRoot, "python.exe"),
          [
            "-I",
            "-B",
            "-c",
            CONSUMER_PYTHON_PROBE,
            join(options.workerRoot, "engine"),
            options.pythonDistributionProfile ?? "full-source",
          ],
          // Cold Torch/librosa/MDX imports are not a lightweight version probe.
          // Only this exact Store product's Python call receives the finite
          // larger budget; legacy Python and every version tool stay at 30 seconds.
          options.pythonDistributionProfile === STORE_KIM_MDX_PYTHON_PROFILE
            ? 120_000
            : 30_000,
        ),
      ),
      "Python probe",
    );
    const ffmpeg = await run(join(options.mediaRoot, "bin", "ffmpeg.exe"), [
      "-version",
    ]);
    const ffprobe = await run(join(options.mediaRoot, "bin", "ffprobe.exe"), [
      "-version",
    ]);
    if (!ffprobe.startsWith(`ffprobe version ${WINDOWS_CONSUMER_PINS.ffmpeg}`))
      throw new TypeError("Consumer FFprobe is not pinned");
    const deno = await run(join(options.youtubeRoot, "bin", "deno.exe"), [
      "--version",
    ]);
    if (
      !ffmpeg.startsWith(`ffmpeg version ${WINDOWS_CONSUMER_PINS.ffmpeg}`) ||
      !deno.startsWith(`deno ${WINDOWS_CONSUMER_PINS.deno} `)
    )
      throw new TypeError("Consumer media/acquisition tool version differs");
    const packages = object(python.packages, "Python distributions");
    if (Object.values(packages).some((value) => typeof value !== "string"))
      throw new TypeError("Python distribution version is invalid");
    return {
      nativeArchitecture: "x64",
      node: node.version as string,
      python: python.python as string,
      onnxRuntime: python.onnxRuntime as string,
      audioSeparator: python.audioSeparator as string,
      ffmpeg: WINDOWS_CONSUMER_PINS.ffmpeg,
      deno: WINDOWS_CONSUMER_PINS.deno,
      packages: Object.fromEntries(
        Object.entries(packages).map(([name, version]) => [
          normalizePackage(name),
          version as string,
        ]),
      ),
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
/** Build-time subprocesses get only fixed Windows plumbing; no caller PATH,
 * Node options, Python path, vendor/account credentials or user-site settings. */
export function windowsConsumerProbeEnvironment(
  source: NodeJS.ProcessEnv,
  privateRoot: string,
): NodeJS.ProcessEnv {
  const root =
    source.SystemRoot ?? source.SYSTEMROOT ?? source.WINDIR ?? source.windir;
  if (!root || !/^[A-Za-z]:\\(?:[^\\\0\r\n]+\\)*[^\\\0\r\n]+$/u.test(root))
    throw new TypeError(
      "Consumer probe requires a canonical Windows system root",
    );
  if (
    win32.resolve(root) !== root ||
    !/^[A-Za-z]:\\/u.test(privateRoot) ||
    win32.resolve(privateRoot) !== privateRoot
  )
    throw new TypeError(
      "Consumer probe roots must be canonical private Windows paths",
    );
  return {
    SystemRoot: root,
    WINDIR: root,
    PATH: "",
    PYTHONNOUSERSITE: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    TEMP: privateRoot,
    TMP: privateRoot,
    HOME: privateRoot,
    USERPROFILE: privateRoot,
    APPDATA: privateRoot,
    LOCALAPPDATA: privateRoot,
  };
}
async function listFiles(root: string): Promise<string[]> {
  await requireDirectory(root);
  const paths: string[] = [];
  const seen = new Set<string>();
  async function visit(directory: string): Promise<void> {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name),
        key = relative(root, path).split(sep).join("/");
      safeRelativePath(key);
      if (seen.has(key.toLowerCase()))
        throw new TypeError("Consumer payload contains Windows path aliases");
      seen.add(key.toLowerCase());
      const info = await lstat(path);
      if (info.isSymbolicLink())
        throw new TypeError(
          "Consumer payload contains a link or reparse entry",
        );
      if (info.isDirectory()) await visit(path);
      else if (info.isFile() && info.nlink === 1) paths.push(path);
      else throw new TypeError("Consumer payload contains an unsafe entry");
      if (seen.size > 100_000)
        throw new TypeError("Consumer payload contains too many entries");
    }
  }
  await visit(root);
  return paths;
}
function safeRelativePath(path: string): void {
  if (
    !path ||
    path.length > 1024 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          /[<>:"|?*\p{Cc}]/u.test(part) ||
          /[. ]$/u.test(part) ||
          /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part),
      )
  )
    throw new TypeError("Consumer payload path is unsafe");
}
async function copyTree(
  source: string,
  destination: string,
  filter: boolean | "windows-python",
): Promise<void> {
  await listFiles(source); // Never silently dereference source links.
  await cp(source, destination, {
    recursive: true,
    dereference: false,
    force: false,
    errorOnExist: true,
    filter: filter
      ? (path) =>
          shouldCopyReleaseTreeEntry(source, path) &&
          (filter !== "windows-python" ||
            !WINDOWS_PYTHON_NON_RUNTIME_LEAVES.has(
              relative(source, path).split(sep).join("/"),
            ))
      : undefined,
  });
}
async function copyFile(source: string, destination: string): Promise<void> {
  await requireFile(source);
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, {
    force: false,
    errorOnExist: true,
    dereference: false,
  });
}
async function requireFile(path: string): Promise<void> {
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.size < 1
  )
    throw new TypeError("Consumer input must be a regular nonempty file");
}
async function requireDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new TypeError("Consumer input must be a real directory");
}
async function assertMissing(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new TypeError("Consumer output must not already exist");
}
async function boundedText(path: string, limit = 64 * 1024): Promise<string> {
  await requireFile(path);
  if ((await lstat(path)).size > limit)
    throw new TypeError("Consumer input exceeds its bound");
  return await readFile(path, "utf8");
}
async function digest(
  path: string,
): Promise<{ bytes: number; sha256: string }> {
  await requireFile(path);
  const info = await lstat(path),
    hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { bytes: info.size, sha256: hash.digest("hex") };
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

async function main(): Promise<void> {
  const [
    optionsPath,
    archivePath,
    signingKeyPath,
    keyId,
    sequenceText,
    expiry,
  ] = process.argv.slice(2);
  if (
    !optionsPath ||
    !archivePath ||
    !signingKeyPath ||
    !keyId ||
    !sequenceText ||
    !expiry ||
    process.argv.length !== 8
  )
    throw new TypeError(
      "Usage: consumer-package <private-options.json> <archive.zip> <external-key.pem> <key-id> <sequence> <expires-at>",
    );
  const options = JSON.parse(
    await boundedText(resolve(optionsPath)),
  ) as WindowsConsumerPackageOptions;
  await buildWindowsConsumerPackage(options);
  const artifact = await createWindowsConsumerArchive(
    options.outputRoot,
    resolve(archivePath),
  );
  const key = createPrivateKey(await boundedText(resolve(signingKeyPath)));
  const signed = signWindowsConsumerArtifact(
    {
      schemaVersion: 1,
      installationProfile: "windows-user",
      platform: "windows-amd64",
      sequence: Number(sequenceText),
      releaseVersion: options.releaseVersion,
      publishedAt: new Date().toISOString(),
      expiresAt: expiry,
      release: artifact,
    },
    keyId,
    key,
  );
  const signedPath = `${resolve(archivePath)}.signed.json`;
  const handle = await open(signedPath, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(signed, null, 2) + "\n");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await writeFile(
    `${resolve(archivePath)}.sha256`,
    `${artifact.sha256}  ${artifact.filename}\n`,
    { flag: "wx", mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      status: "assembled",
      installationProfile: "windows-user",
      archive: artifact.filename,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
      nativeAcceptance: "pending",
    }),
  );
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
