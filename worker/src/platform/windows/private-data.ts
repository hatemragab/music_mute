import { execFile } from "node:child_process";
import { win32 } from "node:path";
import { promisify } from "node:util";

/** POSIX mode bits do not describe Windows confidentiality or write authority. */
export async function assertWindowsPrivateDataFile(
  path: string,
): Promise<void> {
  await assertWindowsPrivateEntry(path, false);
}

export async function assertWindowsPrivateDirectory(
  path: string,
): Promise<void> {
  await assertWindowsPrivateEntry(path, true);
}

export async function assertWindowsAdministratorDataFile(
  path: string,
): Promise<void> {
  await assertWindowsPrivateEntry(path, false, true);
}

async function assertWindowsPrivateEntry(
  path: string,
  directory: boolean,
  administrator = false,
): Promise<void> {
  if (
    process.platform !== "win32" ||
    !/^[A-Za-z]:\\/u.test(path) ||
    win32.normalize(path) !== path ||
    /[\r\n\0]/u.test(path) ||
    path.slice(2).includes(":")
  )
    throw new TypeError("Windows private data path is invalid");
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !/^[A-Za-z]:\\[^\r\n\0]+$/u.test(systemRoot))
    throw new TypeError("Windows system directory is unavailable");
  const script = `
$ErrorActionPreference='Stop'
$Path='${path.replaceAll("'", "''")}'
$Item=Get-Item -LiteralPath $Path -Force
if ($Item.PSIsContainer -ne $${directory ? "true" : "false"}) { throw 'Private entry has an unexpected type.' }
$Parent=if ($Item.PSIsContainer) { $Item.Parent } else { $Item.Directory }
$Cursor=$Item
while ($null -ne $Cursor) {
  if ($Cursor.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Private data cannot use reparse points.' }
  $Cursor=if ($Cursor.PSIsContainer) { $Cursor.Parent } else { $Cursor.Directory }
}
foreach ($Entry in @($Item, $Parent)) {
  $Acl=Get-Acl -LiteralPath $Entry.FullName
  $Owner=$Acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  if ($Owner -notin @('S-1-5-18','S-1-5-19','S-1-5-32-544')) { throw 'Private data owner is not trusted.' }
  if ($${administrator ? "true" : "false"} -and $Owner -eq 'S-1-5-19') { throw 'Administrative receipt cannot be service-owned.' }
  foreach ($Rule in $Acl.Access) {
    $Sid=$Rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    if ($${administrator ? "true" : "false"} -and $Rule.AccessControlType -eq 'Allow' -and $Sid -eq 'S-1-5-19' -and (([long]$Rule.FileSystemRights -band 852246) -ne 0)) { throw 'Administrative receipt cannot be service-writable.' }
    if ($Rule.AccessControlType -eq 'Allow' -and $Sid -notin @('S-1-5-18','S-1-5-19','S-1-5-32-544')) { throw 'Private data permissions are not private.' }
  }
}`;
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
      { windowsHide: true, timeout: 15_000, maxBuffer: 16 * 1024 },
    );
  } catch {
    throw new TypeError("Windows private data ACL or path is unsafe");
  }
}
