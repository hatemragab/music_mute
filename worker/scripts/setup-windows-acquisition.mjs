import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync, inflateRawSync, crc32 } from "node:zlib";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile),
  script = fileURLToPath(import.meta.url),
  workerRoot = resolve(dirname(script), "..");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function fail(code = "WINDOWS_ACQUISITION_INPUT_INVALID") {
  throw new Error(code);
}
function exactRecord(value, fields) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null) ||
    Reflect.ownKeys(value).length !== fields.length ||
    Reflect.ownKeys(value).some(
      (key) => typeof key !== "string" || !fields.includes(key),
    )
  )
    fail();
  const row = Object.create(null),
    descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of fields) {
    const d = descriptors[key];
    if (!d?.enumerable || !("value" in d)) fail();
    row[key] = d.value;
  }
  return row;
}
export const ACQUISITION_SOURCE_PINS = Object.freeze({
  consumerPins:
    "e651fca137f7c4e2378f3054190a2b3776efc2a6a274d2850f396257cf69fe64",
  bootstrap: "2f510f42390050de123e257a8ae85a00266409e02a8142490c3a1b04a9dda6a2",
  patch: "cfd07cac5400627e039ded2ac82a3af5443d22c4c714b6357d65bd5248a575d6",
  generate: "718ba412feecbc67d423c30048fb9a5066c195a610773208abfe1912f6f10b7c",
  generateOriginal:
    "c8a2a22a07d9576c73377ce79edced330fce69c86d3bb901bd81032fa43ab2cd",
  strictJson:
    "c3318c84bbe7040aa2800556be11389992fe1bad06c05774262a476aa87eab0c",
  peImports: "985e95ef85652141445a23d36a59730e7470a76d5422f0344af9d9387a2f7b51",
  sessionOriginal:
    "39a8789229da1003dde24c7e3630a429a4fd7567fd3b8f22d2a2a389b6182c6f",
  sessionPatched:
    "31834151c54c2cb4550f6c3d2f4c72f2e3d6ff381d3bd7ca2f29922bf8abadb0",
});
export const ACQUISITION_ARTIFACTS = Object.freeze({
  node: {
    file: "node-v24.18.0-win-x64.zip",
    url: "https://nodejs.org/dist/v24.18.0/node-v24.18.0-win-x64.zip",
    sha256: "0ae68406b42d7725661da979b1403ec9926da205c6770827f33aac9d8f26e821",
    limit: 80 * 1024 ** 2,
  },
  deno: {
    file: "deno-x86_64-pc-windows-msvc.zip",
    url: "https://github.com/denoland/deno/releases/download/v2.9.7/deno-x86_64-pc-windows-msvc.zip",
    bytes: 42630221,
    sha256: "a0c3101b4158d1dfb7d6a78a7bf0f3de80c96bb423c152beec8beb22786f2238",
  },
  canvas: {
    file: "canvas-v3.2.3-napi-v7-win32-x64.tar.gz",
    url: "https://github.com/Automattic/node-canvas/releases/download/v3.2.3/canvas-v3.2.3-napi-v7-win32-x64.tar.gz",
    bytes: 15235616,
    sha256: "ba953cc8c38303ab94cc83461c7561506a5a3af37d6c678de4a47914d2d0bb48",
  },
  provider: {
    file: "bgutil-2.0.1-source.tar.gz",
    url: "https://codeload.github.com/Brainicism/bgutil-ytdlp-pot-provider/tar.gz/refs/tags/2.0.1",
    sha256: "bae71b7971fa22376af57edca8d3487724ac9a8ada56d1cccf07a547b4b9b62c",
    limit: 64 * 1024 ** 2,
  },
  denoSource: {
    file: "deno-2.9.7-source.tar.gz",
    url: "https://codeload.github.com/denoland/deno/tar.gz/refs/tags/v2.9.7",
    sha256: "28c9677ccee96f9ba0910067d3249fcee90a795063af8a14372769c17a6e1bb2",
    limit: 64 * 1024 ** 2,
  },
  canvasSource: {
    file: "canvas-3.2.3-source.tar.gz",
    url: "https://codeload.github.com/Automattic/node-canvas/tar.gz/refs/tags/v3.2.3",
    sha256: "22c456e461731d2acdb2f8261ce889127d3430688cd9ff654c4ef4667bd85580",
    limit: 64 * 1024 ** 2,
  },
});
/** Hoisted npm layout preserves ordinary parent dependency resolution after
 * every build-side alias is replaced by an independent, inventoried file tree.
 * Neither npm scripts nor ambient/global packages are authorized.
 */
export const ACQUISITION_INSTALL_ARGUMENTS = Object.freeze([
  "install",
  "--prod",
  "--frozen=false",
  "--node-modules-dir=manual",
  "--node-modules-linker=hoisted",
  "--os",
  "win32",
  "--arch",
  "x64",
]);
const wheels = [
  {
    project: "bgutil-ytdlp-pot-provider",
    pypiVersion: "2.0.1",
    version: "2.0.1",
    file: "bgutil_ytdlp_pot_provider-2.0.1-py3-none-any.whl",
    bytes: 12777,
    sha256: "ff6c2e85443e0777e2483e4a5ef2084ca745a1dd3cc07cf355ddd3a77bd882e8",
    url: "https://files.pythonhosted.org/packages/d7/8c/e084842878d23b89c7a263a0c0a29a31b256b61289193979fc192db0aec1/bgutil_ytdlp_pot_provider-2.0.1-py3-none-any.whl",
  },
  {
    project: "yt-dlp",
    pypiVersion: "2026.8.19",
    version: "2026.08.19",
    file: "yt_dlp-2026.8.19-py3-none-any.whl",
    bytes: 3185533,
    sha256: "1d57897e94c6665a0a6f9bc54b34e584284e32c034ffab3a7df25d8f7b24eedf",
    url: "https://files.pythonhosted.org/packages/69/b2/8cd1613f56eed7ceb64fbd4df3f1c01246bfb098e6f398228bafda22b80b/yt_dlp-2026.8.19-py3-none-any.whl",
  },
  {
    project: "yt-dlp-ejs",
    pypiVersion: "0.8.0",
    version: "0.8.0",
    file: "yt_dlp_ejs-0.8.0-py3-none-any.whl",
    bytes: 53443,
    sha256: "79300e5fca7f937a1eeede11f0456862c1b41107ce1d726871e0207424f4bdb4",
    url: "https://files.pythonhosted.org/packages/e3/bd/520769863744b669440a924271a6159ddd82ad5ae26b4ac4d4b69e9f8d44/yt_dlp_ejs-0.8.0-py3-none-any.whl",
  },
];
const hosts = new Set([
  "nodejs.org",
  "api.github.com",
  "github.com",
  "codeload.github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
  "pypi.org",
  "files.pythonhosted.org",
]);
export function acquisitionSourceUrl(value) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    !hosts.has(url.hostname) ||
    url.username ||
    url.password ||
    url.port ||
    url.hash
  )
    fail("WINDOWS_ACQUISITION_SOURCE_INVALID");
  return url;
}
export function acquisitionRelativePath(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 1024 ||
    !/^[\x20-\x7e]+$/u.test(value) ||
    /[\\<>:"|?*;$]/u.test(value) ||
    value.startsWith("/") ||
    value
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          /[. ]$/u.test(part) ||
          /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part),
      )
  )
    fail();
  return value;
}
async function heldFile(
  path,
  maximum = 512 * 1024 ** 2,
  allowCacheHardlinks = false,
  allowEmptyLeaf = false,
) {
  const observation = (value) => ({
    regular: value.isFile(),
    symbolicLink: value.isSymbolicLink(),
    links: String(value.nlink),
    bytes: String(value.size),
    device: String(value.dev),
    inode: String(value.ino),
    modifiedNs: String(value.mtimeNs),
    changedNs: String(value.ctimeNs),
    createdNs: String(value.birthtimeNs),
  });
  const denied = (stage, observed = []) => {
    const error = new Error("WINDOWS_ACQUISITION_INPUT_INVALID");
    error.heldDiagnostic = { stage, observations: observed.map(observation) };
    throw error;
  };
  const named = await lstat(path, { bigint: true });
  if (
    !named.isFile() ||
    named.isSymbolicLink() ||
    named.nlink < 1n ||
    (!allowCacheHardlinks && named.nlink !== 1n) ||
    named.size < (allowEmptyLeaf ? 0n : 1n) ||
    named.size > BigInt(maximum)
  )
    denied("named-leaf", [named]);
  const file = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = await file.stat({ bigint: true });
    const same = (s) =>
      s.isFile() &&
      !s.isSymbolicLink() &&
      s.nlink === before.nlink &&
      s.dev === before.dev &&
      s.ino === before.ino &&
      s.size === before.size &&
      s.mtimeNs === before.mtimeNs &&
      s.ctimeNs === before.ctimeNs &&
      s.birthtimeNs === before.birthtimeNs;
    if (!same(named)) denied("opened-identity", [named, before]);
    const data = Buffer.alloc(Number(before.size));
    for (let at = 0; at < data.length;) {
      const { bytesRead } = await file.read(
        data,
        at,
        Math.min(1024 ** 2, data.length - at),
        at,
      );
      if (!bytesRead) denied("short-read", [before]);
      at += bytesRead;
    }
    if ((await file.read(Buffer.alloc(1), 0, 1, data.length)).bytesRead)
      denied("unexpected-tail", [before]);
    const heldAfter = await file.stat({ bigint: true });
    if (!same(heldAfter)) denied("held-after-identity", [before, heldAfter]);
    const namedAfter = await lstat(path, { bigint: true });
    if (!same(namedAfter)) denied("named-after-identity", [before, namedAfter]);
    return data;
  } finally {
    await file.close();
  }
}
async function exclusiveFile(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
}
async function transfer(url, limit) {
  const abort = new AbortController(),
    lifetime = setTimeout(() => abort.abort(), 180000);
  let inactivity = setTimeout(() => abort.abort(), 15000);
  try {
    let response;
    for (let redirects = 0; redirects < 6; redirects++) {
      acquisitionSourceUrl(url);
      response = await fetch(url, {
        redirect: "manual",
        signal: abort.signal,
        headers: { "User-Agent": "MusicMute-Windows-acquisition-inputs/0.1" },
      });
      if (response.status < 300 || response.status >= 400) break;
      const next = response.headers.get("location");
      await response.body?.cancel();
      if (!next) fail("WINDOWS_ACQUISITION_SOURCE_INVALID");
      url = new URL(next, url).href;
    }
    if (
      !response?.ok ||
      !response.body ||
      Number(response.headers.get("content-length")) > limit
    )
      fail("WINDOWS_ACQUISITION_DOWNLOAD_FAILED");
    const chunks = [];
    let count = 0;
    for await (const chunk of response.body) {
      clearTimeout(inactivity);
      inactivity = setTimeout(() => abort.abort(), 15000);
      count += chunk.length;
      if (count > limit) fail("WINDOWS_ACQUISITION_DOWNLOAD_LIMIT");
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(lifetime);
    clearTimeout(inactivity);
  }
}
export async function pinnedDownload(pin, raw, artifactCache) {
  const data = artifactCache
    ? await heldFile(join(artifactCache, pin.file), pin.bytes ?? pin.limit)
    : await transfer(pin.url, pin.bytes ?? pin.limit);
  if ((pin.bytes && data.length !== pin.bytes) || hash(data) !== pin.sha256)
    fail("WINDOWS_ACQUISITION_ARTIFACT_CHANGED");
  await exclusiveFile(join(raw, pin.file), data);
  return data;
}

/** Replace only the archive's known generator with the current pinned script. */
export async function replaceAcquisitionGenerator(path, generator) {
  const original = await heldFile(path, 65536);
  if (
    hash(original) !== ACQUISITION_SOURCE_PINS.generateOriginal ||
    hash(generator) !== ACQUISITION_SOURCE_PINS.generate
  )
    fail("WINDOWS_ACQUISITION_PROVIDER_SOURCE_CHANGED");
  await writeFile(path, generator);
  return original;
}

/** Known build project inputs remain build-side, never consumer runtime code. */
export function canvasRuntimeFiles(entries) {
  const projectFiles = new Set([
    "build/binding.sln",
    "build/canvas.vcxproj",
    "build/canvas.vcxproj.filters",
    "build/config.gypi",
  ]);
  const result = new Map();
  for (const [name, data] of entries) {
    if (projectFiles.has(name)) continue;
    if (!/^build\/Release\/[A-Za-z0-9._+-]+\.(?:node|dll)$/u.test(name))
      fail("WINDOWS_ACQUISITION_CANVAS_UNEXPECTED_FILE");
    result.set(name, data);
  }
  if (!result.has("build/Release/canvas.node"))
    fail("WINDOWS_ACQUISITION_CANVAS_INCOMPLETE");
  return result;
}

/** Pure bounded ZIP reader for selected official tool/license entries, never extraction APIs. */
export function pinnedZipFiles(value, wanted) {
  const bytes = Buffer.from(value);
  if (bytes.length < 22 || bytes.length > 128 * 1024 ** 2)
    fail("WINDOWS_ACQUISITION_ARCHIVE_INVALID");
  let tail = bytes.length - 22;
  while (
    tail >= Math.max(0, bytes.length - 65557) &&
    bytes.readUInt32LE(tail) !== 0x06054b50
  )
    tail--;
  if (
    tail < 0 ||
    bytes.readUInt32LE(tail) !== 0x06054b50 ||
    tail + 22 + bytes.readUInt16LE(tail + 20) !== bytes.length ||
    bytes.readUInt16LE(tail + 4) ||
    bytes.readUInt16LE(tail + 6) ||
    bytes.readUInt16LE(tail + 8) !== bytes.readUInt16LE(tail + 10)
  )
    fail("WINDOWS_ACQUISITION_ARCHIVE_INVALID");
  const count = bytes.readUInt16LE(tail + 10),
    centralSize = bytes.readUInt32LE(tail + 12),
    begin = bytes.readUInt32LE(tail + 16),
    result = new Map(),
    seen = new Set();
  if (!count || count > 30000 || begin + centralSize !== tail)
    fail("WINDOWS_ACQUISITION_ARCHIVE_INVALID");
  let at = begin;
  for (let i = 0; i < count; i++) {
    if (at + 46 > tail || bytes.readUInt32LE(at) !== 0x02014b50)
      fail("WINDOWS_ACQUISITION_ARCHIVE_INVALID");
    const flags = bytes.readUInt16LE(at + 8),
      method = bytes.readUInt16LE(at + 10),
      crc = bytes.readUInt32LE(at + 16),
      compressed = bytes.readUInt32LE(at + 20),
      size = bytes.readUInt32LE(at + 24),
      nameBytes = bytes.readUInt16LE(at + 28),
      extra = bytes.readUInt16LE(at + 30),
      comment = bytes.readUInt16LE(at + 32),
      mode = (bytes.readUInt32LE(at + 38) >>> 16) & 0xf000,
      local = bytes.readUInt32LE(at + 42);
    if (at + 46 + nameBytes + extra + comment > tail)
      fail("WINDOWS_ACQUISITION_ARCHIVE_INVALID");
    const name = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(at + 46, at + 46 + nameBytes),
    );
    const key = name.endsWith("/") ? name.slice(0, -1) : name;
    acquisitionRelativePath(key);
    if (
      seen.has(key.toLowerCase()) ||
      flags & 1 ||
      ![0, 8].includes(method) ||
      ![0, 0x8000, 0x4000].includes(mode)
    )
      fail("WINDOWS_ACQUISITION_ARCHIVE_INVALID");
    seen.add(key.toLowerCase());
    if (wanted.has(name)) {
      if (
        name.endsWith("/") ||
        size < 1 ||
        size > 256 * 1024 ** 2 ||
        local + 30 > begin ||
        bytes.readUInt32LE(local) !== 0x04034b50 ||
        bytes.readUInt16LE(local + 6) !== flags ||
        bytes.readUInt16LE(local + 8) !== method
      )
        fail("WINDOWS_ACQUISITION_ARCHIVE_INVALID");
      const n = bytes.readUInt16LE(local + 26),
        x = bytes.readUInt16LE(local + 28),
        start = local + 30 + n + x;
      if (
        new TextDecoder("utf-8", { fatal: true }).decode(
          bytes.subarray(local + 30, local + 30 + n),
        ) !== name ||
        start + compressed > begin
      )
        fail("WINDOWS_ACQUISITION_ARCHIVE_INVALID");
      const data =
        method === 8
          ? inflateRawSync(bytes.subarray(start, start + compressed), {
              maxOutputLength: size,
            })
          : Buffer.from(bytes.subarray(start, start + compressed));
      if (data.length !== size || crc32(data) !== crc)
        fail("WINDOWS_ACQUISITION_ARCHIVE_INVALID");
      result.set(name, data);
    }
    at += 46 + nameBytes + extra + comment;
  }
  if (at !== tail || result.size !== wanted.size)
    fail("WINDOWS_ACQUISITION_ARCHIVE_INVALID");
  return result;
}
/** PAX paths supported; links/special entries are never selected or followed. */
export function pinnedTarFiles(value, select) {
  const bytes = gunzipSync(value, { maxOutputLength: 768 * 1024 ** 2 }),
    result = new Map(),
    seen = new Set();
  let at = 0,
    pax = {};
  const field = (block, begin, end) =>
    block.subarray(begin, end).toString("utf8").split("\0", 1)[0];
  while (at + 512 <= bytes.length) {
    const block = bytes.subarray(at, at + 512);
    at += 512;
    if (block.every((byte) => byte === 0)) {
      if (!bytes.subarray(at).every((byte) => byte === 0))
        fail("WINDOWS_ACQUISITION_ARCHIVE_INVALID");
      return result;
    }
    const checksum = Number.parseInt(field(block, 148, 156).trim(), 8);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : block[i];
    const sizeText = field(block, 124, 136).trim();
    if (!/^[0-7]+$/u.test(sizeText) || sum !== checksum)
      fail("WINDOWS_ACQUISITION_ARCHIVE_INVALID");
    const size = Number.parseInt(sizeText, 8);
    if (
      !Number.isSafeInteger(size) ||
      size > 256 * 1024 ** 2 ||
      at + size > bytes.length
    )
      fail("WINDOWS_ACQUISITION_ARCHIVE_INVALID");
    const type = String.fromCharCode(block[156]),
      prefix = field(block, 345, 500),
      original = `${prefix ? prefix + "/" : ""}${field(block, 0, 100)}`,
      content = bytes.subarray(at, at + size);
    at += Math.ceil(size / 512) * 512;
    if (type === "x" || type === "g") {
      if (size > 65536) fail("WINDOWS_ACQUISITION_ARCHIVE_INVALID");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
      let index = 0;
      const data = {};
      while (index < text.length) {
        const space = text.indexOf(" ", index),
          length = Number(text.slice(index, space));
        if (
          space < 0 ||
          !Number.isSafeInteger(length) ||
          length < 3 ||
          index + length > text.length ||
          text[index + length - 1] !== "\n"
        )
          fail("WINDOWS_ACQUISITION_ARCHIVE_INVALID");
        const pair = text.slice(space + 1, index + length - 1),
          eq = pair.indexOf("=");
        if (eq < 1 || Object.hasOwn(data, pair.slice(0, eq)))
          fail("WINDOWS_ACQUISITION_ARCHIVE_INVALID");
        data[pair.slice(0, eq)] = pair.slice(eq + 1);
        index += length;
      }
      if (type === "x") pax = data;
      else if (data.path || data.linkpath || data.size)
        fail("WINDOWS_ACQUISITION_ARCHIVE_INVALID");
      continue;
    }
    const name = (pax.path ?? original).replace(/\/$/u, "");
    pax = {};
    if (
      name.startsWith("/") ||
      name.includes("\\") ||
      name.split("/").some((part) => !part || part === "." || part === "..")
    )
      fail("WINDOWS_ACQUISITION_ARCHIVE_INVALID");
    if (seen.has(name) || seen.size >= 100000)
      fail("WINDOWS_ACQUISITION_ARCHIVE_INVALID");
    seen.add(name);
    if (select(name, type)) {
      acquisitionRelativePath(name);
      if ((type !== "0" && type !== "\0") || size < 1)
        fail("WINDOWS_ACQUISITION_ARCHIVE_INVALID");
      result.set(name, Buffer.from(content));
    }
  }
  fail("WINDOWS_ACQUISITION_ARCHIVE_INVALID");
}

/** Text-equivalent port of the existing pinned patch; no upstream code runs here. */
export function patchProviderSession(text) {
  if (hash(Buffer.from(text)) !== ACQUISITION_SOURCE_PINS.sessionOriginal)
    fail("WINDOWS_ACQUISITION_PROVIDER_SOURCE_CHANGED");
  const replace = (from, to) => {
    if (text.split(from).length !== 2)
      fail("WINDOWS_ACQUISITION_PROVIDER_SOURCE_CHANGED");
    text = text.replace(from, to);
  };
  replace(
    "                        proxy: false,",
    "                        proxy: false,\n                        timeout: 5000,",
  );
  replace(
    "const bgFetch = this.getFetch(pxySpec, 3, 5000);",
    "const bgFetch = this.getFetch(pxySpec, 1, 0);",
  );
  replace(
    "        this._minterCache.set(cacheSpec.key, tokenMinter);",
    "        if (!this._minterCache.has(cacheSpec.key) && this._minterCache.size >= 128) {\n            this._minterCache.delete(this._minterCache.keys().next().value!);\n        }\n        this._minterCache.set(cacheSpec.key, tokenMinter);",
  );
  replace(
    "export class SessionManager {",
    "class MintMutex {\n    private tail: Promise<void> = Promise.resolve();\n    async acquire(): Promise<() => void> {\n        let release!: () => void;\n        const previous = this.tail;\n        this.tail = new Promise<void>((resolve) => { release = resolve; });\n        await previous;\n        return release;\n    }\n}\n\nexport class SessionManager {",
  );
  replace(
    "    private _minterCache: MinterCache = new Map();",
    "    private _minterCache: MinterCache = new Map();\n    private mintMutex = new MintMutex();",
  );
  replace(
    String.raw`            const ytcfgMatch = pageHtml.match(/ytcfg\.set\(({.+?})\);/s);
            if (ytcfgMatch) {
                const ytObj = { config_: JSON.parse(ytcfgMatch[1] as string) };
                const g: any = globalThis as any;
                g.yt = ytObj; // BotGuard reads yt.config_.EVENT_ID
                if (g.window) g.window.yt = ytObj;
            } else {`,
    String.raw`            const ytcfgMatch = pageHtml.match(/ytcfg\.set\(({.+?})\);/s);
            let musicmuteYtConfig: any;
            if (ytcfgMatch) {
                musicmuteYtConfig = { config_: JSON.parse(ytcfgMatch[1] as string) };
            } else {`,
  );
  replace(
    "            return bgChallenge as ChallengeData;",
    "            return { ...bgChallenge, musicmuteYtConfig } as ChallengeData;",
  );
  replace(
    "                interpreterHash,\n                interpreterJavascript:",
    "                interpreterHash,\n                musicmuteYtConfig: (challenge as any).musicmuteYtConfig,\n                interpreterJavascript:",
  );
  replace(
    "                interpreterUrl: {\n                    privateDoNotAccessOrElseTrustedResourceUrlWrappedValue,\n                },\n            };",
    "                interpreterUrl: {\n                    privateDoNotAccessOrElseTrustedResourceUrlWrappedValue,\n                },\n            } as IBotguardClientSideBgChallenge;",
  );
  replace(
    "        if (interpreterJavascript) {\n            new Function(interpreterJavascript)();",
    "        const release = await this.mintMutex.acquire();\n        let webPoSignalOutput: WebPoSignalOutput;\n        let botguardResponse: unknown;\n        try {\n            const config = (descrambledChallenge as any).musicmuteYtConfig;\n            const g: any = globalThis as any;\n            if (config) {\n                g.yt = config;\n                if (g.window) g.window.yt = config;\n            } else {\n                delete g.yt;\n                if (g.window) delete g.window.yt;\n            }\n        if (interpreterJavascript) {\n            new Function(interpreterJavascript)();",
  );
  replace(
    "        try {\n            const webPoSignalOutput: WebPoSignalOutput = [];\n            const botguardResponse = await bgClient.snapshot({\n                webPoSignalOutput,\n            });\n            const integrityTokenResp = await potCtx.fetch(",
    "            webPoSignalOutput = [];\n            botguardResponse = await bgClient.snapshot({ webPoSignalOutput });\n        } finally {\n            release();\n        }\n        try {\n            const integrityTokenResp = await potCtx.fetch(",
  );
  if (hash(Buffer.from(text)) !== ACQUISITION_SOURCE_PINS.sessionPatched)
    fail("WINDOWS_ACQUISITION_PROVIDER_PATCH_CHANGED");
  return text;
}
export function assertDerivedProviderLock(original, derived) {
  if (!original?.npm || !derived?.npm || !Object.keys(derived.npm).length)
    fail("WINDOWS_ACQUISITION_LOCK_CHANGED");
  for (const [name, entry] of Object.entries(derived.npm))
    if (JSON.stringify(entry) !== JSON.stringify(original.npm[name]))
      fail("WINDOWS_ACQUISITION_LOCK_CHANGED");
  if (
    JSON.stringify(derived.jsr ?? {}) !== JSON.stringify(original.jsr ?? {}) ||
    JSON.stringify(derived.remote ?? {}) !==
      JSON.stringify(original.remote ?? {})
  )
    fail("WINDOWS_ACQUISITION_LOCK_CHANGED");
}
export function acquisitionEnvironment(root, systemRoot) {
  if (
    !/^[A-Za-z]:\\Windows$/iu.test(systemRoot ?? "") ||
    win32.resolve(root) !== root ||
    !/^[A-Za-z]:\\/u.test(root)
  )
    fail("WINDOWS_ACQUISITION_ENVIRONMENT_INVALID");
  return {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    PATH: "",
    HOME: root,
    USERPROFILE: root,
    APPDATA: root,
    LOCALAPPDATA: root,
    TEMP: root,
    TMP: root,
    DENO_DIR: win32.join(root, "deno-cache"),
    // Pinned Deno 2.9.7 otherwise hardlinks itself into a writable node PATH
    // shim. No optional subprocess shim is needed by the fixed provider probe.
    DENO_DISABLE_NODE_SHIM: "1",
    DENO_NO_PROMPT: "1",
    DENO_NO_UPDATE_CHECK: "1",
    NO_COLOR: "1",
    NPM_CONFIG_USERCONFIG: win32.join(root, "no-user-npmrc"),
    PYTHONNOUSERSITE: "1",
  };
}

const membershipSource = `#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <cstdio>
int main() {
  SYSTEM_INFO architecture{}; GetNativeSystemInfo(&architecture);
  if (architecture.wProcessorArchitecture != PROCESSOR_ARCHITECTURE_AMD64) return 2;
  DWORD session = 0; BOOL member = FALSE; HANDLE token = nullptr;
  TOKEN_ELEVATION elevation{}; DWORD used = 0;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  const bool sessionObserved = ProcessIdToSessionId(GetCurrentProcessId(), &session) != FALSE;
  const bool inJob = IsProcessInJob(GetCurrentProcess(), nullptr, &member) && member;
  const bool jobObserved = QueryInformationJobObject(nullptr, JobObjectExtendedLimitInformation, &limits, sizeof(limits), nullptr) != FALSE;
  const bool killOnClose = jobObserved && (limits.BasicLimitInformation.LimitFlags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE);
  const bool breakaway = !jobObserved || (limits.BasicLimitInformation.LimitFlags & (JOB_OBJECT_LIMIT_BREAKAWAY_OK | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK));
  const bool tokenObserved = OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token) && GetTokenInformation(token, TokenElevation, &elevation, sizeof(elevation), &used);
  if (token) CloseHandle(token);
  const bool elevated = !tokenObserved || elevation.TokenIsElevated;
  std::printf("{\\"version\\":1,\\"sessionId\\":%lu,\\"inJob\\":%s,\\"killOnClose\\":%s,\\"breakaway\\":%s,\\"elevated\\":%s}\\n", session, inJob ? "true" : "false", killOnClose ? "true" : "false", breakaway ? "true" : "false", elevated ? "true" : "false");
  // NULL queries this process's immediate associated Job, not the original
  // guard's explicit owned handle. Its limits are observations, not authority.
  return sessionObserved && session == 1 && inJob && !elevated ? 0 : 2;
}
`;
// A QA-only child script. Its two actions reach only this freshly owned
// projection; the original guardian still owns process authority and cleanup.
const ownedCodeAclSource = String.raw`param([Parameter(Mandatory=$true)][ValidateSet('seal','restore')][string]$Action)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';Set-StrictMode -Version Latest
$ps=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if([Diagnostics.Process]::GetCurrentProcess().MainModule.FileName-ine $ps-or(Get-FileHash -LiteralPath $ps -Algorithm SHA256).Hash.ToLowerInvariant()-cne '0ff6f2c94bc7e2833a5f7e16de1622e5dba70396f31c7d5f56381870317e8c46'-or(Get-AuthenticodeSignature -LiteralPath $ps).Status.ToString()-cne 'Valid'){throw 'ACQUISITION_ACL_POWERSHELL_CHANGED'}
$cohort=Split-Path -Parent $PSScriptRoot
if($cohort-cnotmatch '^C:\\MMQA6ec8a1a8\\aq[A-Z0-9]-[a-f0-9]{8}$'){throw 'ACQUISITION_ACL_ROOT_INVALID'}
$codes=@((Join-Path $cohort 'inputs\youtube'),(Join-Path $cohort 'build-work\offline-check\deno-cache'));$backup=Join-Path $cohort 'build-work\code-root-dacl-before.json'
function Plain([string]$path,[bool]$directory){$entry=Get-Item -LiteralPath $path -Force;if([bool]$entry.PSIsContainer-ne $directory){throw 'ACQUISITION_ACL_PATH_INVALID'};$cursor=$entry;while($null-ne $cursor){if(($cursor.Attributes-band[IO.FileAttributes]::ReparsePoint)-ne 0){throw 'ACQUISITION_ACL_REPARSE_REJECTED'};if($cursor-is[IO.FileInfo]){$cursor=$cursor.Directory}else{$cursor=$cursor.Parent}};return $entry.FullName}
foreach($code in $codes){$null=Plain $code $true};$null=Plain (Join-Path $cohort 'build-work') $true
$identity=[Security.Principal.WindowsIdentity]::GetCurrent();$principal=New-Object Security.Principal.WindowsPrincipal($identity)
if([Diagnostics.Process]::GetCurrentProcess().SessionId-ne 1-or$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)-or![Environment]::Is64BitProcess-or![Environment]::Is64BitOperatingSystem){throw 'ACQUISITION_ACL_LIMITED_SESSION_REQUIRED'}
$sections=[Security.AccessControl.AccessControlSections]::Access
if($Action-ceq 'seal'){
 if(Test-Path -LiteralPath $backup){throw 'ACQUISITION_ACL_BACKUP_EXISTS'}
 $roots=@($codes|ForEach-Object{@{codeRoot=$_;sddl=(Get-Acl -LiteralPath $_).GetSecurityDescriptorSddlForm($sections)}})
 $record=@{version=1;scope='own-qa-code-root-dacl-only';roots=$roots;sid=$identity.User.Value;ownerMayRestoreDacl=$true}
 $file=[IO.File]::Open($backup,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read);try{$bytes=[Text.Encoding]::UTF8.GetBytes(($record|ConvertTo-Json -Compress));$file.Write($bytes,0,$bytes.Length);$file.Flush($true)}finally{$file.Dispose()}
 $rights=[Security.AccessControl.FileSystemRights]'WriteData,AppendData,WriteExtendedAttributes,WriteAttributes,Delete,DeleteSubdirectoriesAndFiles'
 $deny=New-Object Security.AccessControl.FileSystemAccessRule($identity.User,$rights,[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Deny)
 foreach($root in $roots){$acl=Get-Acl -LiteralPath $root.codeRoot;$acl.AddAccessRule($deny);Set-Acl -LiteralPath $root.codeRoot -AclObject $acl;$after=(Get-Acl -LiteralPath $root.codeRoot).GetSecurityDescriptorSddlForm($sections);if($after-ceq $root.sddl){throw 'ACQUISITION_ACL_NOT_CHANGED'}}
 @{version=1;action='seal';scope='own-qa-code-root-dacl-only';sessionId=1;elevated=$false;sid=$identity.User.Value;ownerMayRestoreDacl=$true;rootsSealed=2;backupSha256=(Get-FileHash -LiteralPath $backup -Algorithm SHA256).Hash.ToLowerInvariant()}|ConvertTo-Json -Compress
}else{
 $null=Plain $backup $false;$entry=Get-Item -LiteralPath $backup;if($entry.Length-lt 1-or$entry.Length-gt 65536){throw 'ACQUISITION_ACL_BACKUP_INVALID'}
 $record=Get-Content -Raw -LiteralPath $backup|ConvertFrom-Json
 if($record.version-ne 1-or$record.scope-cne 'own-qa-code-root-dacl-only'-or$record.sid-cne $identity.User.Value-or!$record.ownerMayRestoreDacl-or$record.roots.Count-ne 2){throw 'ACQUISITION_ACL_BACKUP_INVALID'}
 for($i=0;$i-lt 2;$i++){if($record.roots[$i].codeRoot-cne $codes[$i]-or$record.roots[$i].sddl-isnot[string]){throw 'ACQUISITION_ACL_BACKUP_INVALID'}}
 foreach($root in $record.roots){$acl=Get-Acl -LiteralPath $root.codeRoot;$acl.SetSecurityDescriptorSddlForm($root.sddl,$sections);Set-Acl -LiteralPath $root.codeRoot -AclObject $acl;$after=(Get-Acl -LiteralPath $root.codeRoot).GetSecurityDescriptorSddlForm($sections);if($after-cne $root.sddl){throw 'ACQUISITION_ACL_RESTORE_FAILED'}}
 @{version=1;action='restore';scope='own-qa-code-root-dacl-only';restored=$true;rootsRestored=2}|ConvertTo-Json -Compress
}
`;
export function acquisitionCmake(nodePin) {
  if (
    !Number.isSafeInteger(nodePin?.bytes) ||
    nodePin.bytes < 1 ||
    !/^[a-f0-9]{64}$/u.test(nodePin.sha256)
  )
    fail();
  return `cmake_minimum_required(VERSION 3.24)
project(MusicMuteWindowsAcquisition LANGUAGES CXX)
if(NOT WIN32 OR NOT CMAKE_SIZEOF_VOID_P EQUAL 8)
  message(FATAL_ERROR "WINDOWS_ACQUISITION_X64_REQUIRED")
endif()
get_filename_component(cohort "\${CMAKE_CURRENT_SOURCE_DIR}/../../../.." ABSOLUTE)
file(READ "\${cohort}/frozen-inputs.json" pins LIMIT 8388609)
string(LENGTH "\${pins}" pin_bytes)
if(pin_bytes GREATER 8388608)
  message(FATAL_ERROR "WINDOWS_ACQUISITION_FROZEN_INPUT_INVALID")
endif()
string(JSON count LENGTH "\${pins}" files)
if(count LESS 10 OR count GREATER 30000)
  message(FATAL_ERROR "WINDOWS_ACQUISITION_FROZEN_INPUT_INVALID")
endif()
math(EXPR last "\${count}-1")
foreach(i RANGE 0 \${last})
  string(JSON path GET "\${pins}" files \${i} path)
  string(JSON bytes GET "\${pins}" files \${i} bytes)
  string(JSON sha GET "\${pins}" files \${i} sha256)
  if(path MATCHES [=[[;\\\\$":<>|?*]]=] OR path MATCHES [[(^|/)\\.\\.?(/|$)]] OR path MATCHES "^/" OR IS_SYMLINK "\${cohort}/\${path}")
    message(FATAL_ERROR "WINDOWS_ACQUISITION_FROZEN_INPUT_INVALID")
  endif()
  file(SIZE "\${cohort}/\${path}" actual_bytes)
  file(SHA256 "\${cohort}/\${path}" actual_sha)
  if(NOT actual_bytes EQUAL bytes OR NOT actual_sha STREQUAL sha)
    message(FATAL_ERROR "WINDOWS_ACQUISITION_FROZEN_INPUT_CHANGED")
  endif()
endforeach()
file(SIZE "\${cohort}/tools/node/node.exe" node_bytes)
file(SHA256 "\${cohort}/tools/node/node.exe" node_sha)
if(NOT node_bytes EQUAL ${nodePin.bytes} OR NOT node_sha STREQUAL "${nodePin.sha256}")
  message(FATAL_ERROR "WINDOWS_ACQUISITION_NODE_CHANGED")
endif()
add_executable(musicmute-acquisition-membership membership.cpp)
target_compile_features(musicmute-acquisition-membership PRIVATE cxx_std_20)
if(MSVC)
  set_property(TARGET musicmute-acquisition-membership PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
endif()
target_link_libraries(musicmute-acquisition-membership PRIVATE advapi32)
set_target_properties(musicmute-acquisition-membership PROPERTIES RUNTIME_OUTPUT_DIRECTORY "\${cohort}/build-tools")
foreach(config DEBUG RELEASE RELWITHDEBINFO MINSIZEREL)
  set_target_properties(musicmute-acquisition-membership PROPERTIES RUNTIME_OUTPUT_DIRECTORY_\${config} "\${cohort}/build-tools")
endforeach()
add_custom_target(musicmute-acquisition-inputs ALL
  COMMAND "\${cohort}/tools/node/node.exe" "\${cohort}/source/setup-windows-acquisition.mjs" --assemble-frozen
  DEPENDS musicmute-acquisition-membership
  WORKING_DIRECTORY "\${cohort}"
  VERBATIM)
`;
}
export async function listFiles(root, allowEmptyLeaf = false) {
  const result = [],
    aliases = new Set();
  async function visit(directory, depth = 0) {
    if (depth > 32 || aliases.size > 30000) fail();
    const dir = await lstat(directory);
    if (!dir.isDirectory() || dir.isSymbolicLink()) fail();
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name),
        key = acquisitionRelativePath(
          relative(root, path).split(sep).join("/"),
        ),
        info = await lstat(path);
      if (aliases.has(key.toLowerCase()) || info.isSymbolicLink()) fail();
      aliases.add(key.toLowerCase());
      if (info.isDirectory()) await visit(path, depth + 1);
      else {
        let data;
        try {
          data = await heldFile(path, 512 * 1024 ** 2, false, allowEmptyLeaf);
        } catch (error) {
          const denial = new Error("WINDOWS_ACQUISITION_CENSUS_FAILED");
          denial.censusDiagnostic = {
            version: 1,
            path: key,
            errorCode:
              typeof error.code === "string" &&
              /^[A-Z_]{1,64}$/u.test(error.code)
                ? error.code
                : "WINDOWS_ACQUISITION_HELD_FILE_DENIED",
            held: error.heldDiagnostic ?? null,
          };
          throw denial;
        }
        if (!data.length && /\.(?:exe|dll|pyd|node)$/iu.test(key))
          fail("WINDOWS_ACQUISITION_CLOSURE_INVALID");
        result.push({ path: key, bytes: data.length, sha256: hash(data) });
      }
    }
  }
  await visit(root);
  return result.sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
}
/** Compare actual held-file inventories, including empty code/bookkeeping leaves. */
export function censusChanges(before, after) {
  const collect = (rows) => {
    if (!Array.isArray(rows) || rows.length > 30000) fail();
    const entries = new Map(),
      aliases = new Set();
    let previous = "";
    for (const value of rows) {
      const row = exactRecord(value, ["path", "bytes", "sha256"]);
      acquisitionRelativePath(row.path);
      if (
        row.path <= previous ||
        aliases.has(row.path.toLowerCase()) ||
        !Number.isSafeInteger(row.bytes) ||
        row.bytes < 0 ||
        row.bytes > 512 * 1024 ** 2 ||
        typeof row.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(row.sha256) ||
        (row.bytes === 0 &&
          (row.sha256 !== hash(Buffer.alloc(0)) ||
            /\.(?:exe|dll|pyd|node)$/iu.test(row.path)))
      )
        fail();
      previous = row.path;
      aliases.add(row.path.toLowerCase());
      entries.set(row.path, { bytes: row.bytes, sha256: row.sha256 });
    }
    return entries;
  };
  const old = collect(before),
    current = collect(after),
    changes = [];
  for (const path of [...new Set([...old.keys(), ...current.keys()])].sort()) {
    const left = old.get(path),
      right = current.get(path);
    if (
      !left ||
      !right ||
      left.bytes !== right.bytes ||
      left.sha256 !== right.sha256
    )
      changes.push({
        path,
        change: !left ? "added" : !right ? "removed" : "changed",
        before: left ?? null,
        after: right ?? null,
      });
  }
  return changes;
}
async function sourcePinned(path, digest) {
  const data = await heldFile(path, 65536);
  if (hash(data) !== digest) fail("WINDOWS_ACQUISITION_SOURCE_PIN_CHANGED");
  return data;
}
/** Reuse the existing bounded duplicate-key-rejecting parser for build records. */
export async function parseAcquisitionJson(value, maximum = 4 * 1024 ** 2) {
  const bytes = Buffer.from(value);
  if (!bytes.length || bytes.length > maximum)
    fail("WINDOWS_ACQUISITION_JSON_INVALID");
  const path =
    dirname(script) === join(workerRoot, "source")
      ? join(workerRoot, "source/strict-json.ts")
      : join(workerRoot, "../chrome-extension/src/shared/strict-json.ts");
  await sourcePinned(path, ACQUISITION_SOURCE_PINS.strictJson);
  const { parseStrictJson } = await import(pathToFileURL(path).href);
  return parseStrictJson(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    maximum,
    16384,
  );
}
async function consumerPins(path) {
  await sourcePinned(path, ACQUISITION_SOURCE_PINS.consumerPins);
  const {
    WINDOWS_CONSUMER_PINS: pins,
    WINDOWS_CONSUMER_DOWNLOADER_WHEELS: approved,
  } = await import(pathToFileURL(path).href);
  if (
    pins.node !== "24.18.0" ||
    pins.deno !== "2.9.7" ||
    pins.provider !== "2.0.1" ||
    pins.downloader !== "2026.08.19" ||
    pins.denoArchiveSha256 !== ACQUISITION_ARTIFACTS.deno.sha256 ||
    pins.canvasArchiveSha256 !== ACQUISITION_ARTIFACTS.canvas.sha256 ||
    pins.nodeArchiveSha256 !== ACQUISITION_ARTIFACTS.node.sha256 ||
    JSON.stringify(approved) !==
      JSON.stringify(
        wheels.map(({ file, version, bytes, sha256 }) => ({
          file,
          version,
          bytes,
          sha256,
        })),
      )
  )
    fail("WINDOWS_ACQUISITION_SOURCE_PIN_CHANGED");
  return pins;
}
async function metadata(root) {
  const results = [];
  for (const [name, url, asset, pin] of [
    [
      "deno-release.json",
      "https://api.github.com/repos/denoland/deno/releases/tags/v2.9.7",
      ACQUISITION_ARTIFACTS.deno.file,
      ACQUISITION_ARTIFACTS.deno,
    ],
    [
      "canvas-release.json",
      "https://api.github.com/repos/Automattic/node-canvas/releases/tags/v3.2.3",
      ACQUISITION_ARTIFACTS.canvas.file,
      ACQUISITION_ARTIFACTS.canvas,
    ],
  ]) {
    const bytes = await transfer(url, 4 * 1024 ** 2),
      value = await parseAcquisitionJson(bytes),
      found = value.assets?.filter((entry) => entry.name === asset);
    if (
      found?.length !== 1 ||
      found[0].size !== pin.bytes ||
      found[0].digest !== `sha256:${pin.sha256}` ||
      found[0].browser_download_url !== pin.url ||
      value.draft ||
      value.prerelease
    )
      fail("WINDOWS_ACQUISITION_RELEASE_CHANGED");
    await exclusiveFile(join(root, name), bytes);
    results.push({ url, sha256: hash(bytes) });
  }
  const nodeUrl = "https://nodejs.org/dist/v24.18.0/SHASUMS256.txt",
    bytes = await transfer(nodeUrl, 65536);
  if (
    !bytes
      .toString("utf8")
      .split("\n")
      .includes(
        `${ACQUISITION_ARTIFACTS.node.sha256}  ${ACQUISITION_ARTIFACTS.node.file}`,
      )
  )
    fail("WINDOWS_ACQUISITION_RELEASE_CHANGED");
  await exclusiveFile(join(root, "node-SHASUMS256.txt"), bytes);
  results.push({ url: nodeUrl, sha256: hash(bytes) });
  for (const pin of wheels) {
    const url = `https://pypi.org/pypi/${pin.project}/${pin.pypiVersion}/json`,
      bytes = await transfer(url, 2 * 1024 ** 2),
      value = await parseAcquisitionJson(bytes),
      found = value.urls?.filter((entry) => entry.filename === pin.file);
    if (
      value.info?.name !== pin.project ||
      value.info.version !== pin.pypiVersion ||
      found?.length !== 1 ||
      found[0].url !== pin.url ||
      found[0].size !== pin.bytes ||
      found[0].digests?.sha256 !== pin.sha256 ||
      found[0].packagetype !== "bdist_wheel" ||
      found[0].yanked
    )
      fail("WINDOWS_ACQUISITION_RELEASE_CHANGED");
    await exclusiveFile(join(root, `${pin.project}-release.json`), bytes);
    results.push({ url, sha256: hash(bytes) });
  }
  return results;
}
export async function prepareAcquisitionCohort(target, artifactCache) {
  if (
    process.versions.node !== "24.18.0" ||
    typeof target !== "string" ||
    !isAbsolute(target) ||
    resolve(target) !== target ||
    target === dirname(target) ||
    target === workerRoot ||
    target.startsWith(workerRoot + sep) ||
    target === dirname(workerRoot) ||
    target.startsWith(dirname(workerRoot) + sep) ||
    /[\p{Cc}\p{Cf};"$<>|?*]/u.test(target)
  )
    fail("WINDOWS_ACQUISITION_BUILD_ARGUMENT_INVALID");
  if (artifactCache !== undefined) {
    if (
      typeof artifactCache !== "string" ||
      !isAbsolute(artifactCache) ||
      resolve(artifactCache) !== artifactCache ||
      artifactCache === target ||
      artifactCache.startsWith(target + sep)
    )
      fail("WINDOWS_ACQUISITION_BUILD_ARGUMENT_INVALID");
    const cache = await lstat(artifactCache);
    if (!cache.isDirectory() || cache.isSymbolicLink()) fail();
  }
  const parent = await lstat(dirname(target));
  if (!parent.isDirectory() || parent.isSymbolicLink()) fail();
  const pins = await consumerPins(
    join(workerRoot, "src/platform/windows/consumer-pins.ts"),
  );
  await sourcePinned(
    join(workerRoot, "src/platform/windows/pe-imports.ts"),
    ACQUISITION_SOURCE_PINS.peImports,
  );
  await mkdir(target, { mode: 0o700 });
  for (const dir of [
    "raw",
    "metadata",
    "source",
    "tools/node",
    "base/downloader",
    "base/youtube/bin",
    "base/youtube/provider/src",
    "base/youtube/licenses/deno",
    "base/youtube/licenses/bgutil",
    "base/youtube/licenses/canvas",
    "base/canvas",
    "repository/worker/native/windows-consumer",
  ])
    await mkdir(join(target, dir), { recursive: true });
  const provenance = await metadata(join(target, "metadata")),
    raw = join(target, "raw");
  const artifacts = new Map();
  for (const [name, pin] of Object.entries(ACQUISITION_ARTIFACTS))
    artifacts.set(name, await pinnedDownload(pin, raw, artifactCache));
  for (const pin of wheels) await pinnedDownload(pin, raw, artifactCache);
  const node = pinnedZipFiles(
    artifacts.get("node"),
    new Set([
      "node-v24.18.0-win-x64/node.exe",
      "node-v24.18.0-win-x64/LICENSE",
    ]),
  );
  await exclusiveFile(
    join(target, "tools/node/node.exe"),
    node.get("node-v24.18.0-win-x64/node.exe"),
  );
  await exclusiveFile(
    join(target, "tools/node/LICENSE"),
    node.get("node-v24.18.0-win-x64/LICENSE"),
  );
  const deno = pinnedZipFiles(artifacts.get("deno"), new Set(["deno.exe"]));
  await exclusiveFile(
    join(target, "base/youtube/bin/deno.exe"),
    deno.get("deno.exe"),
  );
  const providerPrefix = "bgutil-ytdlp-pot-provider-2.0.1/",
    serverPrefix = `${providerPrefix}server/`;
  const provider = pinnedTarFiles(
    artifacts.get("provider"),
    (name, type) =>
      type !== "5" &&
      (name === `${providerPrefix}LICENSE` ||
        name.startsWith(`${serverPrefix}src/`) ||
        [
          `${serverPrefix}package.json`,
          `${serverPrefix}deno.lock`,
          `${serverPrefix}deno.json`,
        ].includes(name)),
  );
  if (
    !provider.has(`${providerPrefix}LICENSE`) ||
    !provider.has(`${serverPrefix}src/session_manager.ts`) ||
    !provider.has(`${serverPrefix}package.json`) ||
    !provider.has(`${serverPrefix}deno.lock`)
  )
    fail("WINDOWS_ACQUISITION_PROVIDER_SOURCE_CHANGED");
  for (const [name, data] of provider) {
    if (name === `${providerPrefix}LICENSE`) {
      await exclusiveFile(join(target, "base/youtube/provider/LICENSE"), data);
      await exclusiveFile(
        join(target, "base/youtube/licenses/bgutil/LICENSE"),
        data,
      );
    } else if (name !== `${serverPrefix}deno.json`)
      await exclusiveFile(
        join(target, "base/youtube/provider", name.slice(serverPrefix.length)),
        data,
      );
  }
  const session = join(target, "base/youtube/provider/src/session_manager.ts"),
    original = await heldFile(session, 65536),
    patched = Buffer.from(patchProviderSession(original.toString("utf8")));
  await writeFile(session, patched);
  await exclusiveFile(
    join(target, "metadata/session_manager.original.ts"),
    original,
  );
  const generate = await sourcePinned(
    join(
      workerRoot,
      "../chrome-extension/scripts/youtube-runtime/generate_once.ts",
    ),
    ACQUISITION_SOURCE_PINS.generate,
  );
  await exclusiveFile(
    join(target, "metadata/generate_once.original.ts"),
    await replaceAcquisitionGenerator(
      join(target, "base/youtube/provider/src/generate_once.ts"),
      generate,
    ),
  );
  await exclusiveFile(
    join(target, "base/youtube/licenses/bgutil/generate_once.ts"),
    generate,
  );
  await exclusiveFile(
    join(target, "base/youtube/licenses/bgutil/patch-provider.py"),
    await sourcePinned(
      join(
        workerRoot,
        "../chrome-extension/scripts/youtube-runtime/patch-provider.py",
      ),
      ACQUISITION_SOURCE_PINS.patch,
    ),
  );
  const pkgPath = join(target, "base/youtube/provider/package.json"),
    pkg = await parseAcquisitionJson(await heldFile(pkgPath, 65536), 65536);
  delete pkg.devDependencies;
  delete pkg.scripts;
  delete pkg.allowScripts;
  await writeFile(pkgPath, JSON.stringify(pkg) + "\n");
  await exclusiveFile(
    join(target, "base/youtube/provider/deno.json"),
    Buffer.from('{"nodeModulesDir":"manual","nodeModulesLinker":"hoisted"}\n'),
  );
  for (const [artifact, name, output] of [
    [
      "denoSource",
      "deno-2.9.7/LICENSE.md",
      "base/youtube/licenses/deno/LICENSE",
    ],
    [
      "canvasSource",
      "node-canvas-3.2.3/Readme.md",
      "base/youtube/licenses/canvas/Readme.md",
    ],
    [
      "canvasSource",
      "node-canvas-3.2.3/src/bmp/LICENSE.md",
      "base/youtube/licenses/canvas/bmp/LICENSE.md",
    ],
  ]) {
    const entries = pinnedTarFiles(
      artifacts.get(artifact),
      (path) => path === name,
    );
    if (!entries.has(name)) fail("WINDOWS_ACQUISITION_LICENSE_MISSING");
    await exclusiveFile(join(target, output), entries.get(name));
  }
  const canvas = canvasRuntimeFiles(
    pinnedTarFiles(artifacts.get("canvas"), (name, type) => type !== "5"),
  );
  for (const [name, data] of canvas) {
    await exclusiveFile(join(target, "base/canvas", name), data);
  }
  const bootstrap = await sourcePinned(
    join(workerRoot, "../chrome-extension/engine/downloader_bootstrap.py"),
    ACQUISITION_SOURCE_PINS.bootstrap,
  );
  await exclusiveFile(
    join(target, "base/downloader/downloader_bootstrap.py"),
    bootstrap,
  );
  for (const pin of wheels)
    await copyFile(
      join(raw, pin.file),
      join(target, "base/downloader", pin.file),
      constants.COPYFILE_EXCL,
    );
  await exclusiveFile(
    join(target, "base/downloader/identity.json"),
    Buffer.from(
      JSON.stringify({
        schema_version: 1,
        source: "yt-dlp/yt-dlp",
        asset: "python-wheels",
        version: pins.downloader,
        bootstrap: {
          file: "downloader_bootstrap.py",
          bytes: bootstrap.length,
          sha256: hash(bootstrap),
        },
        wheels: wheels.map(({ file, version, bytes, sha256 }) => ({
          file,
          version,
          bytes,
          sha256,
        })),
      }) + "\n",
    ),
  );
  const notes =
    "Build inputs, not a public release or a Store approval. Bgutil is GPL-3.0-only; exact original source and applied modifications are recorded build-side. Deno and Canvas project notices are included; third-party native library notice/corresponding-source closure and redistribution rights still require review. The unchanged provider evaluates a fetched challenge interpreter; Store policy approval is not established. Raw source/binary archives stay build-side. No YouTube or paid-service request is made by this setup.\n";
  await exclusiveFile(
    join(target, "base/youtube/licenses/README.txt"),
    Buffer.from(notes),
  );
  for (const [from, to] of [
    [script, "setup-windows-acquisition.mjs"],
    [
      join(workerRoot, "src/platform/windows/consumer-pins.ts"),
      "consumer-pins.ts",
    ],
    [join(workerRoot, "src/platform/windows/pe-audit.ts"), "pe-audit.ts"],
    [join(workerRoot, "src/platform/windows/pe-imports.ts"), "pe-imports.ts"],
    [
      join(workerRoot, "../chrome-extension/src/shared/strict-json.ts"),
      "strict-json.ts",
    ],
  ])
    await exclusiveFile(
      join(target, "source", to),
      to === "pe-imports.ts"
        ? await sourcePinned(from, ACQUISITION_SOURCE_PINS.peImports)
        : await heldFile(from, 1024 ** 2),
    );
  await exclusiveFile(
    join(target, "repository/worker/native/windows-consumer/membership.cpp"),
    Buffer.from(membershipSource),
  );
  await exclusiveFile(
    join(target, "source/owned-code-acl.ps1"),
    Buffer.from(ownedCodeAclSource),
  );
  const { auditWindowsX64Binary } = await import(
      pathToFileURL(join(target, "source/pe-audit.ts")).href
    ),
    { readWindowsX64Imports } = await import(
      pathToFileURL(join(target, "source/pe-imports.ts")).href
    ),
    nativeInputs = [];
  for (const path of [
    join(target, "tools/node/node.exe"),
    join(target, "base/youtube/bin/deno.exe"),
    ...[...canvas.keys()].map((name) => join(target, "base/canvas", name)),
  ]) {
    const input = relative(target, path).split(sep).join("/");
    try {
      await auditWindowsX64Binary(path);
      nativeInputs.push({
        path: input,
        imports: await readWindowsX64Imports(path),
      });
    } catch {
      await exclusiveFile(
        join(target, "metadata/native-input-failure.json"),
        Buffer.from(
          JSON.stringify({
            version: 1,
            path: input,
            code: "WINDOWS_ACQUISITION_NATIVE_INPUT_INVALID",
            executesBinaries: false,
            qualified: false,
          }) + "\n",
        ),
      );
      fail("WINDOWS_ACQUISITION_NATIVE_INPUT_INVALID");
    }
  }
  await exclusiveFile(
    join(target, "metadata/native-input-imports.json"),
    Buffer.from(
      JSON.stringify(
        {
          version: 1,
          scope: "static-pinned-input-pe-headers-and-imports",
          executesBinaries: false,
          imports: nativeInputs,
        },
        null,
        2,
      ) + "\n",
    ),
  );
  const nodeBytes = await heldFile(join(target, "tools/node/node.exe"));
  await exclusiveFile(
    join(target, "repository/worker/native/windows-consumer/CMakeLists.txt"),
    Buffer.from(
      acquisitionCmake({ bytes: nodeBytes.length, sha256: hash(nodeBytes) }),
    ),
  );
  await exclusiveFile(
    join(target, "metadata/build-provenance.json"),
    Buffer.from(
      JSON.stringify(
        {
          version: 1,
          platform: "win32",
          architecture: "x64",
          pins,
          artifacts: ACQUISITION_ARTIFACTS,
          metadata: provenance,
          sourcePins: ACQUISITION_SOURCE_PINS,
          offlineQualified: false,
          licenseApproval: "pending",
          storePolicyApproval: "pending",
          rawArchivesConsumerContent: false,
        },
        null,
        2,
      ) + "\n",
    ),
  );
  const files = await listFiles(target);
  await exclusiveFile(
    join(target, "frozen-inputs.json"),
    Buffer.from(
      JSON.stringify(
        { version: 1, purpose: "windows-acquisition-build-inputs", files },
        null,
        2,
      ) + "\n",
    ),
  );
  return {
    root: target,
    sourceDirectory: join(target, "repository/worker/native/windows-consumer"),
    files: files.length,
    prepared: true,
    offlineQualified: false,
    consumerReady: false,
    licenseApproval: "pending",
    storePolicyApproval: "pending",
  };
}

export function assertMembershipObservation(value) {
  value = exactRecord(value, [
    "version",
    "sessionId",
    "inJob",
    "killOnClose",
    "breakaway",
    "elevated",
  ]);
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !==
      "breakaway,elevated,inJob,killOnClose,sessionId,version" ||
    value.version !== 1 ||
    value.sessionId !== 1 ||
    value.inJob !== true ||
    typeof value.killOnClose !== "boolean" ||
    typeof value.breakaway !== "boolean" ||
    value.elevated !== false
  )
    fail("WINDOWS_ACQUISITION_GUARD_REQUIRED");
  // Supplementary observation only. Root's original QA Job controller owns
  // authorization, lifetime, census and confirmed descendant retirement.
  // QueryInformationJobObject(NULL) describes the immediate associated Job;
  // neither its creator nor the original guard's handle is inferred here.
}
export async function materializeAcquisitionTree(
  source,
  destination,
  allowedRoot,
) {
  const authority = await realpath(allowedRoot),
    ancestors = new Set();
  let files = 0,
    total = 0;
  const permitted = (path) =>
    path === authority || path.startsWith(authority + sep);
  const omit = (name) =>
    /(?:^|\/)(?:tests?|fixtures?|examples?|__pycache__|\.cache|\.git|\.npmrc|\.env[^/]*|\.modules\.yaml|\.pnpm-workspace-state-v1\.json|\.package-lock\.json)(?:\/|$)|\.(?:map|pyc|pdb|lib|a|dylib|so)$/iu.test(
      name,
    );
  async function visit(from, to, prefix = "", depth = 0) {
    const actual = await realpath(from),
      info = await lstat(actual);
    if (
      !permitted(actual) ||
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      depth > 32 ||
      ancestors.has(actual)
    )
      fail("WINDOWS_ACQUISITION_LINK_ESCAPE");
    ancestors.add(actual);
    await mkdir(to, { mode: 0o700 });
    try {
      for (const name of (await readdir(actual)).sort()) {
        const key = acquisitionRelativePath(
            prefix ? `${prefix}/${name}` : name,
          ),
          input = join(actual, name),
          target = await realpath(input);
        if (!permitted(target)) fail("WINDOWS_ACQUISITION_LINK_ESCAPE");
        if (omit(key)) continue;
        const state = await lstat(target);
        if (state.isDirectory())
          await visit(target, join(to, name), key, depth + 1);
        else {
          if (
            !state.isFile() ||
            state.size < 0 ||
            (state.size === 0 && /\.(?:exe|dll|pyd|node)$/iu.test(key)) ||
            state.size > 256 * 1024 ** 2 ||
            ++files > 30000 ||
            (total += state.size) > 1024 ** 3
          )
            fail("WINDOWS_ACQUISITION_CLOSURE_INVALID");
          // Hold the cache input while reading it; final files are independent.
          const bytes = await heldFile(target, 256 * 1024 ** 2, true, true);
          if (bytes.length !== state.size || (await realpath(input)) !== target)
            fail("WINDOWS_ACQUISITION_SOURCE_CHANGED");
          await exclusiveFile(join(to, name), bytes);
        }
      }
    } finally {
      ancestors.delete(actual);
    }
  }
  await visit(source, destination);
  return { files, bytes: total };
}
export async function verifyFrozenInputs(cohort) {
  const bytes = await heldFile(
      join(cohort, "frozen-inputs.json"),
      8 * 1024 ** 2,
    ),
    value = await parseAcquisitionJson(bytes, 8 * 1024 ** 2);
  if (
    !value ||
    Object.keys(value).sort().join() !== "files,purpose,version" ||
    value.version !== 1 ||
    value.purpose !== "windows-acquisition-build-inputs" ||
    !Array.isArray(value.files) ||
    value.files.length < 10 ||
    value.files.length > 30000
  )
    fail("WINDOWS_ACQUISITION_FROZEN_INPUT_INVALID");
  const seen = new Set();
  let previous = "";
  for (const row of value.files) {
    if (
      !row ||
      Object.keys(row).sort().join() !== "bytes,path,sha256" ||
      !Number.isSafeInteger(row.bytes) ||
      row.bytes < 1 ||
      row.bytes > 512 * 1024 ** 2 ||
      !/^[a-f0-9]{64}$/u.test(row.sha256)
    )
      fail("WINDOWS_ACQUISITION_FROZEN_INPUT_INVALID");
    acquisitionRelativePath(row.path);
    if (
      row.path <= previous ||
      seen.has(row.path.toLowerCase()) ||
      !/^(?:base|raw|metadata|source|tools|repository)\//u.test(row.path)
    )
      fail("WINDOWS_ACQUISITION_FROZEN_INPUT_INVALID");
    seen.add(row.path.toLowerCase());
    previous = row.path;
    const data = await heldFile(join(cohort, ...row.path.split("/")));
    if (data.length !== row.bytes || hash(data) !== row.sha256)
      fail("WINDOWS_ACQUISITION_FROZEN_INPUT_CHANGED");
  }
  for (const name of [
    "source/setup-windows-acquisition.mjs",
    "source/consumer-pins.ts",
    "source/pe-audit.ts",
    "source/pe-imports.ts",
    "source/strict-json.ts",
    "source/owned-code-acl.ps1",
    "repository/worker/native/windows-consumer/membership.cpp",
    "repository/worker/native/windows-consumer/CMakeLists.txt",
    "tools/node/node.exe",
    "base/youtube/bin/deno.exe",
  ])
    if (!seen.has(name.toLowerCase()))
      fail("WINDOWS_ACQUISITION_FROZEN_INPUT_INVALID");
  const observed = [];
  for (const prefix of [
    "base",
    "raw",
    "metadata",
    "source",
    "tools",
    "repository",
  ])
    for (const row of await listFiles(join(cohort, prefix)))
      observed.push(`${prefix}/${row.path}`);
  const declared = new Set(value.files.map((row) => row.path));
  if (
    observed.length !== seen.size ||
    observed.some((path) => !declared.has(path))
  )
    fail("WINDOWS_ACQUISITION_FROZEN_INPUT_CHANGED");
  return value;
}
/** Called only by the frozen CMake target inside root's original Session 1 QA Job. */
export async function assembleFrozenAcquisition() {
  if (
    process.platform !== "win32" ||
    process.arch !== "x64" ||
    process.versions.node !== "24.18.0" ||
    dirname(script) !== join(workerRoot, "source")
  )
    fail("WINDOWS_ACQUISITION_NATIVE_REQUIRED");
  const cohort = workerRoot,
    pins = await consumerPins(join(cohort, "source/consumer-pins.ts"));
  await verifyFrozenInputs(cohort);
  const { auditWindowsX64Binary } = await import(
      pathToFileURL(join(cohort, "source/pe-audit.ts")).href
    ),
    { readWindowsX64Imports } = await import(
      pathToFileURL(join(cohort, "source/pe-imports.ts")).href
    );
  const witness = join(
    cohort,
    "build-tools/musicmute-acquisition-membership.exe",
  );
  await auditWindowsX64Binary(witness);
  const witnessBefore = hash(await heldFile(witness, 16 * 1024 ** 2)),
    deno = join(cohort, "base/youtube/bin/deno.exe");
  const work = join(cohort, "build-work");
  await mkdir(work, { mode: 0o700 });
  const environment = acquisitionEnvironment(work, process.env.SystemRoot),
    reports = [];
  async function membership() {
    if (hash(await heldFile(witness, 16 * 1024 ** 2)) !== witnessBefore)
      fail("WINDOWS_ACQUISITION_GUARD_CHANGED");
    let stdout;
    try {
      ({ stdout } = await execute(witness, [], {
        cwd: dirname(witness),
        env: environment,
        timeout: 10000,
        maxBuffer: 16384,
        windowsHide: true,
      }));
    } catch (error) {
      let observation = null;
      try {
        const record = exactRecord(
          await parseAcquisitionJson(error.stdout, 16384),
          [
            "version",
            "sessionId",
            "inJob",
            "killOnClose",
            "breakaway",
            "elevated",
          ],
        );
        if (
          record.version === 1 &&
          Number.isSafeInteger(record.sessionId) &&
          record.sessionId >= 0 &&
          ["inJob", "killOnClose", "breakaway", "elevated"].every(
            (key) => typeof record[key] === "boolean",
          )
        )
          observation = record;
      } catch {}
      const exitCode =
        typeof error.code === "number" && Number.isSafeInteger(error.code)
          ? error.code
          : null;
      const errorCode =
        typeof error.code === "string" && /^[A-Z0-9_]{1,40}$/u.test(error.code)
          ? error.code
          : null;
      await exclusiveFile(
        join(work, "membership-start-failed.json"),
        Buffer.from(
          JSON.stringify({
            version: 1,
            exitCode,
            errorCode,
            signal:
              typeof error.signal === "string" &&
              /^[A-Z0-9]{1,20}$/u.test(error.signal)
                ? error.signal
                : null,
            stdoutBytes: Buffer.byteLength(error.stdout ?? ""),
            stderrBytes: Buffer.byteLength(error.stderr ?? ""),
            guardianAuthority: "original-root-qa-job-report-required",
            observationScope: "immediate-associated-job-only",
            qualified: false,
            observation,
          }) + "\n",
        ),
      );
      fail("WINDOWS_ACQUISITION_GUARD_REQUIRED");
    }
    assertMembershipObservation(await parseAcquisitionJson(stdout, 16384));
  }
  async function run(
    name,
    binary,
    args,
    cwd,
    env = environment,
    timeout = 180000,
  ) {
    await membership();
    try {
      const result = await execute(binary, args, {
        cwd,
        env,
        timeout,
        maxBuffer: 256 * 1024,
        windowsHide: true,
      });
      await exclusiveFile(
        join(work, `${name}.stdout.txt`),
        Buffer.from(result.stdout || "\n"),
      );
      await exclusiveFile(
        join(work, `${name}.stderr.txt`),
        Buffer.from(result.stderr || "\n"),
      );
      reports.push({ step: name, passed: true });
      return result.stdout.trim();
    } catch (error) {
      await exclusiveFile(
        join(work, `${name}.failed.txt`),
        Buffer.from(
          String(error.stderr ?? error.message ?? "failed").slice(0, 262144),
        ),
      ).catch(() => {});
      fail("WINDOWS_ACQUISITION_NATIVE_STEP_FAILED");
    }
  }
  const version = await run("deno-version", deno, ["--version"], work);
  if (!version.startsWith(`deno ${pins.deno} `))
    fail("WINDOWS_ACQUISITION_DENO_VERSION_CHANGED");
  const provider = join(work, "provider");
  await materializeAcquisitionTree(
    join(cohort, "base/youtube/provider"),
    provider,
    cohort,
  );
  const originalLock = await parseAcquisitionJson(
    await heldFile(join(provider, "deno.lock"), 4 * 1024 ** 2),
  );
  await run(
    "provider-production-install",
    deno,
    [...ACQUISITION_INSTALL_ARGUMENTS],
    provider,
  );
  const derivedLock = await parseAcquisitionJson(
    await heldFile(join(provider, "deno.lock"), 4 * 1024 ** 2),
  );
  assertDerivedProviderLock(originalLock, derivedLock);
  const canvas = await realpath(join(provider, "node_modules/canvas"));
  if (!canvas.startsWith(work + sep)) fail("WINDOWS_ACQUISITION_LINK_ESCAPE");
  const canvasPackage = await parseAcquisitionJson(
    await heldFile(join(canvas, "package.json"), 65536, true),
  );
  if (canvasPackage.name !== "canvas" || canvasPackage.version !== "3.2.3")
    fail("WINDOWS_ACQUISITION_CANVAS_VERSION_CHANGED");
  for (const row of await listFiles(join(cohort, "base/canvas"))) {
    const target = join(canvas, ...row.path.split("/"));
    await exclusiveFile(
      target,
      await heldFile(join(cohort, "base/canvas", ...row.path.split("/"))),
    );
  }
  await run(
    "provider-frozen-cache",
    deno,
    ["cache", "--frozen", "--no-check", "src/generate_once.ts"],
    provider,
  );
  const inputRoot = join(cohort, "inputs");
  await mkdir(inputRoot, { mode: 0o700 });
  const youtube = join(inputRoot, "youtube"),
    downloader = join(inputRoot, "downloader");
  await materializeAcquisitionTree(
    join(cohort, "base/youtube"),
    youtube,
    cohort,
  );
  // Only replace this newly owned provider copy with the now-complete graph.
  const generatedProvider = join(youtube, "provider");
  const { rm } = await import("node:fs/promises");
  await rm(generatedProvider, { recursive: true });
  await materializeAcquisitionTree(provider, generatedProvider, cohort);
  await materializeAcquisitionTree(
    join(cohort, "base/downloader"),
    downloader,
    cohort,
  );
  const rows = await listFiles(youtube, true),
    imports = [];
  for (const row of rows)
    if (/\.(?:exe|dll|pyd|node)$/iu.test(row.path)) {
      const path = join(youtube, ...row.path.split("/"));
      await auditWindowsX64Binary(path);
      imports.push({
        path: row.path,
        imports: await readWindowsX64Imports(path),
      });
    }
  const privateCheck = join(work, "offline-check");
  await mkdir(privateCheck, { mode: 0o700 });
  const offlineEnvironment = acquisitionEnvironment(
    privateCheck,
    process.env.SystemRoot,
  );
  async function recordPins(name, pins) {
    const bytes = Buffer.from(JSON.stringify(pins) + "\n");
    if (bytes.length > 8 * 1024 ** 2)
      fail("WINDOWS_ACQUISITION_CENSUS_TOO_LARGE");
    await exclusiveFile(join(work, name), bytes);
    return { file: name, bytes: bytes.length, sha256: hash(bytes) };
  }
  const ordinaryBefore = await recordPins("relocated-before-pins.json", rows);
  let ordinaryOutput, ordinaryFailure;
  const offlineArgs = (privateRoot) => [
    "run",
    "--cached-only",
    "--frozen",
    "--no-check",
    "--node-modules-dir=manual",
    "--node-modules-linker=hoisted",
    "--deny-net",
    "--allow-env",
    `--allow-read=${generatedProvider},${privateRoot}`,
    `--allow-ffi=${join(generatedProvider, "node_modules")}`,
    `--allow-write=${privateRoot}`,
    "src/generate_once.ts",
    "--musicmute-check",
  ];
  try {
    ordinaryOutput = await run(
      "relocated-offline-canvas-provider",
      join(youtube, "bin/deno.exe"),
      offlineArgs(privateCheck),
      generatedProvider,
      offlineEnvironment,
      30000,
    );
  } catch (error) {
    ordinaryFailure = error;
  }
  // Preserve the probe's first failure even if its complete after-census also
  // fails. A failed census supplies no unchanged-code proof or qualification.
  let ordinaryAfterRows, ordinaryCensusFailure;
  try {
    ordinaryAfterRows = await listFiles(youtube, true);
  } catch (error) {
    ordinaryCensusFailure = error;
  }
  const ordinaryAfter = ordinaryAfterRows
    ? await recordPins("relocated-after-pins.json", ordinaryAfterRows)
    : null;
  const ordinaryChanges = ordinaryAfterRows
    ? censusChanges(rows, ordinaryAfterRows)
    : null;
  await exclusiveFile(
    join(work, "relocated-census-result.json"),
    Buffer.from(
      JSON.stringify({
        version: 1,
        scope: "owned-relocated-provider-code-bytes-only",
        before: ordinaryBefore,
        after: ordinaryAfter,
        changes: ordinaryChanges,
        censusCompleted: ordinaryCensusFailure === undefined,
        censusErrorCode: ordinaryCensusFailure
          ? "WINDOWS_ACQUISITION_POST_CENSUS_FAILED"
          : null,
        censusDiagnostic: ordinaryCensusFailure?.censusDiagnostic ?? null,
        codeUnchanged: ordinaryChanges !== null && ordinaryChanges.length === 0,
        offlineProbePassed: ordinaryOutput === "ready",
        storeNamespaceProven: false,
      }) + "\n",
    ),
  );
  if (ordinaryFailure) throw ordinaryFailure;
  if (ordinaryCensusFailure) fail("WINDOWS_ACQUISITION_POST_CENSUS_FAILED");
  if (ordinaryOutput !== "ready")
    fail("WINDOWS_ACQUISITION_OFFLINE_PROVIDER_FAILED");
  // Deno's relocated dependency bookkeeping must not change any inventoried
  // byte or add a leaf while the actual offline provider check runs.
  if (!ordinaryChanges || ordinaryChanges.length)
    fail("WINDOWS_ACQUISITION_RELOCATED_CODE_CHANGED");
  const sealedDenoCache = offlineEnvironment.DENO_DIR;
  await mkdir(sealedDenoCache, { recursive: true, mode: 0o700 });
  const cacheBeforeRows = await listFiles(sealedDenoCache, true);
  const cacheBefore = await recordPins(
    "fixed-deno-cache-before-pins.json",
    cacheBeforeRows,
  );
  const powershell = win32.join(
    process.env.SystemRoot,
    "System32/WindowsPowerShell/v1.0/powershell.exe",
  );
  const powershellSha =
    "0ff6f2c94bc7e2833a5f7e16de1622e5dba70396f31c7d5f56381870317e8c46";
  // Only this exact Windows-protected, Microsoft-signed system tool may have
  // OS servicing hard links. Owned source/consumer leaves remain single-link.
  if (hash(await heldFile(powershell, 16 * 1024 ** 2, true)) !== powershellSha)
    fail("WINDOWS_ACQUISITION_POWERSHELL_CHANGED");
  const aclScript = join(cohort, "source/owned-code-acl.ps1"),
    backup = join(work, "code-root-dacl-before.json"),
    aclArgs = (action) => [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      aclScript,
      "-Action",
      action,
    ];
  let readonlyFailure,
    restored = false,
    sealAttempted = false,
    deniedLeaves = 0,
    backupSha,
    privatePins;
  let readonlyAfter,
    cacheAfter,
    readonlyChanges = [],
    cacheChanges = [];
  try {
    sealAttempted = true;
    const seal = await parseAcquisitionJson(
      await run(
        "own-code-acl-seal",
        powershell,
        aclArgs("seal"),
        work,
        environment,
        30000,
      ),
    );
    if (
      seal.version !== 1 ||
      seal.action !== "seal" ||
      seal.scope !== "own-qa-code-root-dacl-only" ||
      seal.rootsSealed !== 2 ||
      seal.sessionId !== 1 ||
      seal.elevated !== false ||
      seal.ownerMayRestoreDacl !== true ||
      typeof seal.backupSha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(seal.backupSha256) ||
      hash(await heldFile(backup, 65536)) !== seal.backupSha256
    )
      fail("WINDOWS_ACQUISITION_ACL_SEAL_INVALID");
    backupSha = seal.backupSha256;
    for (const [root, inventory] of [
      [youtube, rows],
      [sealedDenoCache, cacheBeforeRows],
    ]) {
      for (const row of inventory) {
        let file;
        try {
          file = await open(join(root, ...row.path.split("/")), "r+");
        } catch (error) {
          if (["EACCES", "EPERM"].includes(error.code)) {
            deniedLeaves++;
            continue;
          }
          throw error;
        } finally {
          if (file) await file.close();
        }
        fail("WINDOWS_ACQUISITION_CODE_WRITABLE");
      }
      let file;
      try {
        file = await open(
          join(root, "MusicMuteWriteDeniedProbe.txt"),
          "wx",
          0o600,
        );
      } catch (error) {
        if (!["EACCES", "EPERM"].includes(error.code)) throw error;
      } finally {
        if (file) await file.close();
      }
      if (file) fail("WINDOWS_ACQUISITION_CODE_DIRECTORY_WRITABLE");
      let created = false;
      try {
        await mkdir(join(root, "MusicMuteWriteDeniedDirectory"));
        created = true;
      } catch (error) {
        if (!["EACCES", "EPERM"].includes(error.code)) throw error;
      }
      if (created) fail("WINDOWS_ACQUISITION_CODE_DIRECTORY_WRITABLE");
    }
    const readonlyPrivate = join(work, "readonly-private-data");
    await mkdir(readonlyPrivate, { mode: 0o700 });
    const readonlyEnvironment = {
      ...acquisitionEnvironment(readonlyPrivate, process.env.SystemRoot),
      DENO_DIR: sealedDenoCache,
    };
    const readonlyOutput = await run(
      "readonly-offline-canvas-provider",
      join(youtube, "bin/deno.exe"),
      offlineArgs(readonlyPrivate),
      generatedProvider,
      readonlyEnvironment,
      30000,
    );
    if (readonlyOutput !== "ready")
      fail("WINDOWS_ACQUISITION_READONLY_PROVIDER_FAILED");
    const privateRows = await listFiles(readonlyPrivate, true);
    privatePins = await recordPins(
      "readonly-private-data-pins.json",
      privateRows,
    );
    if (
      privateRows.some((row) =>
        /\.(?:js|jsx|cjs|mjs|ts|tsx|wasm|exe|dll|pyd|node|py|pyc)$/iu.test(
          row.path,
        ),
      )
    )
      fail("WINDOWS_ACQUISITION_WRITABLE_CACHE_CODE");
  } catch (error) {
    readonlyFailure = error;
  } finally {
    try {
      const currentCode = await listFiles(youtube, true),
        currentCache = await listFiles(sealedDenoCache, true);
      readonlyAfter = await recordPins(
        "readonly-code-after-pins.json",
        currentCode,
      );
      cacheAfter = await recordPins(
        "readonly-deno-cache-after-pins.json",
        currentCache,
      );
      readonlyChanges = censusChanges(rows, currentCode);
      cacheChanges = censusChanges(cacheBeforeRows, currentCache);
      if (readonlyChanges.length || cacheChanges.length)
        readonlyFailure ??= new Error(
          "WINDOWS_ACQUISITION_READONLY_CODE_CHANGED",
        );
    } catch (error) {
      readonlyFailure ??= error;
    }
    if (sealAttempted) {
      try {
        if (backupSha && hash(await heldFile(backup, 65536)) !== backupSha)
          fail("WINDOWS_ACQUISITION_ACL_BACKUP_CHANGED");
        const restore = await parseAcquisitionJson(
          await run(
            "own-code-acl-restore",
            powershell,
            aclArgs("restore"),
            work,
            environment,
            30000,
          ),
        );
        if (
          restore.version !== 1 ||
          restore.action !== "restore" ||
          restore.scope !== "own-qa-code-root-dacl-only" ||
          restore.restored !== true ||
          restore.rootsRestored !== 2
        )
          fail("WINDOWS_ACQUISITION_ACL_RESTORE_INVALID");
        restored = true;
      } catch (error) {
        readonlyFailure ??= error;
      }
    }
    await exclusiveFile(
      join(work, "readonly-code-rehearsal.json"),
      Buffer.from(
        JSON.stringify({
          version: 1,
          scope: "own-qa-functional-dacl-rehearsal-only",
          passed: !readonlyFailure && restored,
          codeRoots: ["inputs/youtube", "build-work/offline-check/deno-cache"],
          codeBefore: ordinaryBefore,
          codeAfter: readonlyAfter ?? null,
          cacheBefore,
          cacheAfter: cacheAfter ?? null,
          deniedLeaves,
          codeChanges: readonlyChanges,
          cacheChanges,
          privateDataPins: privatePins ?? null,
          aclRestored: restored,
          ownerMayRestoreDacl: true,
          storeNamespaceProven: false,
          writableCacheCodeCopied: false,
        }) + "\n",
      ),
    );
  }
  if (readonlyFailure) throw readonlyFailure;
  if (
    !restored ||
    hash(await heldFile(powershell, 16 * 1024 ** 2, true)) !== powershellSha
  )
    fail("WINDOWS_ACQUISITION_ACL_RESTORE_INVALID");
  await verifyFrozenInputs(cohort);
  await membership();
  const source = {
    artifacts: ACQUISITION_ARTIFACTS,
    sourcePins: ACQUISITION_SOURCE_PINS,
  };
  await exclusiveFile(
    join(youtube, "identity.json"),
    Buffer.from(
      JSON.stringify({
        schema_version: 1,
        deno_version: pins.deno,
        provider_version: pins.provider,
        platform: "win32",
        arch: "x64",
        sources: source,
        files: rows,
      }) + "\n",
    ),
  );
  const receipt = {
    version: 1,
    purpose: "windows-acquisition-build-inputs",
    platform: "win32",
    architecture: "x64",
    denoVersion: pins.deno,
    providerVersion: pins.provider,
    downloaderVersion: pins.downloader,
    canvasVersion: "3.2.3",
    offlineQualified: true,
    consumerReady: false,
    qualificationScope: "relocated-offline-canvas-provider-only",
    realYouTubeRequests: false,
    paidServiceRequests: false,
    licenseApproval: "pending",
    storePolicyApproval: "pending",
    guardianAuthority: "original-root-qa-job-report-required",
    membershipObservationScope: "immediate-associated-job-only",
    qaReadonlyCodeRehearsal: "passed-functional-owned-projection-only",
    qaCodeAclRestored: true,
    sealedStoreNamespace: "pending",
    steps: reports,
    nativeImports: imports,
    files: rows.length,
  };
  await exclusiveFile(
    join(cohort, "qualification.json"),
    Buffer.from(JSON.stringify(receipt, null, 2) + "\n"),
  );
  return {
    offlineQualified: true,
    consumerReady: false,
    qualificationScope: "relocated-offline-canvas-provider-only",
    files: rows.length,
    downloaderRoot: downloader,
    youtubeRoot: youtube,
    licenseApproval: "pending",
    storePolicyApproval: "pending",
  };
}
async function main() {
  const args = process.argv.slice(2);
  let result;
  if (
    args[0] === "--fetch-build-inputs" &&
    (args.length === 2 || (args.length === 4 && args[2] === "--artifact-cache"))
  )
    result = await prepareAcquisitionCohort(args[1], args[3]);
  else if (args[0] === "--assemble-frozen" && args.length === 1)
    result = await assembleFrozenAcquisition();
  else fail("WINDOWS_ACQUISITION_BUILD_ARGUMENT_INVALID");
  process.stdout.write(JSON.stringify(result) + "\n");
}
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
)
  main().catch((error) => {
    const code = /^[A-Z_]{1,64}$/u.test(error?.message ?? "")
      ? error.message
      : "WINDOWS_ACQUISITION_SETUP_FAILED";
    process.stderr.write(JSON.stringify({ status: "failed", code }) + "\n");
    process.exitCode = 2;
  });
