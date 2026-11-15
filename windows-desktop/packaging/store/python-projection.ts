import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { constants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  hashStoreFile,
  safeStoreRelativePath,
  type StoreInventoryEntry,
} from "./inventory.js";
import { auditWindowsX64Binary } from "../../../worker/src/platform/windows/pe-audit.js";
import {
  windowsConsumerProbeEnvironment,
  STORE_KIM_MDX_PYTHON_PROFILE,
  windowsConsumerPackagesForProfile,
} from "../../../worker/src/platform/windows/consumer-package.js";
import { shouldCopyReleaseTreeEntry } from "../../../worker/src/platform/release-tree-filter.js";
import { WINDOWS_CONSUMER_PINS } from "../../../worker/src/platform/windows/consumer-pins.js";
import { parseStoreBuildDocument } from "./document-json.js";
/** Exact observed third-party launcher identities. This is an explicit Store
 * projection, never a general foreign-PE ignore or a change to legacy copies. */
export const STORE_PYTHON_OMISSIONS = Object.freeze(
  [
    {
      path: "Lib/site-packages/bin/pip.exe",
      sha256:
        "42032e403a571751ddb8e8ccbc436825bc74be228acf24880fc7ad79e1882591",
      bytes: 108370,
      optionalMagic: 523,
      machine: 34404,
      reason: "unused-package-installer-or-venv-launch-template",
    },
    {
      path: "Lib/site-packages/bin/pip3.12.exe",
      sha256:
        "42032e403a571751ddb8e8ccbc436825bc74be228acf24880fc7ad79e1882591",
      bytes: 108370,
      optionalMagic: 523,
      machine: 34404,
      reason: "unused-package-installer-or-venv-launch-template",
    },
    {
      path: "Lib/site-packages/bin/pip3.exe",
      sha256:
        "42032e403a571751ddb8e8ccbc436825bc74be228acf24880fc7ad79e1882591",
      bytes: 108370,
      optionalMagic: 523,
      machine: 34404,
      reason: "unused-package-installer-or-venv-launch-template",
    },
    {
      path: "Lib/site-packages/pip/_vendor/distlib/t32.exe",
      sha256:
        "6b4195e640a85ac32eb6f9628822a622057df1e459df7c17a12f97aeabc9415b",
      bytes: 97792,
      optionalMagic: 267,
      machine: 332,
      reason: "unused-package-installer-or-venv-launch-template",
    },
    {
      path: "Lib/site-packages/pip/_vendor/distlib/t64-arm.exe",
      sha256:
        "ebc4c06b7d95e74e315419ee7e88e1d0f71e9e9477538c00a93a9ff8c66a6cfc",
      bytes: 182784,
      optionalMagic: 523,
      machine: 43620,
      reason: "unused-package-installer-or-venv-launch-template",
    },
    {
      path: "Lib/site-packages/pip/_vendor/distlib/t64.exe",
      sha256:
        "81a618f21cb87db9076134e70388b6e9cb7c2106739011b6a51772d22cae06b7",
      bytes: 108032,
      optionalMagic: 523,
      machine: 34404,
      reason: "unused-package-installer-or-venv-launch-template",
    },
    {
      path: "Lib/site-packages/pip/_vendor/distlib/w32.exe",
      sha256:
        "47872cc77f8e18cf642f868f23340a468e537e64521d9a3a416c8b84384d064b",
      bytes: 91648,
      optionalMagic: 267,
      machine: 332,
      reason: "unused-package-installer-or-venv-launch-template",
    },
    {
      path: "Lib/site-packages/pip/_vendor/distlib/w64-arm.exe",
      sha256:
        "c5dc9884a8f458371550e09bd396e5418bf375820a31b9899f6499bf391c7b2e",
      bytes: 168448,
      optionalMagic: 523,
      machine: 43620,
      reason: "unused-package-installer-or-venv-launch-template",
    },
    {
      path: "Lib/site-packages/pip/_vendor/distlib/w64.exe",
      sha256:
        "7a319ffaba23a017d7b1e18ba726ba6c54c53d6446db55f92af53c279894f8ad",
      bytes: 101888,
      optionalMagic: 523,
      machine: 34404,
      reason: "unused-package-installer-or-venv-launch-template",
    },
    {
      path: "Lib/site-packages/samplerate/_samplerate_data/libsamplerate-32bit.dll",
      sha256:
        "80d6cada86adec6c55a95e453a68b900325c519ceef7a654a783ee229cd6a249",
      bytes: 1488384,
      optionalMagic: 267,
      machine: 332,
      reason: "unused-samplerate-x86-library",
    },
    {
      path: "Lib/site-packages/setuptools/cli-32.exe",
      sha256:
        "32acc1bc543116cbe2cff10cb867772df2f254ff2634c870aef0b46c4b696fdb",
      bytes: 11776,
      optionalMagic: 267,
      machine: 332,
      reason: "unused-package-installer-or-venv-launch-template",
    },
    {
      path: "Lib/site-packages/setuptools/cli-64.exe",
      sha256:
        "bbb3de5707629e6a60a0c238cd477b28f07f0066982fda953fa6fcec39073a4a",
      bytes: 14336,
      optionalMagic: 523,
      machine: 34404,
      reason: "unused-package-installer-or-venv-launch-template",
    },
    {
      path: "Lib/site-packages/setuptools/cli-arm64.exe",
      sha256:
        "b9a7d08da880dfac8bcf548eba4b06fb59b6f09b17d33148a0f6618328926c61",
      bytes: 13824,
      optionalMagic: 523,
      machine: 43620,
      reason: "unused-package-installer-or-venv-launch-template",
    },
    {
      path: "Lib/site-packages/setuptools/cli.exe",
      sha256:
        "32acc1bc543116cbe2cff10cb867772df2f254ff2634c870aef0b46c4b696fdb",
      bytes: 11776,
      optionalMagic: 267,
      machine: 332,
      reason: "unused-package-installer-or-venv-launch-template",
    },
    {
      path: "Lib/site-packages/setuptools/gui-32.exe",
      sha256:
        "85dae1e95d77845f2cb59bcac3d4afe74bbe4c91a9bcc5bf4a71cd43104dbe7c",
      bytes: 11776,
      optionalMagic: 267,
      machine: 332,
      reason: "unused-package-installer-or-venv-launch-template",
    },
    {
      path: "Lib/site-packages/setuptools/gui-64.exe",
      sha256:
        "3471b6140eadc6412277dbbefe3fef8c345a0f1a59776086b80a3618c3a83e3b",
      bytes: 14336,
      optionalMagic: 523,
      machine: 34404,
      reason: "unused-package-installer-or-venv-launch-template",
    },
    {
      path: "Lib/site-packages/setuptools/gui-arm64.exe",
      sha256:
        "e694f4743405c8b5926ff457db6fe7f1a12dec7c16a9c3864784d3f4e07ae097",
      bytes: 13824,
      optionalMagic: 523,
      machine: 43620,
      reason: "unused-package-installer-or-venv-launch-template",
    },
    {
      path: "Lib/site-packages/setuptools/gui.exe",
      sha256:
        "85dae1e95d77845f2cb59bcac3d4afe74bbe4c91a9bcc5bf4a71cd43104dbe7c",
      bytes: 11776,
      optionalMagic: 267,
      machine: 332,
      reason: "unused-package-installer-or-venv-launch-template",
    },
    {
      path: "Lib/venv/scripts/nt/python.exe",
      sha256:
        "0b471133e110cfb53a061cad528ce8e517d7b9ac41a0a396c39ad795a487fc14",
      bytes: 274424,
      optionalMagic: 523,
      machine: 34404,
      reason: "unused-package-installer-or-venv-launch-template",
    },
    {
      path: "Lib/venv/scripts/nt/pythonw.exe",
      sha256:
        "c946a75fdc676012b084f6dc056506bfca5098dad04c407419ce7605bd85108c",
      bytes: 263400,
      optionalMagic: 523,
      machine: 34404,
      reason: "unused-package-installer-or-venv-launch-template",
    },
  ].map((row) => Object.freeze(row)),
);
/** Finite Windows leaves verified against the original pinned SDK inventory
 * and rehashed on the Z440. Only unused Demucs quantization code is omitted;
 * the original source runtime, upstream metadata and license stay untouched. */
export const STORE_MDX_UNUSED_DEPENDENCY_OMISSIONS = Object.freeze(
  [
    {
      path: "Lib/site-packages/diffq/__init__.py",
      bytes: 1079,
      sha256:
        "1f48ac97beaf29cf02630e1117316f009f9025147acf5e4b99c605f3585193c8",
    },
    {
      path: "Lib/site-packages/diffq/base.py",
      bytes: 12418,
      sha256:
        "b9065d7573ae8256dc081d0d010e47ef756981cbff2c72f8b129a1f2fbe32ee1",
    },
    {
      path: "Lib/site-packages/diffq/bitpack.cp312-win_amd64.pyd",
      bytes: 168960,
      sha256:
        "ba08a37412fcd4d9ffdc8741133dc107e7ca69241f9d86f2431da280371dc71b",
    },
    {
      path: "Lib/site-packages/diffq/diffq.py",
      bytes: 13818,
      sha256:
        "c76bcf116118b1fe8a8db60dba708313f5a54adcbb4aa9b1208d7a4e6725b72d",
    },
    {
      path: "Lib/site-packages/diffq/lsq.py",
      bytes: 7010,
      sha256:
        "6ebe316ceca74395283cd1ce80f9685b8029f9fdbb51d7d219af0ddedd494b8a",
    },
    {
      path: "Lib/site-packages/diffq/torch_pack.py",
      bytes: 3083,
      sha256:
        "a54e6faec4dd40c4bfffc1bee620bcb27c0e0fedde3f5b703d3f2b145232d9df",
    },
    {
      path: "Lib/site-packages/diffq/ts_export.py",
      bytes: 7891,
      sha256:
        "8032999a73b38b5a03523505c52eaae18e3c3770ee921beb764933fa41a6df61",
    },
    {
      path: "Lib/site-packages/diffq/uniform.py",
      bytes: 4880,
      sha256:
        "226ab7e251b5acef47a9bc8dcf987562378697cc294da4d521345cb0e4d624da",
    },
    {
      path: "Lib/site-packages/diffq/utils.py",
      bytes: 1794,
      sha256:
        "30410b4a4c547d436622cd6b220b6bb481c1c28985c4d4254040f74f2f854e8b",
    },
    {
      path: "Lib/site-packages/diffq_fixed-0.2.4.dist-info/INSTALLER",
      bytes: 4,
      sha256:
        "ceebae7b8927a3227e5303cf5e0f1f7b34bb542ad7250ac03fbcde36ec2f1508",
    },
    {
      path: "Lib/site-packages/diffq_fixed-0.2.4.dist-info/LICENSE",
      bytes: 19730,
      sha256:
        "37fa438dc96479af8ca1fb651bdc927bb8299a3dbcecba82226d2bed923c663f",
    },
    {
      path: "Lib/site-packages/diffq_fixed-0.2.4.dist-info/METADATA",
      bytes: 8815,
      sha256:
        "1cafc3c8181966dee6ad7c90a16b0bf77b635d33f5ab27ee2cc7cefe1be339d3",
    },
    {
      path: "Lib/site-packages/diffq_fixed-0.2.4.dist-info/RECORD",
      bytes: 1633,
      sha256:
        "98a2713e6ad6fe4c8f514f0634c9245d52779384e4160e9fb85cf230d5024e95",
    },
    {
      path: "Lib/site-packages/diffq_fixed-0.2.4.dist-info/REQUESTED",
      bytes: 0,
      sha256:
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    },
    {
      path: "Lib/site-packages/diffq_fixed-0.2.4.dist-info/WHEEL",
      bytes: 101,
      sha256:
        "6e41538106e557656ec1a5ff73a4add709782a36cde405bf89fdd341f4347e12",
    },
    {
      path: "Lib/site-packages/diffq_fixed-0.2.4.dist-info/top_level.txt",
      bytes: 6,
      sha256:
        "50b1a8a5d57e51e91a651b57691aa594fa216bc38f8dfc694f4e30f5d30027d7",
    },
  ].map((row) => Object.freeze(row)),
);
export const STORE_MDX_RETAINED_SOURCE_PINS = Object.freeze(
  [
    {
      path: "Lib/site-packages/audio_separator-0.47.0.dist-info/METADATA",
      bytes: 53030,
      sha256:
        "f89f3734829ccbce2d8f0e108f00377145133e999739a94c0b767f15ec25cfb1",
    },
    {
      path: "Lib/site-packages/audio_separator/separator/__init__.py",
      bytes: 213,
      sha256:
        "ef93f24a3a5ec93c70216b3479a501d8319c668a498a2132dd5ff07ad3d2f414",
    },
    {
      path: "Lib/site-packages/audio_separator/separator/architectures/__init__.py",
      bytes: 0,
      sha256:
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    },
    {
      path: "Lib/site-packages/audio_separator/separator/architectures/demucs_separator.py",
      bytes: 11242,
      sha256:
        "7f1a06c9827e4e09389c90060711619c86ae9405e4c84ef32f917a8f5d6286bc",
    },
    {
      path: "Lib/site-packages/audio_separator/separator/architectures/mdx_separator.py",
      bytes: 24823,
      sha256:
        "f1a647d5d94f938ff673739bba4adf6da86eedb89ae4b7aa736bbf9340fa9013",
    },
    {
      path: "Lib/site-packages/audio_separator/separator/common_separator.py",
      bytes: 28298,
      sha256:
        "9a175e9bb1978bb7e6e22b329cfa1cb29fec09c45b6adee2c65096703673d32c",
    },
    {
      path: "Lib/site-packages/audio_separator/separator/ensembler.py",
      bytes: 7221,
      sha256:
        "86793a52c8a19cd1cd534d8898e8ce0fa4f1a52c3d7b29a668cc92d3b4136663",
    },
    {
      path: "Lib/site-packages/audio_separator/separator/separator.py",
      bytes: 80964,
      sha256:
        "43c0b2c84ccc8106e5b74c71a21fc559fb2d12cf5e5f3d917e3bdb39c1054c78",
    },
    {
      path: "Lib/site-packages/audio_separator/separator/uvr_lib_v5/__init__.py",
      bytes: 0,
      sha256:
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    },
    {
      path: "Lib/site-packages/audio_separator/separator/uvr_lib_v5/demucs/pretrained.py",
      bytes: 5554,
      sha256:
        "7f8d57b95786067f1f39bb5f92f85ea4d0ba507c21a8e433674087822f4ed02a",
    },
    {
      path: "Lib/site-packages/audio_separator/separator/uvr_lib_v5/demucs/states.py",
      bytes: 3963,
      sha256:
        "44dc35143f5e64d33ea3ca29caeac19819d72fd4c5b89148a0d32a29862f2f81",
    },
    {
      path: "Lib/site-packages/audio_separator/separator/uvr_lib_v5/demucs/utils.py",
      bytes: 16401,
      sha256:
        "a991ed8cbd659e01a88bdde76136a3ee238dc21b832c915e29f252fabaf6feb8",
    },
    {
      path: "Lib/site-packages/audio_separator/separator/uvr_lib_v5/spec_utils.py",
      bytes: 46754,
      sha256:
        "2c0ceb5062166c85d639a739f5707f783faba40d1641bd156f48a716608b63b6",
    },
    {
      path: "Lib/site-packages/audio_separator/separator/uvr_lib_v5/stft.py",
      bytes: 6194,
      sha256:
        "98eb04e41a204935de31e731f464e2379b194a6a8b3f98a61fa01a773d17222e",
    },
  ].map((row) => Object.freeze(row)),
);
export const STORE_SAMPLERATE_BINDING = Object.freeze({
  path: "Lib/site-packages/samplerate/lowlevel.py",
  bytes: 7786,
  sha256: "417fe80fb6e0543bf426e6f6bbcf798e6ebbdab218a02c1ce2fc5240d065fa05",
});
export const STORE_SAMPLERATE_LIBRARY = Object.freeze({
  path: "Lib/site-packages/samplerate/_samplerate_data/libsamplerate-64bit.dll",
  bytes: 1496576,
  sha256: "850ea5aeb4cb7be7134b8d1f97d343f93d857d6dc8d7ef7f3a34460952f54719",
});
const execute = promisify(execFile),
  hash = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
/** Builder-only byte read fenced by the existing held hash primitive. Keep
 * this leaf independent of GUI/Electron packaging modules. */
async function packageFile(path: string, maximum: number) {
  const before = await hashStoreFile(path);
  if (before.bytes > maximum) invalid();
  const bytes = await readFile(path);
  if (
    bytes.length !== before.bytes ||
    hash(bytes) !== before.sha256 ||
    !same(before, await hashStoreFile(path))
  )
    invalid("STORE_PYTHON_SOURCE_CHANGED");
  return bytes;
}
function invalid(code = "STORE_PYTHON_PROJECTION_INVALID"): never {
  throw Error(code);
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
  const out: Record<string, unknown> = Object.create(null);
  for (const key of fields) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d?.enumerable || !("value" in d)) invalid();
    out[key] = d.value;
  }
  return out;
}
/** A named architecture-dependent auxiliary may be excluded only when all of
 * its fixed observed bytes and PE fields match. Unknown leaves remain audited. */
export function assertStorePythonOmission(input: unknown) {
  const value = record(input, [
    "path",
    "bytes",
    "sha256",
    "machine",
    "optionalMagic",
  ]);
  const known = STORE_PYTHON_OMISSIONS.find((row) => row.path === value.path);
  if (
    !known ||
    known.bytes !== value.bytes ||
    known.sha256 !== value.sha256 ||
    known.machine !== value.machine ||
    known.optionalMagic !== value.optionalMagic
  )
    invalid();
  return known;
}
export function assertStoreMdxUnusedDependencyOmission(input: unknown) {
  const value = record(input, ["path", "bytes", "sha256"]),
    known = STORE_MDX_UNUSED_DEPENDENCY_OMISSIONS.find(
      (row) => row.path === value.path,
    );
  if (!known || known.bytes !== value.bytes || known.sha256 !== value.sha256)
    invalid();
  return known;
}
async function directory(path: string) {
  if (
    !isAbsolute(path) ||
    resolve(path) !== path ||
    path === dirname(path) ||
    (await realpath(path)) !== path
  )
    invalid();
  for (let p = path; ; p = dirname(p)) {
    const s = await lstat(p);
    if (!s.isDirectory() || s.isSymbolicLink()) invalid();
    if (p === dirname(p)) break;
  }
}
async function rows(root: string, filter = false) {
  await directory(root);
  const out: StoreInventoryEntry[] = [],
    seen = new Set<string>();
  async function visit(path: string, depth = 0) {
    if (depth > 32 || seen.size > 65536) invalid();
    for (const name of (await readdir(path)).sort()) {
      const p = join(path, name),
        key = safeStoreRelativePath(relative(root, p).split(sep).join("/")),
        s = await lstat(p);
      if (seen.has(key.toLowerCase()) || s.isSymbolicLink()) invalid();
      seen.add(key.toLowerCase());
      if (filter && !shouldCopyReleaseTreeEntry(root, p)) continue;
      if (s.isDirectory()) await visit(p, depth + 1);
      else if (s.isFile() && s.nlink === 1)
        out.push({ path: key, ...(await hashStoreFile(p)) });
      else invalid();
    }
  }
  await visit(root);
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
function same(
  a: Pick<StoreInventoryEntry, "bytes" | "sha256">,
  b: Pick<StoreInventoryEntry, "bytes" | "sha256">,
) {
  return a.bytes === b.bytes && a.sha256 === b.sha256;
}
async function exactLeaf(root: string, pin: StoreInventoryEntry) {
  if (!same(await hashStoreFile(join(root, ...pin.path.split("/"))), pin))
    invalid("STORE_PYTHON_SOURCE_CHANGED");
}
export async function verifyStoreMdxRetainedPythonSources(root: string) {
  for (const pin of STORE_MDX_RETAINED_SOURCE_PINS) await exactLeaf(root, pin);
}
const SAMPLERATE_PROBE = String.raw`
import sys,json,platform,hashlib,importlib.metadata as metadata
from pathlib import Path
import numpy as np
import samplerate
from samplerate import lowlevel
root=Path(sys.prefix).resolve()
binding=root/'Lib/site-packages/samplerate/lowlevel.py'
expected=root/'Lib/site-packages/samplerate/_samplerate_data/libsamplerate-64bit.dll'
actual=Path(lowlevel.lib_filename).resolve()
assert platform.python_version()=='3.12.10' and platform.architecture()[0]=='64bit'
assert metadata.version('samplerate')=='0.1.0' and actual==expected.resolve()
assert hashlib.sha256(binding.read_bytes()).hexdigest()=='417fe80fb6e0543bf426e6f6bbcf798e6ebbdab218a02c1ce2fc5240d065fa05'
assert hashlib.sha256(actual.read_bytes()).hexdigest()=='850ea5aeb4cb7be7134b8d1f97d343f93d857d6dc8d7ef7f3a34460952f54719'
input=np.sin(np.arange(128,dtype=np.float32)*np.float32(0.2))
output=samplerate.resample(input,2.0,converter_type='sinc_best')
assert output.shape==(256,) and np.isfinite(output).all() and np.max(np.abs(output))>0.5
packages={}
for d in metadata.distributions():
    name=d.metadata['Name'].lower().replace('_','-')
    assert name not in packages, 'Duplicate Python distribution metadata'
    assert Path(d.locate_file('')).resolve().is_relative_to(root), 'Package metadata escapes private runtime'
    packages[name]=d.version
print(json.dumps({'python':platform.python_version(),'architecture':'x64','samplerate':metadata.version('samplerate'),'chosenLibrary':str(actual),'chosenLibrarySha256':hashlib.sha256(actual.read_bytes()).hexdigest(),'bindingSha256':hashlib.sha256(binding.read_bytes()).hexdigest(),'inputSamples':128,'outputSamples':int(output.size),'finiteOutput':True,'packages':packages}))
`;
/** A real import/function probe of the exact retained DLL. Synthetic signal
 * bytes stay in memory; no user media, model, network or recipe is involved. */
export async function probeStoreSamplerate(
  root: string,
  data: string,
  requirements: Uint8Array,
  profile?: typeof STORE_KIM_MDX_PYTHON_PROFILE,
) {
  if (process.platform !== "win32" || process.arch !== "x64")
    invalid("STORE_WORKER_WINDOWS_REQUIRED");
  await directory(root);
  await directory(dirname(data));
  await mkdir(data);
  await exactLeaf(root, STORE_SAMPLERATE_BINDING);
  await exactLeaf(root, STORE_SAMPLERATE_LIBRARY);
  await auditWindowsX64Binary(
    join(root, ...STORE_SAMPLERATE_LIBRARY.path.split("/")),
  );
  const python = join(root, "python.exe"),
    before = await hashStoreFile(python);
  await auditWindowsX64Binary(python);
  if (
    before.sha256 !==
    "4d6f5f81a4bca11191c4c7c6b43632694d0a4ce74e068619d8fdc161d469859a"
  )
    invalid();
  let result;
  try {
    result = await execute(
      python,
      ["-I", "-B", "-c", SAMPLERATE_PROBE, profile ?? "full-source"],
      {
        cwd: data,
        env: windowsConsumerProbeEnvironment(process.env, data),
        shell: false,
        windowsHide: true,
        timeout: 30000,
        maxBuffer: 65536,
      },
    );
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    await writeFile(join(data, "failed.stdout.log"), String(e.stdout ?? ""), {
      flag: "wx",
    });
    await writeFile(join(data, "failed.stderr.log"), String(e.stderr ?? ""), {
      flag: "wx",
    });
    invalid("STORE_SAMPLERATE_PROBE_FAILED");
  }
  await writeFile(join(data, "probe.stdout.json"), result.stdout, {
    flag: "wx",
  });
  await writeFile(join(data, "probe.stderr.log"), result.stderr, {
    flag: "wx",
  });
  if (result.stderr.trim() || !same(before, await hashStoreFile(python)))
    invalid();
  const parsed = parseStoreBuildDocument(
      Buffer.from(result.stdout),
      65536,
    ) as Record<string, unknown>,
    expected = windowsConsumerPackagesForProfile(
      new TextDecoder("utf-8", { fatal: true }).decode(requirements),
      profile,
    );
  if (
    !parsed ||
    Array.isArray(parsed) ||
    Object.keys(parsed).sort().join() !==
      "architecture,bindingSha256,chosenLibrary,chosenLibrarySha256,finiteOutput,inputSamples,outputSamples,packages,python,samplerate" ||
    parsed.python !== WINDOWS_CONSUMER_PINS.python ||
    parsed.architecture !== "x64" ||
    parsed.samplerate !== "0.1.0" ||
    parsed.chosenLibrary !==
      join(root, ...STORE_SAMPLERATE_LIBRARY.path.split("/")) ||
    parsed.chosenLibrarySha256 !== STORE_SAMPLERATE_LIBRARY.sha256 ||
    parsed.bindingSha256 !== STORE_SAMPLERATE_BINDING.sha256 ||
    parsed.inputSamples !== 128 ||
    parsed.outputSamples !== 256 ||
    parsed.finiteOutput !== true ||
    !parsed.packages ||
    Array.isArray(parsed.packages) ||
    typeof parsed.packages !== "object"
  )
    invalid();
  const packages = parsed.packages as Record<string, unknown>;
  if (
    Object.keys(packages).length !== Object.keys(expected).length ||
    Object.entries(expected).some(([k, v]) => packages[k] !== v)
  )
    invalid();
  await exactLeaf(root, STORE_SAMPLERATE_BINDING);
  await exactLeaf(root, STORE_SAMPLERATE_LIBRARY);
  return Object.freeze(parsed);
}
/** Create a new explicit input projection; never remove from or rewrite the
 * source runtime. Legacy tree filters and all default consumer probes remain. */
export async function createStorePythonProjection(
  source: string,
  output: string,
  work: string,
  requirements: Uint8Array,
) {
  if (process.platform !== "win32" || process.arch !== "x64")
    invalid("STORE_WORKER_WINDOWS_REQUIRED");
  await directory(source);
  await directory(dirname(output));
  await directory(dirname(work));
  const inside = (a: string, b: string) =>
    a.toLowerCase() === b.toLowerCase() ||
    b.toLowerCase().startsWith(a.toLowerCase() + sep);
  if (
    inside(source, output) ||
    inside(output, source) ||
    inside(work, output) ||
    inside(output, work) ||
    inside(source, work) ||
    inside(work, source)
  )
    invalid();
  for (const path of [output, work]) {
    if (
      !isAbsolute(path) ||
      resolve(path) !== path ||
      path === dirname(path) ||
      /[\p{Cc}\p{Cf};"$<>|*?]/u.test(path)
    )
      invalid();
    try {
      await lstat(path);
      invalid("STORE_PYTHON_OUTPUT_EXISTS");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  await mkdir(work);
  await mkdir(output);
  const before = await rows(source, true);
  windowsConsumerPackagesForProfile(
    new TextDecoder("utf-8", { fatal: true }).decode(requirements),
    STORE_KIM_MDX_PYTHON_PROFILE,
  );
  for (const pin of [
    ...STORE_MDX_UNUSED_DEPENDENCY_OMISSIONS,
    ...STORE_MDX_RETAINED_SOURCE_PINS,
  ])
    await exactLeaf(source, pin);
  for (const row of before)
    if (/^Lib\/site-packages\/diffq(?:[./_-]|$)/iu.test(row.path))
      assertStoreMdxUnusedDependencyOmission(row);
  await exactLeaf(source, STORE_SAMPLERATE_BINDING);
  await exactLeaf(source, STORE_SAMPLERATE_LIBRARY);
  for (const omitted of STORE_PYTHON_OMISSIONS) {
    const pin = before.find((row) => row.path === omitted.path);
    if (!pin) invalid();
    await exactLeaf(source, omitted);
    const b = await packageFile(
        join(source, ...omitted.path.split("/")),
        2 * 1024 ** 2,
      ),
      off = b.readUInt32LE(0x3c);
    if (
      b.toString("ascii", 0, 2) !== "MZ" ||
      off < 64 ||
      off > 1024 ** 2 ||
      off + 26 > b.length ||
      b.toString("binary", off, off + 4) !== "PE\0\0"
    )
      invalid();
    assertStorePythonOmission({
      ...pin,
      machine: b.readUInt16LE(off + 4),
      optionalMagic: b.readUInt16LE(off + 24),
    });
  }
  const sourceProbe = await probeStoreSamplerate(
      source,
      join(work, "source-probe"),
      requirements,
    ),
    omitted = new Set(
      [...STORE_PYTHON_OMISSIONS, ...STORE_MDX_UNUSED_DEPENDENCY_OMISSIONS].map(
        (row) => row.path,
      ),
    ),
    selected = before.filter((row) => !omitted.has(row.path));
  for (const row of selected) {
    const p = join(source, ...row.path.split("/"));
    await exactLeaf(source, row);
    if (/\.(?:exe|dll|pyd|node)$/iu.test(row.path))
      await auditWindowsX64Binary(p);
    const dest = join(output, ...row.path.split("/"));
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(p, dest, constants.COPYFILE_EXCL);
    if (!same(await hashStoreFile(dest), row))
      invalid("STORE_PYTHON_COPY_CHANGED");
  }
  const outputProbe = await probeStoreSamplerate(
      output,
      join(work, "projection-probe"),
      requirements,
      STORE_KIM_MDX_PYTHON_PROFILE,
    ),
    actual = await rows(output);
  if (
    JSON.stringify(actual) !== JSON.stringify(selected) ||
    JSON.stringify(await rows(source, true)) !== JSON.stringify(before)
  )
    invalid("STORE_PYTHON_CENSUS_CHANGED");
  const census = Buffer.from(JSON.stringify(actual) + "\n");
  const sourceCensus = Buffer.from(JSON.stringify(before) + "\n");
  parseStorePythonProjectionCensuses(sourceCensus, census);
  await writeFile(join(work, "python-source-census.json"), sourceCensus, {
    flag: "wx",
  });
  await writeFile(join(work, "python-projection-census.json"), census, {
    flag: "wx",
  });
  const receipt = {
    version: 2,
    purpose: "store-only-x64-python-projection",
    pythonDistributionProfile: STORE_KIM_MDX_PYTHON_PROFILE,
    pythonDependencyClosure: "product-specific-not-full-upstream",
    sourceRoot: source,
    outputRoot: output,
    sourceSelectedFiles: before.length,
    omissions: STORE_PYTHON_OMISSIONS,
    unusedDependencyOmissions: STORE_MDX_UNUSED_DEPENDENCY_OMISSIONS,
    retainedSourcePins: STORE_MDX_RETAINED_SOURCE_PINS,
    outputFiles: actual.length,
    outputCensus: {
      file: "python-projection-census.json",
      bytes: census.length,
      sha256: hash(census),
    },
    sourceCensus: {
      file: "python-source-census.json",
      bytes: sourceCensus.length,
      sha256: hash(sourceCensus),
    },
    requirementsLockSha256: hash(requirements),
    sourceSamplerateProbe: sourceProbe,
    projectionSamplerateProbe: outputProbe,
    defaultConsumerDmlProbesRequired: true,
    legacyCorePreserved: true,
    consumerReady: false,
    storeExecutionQualified: false,
    licenseApproval: "pending",
  };
  await writeFile(
    join(work, "python-projection-receipt.json"),
    JSON.stringify(receipt, null, 2) + "\n",
    { flag: "wx" },
  );
  return Object.freeze({ output, work, receipt });
}
function census(bytes: Uint8Array) {
  const value = parseStoreBuildDocument(bytes);
  if (!Array.isArray(value) || value.length < 1 || value.length > 30000)
    invalid();
  const seen = new Set<string>();
  let previous = "",
    total = 0;
  return value.map((v) => {
    const r = record(v, ["path", "bytes", "sha256"]),
      path = safeStoreRelativePath(r.path);
    if (
      path <= previous ||
      seen.has(path.toLowerCase()) ||
      !Number.isSafeInteger(r.bytes) ||
      (r.bytes as number) < 0 ||
      (r.bytes as number) > 4 * 1024 ** 3 ||
      typeof r.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(r.sha256) ||
      (r.bytes === 0 &&
        (r.sha256 !==
          "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" ||
          /\.(?:exe|dll|pyd|node)$/iu.test(path)))
    )
      invalid();
    previous = path;
    seen.add(path.toLowerCase());
    total += r.bytes as number;
    if (total > 8 * 1024 ** 3) invalid();
    return Object.freeze({ path, bytes: r.bytes as number, sha256: r.sha256 });
  });
}
/** Complete source minus the finite approved omissions must be exactly the
 * current product census. No path-prefix deletion or mutable allowlist applies. */
export function parseStorePythonProjectionCensuses(
  sourceBytes: Uint8Array,
  outputBytes: Uint8Array,
  profile:
    | typeof STORE_KIM_MDX_PYTHON_PROFILE
    | "legacy-full-source" = STORE_KIM_MDX_PYTHON_PROFILE,
) {
  const source = census(sourceBytes),
    output = census(outputBytes),
    omissions = [
      ...STORE_PYTHON_OMISSIONS,
      ...(profile === STORE_KIM_MDX_PYTHON_PROFILE
        ? STORE_MDX_UNUSED_DEPENDENCY_OMISSIONS
        : []),
    ],
    omitted = new Set(omissions.map((row) => row.path));
  if (
    profile !== STORE_KIM_MDX_PYTHON_PROFILE &&
    profile !== "legacy-full-source"
  )
    invalid();
  for (const known of omissions) {
    const actual = source.find((row) => row.path === known.path);
    if (!actual || !same(actual, known)) invalid();
  }
  for (const row of profile === STORE_KIM_MDX_PYTHON_PROFILE ? source : [])
    if (/^Lib\/site-packages\/diffq(?:[./_-]|$)/iu.test(row.path))
      assertStoreMdxUnusedDependencyOmission(row);
  if (
    JSON.stringify(source.filter((row) => !omitted.has(row.path))) !==
    JSON.stringify(output)
  )
    invalid("STORE_PYTHON_CENSUS_CHANGED");
  for (const known of profile === STORE_KIM_MDX_PYTHON_PROFILE
    ? STORE_MDX_RETAINED_SOURCE_PINS
    : []) {
    const actual = output.find((row) => row.path === known.path);
    if (!actual || !same(actual, known)) invalid("STORE_PYTHON_SOURCE_CHANGED");
  }
  return Object.freeze({ source, output });
}
function censusPin(value: unknown, file: string) {
  const r = record(value, ["file", "bytes", "sha256"]);
  if (
    r.file !== file ||
    !Number.isSafeInteger(r.bytes) ||
    (r.bytes as number) < 1 ||
    (r.bytes as number) > 8 * 1024 ** 2 ||
    typeof r.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(r.sha256)
  )
    invalid();
  return Object.freeze({ file, bytes: r.bytes as number, sha256: r.sha256 });
}
function probeRecord(
  value: unknown,
  root: string,
  requirements: Uint8Array,
  profile?: typeof STORE_KIM_MDX_PYTHON_PROFILE,
) {
  const r = record(value, [
      "python",
      "architecture",
      "samplerate",
      "chosenLibrary",
      "chosenLibrarySha256",
      "bindingSha256",
      "inputSamples",
      "outputSamples",
      "finiteOutput",
      "packages",
    ]),
    expected = windowsConsumerPackagesForProfile(
      new TextDecoder("utf-8", { fatal: true }).decode(requirements),
      profile,
    );
  const packages = record(r.packages, Object.keys(expected));
  if (
    Object.entries(expected).some(([k, v]) => packages[k] !== v) ||
    r.python !== WINDOWS_CONSUMER_PINS.python ||
    r.architecture !== "x64" ||
    r.samplerate !== "0.1.0" ||
    r.chosenLibrary !==
      join(root, ...STORE_SAMPLERATE_LIBRARY.path.split("/")) ||
    r.chosenLibrarySha256 !== STORE_SAMPLERATE_LIBRARY.sha256 ||
    r.bindingSha256 !== STORE_SAMPLERATE_BINDING.sha256 ||
    r.inputSamples !== 128 ||
    r.outputSamples !== 256 ||
    r.finiteOutput !== true
  )
    invalid();
  return Object.freeze({ ...r, packages: Object.freeze(packages) });
}
export function parseStorePythonProjectionReceipt(
  bytes: Uint8Array,
  root: string,
  requirements: Uint8Array,
) {
  const parsed = parseStoreBuildDocument(bytes, 65536),
    legacy =
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      Object.getOwnPropertyDescriptor(parsed, "version")?.value === 1;
  const r = record(parsed, [
    "version",
    "purpose",
    ...(legacy ? [] : ["pythonDistributionProfile", "pythonDependencyClosure"]),
    "sourceRoot",
    "outputRoot",
    "sourceSelectedFiles",
    "omissions",
    ...(legacy ? [] : ["unusedDependencyOmissions", "retainedSourcePins"]),
    "outputFiles",
    "outputCensus",
    "sourceCensus",
    "requirementsLockSha256",
    "sourceSamplerateProbe",
    "projectionSamplerateProbe",
    "defaultConsumerDmlProbesRequired",
    "legacyCorePreserved",
    "consumerReady",
    "storeExecutionQualified",
    "licenseApproval",
  ]);
  if (
    r.version !== (legacy ? 1 : 2) ||
    r.purpose !== "store-only-x64-python-projection" ||
    (!legacy &&
      (r.pythonDistributionProfile !== STORE_KIM_MDX_PYTHON_PROFILE ||
        r.pythonDependencyClosure !== "product-specific-not-full-upstream")) ||
    typeof r.sourceRoot !== "string" ||
    !isAbsolute(r.sourceRoot) ||
    resolve(r.sourceRoot) !== r.sourceRoot ||
    r.sourceRoot === root ||
    r.outputRoot !== root ||
    r.requirementsLockSha256 !== hash(requirements) ||
    !Number.isSafeInteger(r.sourceSelectedFiles) ||
    !Number.isSafeInteger(r.outputFiles) ||
    (r.outputFiles as number) < 1 ||
    (r.sourceSelectedFiles as number) !==
      (r.outputFiles as number) +
        STORE_PYTHON_OMISSIONS.length +
        (legacy ? 0 : STORE_MDX_UNUSED_DEPENDENCY_OMISSIONS.length) ||
    (r.sourceSelectedFiles as number) > 30000 ||
    r.defaultConsumerDmlProbesRequired !== true ||
    r.legacyCorePreserved !== true ||
    r.consumerReady !== false ||
    r.storeExecutionQualified !== false ||
    r.licenseApproval !== "pending" ||
    !Array.isArray(r.omissions) ||
    r.omissions.length !== STORE_PYTHON_OMISSIONS.length
  )
    invalid();
  for (const [index, v] of r.omissions.entries()) {
    const row = record(v, [
        "path",
        "bytes",
        "sha256",
        "machine",
        "optionalMagic",
        "reason",
      ]),
      known = STORE_PYTHON_OMISSIONS[index]!;
    if (Object.entries(known).some(([k, v]) => row[k] !== v)) invalid();
  }
  for (const [actual, known] of legacy
    ? []
    : ([
        [r.unusedDependencyOmissions, STORE_MDX_UNUSED_DEPENDENCY_OMISSIONS],
        [r.retainedSourcePins, STORE_MDX_RETAINED_SOURCE_PINS],
      ] as const)) {
    if (!Array.isArray(actual) || actual.length !== known.length) invalid();
    for (const [index, item] of actual.entries()) {
      const row = record(item, ["path", "bytes", "sha256"]),
        pin = known[index]!;
      if (Object.entries(pin).some(([key, value]) => row[key] !== value))
        invalid();
    }
  }
  return Object.freeze({
    pythonDistributionProfile: legacy
      ? undefined
      : STORE_KIM_MDX_PYTHON_PROFILE,
    pythonDependencyClosure: legacy
      ? "full-source-distribution-census"
      : "product-specific-not-full-upstream",
    sourceRoot: r.sourceRoot,
    sourceSelectedFiles: r.sourceSelectedFiles as number,
    outputFiles: r.outputFiles as number,
    sourceCensus: censusPin(r.sourceCensus, "python-source-census.json"),
    outputCensus: censusPin(r.outputCensus, "python-projection-census.json"),
    sourceSamplerateProbe: probeRecord(
      r.sourceSamplerateProbe,
      r.sourceRoot,
      requirements,
    ),
    projectionSamplerateProbe: probeRecord(
      r.projectionSamplerateProbe,
      root,
      requirements,
      legacy ? undefined : STORE_KIM_MDX_PYTHON_PROFILE,
    ),
  });
}
/** Receiving a prior functional receipt is not sufficient: re-read its held
 * censuses and every current projected/source leaf before using the input. */
export async function verifyStorePythonProjection(
  root: string,
  work: string,
  receiptBytes: Uint8Array,
  requirements: Uint8Array,
) {
  const receipt = parseStorePythonProjectionReceipt(
    receiptBytes,
    root,
    requirements,
  );
  await directory(root);
  await directory(work);
  await directory(receipt.sourceRoot);
  async function load(pin: { file: string; bytes: number; sha256: string }) {
    const path = join(work, pin.file),
      before = await hashStoreFile(path),
      b = await packageFile(path, 8 * 1024 ** 2);
    if (
      !same(before, pin) ||
      b.length !== pin.bytes ||
      hash(b) !== pin.sha256 ||
      !same(before, await hashStoreFile(path))
    )
      invalid();
    return b;
  }
  const { source, output } = parseStorePythonProjectionCensuses(
    await load(receipt.sourceCensus),
    await load(receipt.outputCensus),
    receipt.pythonDistributionProfile ?? "legacy-full-source",
  );
  if (
    source.length !== receipt.sourceSelectedFiles ||
    output.length !== receipt.outputFiles ||
    JSON.stringify(await rows(root)) !== JSON.stringify(output) ||
    JSON.stringify(await rows(receipt.sourceRoot, true)) !==
      JSON.stringify(source)
  )
    invalid("STORE_PYTHON_CENSUS_CHANGED");
  for (const pin of [STORE_SAMPLERATE_BINDING, STORE_SAMPLERATE_LIBRARY])
    await exactLeaf(root, pin);
  return Object.freeze({
    pythonDistributionProfile: receipt.pythonDistributionProfile,
    pythonDependencyClosure: receipt.pythonDependencyClosure,
    sourceDistributionCount: Object.keys(receipt.sourceSamplerateProbe.packages)
      .length,
    productDistributionCount: Object.keys(
      receipt.projectionSamplerateProbe.packages,
    ).length,
    omittedDependencyFiles:
      receipt.pythonDistributionProfile === STORE_KIM_MDX_PYTHON_PROFILE
        ? STORE_MDX_UNUSED_DEPENDENCY_OMISSIONS.length
        : 0,
    projectionFiles: output.length,
    bindingSha256: STORE_SAMPLERATE_BINDING.sha256,
    chosenLibrarySha256: STORE_SAMPLERATE_LIBRARY.sha256,
    defaultConsumerDmlProbesRequired: true,
    storeExecutionQualified: false,
  });
}
