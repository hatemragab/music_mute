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

  it("keeps staged qualification and service management inside MusicMute scope", async () => {
    const source = await serviceManagerSource();
    expect(source).toContain(
      '[ValidateSet("Stage", "Benchmark", "Install", "Repair", "Update", "Reactivate", "Recover", "Doctor", "ResetRestartBudget", "Uninstall")]',
    );
    expect(source).toContain(
      "$StagingOnly = $Action -in @('Stage', 'Benchmark')",
    );
    expect(source).toContain("if (-not $StagingOnly)");
    expect(source).toContain("if ($StagingOnly)");
    expect(source).toContain('$ServiceName = "MusicMuteWorker"');
    expect(source).toContain('$LocalServiceSid = "*S-1-5-19"');
    expect(source).toContain('windows", "verify');
    expect(source).toContain("directml");
    expect(source).toContain(
      '$Slot.PSObject.Properties.Name -contains "directmlDeviceId"',
    );
    expect(source).toContain("function Restore-ManagedFile");
    expect(source).toContain("function Wait-WorkerRuntimeStarted");
    expect(source).toContain("function Wait-WorkerQualification");
    expect(source).toContain("$ServiceWasRunning =");
    expect(source).toContain("if ($ServiceWasRunning)");
    expect(source).toContain('[string]$QualificationOutput = ""');
    expect(source).toContain("function Export-PrivateFileExclusive");
    expect(source).toContain(
      "Export-PrivateFileExclusive $QualificationReport $QualificationOutputPath",
    );
    expect(source).toContain(
      '"--qualification-fixture", $QualificationFixture',
    );
    expect(source).toContain('"--qualification-report", $QualificationReport');
    expect(source).toContain(
      "Wait-WorkerQualification $InstalledRelease $QualificationReport $FixtureSha256",
    );
    expect(source).toContain('@("uninstall")');
    expect(source).toContain("Move-Item -LiteralPath $ActiveXml");
    expect(source).toContain(
      'throw "The MusicMute worker did not complete runtime startup."',
    );
    expect(source).toContain(
      "Test-InstalledRuntime $Root $Version $StartedAfter",
    );
    const consistencyCheck = source.indexOf(
      'throw "The installed service state is incomplete."',
    );
    const candidateConfigWrite = source.indexOf(
      "Copy-PrivateFile $ConfigItem.FullName $RuntimeConfigPath",
    );
    const candidateCredentialWrite = source.indexOf(
      "Copy-PrivateFile $CredentialItem.FullName $CredentialPath",
    );
    const journalCommit = source.indexOf(
      "  Save-OperationJournal $Root ",
      consistencyCheck,
    );
    const rollbackConfigRestore = source.indexOf(
      "      Restore-OperationJournal $Root",
      candidateCredentialWrite,
    );
    expect(consistencyCheck).toBeGreaterThan(-1);
    expect(journalCommit).toBeGreaterThan(consistencyCheck);
    const drain = source.indexOf(
      "$Drained = Wait-WorkerDrain $Root $UpdatePlan.force",
      consistencyCheck,
    );
    expect(drain).toBeGreaterThan(consistencyCheck);
    expect(drain).toBeLessThan(journalCommit);
    expect(source).toContain("-OriginalLifecycle $OriginalLifecycle");
    expect(candidateConfigWrite).toBeGreaterThan(journalCommit);
    expect(source).toContain("$Stream.Flush($true)");
    expect(source).toContain("The operation snapshot content changed.");
    expect(source).toContain("Complete-OperationJournal $Root");
    expect(source).toContain("Drain and stop MusicMuteWorker");
    expect(candidateCredentialWrite).toBeGreaterThan(candidateConfigWrite);
    expect(rollbackConfigRestore).toBeGreaterThan(candidateCredentialWrite);
    expect(source).toContain("Remove-Item -LiteralPath $Temporary -Force");
    expect(source).toContain("stopwait");
    expect(source).not.toContain("--no-elevate");
    expect(source).not.toContain('@("refresh"');
    expect(source).not.toMatch(/Set-Service.+(driver|firewall)/iu);
    expect(source).not.toContain("ExecutionPolicy Bypass");
  });

  it("packages a stopped-service reset that preserves the previous budget", async () => {
    // Source contract only; actual service state and ACL behavior require Windows.
    const source = await serviceManagerSource();
    const start = source.indexOf('if ($Action -eq "ResetRestartBudget")');
    const end = source.indexOf('if ($Action -eq "Doctor")', start);
    expect(start).toBeGreaterThan(source.indexOf("$Mutex.WaitOne(0)"));
    expect(end).toBeGreaterThan(start);
    const reset = source.slice(start, end);
    expect(reset).toContain(
      "[ServiceProcess.ServiceControllerStatus]::Stopped",
    );
    expect(reset).toContain("[IO.FileAttributes]::ReparsePoint");
    expect(reset.indexOf("::Stopped")).toBeLessThan(
      reset.indexOf("Move-Item -LiteralPath $BudgetPath"),
    );
    expect(reset).toContain(
      'Assert-RegularFile $BudgetPath "restart budget" 4096',
    );
    expect(reset).toContain(
      "Move-Item -LiteralPath $BudgetPath -Destination $SavedBudget -ErrorAction Stop",
    );
    expect(reset).not.toMatch(
      /Start-Service|Remove-Item|Set-Content|Invoke-Checked/u,
    );
    expect(reset).toContain("service remains stopped");
  });

  it("cleans generated qualification media after commit and retains Stage uploads", async () => {
    // Source contract only; Windows filesystem and service checks run natively.
    const source = await serviceManagerSource();
    const completed = source.indexOf("      Complete-OperationJournal $Root");
    const cleanup = source.indexOf(
      "        Remove-QualificationWorkspace $Root $QualificationReport",
    );
    expect(cleanup).toBeGreaterThan(completed);
    const staged = source.slice(
      source.indexOf("    if ($StagingOnly) {"),
      source.indexOf("    } else {", source.indexOf("    if ($StagingOnly) {")),
    );
    expect(staged).not.toContain("Remove-QualificationWorkspace");
    expect(source).toContain("$Output.StartsWith($Prefix");
    expect(source).toContain("Remove-OperationScratch $Workspace");
    expect(source).toContain("[IO.FileAttributes]::ReparsePoint");
    expect(source).toContain("installation remains committed");
  });
});

async function serviceManagerSource(): Promise<string> {
  const helpers = await readFile(
    resolve(workerRoot, "scripts/windows-service-functions.ps1"),
    "utf8",
  );
  const manager = await readFile(
    resolve(workerRoot, "scripts/manage-windows-service.ps1"),
    "utf8",
  );
  return manager.replace(
    ". (Join-Path $PSScriptRoot 'windows-service-functions.ps1')",
    helpers,
  );
}
