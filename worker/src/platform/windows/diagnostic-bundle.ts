import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, realpath, rm } from "node:fs/promises";
import { win32 } from "node:path";
import { promisify } from "node:util";
import {
  MAX_BUNDLE_BYTES,
  writeDiagnosticContents,
  type DiagnosticContentOptions,
  type DiagnosticBundleResult,
} from "../shared/diagnostic-bundle.js";
import { WindowsServiceController } from "./native-service.js";
import {
  assertWindowsPrivateDataFile,
  assertWindowsPrivateDirectory,
} from "./private-data.js";
import type { WindowsServiceLayout } from "./service-definition.js";

export function validateWindowsDiagnosticDestination(
  layout: WindowsServiceLayout,
  output: string,
): void {
  if (
    !/^[A-Za-z]:\\/u.test(output) ||
    win32.normalize(output) !== output ||
    output.slice(2).includes(":") ||
    [...output].some(
      (character) =>
        character.charCodeAt(0) < 32 || '"<>|?*'.includes(character),
    ) ||
    !output.endsWith(".zip") ||
    win32.basename(output).length > 180 ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])\./iu.test(win32.basename(output))
  )
    throw new TypeError(
      "Diagnostics output requires a normalized local absolute .zip path",
    );
  const relative = win32.relative(layout.installRoot, output);
  if (
    relative === "" ||
    (!relative.startsWith("..\\") &&
      relative !== ".." &&
      !win32.isAbsolute(relative))
  ) {
    if (
      win32.dirname(output).toLowerCase() !==
        layout.serviceRoot.toLowerCase() ||
      !/^diagnostics-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.zip$/u.test(
        win32.basename(output),
      )
    )
      throw new TypeError(
        "Diagnostics output cannot modify installation files",
      );
  }
}

export async function createWindowsDiagnosticBundle(
  options: DiagnosticContentOptions & {
    layout: WindowsServiceLayout;
    outputPath?: string;
  },
): Promise<DiagnosticBundleResult> {
  const { layout } = options;
  await new WindowsServiceController(layout).assertPrivateInstallation();
  const outputPath =
    options.outputPath ??
    win32.join(layout.serviceRoot, `diagnostics-${randomUUID()}.zip`);
  validateWindowsDiagnosticDestination(layout, outputPath);
  if (
    (await realpath(win32.dirname(outputPath))).toLowerCase() !==
    win32.dirname(outputPath).toLowerCase()
  )
    throw new TypeError(
      "Diagnostics output parent must exist without directory links",
    );
  // The service cannot write this parent, unlike its processing scratch root.
  await assertWindowsPrivateDirectory(layout.serviceRoot);
  const staging = win32.join(layout.serviceRoot, `diagnostics-${randomUUID()}`);
  await createPrivateStaging(staging);
  try {
    await assertWindowsPrivateDirectory(staging);
    const contentRoot = win32.join(staging, "contents");
    await mkdir(contentRoot);
    const { files, createdAt } = await writeDiagnosticContents(contentRoot, {
      ...options,
      assertConfigPrivate: assertWindowsPrivateDataFile,
    });
    await archiveAndPublish(
      contentRoot,
      win32.join(staging, "bundle.zip"),
      outputPath,
    );
    return { schemaVersion: 1, path: outputPath, files, createdAt };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function archiveAndPublish(
  contentRoot: string,
  archivePath: string,
  outputPath: string,
): Promise<void> {
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const script = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$Source=${quote(contentRoot)}
$Archive=${quote(archivePath)}
$Output=${quote(outputPath)}
foreach($Path in @($Source, [IO.Path]::GetDirectoryName($Output))) {
  $Cursor=Get-Item -LiteralPath $Path -Force
  while($null -ne $Cursor) {
    if($Cursor.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Directory links are not allowed.' }
    $Cursor=$Cursor.Parent
  }
}
[IO.Compression.ZipFile]::CreateFromDirectory($Source,$Archive,[IO.Compression.CompressionLevel]::Fastest,$false)
$Info=Get-Item -LiteralPath $Archive
if($Info.Length -lt 1 -or $Info.Length -gt ${MAX_BUNDLE_BYTES}) { throw 'Archive exceeds export bounds.' }
$Acl=[Security.AccessControl.FileSecurity]::new()
$Acl.SetAccessRuleProtection($true,$false)
$Admin=[Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
$Acl.SetOwner($Admin)
foreach($Sid in @('S-1-5-18','S-1-5-32-544')) {
  $Identity=[Security.Principal.SecurityIdentifier]::new($Sid)
  $Rule=[Security.AccessControl.FileSystemAccessRule]::new($Identity,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.AccessControlType]::Allow)
  $Acl.AddAccessRule($Rule)
}
$InputStream=[IO.File]::OpenRead($Archive)
try {
  # CreateNew refuses collisions; the private ACL is applied before any bytes are written.
  $OutputStream=[IO.FileStream]::new($Output,[IO.FileMode]::CreateNew,[Security.AccessControl.FileSystemRights]::Write,[IO.FileShare]::None,65536,[IO.FileOptions]::WriteThrough,$Acl)
  try { $InputStream.CopyTo($OutputStream); $OutputStream.Flush($true) }
  finally { $OutputStream.Dispose() }
} finally { $InputStream.Dispose() }
`;
  await runDiagnosticScript(script);
}

async function createPrivateStaging(path: string): Promise<void> {
  await runDiagnosticScript(`
$ErrorActionPreference='Stop'
$Path='${path.replaceAll("'", "''")}'
if(Test-Path -LiteralPath $Path) { throw 'Staging path already exists.' }
$Acl=[Security.AccessControl.DirectorySecurity]::new()
$Acl.SetAccessRuleProtection($true,$false)
$Acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
foreach($Sid in @('S-1-5-18','S-1-5-32-544')) {
  $Identity=[Security.Principal.SecurityIdentifier]::new($Sid)
  $Rule=[Security.AccessControl.FileSystemAccessRule]::new($Identity,[Security.AccessControl.FileSystemRights]::FullControl,([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
  $Acl.AddAccessRule($Rule)
}
[void][IO.Directory]::CreateDirectory($Path,$Acl)
`);
}

async function runDiagnosticScript(script: string): Promise<void> {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !/^[A-Za-z]:\\[^\r\n\0]+$/u.test(systemRoot))
    throw new TypeError("Windows system directory is unavailable");
  try {
    await promisify(execFile)(
      win32.join(
        systemRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { windowsHide: true, timeout: 60_000, maxBuffer: 64 * 1024 },
    );
  } catch {
    throw new Error(
      "Diagnostics archive could not be created; check the output path, collisions, and permissions",
    );
  }
}
