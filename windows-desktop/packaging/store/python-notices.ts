import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { hashStoreFile, type StoreInventoryEntry } from "./inventory.js";
import {
  STORE_SAMPLERATE_BINDING,
  STORE_SAMPLERATE_LIBRARY,
} from "./python-projection.js";

/** Verbatim upstream text, recovered against the original qualified Windows
 * census. These are data assets, never a wheel install or metadata rewrite. */
export const STORE_PYTHON_NOTICE_ASSETS = Object.freeze(
  [
    {
      component: "Cython",
      version: "3.3.0",
      path: "runtime/licenses/cython/COPYING.txt",
      sourcePath: "packaging/notices/python/cython/COPYING.txt",
      bytes: 756,
      sha256:
        "e1eb1c49a8508e8173dac30157e4a6439a44ad8846194746c424fbc3fc2b95d7",
      source: {
        url: "https://files.pythonhosted.org/packages/a9/d8/4981ef716ad0e3ff0d3ef383aefc6b03c4a88dee33b272bf8e0d833001ca/cython-3.3.0.tar.gz",
        archiveBytes: 3727515,
        archiveSha256:
          "eed0d93fbca7087f143b42c34b05a825849bdf17f101572c2105acfa49aa88b8",
        archiveMember: "cython-3.3.0/COPYING.txt",
      },
    },
    {
      component: "Cython",
      version: "3.3.0",
      path: "runtime/licenses/cython/LICENSE.txt",
      sourcePath: "packaging/notices/python/cython/LICENSE.txt",
      bytes: 10174,
      sha256:
        "9568a2b155e66ac3e0ba1fd80b52b827b9460e6cf6f233125e7cbca8e206ddc3",
      source: {
        url: "https://files.pythonhosted.org/packages/a9/d8/4981ef716ad0e3ff0d3ef383aefc6b03c4a88dee33b272bf8e0d833001ca/cython-3.3.0.tar.gz",
        archiveBytes: 3727515,
        archiveSha256:
          "eed0d93fbca7087f143b42c34b05a825849bdf17f101572c2105acfa49aa88b8",
        archiveMember: "cython-3.3.0/LICENSE.txt",
      },
    },
    {
      component: "samplerate",
      version: "0.1.0",
      path: "runtime/licenses/samplerate/LICENSE.rst",
      sourcePath: "packaging/notices/python/samplerate/LICENSE.rst",
      bytes: 1099,
      sha256:
        "32497d59054696f50430bcf8490250028487784c963c6d6b88e1389eab2650cb",
      source: {
        url: "https://files.pythonhosted.org/packages/da/9c/6a13fbc59b1ceaef194a53d3aeafa983057133fb13660c423854184eafa7/samplerate-0.1.0.tar.gz",
        archiveBytes: 4044998,
        archiveSha256:
          "75ef725e6cd9c4545569caf4c47147beab7b53b2c36e5122e8c285d348f88847",
        archiveMember: "samplerate-0.1.0/LICENSE.rst",
      },
    },
    {
      component: "flatbuffers",
      version: "25.12.19",
      path: "runtime/licenses/flatbuffers/LICENSE",
      sourcePath: "packaging/notices/python/flatbuffers/LICENSE",
      bytes: 11358,
      sha256:
        "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30",
      source: {
        url: "https://raw.githubusercontent.com/google/flatbuffers/v25.12.19/LICENSE",
      },
    },
    {
      component: "libsamplerate",
      version: "0.1.9",
      path: "runtime/licenses/libsamplerate/COPYING",
      sourcePath: "packaging/notices/python/libsamplerate/COPYING",
      bytes: 1334,
      sha256:
        "2c1f76ce2effdddb425018405d5690c0b1ab4e6976e35296b0a6db65c5e1a55d",
      source: {
        url: "https://raw.githubusercontent.com/libsndfile/libsamplerate/0.1.9/COPYING",
      },
    },
  ].map((row) => Object.freeze({ ...row, source: Object.freeze(row.source) })),
);
export const STORE_PYTHON_NOTICE_METADATA = Object.freeze(
  [
    {
      component: "Cython",
      version: "3.3.0",
      path: "runtime/python/Lib/site-packages/cython-3.3.0.dist-info/METADATA",
      bytes: 28958,
      sha256:
        "a24705e708476ddea0fe4a8ce063210600a8dc7fc3afe7e4d2a0ea301e0fde4f",
      wheel: {
        url: "https://files.pythonhosted.org/packages/f4/9b/cd724d91c500116769bdb853450a2197ba3d640dbbe3b02fc54ebdfdbd1b/cython-3.3.0-cp312-cp312-win_amd64.whl",
        bytes: 2872123,
        sha256:
          "333449cc0350baedee5a6af27929eac8a71eac4ec59333c45ff476b33c6c660d",
      },
    },
    {
      component: "flatbuffers",
      version: "25.12.19",
      path: "runtime/python/Lib/site-packages/flatbuffers-25.12.19.dist-info/METADATA",
      bytes: 1004,
      sha256:
        "9f38239f96faa21522a6aadab6912e1e560708bbe9c9f696a0679c9403fa089e",
      wheel: {
        url: "https://files.pythonhosted.org/packages/e8/2d/d2a548598be01649e2d46231d151a6c56d10b964d94043a335ae56ea2d92/flatbuffers-25.12.19-py2.py3-none-any.whl",
        bytes: 26661,
        sha256:
          "7634f50c427838bb021c2d66a3d1168e9d199b0607e6329399f04846d42e20b4",
      },
    },
    {
      component: "samplerate",
      version: "0.1.0",
      path: "runtime/python/Lib/site-packages/samplerate-0.1.0.dist-info/METADATA",
      bytes: 3202,
      sha256:
        "ab726d3087d69f14c2ca471ef15bdcdfe1c0dd16583b41862017c49bbc618a92",
      wheel: {
        url: "https://files.pythonhosted.org/packages/0c/3c/4c1aa376332d18e708dcc3289e4dbdd2c508bcac1b8eb1b35b73092fa00f/samplerate-0.1.0-py2.py3-none-any.whl",
        bytes: 4028658,
        sha256:
          "f55e5c9d0a8ba3c82a53b7d9c34a2d145439c61166a7f310efaec88f2781b8f8",
      },
    },
  ].map((row) => Object.freeze({ ...row, wheel: Object.freeze(row.wheel) })),
);
export const STORE_PYTHON_NOTICE_SOURCE_PATH =
  "runtime/licenses/python-notice-sources.json";
export const STORE_PYTHON_NOTICE_FILES = Object.freeze([
  ...STORE_PYTHON_NOTICE_ASSETS.map((row) => row.path),
  STORE_PYTHON_NOTICE_SOURCE_PATH,
]);
export const STORE_PYTHON_NOTICE_RUNTIME_PINS = Object.freeze([
  ...STORE_PYTHON_NOTICE_METADATA.map(({ path, bytes, sha256 }) =>
    Object.freeze({ path, bytes, sha256 }),
  ),
  ...[STORE_SAMPLERATE_BINDING, STORE_SAMPLERATE_LIBRARY].map((row) =>
    Object.freeze({ ...row, path: "runtime/python/" + row.path }),
  ),
]);
function invalid(): never {
  throw Error("STORE_PYTHON_NOTICE_INVALID");
}
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
async function physical(path: string, directory: boolean) {
  if (
    !isAbsolute(path) ||
    resolve(path) !== path ||
    (await realpath(path)) !== path
  )
    invalid();
  for (let p = path; ; p = dirname(p)) {
    const stat = await lstat(p);
    if (
      stat.isSymbolicLink() ||
      ((p !== path || directory) && !stat.isDirectory())
    )
      invalid();
    if (p === dirname(p)) break;
  }
}
async function held(
  path: string,
  pin: Pick<StoreInventoryEntry, "bytes" | "sha256">,
) {
  await physical(path, false);
  const before = await hashStoreFile(path);
  if (before.bytes !== pin.bytes || before.sha256 !== pin.sha256) invalid();
  const raw = await readFile(path),
    after = await hashStoreFile(path);
  if (
    raw.length !== pin.bytes ||
    hash(raw) !== pin.sha256 ||
    after.bytes !== before.bytes ||
    after.sha256 !== before.sha256
  )
    invalid();
  return raw;
}
export function buildStorePythonNoticeSources() {
  return Buffer.from(
    JSON.stringify(
      {
        version: 1,
        purpose:
          "verbatim-upstream-python-notices-with-pinned-Windows-runtime-bindings",
        originalSourceCensus: {
          bytes: 1524654,
          sha256:
            "79f63ba0a1926989b09708aa18c2402fe5d46aaf776f40d0755eaaf30487a5f2",
        },
        recoveredUpstreamProofSha256:
          "a206dc5aea93edda9883ff490495830fce31cc14f18e29f97d15e79e6d2d45a3",
        notices: STORE_PYTHON_NOTICE_ASSETS.map(
          ({ sourcePath: _, ...row }) => row,
        ),
        distributions: STORE_PYTHON_NOTICE_METADATA,
        embeddedLibrary: {
          component: "libsamplerate",
          version: "0.1.9",
          library: STORE_SAMPLERATE_LIBRARY,
          binding: STORE_SAMPLERATE_BINDING,
        },
        runtimeCodeChanged: false,
        legalApprovalAsserted: false,
      },
      null,
      2,
    ) + "\n",
  );
}
async function verifyRuntime(root: string) {
  for (const pin of STORE_PYTHON_NOTICE_RUNTIME_PINS) {
    const path = join(root, ...pin.path.split("/"));
    await physical(path, false);
    const actual = await hashStoreFile(path);
    if (actual.bytes !== pin.bytes || actual.sha256 !== pin.sha256) invalid();
  }
}
/** Existing immutable inputs and wheel RECORDs are untouched. The real runtime
 * metadata/binding/DLL and source text must qualify before any exclusive copy. */
export async function stageStorePythonNotices(
  root: string,
  componentRoot: string,
) {
  await physical(root, true);
  await physical(componentRoot, true);
  await verifyRuntime(root);
  const inputs = [];
  for (const row of STORE_PYTHON_NOTICE_ASSETS)
    inputs.push({
      row,
      raw: await held(join(componentRoot, ...row.sourcePath.split("/")), row),
    });
  for (const path of STORE_PYTHON_NOTICE_FILES) {
    try {
      await lstat(join(root, ...path.split("/")));
      invalid();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  for (const { row, raw } of inputs) {
    const source = join(componentRoot, ...row.sourcePath.split("/")),
      destination = join(root, ...row.path.split("/"));
    await mkdir(dirname(destination), { recursive: true });
    await physical(dirname(destination), true);
    await copyFile(source, destination, constants.COPYFILE_EXCL);
    if (!(await held(destination, row)).equals(raw)) invalid();
    await held(source, row);
  }
  const sources = buildStorePythonNoticeSources(),
    destination = join(root, STORE_PYTHON_NOTICE_SOURCE_PATH);
  await writeFile(destination, sources, { flag: "wx" });
  await verifyStorePythonNotices(root, componentRoot);
  return Object.freeze({
    files: STORE_PYTHON_NOTICE_FILES,
    sourceManifest: {
      path: STORE_PYTHON_NOTICE_SOURCE_PATH,
      bytes: sources.length,
      sha256: hash(sources),
    },
    runtimeBindingsVerified: true,
    upstreamTextPreserved: true,
    runtimeCodeChanged: false,
    legalApprovalAsserted: false,
  });
}
/** Independent receiving audit: freshly check current runtime/source/payload
 * bytes, rather than trusting a prior notice receipt or a version string. */
export async function verifyStorePythonNotices(
  root: string,
  componentRoot: string,
) {
  await physical(root, true);
  await physical(componentRoot, true);
  await verifyRuntime(root);
  for (const row of STORE_PYTHON_NOTICE_ASSETS) {
    const source = await held(
        join(componentRoot, ...row.sourcePath.split("/")),
        row,
      ),
      actual = await held(join(root, ...row.path.split("/")), row);
    if (!actual.equals(source)) invalid();
  }
  const sources = buildStorePythonNoticeSources();
  if (
    !(
      await held(join(root, STORE_PYTHON_NOTICE_SOURCE_PATH), {
        bytes: sources.length,
        sha256: hash(sources),
      })
    ).equals(sources)
  )
    invalid();
  await verifyRuntime(root);
}
