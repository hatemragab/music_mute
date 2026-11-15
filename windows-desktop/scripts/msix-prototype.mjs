import { readFile, writeFile, mkdir, lstat, realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute, resolve, join } from "node:path";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import yauzl from "yauzl";
import {
  prototypeIdentity,
  parsePrototypeIdentity,
  prototypeBuildRelativeDirectory,
  manifestXml,
  configHeader,
  packageNativeManifest,
  sha256,
} from "../acceptance/msix-prototype/contract.ts";
import { chromeFixtureFiles } from "../acceptance/msix-prototype/chrome-fixture.mjs";

const component = resolve(import.meta.dirname, "..");
const source = join(component, "acceptance/msix-prototype");
const fixedSources = [
  "CMakeLists.txt",
  "probe.cpp",
  "protocol.hpp",
  "protocol.test.cpp",
  "app.manifest",
];
function absolute(value) {
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    value.length > 4096 ||
    /[\p{Cc}\p{Cf}]/u.test(value)
  )
    throw new Error("MSIX_QA_PATH_INVALID");
  return resolve(value);
}
async function regular(path, maximum = 16 * 1024 ** 2) {
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.size < 1 ||
    info.size > maximum ||
    (await realpath(path)) !== resolve(path)
  )
    throw new Error("MSIX_QA_FILE_INVALID");
  return readFile(path);
}
function crc32(bytes) {
  let n = 0xffffffff;
  for (const byte of bytes) {
    n ^= byte;
    for (let bit = 0; bit < 8; bit++) n = (n >>> 1) ^ (n & 1 ? 0xedb88320 : 0);
  }
  return (n ^ 0xffffffff) >>> 0;
}
function chunk(name, data) {
  const label = Buffer.from(name),
    prefix = Buffer.alloc(4),
    suffix = Buffer.alloc(4);
  prefix.writeUInt32BE(data.length);
  suffix.writeUInt32BE(crc32(Buffer.concat([label, data])));
  return Buffer.concat([prefix, label, data, suffix]);
}
export function prototypeLogo(size) {
  if (![44, 50, 150].includes(size)) throw new Error("MSIX_QA_ASSET_INVALID");
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = Buffer.alloc((size * 4 + 1) * size);
  for (let row = 0; row < size; row++)
    for (let column = 0; column < size; column++) {
      const offset = row * (size * 4 + 1) + 1 + column * 4;
      pixels.set([26, 112, 117, 255], offset);
    }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
export function x64Executable(bytes) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length < 512 ||
    bytes.length > 16 * 1024 ** 2
  )
    throw new Error("MSIX_QA_PE_INVALID");
  if (bytes.readUInt16LE(0) !== 0x5a4d) throw new Error("MSIX_QA_PE_INVALID");
  const offset = bytes.readUInt32LE(0x3c);
  if (
    offset < 64 ||
    offset > bytes.length - 24 ||
    bytes.readUInt32LE(offset) !== 0x4550 ||
    bytes.readUInt16LE(offset + 4) !== 0x8664
  )
    throw new Error("MSIX_QA_PE_INVALID");
}
export async function createPrototypePlan(
  output,
  qaId = randomUUID().replaceAll("-", ""),
  namespaceCandidate,
) {
  const root = absolute(output),
    identity = prototypeIdentity(qaId, namespaceCandidate);
  const files = [];
  for (const leaf of fixedSources) {
    const bytes = await regular(join(source, leaf));
    files.push({ path: leaf, bytes });
  }
  files.push({
    path: "json.hpp",
    bytes: await regular(
      join(component, "../worker/native/windows-consumer/json.hpp"),
    ),
  });
  files.push({
    path: "qa-config.hpp",
    bytes: Buffer.from(configHeader(identity)),
  });
  // Exclusive leaf; any previous run or foreign path is preserved.
  await mkdir(root, { mode: 0o700 });
  await mkdir(join(root, "native"), { mode: 0o700 });
  await mkdir(join(root, "payload"), { mode: 0o700 });
  await mkdir(join(root, "payload/Assets"), { mode: 0o700 });
  await mkdir(join(root, "ChromeQA"), { mode: 0o700 });
  const chromeFiles = [];
  for (const [leaf, text] of Object.entries(chromeFixtureFiles(identity))) {
    const bytes = Buffer.from(text);
    await writeFile(join(root, "ChromeQA", leaf), bytes, {
      flag: "wx",
      mode: 0o600,
    });
    chromeFiles.push({
      path: leaf,
      bytes: bytes.length,
      sha256: sha256(bytes),
    });
  }
  for (const file of files)
    await writeFile(join(root, "native", file.path), file.bytes, {
      flag: "wx",
      mode: 0o600,
    });
  const manifest = Buffer.from(manifestXml(identity));
  await writeFile(join(root, "payload/AppxManifest.xml"), manifest, {
    flag: "wx",
    mode: 0o600,
  });
  const nativeManifest = Buffer.from(packageNativeManifest(identity));
  await writeFile(
    join(root, "payload/NativeMessagingHost.json"),
    nativeManifest,
    {
      flag: "wx",
      mode: 0o600,
    },
  );
  for (const [leaf, size] of [
    ["StoreLogo.png", 50],
    ["Square44x44Logo.png", 44],
    ["Square150x150Logo.png", 150],
  ])
    await writeFile(join(root, "payload/Assets", leaf), prototypeLogo(size), {
      flag: "wx",
      mode: 0o600,
    });
  const plan = {
    identity,
    sourceFiles: files.map((file) => ({
      path: file.path,
      bytes: file.bytes.length,
      sha256: sha256(file.bytes),
    })),
    manifest: { bytes: manifest.length, sha256: sha256(manifest) },
    immutableNativeManifest: {
      bytes: nativeManifest.length,
      sha256: sha256(nativeManifest),
    },
    toolsExecuted: false,
    deploymentExecuted: false,
    storeSigned: false,
    trustStoreChanged: false,
    developerModeChanged: false,
    nativeBuildEntry: "runPrototypeNativeBuild",
    guardedSourceGeometry: "repository/worker/native/windows-consumer",
    buildRelativeDirectory: prototypeBuildRelativeDirectory(identity),
    chromeFixture: {
      directory: "ChromeQA",
      extensionId: identity.extensionId,
      files: chromeFiles,
      profileMutation: false,
      includedInMsixPayload: false,
    },
    makeAppx: {
      path: "C:\\Program Files (x86)\\Windows Kits\\10\\bin\\10.0.26100.0\\x64\\MakeAppx.exe",
      bytes: 584024,
      sha256:
        "00fff202b71c1266b8c3899701e42b5468ea153b2b33a0a47215fe27695f16d0",
    },
    packWithinGuardedCompileJob: true,
  };
  await writeFile(
    join(root, "plan.json"),
    JSON.stringify(plan, null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  return plan;
}
async function readPlan(root) {
  const raw = JSON.parse(
    (await regular(join(root, "plan.json"), 65536)).toString("utf8"),
  );
  const identity = parsePrototypeIdentity(raw.identity);
  if (raw.buildRelativeDirectory !== prototypeBuildRelativeDirectory(identity))
    throw new Error("MSIX_QA_BUILD_GEOMETRY_INVALID");
  const chromeExpected = Object.entries(chromeFixtureFiles(identity));
  if (
    !raw.chromeFixture ||
    raw.chromeFixture.directory !== "ChromeQA" ||
    raw.chromeFixture.extensionId !== identity.extensionId ||
    raw.chromeFixture.profileMutation !== false ||
    raw.chromeFixture.includedInMsixPayload !== false ||
    !Array.isArray(raw.chromeFixture.files) ||
    raw.chromeFixture.files.length !== chromeExpected.length
  )
    throw new Error("MSIX_QA_CHROME_FIXTURE_INVALID");
  for (const [index, [leaf, text]] of chromeExpected.entries()) {
    const pin = raw.chromeFixture.files[index];
    const bytes = await regular(join(root, "ChromeQA", leaf), 65536);
    if (
      pin?.path !== leaf ||
      pin.bytes !== bytes.length ||
      pin.sha256 !== sha256(bytes) ||
      !bytes.equals(Buffer.from(text))
    )
      throw new Error("MSIX_QA_CHROME_FIXTURE_CHANGED");
  }
  if (!Array.isArray(raw.sourceFiles) || raw.sourceFiles.length !== 7)
    throw new Error("MSIX_QA_PLAN_INVALID");
  const seen = new Set();
  for (const expected of raw.sourceFiles) {
    if (
      ![...fixedSources, "json.hpp", "qa-config.hpp"].includes(expected.path) ||
      seen.has(expected.path)
    )
      throw new Error("MSIX_QA_PLAN_INVALID");
    seen.add(expected.path);
    const bytes = await regular(join(root, "native", expected.path));
    if (bytes.length !== expected.bytes || sha256(bytes) !== expected.sha256)
      throw new Error("MSIX_QA_SOURCE_CHANGED");
  }
  const manifest = await regular(join(root, "payload/AppxManifest.xml"), 16384);
  if (!manifest.equals(Buffer.from(manifestXml(identity))))
    throw new Error("MSIX_QA_MANIFEST_CHANGED");
  const nativeManifest = await regular(
    join(root, "payload/NativeMessagingHost.json"),
    16384,
  );
  if (
    !nativeManifest.equals(Buffer.from(packageNativeManifest(identity))) ||
    raw.immutableNativeManifest?.bytes !== nativeManifest.length ||
    raw.immutableNativeManifest?.sha256 !== sha256(nativeManifest)
  )
    throw new Error("MSIX_QA_NATIVE_MANIFEST_CHANGED");
  return identity;
}
async function auditArchive(root, archive) {
  const expected = new Map();
  for (const leaf of [
    "AppxManifest.xml",
    "NativeMessagingHost.json",
    "MusicMuteMsixProbe.exe",
    "MusicMuteMsixChromeHost.exe",
    "Assets/StoreLogo.png",
    "Assets/Square44x44Logo.png",
    "Assets/Square150x150Logo.png",
  ])
    expected.set(leaf, await regular(join(root, "payload", leaf)));
  return new Promise((resolveAudit, reject) => {
    yauzl.fromBuffer(
      archive,
      { lazyEntries: true, strictFileNames: true, validateEntrySizes: true },
      (error, zip) => {
        if (error || !zip) return reject(new Error("MSIX_QA_ARCHIVE_INVALID"));
        const seen = new Set();
        let total = 0;
        const fail = () => {
          zip.close();
          reject(new Error("MSIX_QA_ARCHIVE_INVALID"));
        };
        zip.on("error", fail);
        zip.on("entry", (entry) => {
          if (
            seen.size >= 16 ||
            seen.has(entry.fileName.toLowerCase()) ||
            ![
              ...expected.keys(),
              "[Content_Types].xml",
              "AppxBlockMap.xml",
            ].includes(entry.fileName) ||
            entry.uncompressedSize < 1 ||
            entry.uncompressedSize > 16 * 1024 ** 2 ||
            (total += entry.uncompressedSize) > 40 * 1024 ** 2 ||
            entry.generalPurposeBitFlag & 1
          )
            return fail();
          seen.add(entry.fileName.toLowerCase());
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError || !stream) return fail();
            const chunks = [];
            let bytes = 0;
            stream.on("error", fail);
            stream.on("data", (chunk) => {
              bytes += chunk.length;
              if (bytes > entry.uncompressedSize) {
                stream.destroy();
                fail();
              } else chunks.push(chunk);
            });
            stream.on("end", () => {
              const content = Buffer.concat(chunks),
                pin = expected.get(entry.fileName);
              if (
                content.length !== entry.uncompressedSize ||
                (pin && !content.equals(pin))
              )
                return fail();
              if (
                !pin &&
                (!content
                  .toString("utf8")
                  .includes(
                    entry.fileName === "AppxBlockMap.xml"
                      ? "<BlockMap"
                      : "<Types",
                  ) ||
                  content.includes(Buffer.from("<!DOCTYPE")) ||
                  content.includes(Buffer.from("<!ENTITY")))
              )
                return fail();
              zip.readEntry();
            });
          });
        });
        zip.on("end", () => {
          if (
            seen.size !== expected.size + 2 ||
            [...expected.keys()].some((key) => !seen.has(key.toLowerCase()))
          )
            return fail();
          resolveAudit({
            entries: seen.size,
            payloadByteMatches: expected.size,
            signaturePresent: false,
          });
        });
        zip.readEntry();
      },
    );
  });
}
export async function assemblePrototypeLayout(output) {
  const root = absolute(output),
    identity = await readPlan(root),
    entries = [];
  const build = JSON.parse(
    (await regular(join(root, "native-build-receipt.json"), 65536)).toString(
      "utf8",
    ),
  );
  if (
    JSON.stringify(parsePrototypeIdentity(build.identity)) !==
      JSON.stringify(identity) ||
    build.buildRelativeDirectory !==
      prototypeBuildRelativeDirectory(identity) ||
    !Array.isArray(build.binaries) ||
    !Array.isArray(build.steps) ||
    build.steps.length !== 3 ||
    build.steps.some(
      (row, index) =>
        row.step !== ["configure", "compile", "ctest"][index] ||
        row.code !== 0 ||
        row.toolExitCode !== 0 ||
        row.reason !== "completed" ||
        row.wholeJobZero !== true,
    )
  )
    throw new Error("MSIX_QA_BUILD_RECEIPT_INVALID");
  const buildDirectory = join(
    root,
    ...prototypeBuildRelativeDirectory(identity).split("/"),
    "Release",
  );
  for (const leaf of [identity.executable, identity.hostExecutable]) {
    const bytes = await regular(join(buildDirectory, leaf));
    x64Executable(bytes);
    if (!bytes.includes(Buffer.from(identity.packageName, "utf16le")))
      throw new Error("MSIX_QA_PE_IDENTITY_INVALID");
    const pin = build.binaries.find((row) => row.path === leaf);
    if (
      !pin ||
      pin.bytes !== bytes.length ||
      pin.sha256 !== sha256(bytes) ||
      !(await regular(join(root, "payload", leaf))).equals(bytes)
    )
      throw new Error("MSIX_QA_PACKAGE_CHANGED");
    entries.push({ path: leaf, bytes: bytes.length, sha256: sha256(bytes) });
  }
  await writeFile(
    join(root, "native-files.json"),
    JSON.stringify(
      {
        identity,
        entries,
        nativeBuildReceiptRequired: true,
        nativeBuildReceiptSha256: sha256(
          await regular(join(root, "native-build-receipt.json"), 65536),
        ),
      },
      null,
      2,
    ) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  return entries;
}
export async function recordPrototypePackage(output) {
  const root = absolute(output),
    identity = await readPlan(root),
    archive = await regular(
      join(root, "MusicMute-S03-QA.msix"),
      64 * 1024 ** 2,
    );
  if (archive.readUInt32LE(0) !== 0x04034b50)
    throw new Error("MSIX_QA_PACKAGE_INVALID");
  const archiveAudit = await auditArchive(root, archive);
  const native = JSON.parse(
    (await regular(join(root, "native-files.json"), 16384)).toString("utf8"),
  );
  parsePrototypeIdentity(native.identity);
  if (
    JSON.stringify(native.identity) !== JSON.stringify(identity) ||
    !Array.isArray(native.entries) ||
    native.entries.length !== 2
  )
    throw new Error("MSIX_QA_PACKAGE_INVALID");
  for (const leaf of [identity.executable, identity.hostExecutable]) {
    const pin = native.entries.find((row) => row.path === leaf),
      bytes = await regular(join(root, "payload", leaf));
    if (!pin || pin.bytes !== bytes.length || pin.sha256 !== sha256(bytes))
      throw new Error("MSIX_QA_PACKAGE_CHANGED");
  }
  const receipt = {
    identity,
    artifact: {
      path: "MusicMute-S03-QA.msix",
      bytes: archive.length,
      sha256: sha256(archive),
    },
    storeSigned: false,
    nativeBuildReceiptRequired: true,
    archiveAudit,
  };
  await writeFile(
    join(root, "package-receipt.json"),
    JSON.stringify(receipt, null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  return receipt;
}
export async function createDeploymentScript(output, acknowledge) {
  if (acknowledge !== "--acknowledge-all-users-unsigned-qa")
    throw new Error("MSIX_QA_ALL_USERS_ACK_REQUIRED");
  const root = absolute(output),
    identity = await readPlan(root);
  const receipt = JSON.parse(
    (await regular(join(root, "package-receipt.json"), 16384)).toString("utf8"),
  );
  if (
    JSON.stringify(parsePrototypeIdentity(receipt.identity)) !==
    JSON.stringify(identity)
  )
    throw new Error("MSIX_QA_PACKAGE_INVALID");
  const archive = await regular(
    join(root, "MusicMute-S03-QA.msix"),
    64 * 1024 ** 2,
  );
  if (
    archive.length !== receipt.artifact.bytes ||
    sha256(archive) !== receipt.artifact.sha256
  )
    throw new Error("MSIX_QA_PACKAGE_CHANGED");
  await auditArchive(root, archive);
  // This generates a reviewable script only; root executes it separately after
  // package-content inspection. No policy/certificate/profile edit is emitted.
  const script = `$ErrorActionPreference = 'Stop'
function Write-QAReceipt([string]$path, $record) {
  $stream = [IO.File]::Open($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
  try { $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes(($record | ConvertTo-Json -Depth 8) + "\x60n"); $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
}
$name = '${identity.packageName}'
$publisher = '${identity.publisher}'
$archive = Join-Path $PSScriptRoot 'MusicMute-S03-QA.msix'
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'MSIX_QA_ELEVATED_INSTALL_REQUIRED' }
if ([Environment]::OSVersion.Version.Build -lt 22000) { throw 'MSIX_QA_WINDOWS11_REQUIRED' }
if (-not (Get-Command Add-AppxPackage).Parameters.ContainsKey('AllowUnsigned')) { throw 'MSIX_QA_UNSIGNED_INSTALL_UNSUPPORTED' }
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne '${receipt.artifact.sha256}') { throw 'MSIX_QA_PACKAGE_CHANGED' }
$before = @(Get-AppxPackage -AllUsers -Name $name)
if ($before.Count -ne 0) { throw 'MSIX_QA_PACKAGE_ALREADY_EXISTS' }
$beforePath = Join-Path $PSScriptRoot 'deployment-before.json'
Write-QAReceipt $beforePath @{ version=1; name=$name; before_count=0; install_scope='all-users-executable-unsigned-qa'; store_signed=$false }
Add-AppxPackage -Path $archive -AllowUnsigned
$after = @(Get-AppxPackage -AllUsers -Name $name)
if ($after.Count -ne 1 -or $after[0].Publisher -ne $publisher -or $after[0].SignatureKind.ToString() -ne 'None' -or $after[0].Architecture.ToString() -ne 'X64') { throw 'MSIX_QA_INSTALLED_IDENTITY_INVALID' }
$record = @{ version=1; name=$name; package_full_name=$after[0].PackageFullName; package_family_name=$after[0].PackageFamilyName; publisher=$after[0].Publisher; architecture=$after[0].Architecture.ToString(); install_location=$after[0].InstallLocation; signature_kind=$after[0].SignatureKind.ToString(); status=$after[0].Status.ToString(); users=@($after[0].PackageUserInformation | ForEach-Object { @{ sid=$_.UserSecurityId.Sid; state=$_.InstallState.ToString() } }); store_signed=$false; runtime_must_be_limited_session1=$true }
$afterPath = Join-Path $PSScriptRoot 'deployment-after.json'
Write-QAReceipt $afterPath $record
Write-Output 'MSIX_QA_UNSIGNED_DEPLOYMENT_RECORDED'
`;
  await writeFile(join(root, "deploy-unsigned-qa.ps1"), script, {
    flag: "wx",
    mode: 0o600,
  });
  return {
    deploymentExecuted: false,
    script: join(root, "deploy-unsigned-qa.ps1"),
    installScope: identity.installScope,
  };
}
export async function prototypeMain(argv) {
  if (argv.length === 0)
    return {
      mode: "plan",
      toolsExecuted: false,
      deploymentExecuted: false,
      usage:
        "plan <new-absolute-directory> | plan-unvirtualized <new-absolute-directory> <cohort-UUIDv4-compact> <gui|worker> | layout <plan-directory> | record-package <plan-directory> | deployment-script <plan-directory> --acknowledge-all-users-unsigned-qa",
    };
  if (argv.length === 2 && argv[0] === "plan")
    return createPrototypePlan(argv[1]);
  if (argv.length === 4 && argv[0] === "plan-unvirtualized")
    return createPrototypePlan(argv[1], randomUUID().replaceAll("-", ""), {
      namespaceProfile: "unvirtualized-candidate-v1",
      dataCohort: argv[2],
      dataRole: argv[3],
    });
  if (argv.length === 2 && argv[0] === "layout")
    return assemblePrototypeLayout(argv[1]);
  if (argv.length === 2 && argv[0] === "record-package")
    return recordPrototypePackage(argv[1]);
  if (argv.length === 3 && argv[0] === "deployment-script")
    return createDeploymentScript(argv[1], argv[2]);
  throw new Error("MSIX_QA_ARGUMENT_INVALID");
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await prototypeMain(process.argv.slice(2))
    .then((result) => process.stdout.write(JSON.stringify(result) + "\n"))
    .catch((error) => {
      process.stderr.write(
        `${error instanceof Error && /^MSIX_QA_[A-Z_]+$/u.test(error.message) ? error.message : "MSIX_QA_FAILED"}\n`,
      );
      process.exitCode = 2;
    });
