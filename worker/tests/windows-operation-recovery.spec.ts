import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { buildServiceRuntimeConfig } from "../src/enrollment/runtime-config-builder.js";

const execute = promisify(execFile);
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const manager = resolve(
  import.meta.dirname,
  "../scripts/windows-service-functions.ps1",
);
const shell = join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
function script(root: string, body: string): string[] {
  const code = `$ErrorActionPreference='Stop'; Set-StrictMode -Version Latest
$Ast=[Management.Automation.Language.Parser]::ParseFile(${quote(manager)},[ref]$null,[ref]$null)
foreach ($Function in $Ast.EndBlock.Statements) {
  if ($Function -is [Management.Automation.Language.FunctionDefinitionAst]) {
    . ([ScriptBlock]::Create($Function.Extent.Text))
  }
}
$Root=${quote(root)}
$ServiceName='MusicMuteRecoveryFixtureServiceNeverInstalled'
$LocalServiceSid='*S-1-5-19'; $SystemSid='*S-1-5-18'; $AdministratorsSid='*S-1-5-32-544'
${body}`;
  return [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(code, "utf16le").toString("base64"),
  ];
}
const prepare = `
New-Item -ItemType Directory -Path (Join-Path $Root 'state'),(Join-Path $Root 'service') | Out-Null
Set-DirectoryAcl (Join-Path $Root 'service') 'RX' | Out-Null
[IO.File]::WriteAllText((Join-Path $Root 'state\\runtime.json'), '{"fixture":"before"}')
[IO.File]::WriteAllText((Join-Path $Root 'state\\machine.credential'), 'synthetic-fixture-not-a-real-credential')
[IO.File]::WriteAllText((Join-Path $Root 'state\\lifecycle.json'), '{"schemaVersion":1,"intent":"paused","revision":4,"updatedAt":"2026-09-29T00:00:00Z"}')
[IO.File]::WriteAllText((Join-Path $Root 'service\\update-state.json'), '{"schemaVersion":1,"highestSequence":5,"quarantinedVersions":[]}')
Save-OperationJournal $Root $false $false ''
[IO.File]::WriteAllText((Join-Path $Root 'state\\runtime.json'), '{"fixture":"after"}')
[IO.File]::WriteAllText((Join-Path $Root 'state\\active-release.json'), '{"fixture":"candidate"}')
Remove-Item -LiteralPath (Join-Path $Root 'state\\machine.credential')
[IO.File]::WriteAllText((Join-Path $Root 'state\\lifecycle.json'), '{"intent":"draining"}')
[IO.File]::WriteAllText((Join-Path $Root 'service\\update-state.json'), '{"highestSequence":6}')
`;

describe.skipIf(process.platform !== "win32")(
  "native Windows durable operation recovery",
  () => {
    it("journals actual SCM recovery settings and disables restarts during qualification", async () => {
      const root = await mkdtemp(join(tmpdir(), "mw-scm-policy-"));
      const serviceName = `MusicMutePolicyFixture-${randomUUID()}`;
      try {
        await execute(
          shell,
          script(
            root,
            `
$ServiceName=${quote(serviceName)}
New-Item -ItemType Directory -Path (Join-Path $Root 'state'),(Join-Path $Root 'service') | Out-Null
Set-DirectoryAcl (Join-Path $Root 'service') 'RX' | Out-Null
$Wrapper=Join-Path $Root 'service\\MusicMuteWorkerService.exe'
Copy-Item -LiteralPath (Join-Path $env:SystemRoot 'System32\\cmd.exe') -Destination $Wrapper
# This fixture registers an inert executable and never starts the service.
$Created=Invoke-CimMethod -ClassName Win32_Service -MethodName Create -Arguments @{Name=$ServiceName;DisplayName=$ServiceName;PathName=('"'+$Wrapper+'"');ServiceType=[byte]16;ErrorControl=[byte]1;StartMode='Manual';StartName='NT AUTHORITY\\LocalService'}
if ($Created.ReturnValue -ne 0) { throw 'SCM fixture creation failed' }
try {
  [IO.File]::WriteAllText((Join-Path $Root 'state\\runtime.json'), '{"fixture":"config"}')
  [IO.File]::WriteAllText((Join-Path $Root 'state\\machine.credential'), 'synthetic-policy-fixture')
  [IO.File]::WriteAllText((Join-Path $Root 'service\\MusicMuteWorkerService.xml'), '<fixture/>')
  [IO.File]::WriteAllText((Join-Path $Root 'state\\active-release.json'), '{"releaseVersion":"0.1.0-test"}')
  $Expected=@{schemaVersion=1;startMode='Auto';delayedAutoStart=$true;nonCrash=$true;resetPeriod=7200;types=@(1,1,0);delays=@(100,250,0)}
  Set-ServicePolicy $Root $Expected
  foreach($Case in @('boolean','fraction','command','delay','length')) {
    $Invalid=$Expected|ConvertTo-Json|ConvertFrom-Json
    switch($Case) {
      'boolean' {$Invalid.resetPeriod=$true}
      'fraction' {$Invalid.delays[0]=0.5}
      'command' {$Invalid.types[0]=3}
      'delay' {$Invalid.delays[0]=60001}
      'length' {$Invalid.delays=@()}
    }
    $Rejected=$false
    try {Set-ServicePolicy $Root $Invalid} catch {$Rejected=$true}
    if(-not $Rejected) {throw 'Invalid SCM policy was accepted'}
  }
  Save-OperationJournal $Root $true $false '0.1.0-test' '' '' '0.1.0-test'
  $Saved=(Read-OperationJournal $Root).servicePolicy
  if($Saved.startMode -ne 'Auto' -or -not $Saved.delayedAutoStart -or ($Saved.delays -join ',') -ne '100,250,0') { throw 'SCM policy was not journaled' }
  $Quiet=Disable-ServiceRestarts $Root $Saved
  $Disabled=Get-ServicePolicy $Root
  if($Disabled.startMode -ne 'Disabled' -or ($Disabled.types -join ',') -ne '0') { throw 'Restarts were not disabled' }
  Wait-ServiceRestartQueue $Quiet
  if($Quiet.clock.ElapsedMilliseconds -lt 250) { throw 'Queued restart deadline was not respected' }
  Enable-QualificationService $Root
  $Qualification=Get-ServicePolicy $Root
  if($Qualification.startMode -ne 'Manual' -or ($Qualification.types -join ',') -ne '0' -or $Qualification.nonCrash) { throw 'Qualification recovery policy was unsafe' }
  function Read-ReleaseManifest { return @{releaseVersion='0.1.0-test'} }
  Restore-OperationJournal $Root
  $Restored=Get-ServicePolicy $Root
  foreach($Key in @('startMode','delayedAutoStart','nonCrash','resetPeriod')) { if($Restored[$Key] -ne $Expected[$Key]) { throw 'SCM policy was not restored' } }
  if(($Restored.types -join ',') -ne '1,1,0' -or ($Restored.delays -join ',') -ne '100,250,0') { throw 'SCM actions were not restored' }
  if(Test-Path (Join-Path $Root 'service\\operation-recovery')) { throw 'Recovery did not commit' }
  $StopClock=[Diagnostics.Stopwatch]::StartNew()
  Stop-ManagedService $Root '0.1.0-test'
  if($StopClock.ElapsedMilliseconds -lt 250) { throw 'Explicit stop skipped the restart queue window' }
  $StoppedPolicy=Get-ServicePolicy $Root
  foreach($Key in @('startMode','delayedAutoStart','nonCrash','resetPeriod')) { if($StoppedPolicy[$Key] -ne $Expected[$Key]) { throw 'Explicit stop changed SCM policy' } }
  if(($StoppedPolicy.types -join ',') -ne '1,1,0' -or ($StoppedPolicy.delays -join ',') -ne '100,250,0') { throw 'Explicit stop changed recovery actions' }
  if(Test-Path (Join-Path $Root 'service\\operation-recovery')) { throw 'Explicit stop did not commit' }
  function Wait-WorkerDrain {
    [IO.File]::WriteAllText((Join-Path $Root 'state\\lifecycle.json'), '{"intent":"draining"}')
    throw 'fixture drain refusal'
  }
  $Rejected=$false
  try { Invoke-Uninstall $Root } catch { if($_.Exception.Message -notmatch 'fixture drain refusal') {throw}; $Rejected=$true }
  if(-not $Rejected) {throw 'Uninstall ignored a drain failure'}
  $Retained=Get-ServicePolicy $Root
  foreach($Key in @('startMode','delayedAutoStart','nonCrash','resetPeriod')) {if($Retained[$Key] -ne $Expected[$Key]) {throw 'Rejected uninstall changed SCM policy'}}
  if(($Retained.types -join ',') -ne '1,1,0' -or ($Retained.delays -join ',') -ne '100,250,0') {throw 'Rejected uninstall changed recovery actions'}
  foreach($Leaf in @('service\\MusicMuteWorkerService.exe','service\\MusicMuteWorkerService.xml','state\\runtime.json','state\\machine.credential','state\\active-release.json')) {
    if(-not (Test-Path (Join-Path $Root $Leaf))) {throw 'Rejected uninstall lost original files'}
  }
  if(([IO.File]::ReadAllText((Join-Path $Root 'state\\lifecycle.json'))|ConvertFrom-Json).intent -ne 'draining') {throw 'Rejected uninstall lost drain intent'}
  if(Test-Path (Join-Path $Root 'service\\operation-recovery')) {throw 'Rejected uninstall entered a rollback transaction'}

} finally {
  $Native=Get-CimInstance Win32_Service -Filter "Name='$ServiceName'"
  if($null -ne $Native) {
    if($Native.State -ne 'Stopped' -or $Native.ProcessId -ne 0) { throw 'Inert policy fixture unexpectedly started' }
    $Deleted=Invoke-CimMethod -InputObject $Native -MethodName Delete
    if($Deleted.ReturnValue -ne 0) { throw 'SCM fixture deletion failed' }
  }
}
`,
          ),
          { timeout: 90_000 },
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }, 100_000);

    it("drains the current runtime before an update and refuses a stale process identity", async () => {
      const root = await mkdtemp(join(tmpdir(), "mw-update-drain-"));
      try {
        await execute(
          shell,
          script(
            root,
            `
Add-Type -AssemblyName System.ServiceProcess
New-Item -ItemType Directory -Path (Join-Path $Root 'state') | Out-Null
Set-DirectoryAcl $Root 'RX' | Out-Null
$LifecyclePath=Join-Path $Root 'state\\lifecycle.json'
$StatusPath=Join-Path $Root 'state\\runtime-status.json'
[IO.File]::WriteAllText($LifecyclePath, '{"schemaVersion":1,"intent":"paused","revision":1,"updatedAt":"2026-09-29T00:00:00Z"}')
$script:Stopped=$false; $script:StatusReads=0; $script:ChildPid=777; $script:ForceCase=$false
function Get-CimInstance([string]$ClassName,[string]$Filter) {
  if ($ClassName -eq 'Win32_Process') {
    return [pscustomobject]@{ Name='node.exe'; ExecutablePath=(Join-Path $Root 'releases\\0.1.0\\runtime\\node\\node.exe'); ProcessId=$script:ChildPid; CreationDate=[DateTime]::UtcNow.AddMinutes(-1) }
  }
  return [pscustomobject]@{State=$(if($script:Stopped){'Stopped'}else{'Running'});ProcessId=$(if($script:Stopped){0}else{100});StartName='NT AUTHORITY\\LocalService';PathName=(Join-Path $Root 'service\\MusicMuteWorkerService.exe')}
}
function Get-Service {
  $Result=[pscustomobject]@{}
  $Result|Add-Member ScriptMethod WaitForStatus {param($Target,$Timeout)}
  $Result|Add-Member ScriptMethod Dispose {}
  return $Result
}
function Stop-Service {
  if (-not $script:ForceCase -and $script:StatusReads -lt 2) { throw 'Stopped before drain acknowledgement' }
  $script:Stopped=$true
}
$OriginalAssert=(Get-Item Function:Assert-RegularFile).ScriptBlock
function Assert-RegularFile([string]$Path,[string]$Label,[long]$MaximumBytes) {
  if ($Path -eq $StatusPath) {
    $script:StatusReads++
    $Life=[IO.File]::ReadAllText($LifecyclePath)|ConvertFrom-Json
    $Value=@{schemaVersion=1;processId=777;updatedAt=[DateTimeOffset]::UtcNow.ToString('o');activeAttemptIds=@();observedLifecycle=@{revision=$Life.revision;intent=$Life.intent}}
    if ($script:StatusReads -eq 1) { $Value.activeAttemptIds=@('synthetic-attempt') }
    [IO.File]::WriteAllText($StatusPath,($Value|ConvertTo-Json -Depth 4 -Compress))
  }
  & $OriginalAssert $Path $Label $MaximumBytes
}
$Drained=Wait-WorkerDrain $Root $false
if ($script:Stopped -or $script:StatusReads -ne 2) {throw 'Pre-transaction drain stopped the service'}
$Original=[Text.Encoding]::UTF8.GetString([byte[]]$Drained.originalLifecycle)|ConvertFrom-Json
if ($Original.intent -ne 'paused' -or $Original.revision -ne 1) {throw 'Drain lost original lifecycle intent'}
New-Item -ItemType Directory -Path (Join-Path $Root 'service') | Out-Null
Save-OperationJournal $Root $false $false '' -OriginalLifecycle $Drained.originalLifecycle
$Journal=Read-OperationJournal $Root
if (-not $Journal.files.lifecycle.existed) {throw 'Original lifecycle was not journaled'}
$Saved=[IO.File]::ReadAllText((Join-Path $Root 'service\\operation-recovery\\lifecycle.bin'))|ConvertFrom-Json
if ($Saved.intent -ne 'paused' -or $Saved.revision -ne 1) {throw 'Journal replaced original intent with draining'}
Complete-OperationJournal $Root
Stop-RegisteredWorker $Root
if (-not $script:Stopped -or $script:StatusReads -ne 2) { throw 'Graceful drain did not complete' }
$Life=[IO.File]::ReadAllText($LifecyclePath)|ConvertFrom-Json
if ($Life.intent -ne 'draining' -or $Life.revision -ne 2) { throw 'Drain intent was not recorded' }
$script:Stopped=$false; $script:ChildPid=888
$Failed=$false
try { Stop-WorkerForUpdate $Root $false } catch { $Failed=$true }
if (-not $Failed -or $script:Stopped) { throw 'Stale process identity was not refused' }
$Before=$script:StatusReads; $script:ForceCase=$true
Stop-WorkerForUpdate $Root $true
if (-not $script:Stopped -or $Before -ne $script:StatusReads) { throw 'Forced stop read unsafe runtime status' }
`,
          ),
          { timeout: 45_000 },
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }, 60_000);

    it("commits preserved reactivation only after health and restores files after failure", async () => {
      const root = await mkdtemp(join(tmpdir(), "mw-reactivate-recovery-"));
      try {
        await execute(
          shell,
          script(
            root,
            `
New-Item -ItemType Directory -Path (Join-Path $Root 'state'),(Join-Path $Root 'service'),(Join-Path $Root 'releases\\0.1.0-test\\runtime\\service') | Out-Null
Set-DirectoryAcl $Root 'RX' | Out-Null
Set-DirectoryAcl (Join-Path $Root 'service') 'RX' | Out-Null
Set-DirectoryAcl (Join-Path $Root 'releases') 'RX' | Out-Null
$Release=Join-Path $Root 'releases\\0.1.0-test'
[IO.File]::WriteAllText((Join-Path $Release 'runtime\\service\\MusicMuteWorkerService.exe'), 'fixture-wrapper-never-executed')
[IO.File]::WriteAllText((Join-Path $Root 'state\\runtime.json'), '{"fixture":"preserved-config"}')
[IO.File]::WriteAllText((Join-Path $Root 'state\\machine.credential'), 'synthetic-private-credential')
[IO.File]::WriteAllText((Join-Path $Root 'state\\lifecycle.json'), '{"intent":"paused"}')
function Read-ReleaseManifest { return @{releaseVersion='0.1.0-test'} }
function Get-Service { return $null }
function Invoke-WorkerCli([string]$ReleaseRoot, [string[]]$Arguments) {
  if ($Arguments[1] -eq 'service-config') { [IO.File]::WriteAllText($Arguments[-1], '<fixture-service/>') }
  elseif ($Arguments[1] -ne 'config-check') { throw 'Unexpected CLI operation' }
}
$OriginalInvoke=(Get-Item Function:Invoke-Checked).ScriptBlock
function Invoke-Checked([string]$Command, [string[]]$Arguments) {
  if ($Command.EndsWith('MusicMuteWorkerService.exe')) { return }
  & $OriginalInvoke $Command $Arguments
}
$script:FailHealth=$true
function Test-InstalledRuntime { if ($script:FailHealth) { throw 'synthetic health failure' } }
$Failed=$false
try { Invoke-Reactivate $Root $Release } catch { $Failed=$true }
if (-not $Failed) { throw 'Health failure was accepted' }
foreach ($Suffix in @('service\\operation-recovery','service\\MusicMuteWorkerService.exe','service\\MusicMuteWorkerService.xml','state\\active-release.json')) {
  if (Test-Path -LiteralPath (Join-Path $Root $Suffix)) { throw 'Failed activation was not restored' }
}
$script:FailHealth=$false
Invoke-Reactivate $Root $Release
if (Test-Path -LiteralPath (Join-Path $Root 'service\\operation-recovery')) { throw 'Successful activation did not commit' }
if ((Read-ActiveVersion (Join-Path $Root 'state')) -ne '0.1.0-test') { throw 'Expected release was not activated' }
`,
          ),
          { timeout: 45_000 },
        );
        expect(
          await readFile(join(root, "state", "runtime.json"), "utf8"),
        ).toBe('{"fixture":"preserved-config"}');
        expect(
          await readFile(join(root, "state", "machine.credential"), "utf8"),
        ).toBe("synthetic-private-credential");
        expect(
          await readFile(join(root, "state", "lifecycle.json"), "utf8"),
        ).toBe('{"intent":"paused"}');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }, 60_000);

    it("accepts two adapter-0 slots only with the installed capacity approval path", async () => {
      const root = await mkdtemp(join(tmpdir(), "mw-slot-layout-"));
      try {
        const config = buildServiceRuntimeConfig({
          platform: "windows-amd64",
          installRoot: root,
          releaseVersion: "0.1.0-test",
          backendBaseUrl: "https://api.musicmute.test",
          machineId: "00000000-0000-4000-8000-000000000010",
          workerId: "00000000-0000-4000-8000-000000000011",
        });
        await execute(
          shell,
          script(
            root,
            `
$ConfigPath=Join-Path $Root 'runtime.json'
$Config='${JSON.stringify(config).replaceAll("'", "''")}'|ConvertFrom-Json
$Release=Join-Path $Root 'releases\\0.1.0-test'
$State=Join-Path $Root 'state'
function Check-Config { [IO.File]::WriteAllText($ConfigPath,($Config|ConvertTo-Json -Depth 6)); Assert-RuntimeConfig $ConfigPath $Release $State }
Check-Config
$Second=$Config.slots[0]|ConvertTo-Json|ConvertFrom-Json
$Second.workerId='00000000-0000-4000-8000-000000000012'; $Second.slotIndex=1
$Config.slots=@($Config.slots[0],$Second)
$Config.validatedMaxWorkersPerGpu=2
$Config|Add-Member -NotePropertyName capacityValidationFile -NotePropertyValue (Join-Path $State 'capacity-validation.json')
Check-Config
foreach ($Case in @('receipt','device','index','provider','three')) {
  $Saved=$Config|ConvertTo-Json -Depth 6
  switch ($Case) {
    'receipt' { $Config.capacityValidationFile=Join-Path $Root 'foreign.json' }
    'device' { $Config.slots[1].directmlDeviceId=1 }
    'index' { $Config.slots[1].slotIndex=0 }
    'provider' { $Config.slots[1].provider='cpu' }
    'three' { $Config.slots+=@($Second) }
  }
  $Rejected=$false
  try { Check-Config } catch { $Rejected=$true }
  if (-not $Rejected) { throw "Unsafe slot layout accepted: $Case" }
  $Config=$Saved|ConvertFrom-Json
}
`,
          ),
          { timeout: 30_000 },
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }, 45_000);

    it("protects installation files and rejects report paths through directory links", async () => {
      const root = await mkdtemp(join(tmpdir(), "mw-report-path-"));
      try {
        await execute(
          shell,
          script(
            root,
            `
New-Item -ItemType Directory -Path (Join-Path $Root 'state'),(Join-Path $Root 'target') | Out-Null
Assert-ReportDestination $Root (Join-Path $Root 'state\\benchmark-12345678-1234-1234-1234-123456789abc.json')
foreach ($Suffix in @('releases\\version\\extra.json','service\\extra.json','state\\runtime.json')) {
  $Rejected=$false
  try { Assert-ReportDestination $Root (Join-Path $Root $Suffix) } catch { $Rejected=$true }
  if (-not $Rejected) { throw 'Installation report path was accepted' }
}
New-Item -ItemType Junction -Path (Join-Path $Root 'link') -Target (Join-Path $Root 'target') | Out-Null
$Rejected=$false
try { Assert-ReportDestination (Join-Path $Root 'install') (Join-Path $Root 'link\\output.json') } catch { $Rejected=$true }
if (-not $Rejected) { throw 'Linked report directory was accepted' }
`,
          ),
          { timeout: 30_000 },
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }, 60_000);

    it("restores the pre-operation files after killing the installer and is idempotent", async () => {
      const root = await mkdtemp(join(tmpdir(), "mw-recovery-"));
      const child = spawn(
        shell,
        script(
          root,
          `${prepare}\n[Console]::WriteLine('ready'); [Console]::ReadLine() | Out-Null`,
        ),
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      try {
        await Promise.race([
          once(child.stdout!, "data").then(([data]) =>
            expect(String(data)).toContain("ready"),
          ),
          once(child, "exit").then(() => {
            throw new Error("Fixture installer exited early");
          }),
        ]);
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
        await execute(
          shell,
          script(
            root,
            "Restore-OperationJournal $Root; Restore-OperationJournal $Root",
          ),
          { timeout: 30_000 },
        );
        expect(
          await readFile(join(root, "state", "runtime.json"), "utf8"),
        ).toBe('{"fixture":"before"}');
        expect(
          await readFile(join(root, "state", "machine.credential"), "utf8"),
        ).toBe("synthetic-fixture-not-a-real-credential");
        expect(
          JSON.parse(
            await readFile(join(root, "state", "lifecycle.json"), "utf8"),
          ),
        ).toMatchObject({ intent: "paused", revision: 4 });
        expect(
          JSON.parse(
            await readFile(join(root, "service", "update-state.json"), "utf8"),
          ),
        ).toMatchObject({ highestSequence: 5, quarantinedVersions: [] });
        await expect(
          stat(join(root, "state", "active-release.json")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        await expect(
          stat(join(root, "service", "operation-recovery")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await rm(root, { recursive: true, force: true });
      }
    }, 60_000);

    it("refuses corrupted backup content before changing the candidate files", async () => {
      const root = await mkdtemp(join(tmpdir(), "mw-corrupt-recovery-"));
      try {
        await execute(
          shell,
          script(
            root,
            `${prepare}\n[IO.File]::WriteAllText((Join-Path $Root 'service\\operation-recovery\\config.bin'), 'tampered')`,
          ),
          { timeout: 30_000 },
        );
        await expect(
          execute(shell, script(root, "Restore-OperationJournal $Root"), {
            timeout: 30_000,
          }),
        ).rejects.toThrow("snapshot content changed");
        expect(
          await readFile(join(root, "state", "runtime.json"), "utf8"),
        ).toBe('{"fixture":"after"}');
        expect(
          (
            await stat(join(root, "service", "operation-recovery"))
          ).isDirectory(),
        ).toBe(true);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }, 60_000);

    it("does not roll back after the operation has committed", async () => {
      const root = await mkdtemp(join(tmpdir(), "mw-committed-recovery-"));
      try {
        await execute(
          shell,
          script(
            root,
            `${prepare}\nComplete-OperationJournal $Root; Restore-OperationJournal $Root`,
          ),
          { timeout: 30_000 },
        );
        expect(
          await readFile(join(root, "state", "runtime.json"), "utf8"),
        ).toBe('{"fixture":"after"}');
        expect(
          (await stat(join(root, "state", "active-release.json"))).isFile(),
        ).toBe(true);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }, 60_000);
  },
);
