import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import {
  assertWindowsPrivateDataFile,
  assertWindowsAdministratorDataFile,
} from "../src/platform/windows/private-data.js";

it.skipIf(process.platform !== "win32")(
  "checks the actual NTFS file and parent ACL instead of POSIX mode bits",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "musicmute-acl-"));
    const path = join(root, "receipt.json");
    const powershell = async (body: string) =>
      await promisify(execFile)(
        win32.join(
          process.env.SystemRoot!,
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "powershell.exe",
        ),
        [
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(
            `$ErrorActionPreference='Stop'\n$Root='${root.replaceAll("'", "''")}'\n$Path=Join-Path $Root 'receipt.json'\n${body}`,
            "utf16le",
          ).toString("base64"),
        ],
        { timeout: 15000, maxBuffer: 16384 },
      );
    try {
      await writeFile(path, "{}");
      await powershell(`
foreach ($Entry in @($Root,$Path)) {
  $Acl=Get-Acl -LiteralPath $Entry
  $Acl.SetAccessRuleProtection($true,$false)
  foreach ($Rule in @($Acl.Access)) { $Acl.RemoveAccessRuleSpecific($Rule) }
  $Admin=New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')
  $Acl.SetOwner($Admin)
  $Acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($Admin,'FullControl','Allow')))
  Set-Acl -LiteralPath $Entry -AclObject $Acl
}`);
      await expect(assertWindowsPrivateDataFile(path)).resolves.toBeUndefined();
      await expect(
        assertWindowsAdministratorDataFile(path),
      ).resolves.toBeUndefined();
      await powershell(`
$Acl=Get-Acl -LiteralPath $Path
$LocalService=New-Object Security.Principal.SecurityIdentifier('S-1-5-19')
$Acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($LocalService,'Write','Allow')))
Set-Acl -LiteralPath $Path -AclObject $Acl
`);
      await expect(assertWindowsPrivateDataFile(path)).resolves.toBeUndefined();
      await expect(assertWindowsAdministratorDataFile(path)).rejects.toThrow(
        "ACL or path is unsafe",
      );
      await powershell(`
$Acl=Get-Acl -LiteralPath $Path
foreach($Rule in @($Acl.Access)) {
 if($Rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq 'S-1-5-19') { $Acl.RemoveAccessRuleSpecific($Rule) }
}
Set-Acl -LiteralPath $Path -AclObject $Acl
`);
      await expect(
        assertWindowsAdministratorDataFile(path),
      ).resolves.toBeUndefined();
      await powershell(`
$Acl=Get-Acl -LiteralPath $Path
$Everyone=New-Object Security.Principal.SecurityIdentifier('S-1-1-0')
$Acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($Everyone,'Read','Allow')))
Set-Acl -LiteralPath $Path -AclObject $Acl
`);
      await expect(assertWindowsPrivateDataFile(path)).rejects.toThrow(
        "ACL or path is unsafe",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  45_000,
);
