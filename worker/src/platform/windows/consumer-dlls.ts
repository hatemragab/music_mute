import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { readWindowsX64Imports } from "./pe-imports.js";
import {
  WindowsPythonWheels,
  type WheelDllProof,
} from "./python-wheel-dlls.js";
export const CONSUMER_DLL_POLICY = "private-pe-imports-msvc-v3";

// Windows 10 22H2 OS/API-set dependencies are never copied from a builder's
// System32. Unknown libraries must resolve inside the matching private payload.
const SYSTEM_DLLS = new Set(
  [
    "advapi32",
    // Video for Windows capture is an OS dependency (Windows 2000 desktop+).
    "avicap32",
    "avrt",
    "bcrypt",
    "bcryptprimitives",
    // Cabinet decompression is supplied by Windows (Windows 2000 desktop+).
    "cabinet",
    "cfgmgr32",
    "combase",
    "comctl32",
    "comdlg32",
    "crypt32",
    "cryptbase",
    "cryptsp",
    "d3d11",
    "d3d12",
    "d3dcompiler_47",
    "dbghelp",
    "dnsapi",
    "dsound",
    "dwmapi",
    "dwrite",
    "dxcore",
    "dxgi",
    "gdi32",
    "gdi32full",
    "gdiplus",
    "hid",
    "imm32",
    "iphlpapi",
    "kernel32",
    "kernelbase",
    // CreateTransaction is a supported OS export (Vista+); never bundle its DLL.
    "ktmw32",
    "mf",
    "mfplat",
    "mfreadwrite",
    "mfuuid",
    "msacm32",
    // Windows Installer is an OS dependency of CPython's optional _msi module.
    "msi",
    "msimg32",
    "msvcrt",
    "mswsock",
    "ncrypt",
    "netapi32",
    "normaliz",
    "ntdll",
    "ole32",
    "oleacc",
    "oleaut32",
    "opengl32",
    "powrprof",
    "propsys",
    "psapi",
    "rpcrt4",
    "rstrtmgr",
    "runtimeobject",
    "secur32",
    "setupapi",
    "shell32",
    "shlwapi",
    "sspicli",
    "ucrtbase",
    "user32",
    "userenv",
    "usp10",
    "version",
    "wevtapi",
    "winhttp",
    "wininet",
    "winmm",
    "winspool.drv",
    "wintrust",
    "ws2_32",
    "wtsapi32",
    // XmlLite ships with Windows Vista+ and must not be redistributed.
    "xmllite",
  ].map((name) => (name.endsWith(".drv") ? name : `${name}.dll`)),
);
function system(name: string): boolean {
  return (
    SYSTEM_DLLS.has(name) ||
    /^(?:api-ms-win|ext-ms-win)-[a-z0-9-]+\.dll$/u.test(name)
  );
}
function msvc(name: string): boolean {
  return /^(?:vcruntime140(?:_[a-z0-9]+)?|msvcp140(?:_[a-z0-9]+|_atomic_wait|_codecvt_ids)?|msvcp140-[a-f0-9]{32}|concrt140|vcomp140)\.dll$/u.test(
    name,
  );
}
function debugRuntime(name: string): boolean {
  return /^(?:(?:vcruntime|msvcp|concrt|vcomp)140(?:_[a-z0-9_]+)?d|ucrtbased|msvcrtd)(?:-[a-f0-9]{32})?\.dll$/u.test(
    name,
  );
}
function component(path: string): string {
  // Store launchers are exact root entries, not a root DLL search namespace.
  if (path === "MusicMuteWorker.exe" || path === "MusicMuteSession.exe")
    return "store-launchers";
  for (const prefix of [
    "runtime/python/",
    "runtime/node/",
    "runtime/bin/",
    "runtime/native/",
    "app/",
    "tools/youtube/",
    "tools/downloader/",
  ])
    if (path.startsWith(prefix)) return prefix;
  throw new TypeError(
    "Consumer native binary is outside an approved private component",
  );
}
function key(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}
async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
interface FilePin {
  path: string;
  bytes: number;
  sha256: string;
}
interface MsvcGroup {
  kind: "executable" | "wheel";
  record: FilePin | null;
  sourceUrl: string;
  license: FilePin;
  files: (FilePin & { version: string })[];
}
interface MsvcEvidence {
  version: string | null;
  sourceUrl: string | null;
  license: FilePin | null;
  groups?: MsvcGroup[];
}
interface MsvcSource {
  schemaVersion: 1;
  architecture: "x64";
  sourceUrl: string;
  version: string;
  license: FilePin;
  files: FilePin[];
}
function object(value: unknown, fields: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== [...fields].sort().join()
  )
    throw new TypeError("Consumer MSVC source/notice record is invalid");
  return value as Record<string, unknown>;
}
function pin(value: unknown): FilePin {
  const row = object(value, ["path", "bytes", "sha256"]);
  if (
    typeof row.path !== "string" ||
    row.path.length > 240 ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]+$/u.test(row.path) ||
    row.path
      .split("/")
      .some((part) => !part || part === "." || part === "..") ||
    !Number.isSafeInteger(row.bytes) ||
    (row.bytes as number) < 1 ||
    (row.bytes as number) > 32 * 1024 * 1024 ||
    typeof row.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(row.sha256)
  )
    throw new TypeError("Consumer MSVC source pin is invalid");
  return row as unknown as FilePin;
}
async function verify(root: string, expected: FilePin): Promise<void> {
  const path = join(root, ...expected.path.split("/")),
    before = await lstat(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    before.size !== expected.bytes ||
    (await sha256(path)) !== expected.sha256
  )
    throw new TypeError(
      "Consumer MSVC DLL or license bytes differ from approved input",
    );
  const after = await lstat(path);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  )
    throw new TypeError("Consumer MSVC source changed during verification");
}
function microsoftUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error();
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    ![
      "aka.ms",
      "download.microsoft.com",
      "download.visualstudio.microsoft.com",
      "visualstudio.microsoft.com",
      "learn.microsoft.com",
    ].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    url.search ||
    url.href !== value
  )
    throw new Error();
  return value;
}
function runtimeVersion(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^14\.[0-9]{1,3}\.[0-9]{1,6}(?:\.[0-9]{1,6})?$/u.test(value) ||
    Number(value.split(".")[1]) < 29
  )
    throw new Error();
  return value;
}
async function scopedSource(
  root: string,
  libraries: readonly string[],
  wheels: WindowsPythonWheels,
  value: unknown,
): Promise<MsvcEvidence> {
  let groups: MsvcGroup[];
  try {
    const row = object(value, ["schemaVersion", "architecture", "groups"]);
    if (
      row.schemaVersion !== 3 ||
      row.architecture !== "x64" ||
      !Array.isArray(row.groups) ||
      row.groups.length < 1 ||
      row.groups.length > 32
    )
      throw new Error();
    const seen = new Set<string>(),
      owners = new Set<string>();
    groups = row.groups.map((value) => {
      const group = object(value, [
        "kind",
        "record",
        "sourceUrl",
        "license",
        "files",
      ]);
      if (group.kind !== "executable" && group.kind !== "wheel")
        throw new Error();
      const record = group.kind === "wheel" ? pin(group.record) : null;
      if (
        (group.kind === "executable" && group.record !== null) ||
        (record &&
          !/^runtime\/python\/Lib\/site-packages\/[A-Za-z0-9_.]+-[A-Za-z0-9_.+]+\.dist-info\/RECORD$/u.test(
            record.path,
          ))
      )
        throw new Error();
      const scope = record?.path ?? "runtime/python";
      if (owners.has(scope)) throw new Error();
      owners.add(scope);
      const sourceUrl = microsoftUrl(group.sourceUrl),
        license = pin(group.license);
      if (
        !license.path.startsWith("runtime/python/licenses/msvc/") ||
        license.bytes > 1024 * 1024 ||
        !/\.(?:txt|html|rtf)$/u.test(license.path) ||
        !Array.isArray(group.files) ||
        group.files.length < 1 ||
        group.files.length > 64
      )
        throw new Error();
      const versions = new Map<string, string>();
      const files = group.files.map((value) => {
        const file = object(value, ["path", "bytes", "sha256", "version"]);
        const entry = pin({
          path: file.path,
          bytes: file.bytes,
          sha256: file.sha256,
        });
        const version = runtimeVersion(file.version),
          name = basename(entry.path).toLowerCase();
        if (
          !libraries.includes(entry.path) ||
          !msvc(name) ||
          seen.has(entry.path.toLowerCase()) ||
          (group.kind === "executable" &&
            dirname(entry.path) !== "runtime/python")
        )
          throw new Error();
        seen.add(entry.path.toLowerCase());
        const identity = `${entry.bytes}:${entry.sha256}:${version}`,
          previous = versions.get(name);
        if (previous && previous !== identity) throw new Error();
        versions.set(name, identity);
        return { ...entry, version };
      });
      if (
        group.kind === "executable" &&
        new Set(files.map((file) => file.version)).size !== 1
      )
        throw new Error();
      return {
        kind: group.kind,
        record,
        sourceUrl,
        license,
        files,
      } as MsvcGroup;
    });
    if (seen.size !== libraries.length) throw new Error();
  } catch {
    throw new TypeError("Consumer MSVC source/notice record is invalid");
  }
  for (const group of groups) {
    await verify(root, group.license);
    if (group.record) await verify(root, group.record);
    for (const file of group.files) {
      await verify(root, file);
      if (group.record) await wheels.ownership(file.path, group.record);
    }
  }
  const primary = groups.find((group) => group.kind === "executable");
  return {
    version: primary?.files[0]?.version ?? null,
    sourceUrl: primary?.sourceUrl ?? null,
    license: primary?.license ?? null,
    groups,
  };
}
async function source(
  root: string,
  libraries: readonly string[],
  wheels: WindowsPythonWheels,
): Promise<MsvcEvidence | null> {
  if (!libraries.length) return null;
  const file = "runtime/python/redistributables.json",
    path = join(root, ...file.split("/")),
    info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.size < 2 ||
    info.size > 65536
  )
    throw new TypeError("Consumer MSVC redistribution evidence is required");
  let json: unknown;
  try {
    json = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new TypeError("Consumer MSVC source/notice record is invalid");
  }
  if (
    json &&
    typeof json === "object" &&
    "schemaVersion" in json &&
    json.schemaVersion === 3
  )
    return scopedSource(root, libraries, wheels, json);
  let parsed: MsvcSource;
  try {
    const row = object(json, [
        "schemaVersion",
        "architecture",
        "sourceUrl",
        "version",
        "license",
        "files",
      ]),
      url = new URL(String(row.sourceUrl));
    if (
      row.schemaVersion !== 1 ||
      row.architecture !== "x64" ||
      typeof row.version !== "string" ||
      !/^14\.[0-9]{1,3}\.[0-9]{1,6}(?:\.[0-9]{1,6})?$/u.test(row.version) ||
      Number(row.version.split(".")[1]) < 29 ||
      url.protocol !== "https:" ||
      ![
        "aka.ms",
        "download.microsoft.com",
        "download.visualstudio.microsoft.com",
        "visualstudio.microsoft.com",
      ].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.port ||
      url.hash ||
      url.search ||
      typeof row.sourceUrl !== "string" ||
      url.href !== row.sourceUrl ||
      !Array.isArray(row.files) ||
      row.files.length < 1 ||
      row.files.length > 64
    )
      throw new Error();
    parsed = {
      schemaVersion: 1,
      architecture: "x64",
      sourceUrl: row.sourceUrl,
      version: row.version,
      license: pin(row.license),
      files: row.files.map(pin),
    };
    const versions = new Map<string, string>();
    for (const entry of parsed.files) {
      const name = basename(entry.path).toLowerCase(),
        previous = versions.get(name);
      if (previous && previous !== `${entry.bytes}:${entry.sha256}`)
        throw new Error();
      versions.set(name, `${entry.bytes}:${entry.sha256}`);
    }
    if (
      !parsed.license.path.startsWith("runtime/python/licenses/msvc/") ||
      parsed.license.bytes > 1024 * 1024 ||
      !/\.(?:txt|html|rtf)$/u.test(parsed.license.path) ||
      new Set(parsed.files.map((entry) => entry.path.toLowerCase())).size !==
        parsed.files.length ||
      parsed.files.some(
        (entry) =>
          !libraries.includes(entry.path) ||
          !msvc(basename(entry.path).toLowerCase()) ||
          /^msvcp140-[a-f0-9]{32}\.dll$/u.test(
            basename(entry.path).toLowerCase(),
          ),
      ) ||
      parsed.files.length !== libraries.length
    )
      throw new Error();
  } catch {
    throw new TypeError("Consumer MSVC source/notice record is invalid");
  }
  await verify(root, parsed.license);
  for (const entry of parsed.files) await verify(root, entry);
  return {
    version: parsed.version,
    sourceUrl: parsed.sourceUrl,
    license: parsed.license,
  };
}
export interface ConsumerDllAudit {
  schemaVersion: 1;
  policy: typeof CONSUMER_DLL_POLICY;
  binaryCount: number;
  imports: {
    binary: string;
    name: string;
    kind: "import" | "delay";
    source: "windows" | "private" | "node-api-host";
    path?: string;
    wheel?: WheelDllProof;
  }[];
  msvc: MsvcEvidence | null;
}
/** Build-time static existence/architecture/notice closure only. Private DLL
 * search/bootstrap, symbol compatibility and dynamic loads remain native probes. */
export async function auditWindowsConsumerDlls(
  root: string,
  files: readonly string[],
): Promise<ConsumerDllAudit> {
  if (files.some((path) => system(basename(path).toLowerCase())))
    throw new TypeError(
      "Consumer payload must not redistribute Windows OS/API-set DLLs",
    );
  if (files.some((path) => debugRuntime(basename(path).toLowerCase())))
    throw new TypeError(
      "Consumer payload must not redistribute debug VC/UCRT libraries",
    );
  const binaries = files.filter((path) =>
    /\.(?:exe|dll|pyd|node)$/iu.test(path),
  );
  if (binaries.length < 1 || binaries.length > 8192)
    throw new TypeError("Consumer DLL audit binary limit exceeded");
  const paths = binaries.map((path) => ({
    path,
    key: key(root, path),
    name: basename(path).toLowerCase(),
  }));
  for (const row of paths) {
    component(row.key);
    if (system(row.name))
      throw new TypeError(
        "Consumer payload must not redistribute Windows OS/API-set DLLs",
      );
  }
  const wheels = await WindowsPythonWheels.read(root, files);
  const result: ConsumerDllAudit = {
    schemaVersion: 1,
    policy: CONSUMER_DLL_POLICY,
    binaryCount: binaries.length,
    imports: [],
    msvc: null,
  };
  for (const row of paths) {
    if (row.key.startsWith("runtime/python/")) await wheels.audit(row.key);
    const imported = await readWindowsX64Imports(row.path);
    for (const entry of imported) {
      if (debugRuntime(entry.name))
        throw new TypeError(
          "Consumer binary depends on a nonredistributable debug VC/UCRT library",
        );
      if (result.imports.length >= 32768)
        throw new TypeError("Consumer DLL audit import limit exceeded");
      if (entry.name === "node.exe") {
        // A Windows Node-API addon imports its host API, rather than loading
        // node.exe as a library or spawning it. Deno provides that API for the
        // pinned provider addon. Require the actual fixed host in this inventory;
        // static closure alone never proves symbol/ABI compatibility.
        const host =
          row.key.startsWith("tools/youtube/provider/") &&
          row.name.endsWith(".node")
            ? "tools/youtube/bin/deno.exe"
            : row.key.startsWith("app/node_modules/") &&
                row.name.endsWith(".node")
              ? "runtime/node/node.exe"
              : undefined;
        if (
          !host ||
          paths.filter((candidate) => candidate.key === host).length !== 1
        )
          throw new TypeError(
            "Consumer Node-API addon has no supported inventoried host",
          );
        result.imports.push({
          binary: row.key,
          ...entry,
          source: "node-api-host",
          path: host,
        });
        continue;
      }
      if (system(entry.name)) {
        result.imports.push({ binary: row.key, ...entry, source: "windows" });
        continue;
      }
      let candidates = paths.filter(
        (candidate) =>
          candidate.name === entry.name &&
          component(candidate.key) === component(row.key),
      );
      let wheel: WheelDllProof | undefined;
      const adjacent = candidates.filter(
        (candidate) => dirname(candidate.key) === dirname(row.key),
      );
      if (adjacent.length) {
        candidates = adjacent;
        if (row.key.startsWith("runtime/python/"))
          for (const candidate of adjacent)
            await wheels.adjacent(row.key, candidate.key);
      } else {
        const scoped = row.key.startsWith("runtime/python/")
          ? await wheels.resolve(
              row.key,
              entry.name,
              candidates.map((candidate) => candidate.key),
            )
          : { paths: [] as string[], proof: undefined };
        if (scoped.paths.length) {
          candidates = candidates.filter((candidate) =>
            scoped.paths.includes(candidate.key),
          );
          wheel = scoped.proof;
        } else if (msvc(entry.name)) {
          // The interpreter/executable directory is the supported fallback;
          // another wheel's private copy never supplies this dependency.
          const executable = row.key.startsWith("runtime/python/")
            ? "runtime/python"
            : row.key.startsWith("app/") ||
                row.key.startsWith("tools/youtube/provider/")
              ? "runtime/node"
              : dirname(row.key);
          candidates = paths.filter(
            (candidate) =>
              candidate.name === entry.name &&
              dirname(candidate.key) === executable,
          );
        } else if (row.key.startsWith("runtime/python/")) {
          candidates = candidates.filter(
            (candidate) => dirname(candidate.key) === "runtime/python",
          );
        }
      }
      if (candidates.length !== 1)
        throw new TypeError(
          `Consumer DLL missing or ambiguous inside private component: ${row.key} -> ${entry.name}`,
        );
      result.imports.push({
        binary: row.key,
        ...entry,
        source: "private",
        path: candidates[0]!.key,
        ...(wheel ? { wheel } : {}),
      });
    }
  }
  result.msvc = await source(
    root,
    paths
      .filter((row) => msvc(row.name))
      .map((row) => row.key)
      .sort(),
    wheels,
  );
  if (Buffer.byteLength(JSON.stringify(result)) > 8 * 1024 * 1024)
    throw new TypeError("Consumer DLL report exceeds its bound");
  return result;
}
