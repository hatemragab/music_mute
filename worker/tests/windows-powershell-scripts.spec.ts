import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const workerRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

describe("Windows PowerShell tooling", () => {
  it("pins and verifies the stable x64 WinSW runtime", async () => {
    const source = await readFile(
      resolve(workerRoot, "scripts/build-windows-service-runtime.ps1"),
      "utf8",
    );
    expect(source).toContain('$WinSWVersion = "2.12.0"');
    expect(source).toContain(
      "05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da",
    );
    expect(source).toContain("Get-FileHash -Algorithm SHA256");
    expect(source).not.toContain("ExecutionPolicy Bypass");
  });

  it("keeps install, repair, doctor and uninstall inside MusicMute scope", async () => {
    const source = await readFile(
      resolve(workerRoot, "scripts/manage-windows-service.ps1"),
      "utf8",
    );
    expect(source).toContain(
      '[ValidateSet("Install", "Repair", "Doctor", "Uninstall")]',
    );
    expect(source).toContain('$ServiceName = "MusicMuteWorker"');
    expect(source).toContain('$LocalServiceSid = "*S-1-5-19"');
    expect(source).toContain('windows", "verify');
    expect(source).toContain("directml");
    expect(source).toContain(
      '$Slot.PSObject.Properties.Name -contains "directmlDeviceId"',
    );
    expect(source).toContain("function Restore-ManagedFile");
    expect(source).toContain(
      "Restore-ManagedFile $RuntimeConfigPath $RuntimeConfigExisted $PreviousRuntimeConfig $false",
    );
    expect(source).toContain(
      "Restore-ManagedFile $CredentialPath $CredentialExisted $PreviousCredential $false",
    );
    expect(source).toContain(
      "Restore-ManagedFile $Wrapper $WrapperExisted $PreviousWrapper $true",
    );
    expect(source).toContain(
      "Restore-ManagedFile $ServiceXml $ServiceXmlExisted $PreviousXml $false",
    );
    expect(source).toContain("Test-InstalledRuntime $Root $PreviousVersion");
    const consistencyCheck = source.indexOf(
      'throw "The installed service state is incomplete."',
    );
    const candidateConfigWrite = source.indexOf(
      "Copy-PrivateFile $ConfigItem.FullName $RuntimeConfigPath",
    );
    const candidateCredentialWrite = source.indexOf(
      "Copy-PrivateFile $CredentialItem.FullName $CredentialPath",
    );
    const rollbackConfigRestore = source.indexOf(
      "Restore-ManagedFile $RuntimeConfigPath",
    );
    expect(consistencyCheck).toBeGreaterThan(-1);
    expect(candidateConfigWrite).toBeGreaterThan(consistencyCheck);
    expect(candidateCredentialWrite).toBeGreaterThan(candidateConfigWrite);
    expect(rollbackConfigRestore).toBeGreaterThan(candidateCredentialWrite);
    expect(source).toContain("Remove-Item -LiteralPath $Temporary -Force");
    expect(source).toContain("stopwait");
    expect(source).not.toContain("--no-elevate");
    expect(source).not.toContain('@("refresh"');
    expect(source).not.toMatch(/Set-Service.+(driver|firewall)/iu);
    expect(source).not.toContain("ExecutionPolicy Bypass");
  });
});
