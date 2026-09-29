import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execute = promisify(execFile);
const wrapper = process.env.MUSICMUTE_WINSW_TEST_BINARY;
const enabled = process.platform === "win32" && wrapper !== undefined;
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

// A unique temporary SCM registration. Never mutates the installed worker.
describe.runIf(enabled)("native Windows explicit stop", () => {
  it("suppresses crash restart, preserves SCM policy and safely uninstalls", async () => {
    const root = await mkdtemp(join(tmpdir(), "mw-stop-service-"));
    const serviceName = `MusicMuteStopFixture-${randomUUID()}`;
    const helper = resolve(
      import.meta.dirname,
      "../scripts/windows-service-functions.ps1",
    );
    const script = `
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
. ${quote(helper)}
Assert-Administrator
$Root=${quote(root)}
$ServiceName=${quote(serviceName)}
$OwnedChildren=@()
$Registered=$false
try {
  Set-DirectoryAcl $Root 'RX' | Out-Null
  foreach($Leaf in @('service','state')) {New-Item -ItemType Directory -Path (Join-Path $Root $Leaf) | Out-Null}
  Set-DirectoryAcl (Join-Path $Root 'service') 'RX' | Out-Null
  Set-DirectoryAcl (Join-Path $Root 'state') 'M' | Out-Null
  $Exe=Join-Path $Root 'service\\MusicMuteWorkerService.exe'
  Copy-PrivateFile ${quote(wrapper ?? "")} $Exe
  Set-ExecutableFileAcl $Exe
  $Shell=[Security.SecurityElement]::Escape((Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'))
  $Logs=[Security.SecurityElement]::Escape((Join-Path $Root 'state'))
  $Xml="<service><id>$ServiceName</id><name>$ServiceName</name><description>MusicMute owned stop test</description><executable>$Shell</executable><arguments>-NoLogo -NoProfile -NonInteractive -Command &quot;Start-Sleep -Seconds 300&quot;</arguments><logpath>$Logs</logpath><stoptimeout>3 sec</stoptimeout><startmode>Manual</startmode><serviceaccount><domain>NT AUTHORITY</domain><user>LocalService</user></serviceaccount></service>"
  Write-DurablePrivateFile (Join-Path $Root 'service\\MusicMuteWorkerService.xml') ([Text.Encoding]::UTF8.GetBytes($Xml))
  foreach($File in @('runtime.json','active-release.json')) {Write-DurablePrivateFile (Join-Path $Root "state\\$File") ([Text.Encoding]::UTF8.GetBytes('{}'))}
  Write-DurablePrivateFile (Join-Path $Root 'state\\lifecycle.json') ([Text.Encoding]::UTF8.GetBytes('{"schemaVersion":1,"intent":"active","revision":1,"updatedAt":"2026-09-29T00:00:00Z"}'))
  Write-ActiveVersion (Join-Path $Root 'state') '0.1.0-stop-fixture'
  Write-DurablePrivateFile (Join-Path $Root 'state\\machine.credential') ([Text.Encoding]::UTF8.GetBytes('synthetic-stop-fixture'))
  Invoke-Checked $Exe @('install')
  $Registered=$true
  # Leave time for native identity/journal checks under full-suite load before
  # SCM attempts the queued restart. The stop must still wait this whole delay.
  $RestartDelay=30000
  $Policy=@{schemaVersion=1;startMode='Manual';delayedAutoStart=$false;nonCrash=$true;resetPeriod=7200;types=@(1,0);delays=@($RestartDelay,0)}
  Set-ServicePolicy $Root $Policy
  Invoke-Checked $Exe @('start')
  $StartedController=Get-Service -Name $ServiceName
  try {$StartedController.WaitForStatus([ServiceProcess.ServiceControllerStatus]::Running,[TimeSpan]::FromSeconds(30))} finally {$StartedController.Dispose()}
  $Native=Get-CimInstance Win32_Service -Filter "Name='$ServiceName'"
  if($Native.State -ne 'Running' -or $Native.ProcessId -le 0) {throw 'Fixture did not start'}
  $Started=[DateTime]::Now.AddSeconds(-1)
  $ChildClock=[Diagnostics.Stopwatch]::StartNew()
  do {
    $OwnedChildren=@(Get-CimInstance Win32_Process -Filter ("ParentProcessId="+$Native.ProcessId) | Select-Object ProcessId,CreationDate)
    if($OwnedChildren.Count -gt 0) {break}
    if($ChildClock.Elapsed.TotalSeconds -ge 10) {throw 'Fixture child did not start'}
    Start-Sleep -Milliseconds 25
  } while($true)
  Stop-Process -Id $Native.ProcessId -Force -ErrorAction Stop
  $Clock=[Diagnostics.Stopwatch]::StartNew()
  do {
    $Native=Get-CimInstance Win32_Service -Filter "Name='$ServiceName'"
    if($Native.State -eq 'Stopped') {break}
    if($Clock.Elapsed.TotalSeconds -ge 3) {throw 'Fixture crash did not stop the service'}
    Start-Sleep -Milliseconds 25
  } while($true)
  Stop-ManagedService $Root '0.1.0-stop-fixture'
  if($Clock.ElapsedMilliseconds -lt $RestartDelay) {throw 'Stop skipped the restart queue delay'}
  $Restored=Get-ServicePolicy $Root
  foreach($Key in @('startMode','delayedAutoStart','nonCrash','resetPeriod')) {if($Restored[$Key] -ne $Policy[$Key]) {throw 'Stop changed SCM policy'}}
  if(($Restored.types -join ',') -ne '1,0' -or ($Restored.delays -join ',') -ne "$RestartDelay,0") {throw 'Stop changed recovery actions'}
  if(Test-Path (Join-Path $Root 'service\\operation-recovery')) {throw 'Stop journal did not commit'}
  $Events=@(Get-WinEvent -FilterHashtable @{LogName='System';ProviderName='Service Control Manager';Id=7031;StartTime=$Started} -ErrorAction SilentlyContinue | Where-Object {$_.Properties[0].Value -eq $ServiceName})
  if($Events.Count -lt 1) {throw 'SCM crash/restart event is missing'}
  Start-Sleep -Seconds 6
  $Native=Get-CimInstance Win32_Service -Filter "Name='$ServiceName'"
  if($Native.State -ne 'Stopped' -or $Native.ProcessId -ne 0) {throw 'Queued restart escaped explicit stop'}
  Write-Output 'queued-restart-suppressed'
  Invoke-Uninstall $Root
  Invoke-Uninstall $Root
  foreach($Leaf in @('service\\MusicMuteWorkerService.exe','service\\MusicMuteWorkerService.xml','state\\active-release.json','service\\operation-recovery')) {
    if(Test-Path (Join-Path $Root $Leaf)) {throw 'Uninstall retained activation files'}
  }
  foreach($Leaf in @('runtime.json','lifecycle.json','machine.credential')) {
    if(-not (Test-Path (Join-Path $Root "state\\$Leaf"))) {throw 'Uninstall removed retained state'}
  }
  if(([IO.File]::ReadAllText((Join-Path $Root 'state\\lifecycle.json'))|ConvertFrom-Json).intent -ne 'draining') {throw 'Uninstall did not fence claims'}
  Write-Output 'uninstall-preserved-state'
} finally {
  if($Registered) {
    $Current=Get-CimInstance Win32_Service -Filter "Name='$ServiceName'"
    if($null -ne $Current) {
      if($Current.PathName.Trim('"') -ine $Exe) {throw 'Fixture cleanup found an unrelated executable'}
      if($Current.StartName -ine 'NT AUTHORITY\\LocalService') {
        if($Current.State -ne 'Stopped' -or $Current.ProcessId -ne 0) {throw 'Unexpected fixture identity is running'}
        Invoke-Checked $Exe @('uninstall')
      } else {
      $Quiet=Disable-ServiceRestarts $Root
      $Controller=Get-Service -Name $ServiceName
      try {if($Controller.Status -ne 'Stopped') {Stop-Service -InputObject $Controller;$Controller.WaitForStatus([ServiceProcess.ServiceControllerStatus]::Stopped,[TimeSpan]::FromSeconds(30))}} finally {$Controller.Dispose()}
      Wait-ServiceRestartQueue $Quiet
      Invoke-Checked $Exe @('uninstall')
      }
    }
  }
  foreach($Owned in $OwnedChildren) {
    $Current=Get-CimInstance Win32_Process -Filter ("ProcessId="+$Owned.ProcessId)
    if($null -ne $Current -and $Current.CreationDate -eq $Owned.CreationDate) {Stop-Process -Id $Current.ProcessId -Force -ErrorAction Stop}
  }
  if($null -ne (Get-CimInstance Win32_Service -Filter "Name='$ServiceName'")) {throw 'Fixture cleanup is incomplete'}
}
`;
    const result = await execute(
      join(
        process.env.SystemRoot!,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "RemoteSigned",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { timeout: 240_000, maxBuffer: 128 * 1024 },
    );
    expect(result.stdout).toContain("queued-restart-suppressed");
    expect(result.stdout).toContain("uninstall-preserved-state");
    // On failure retain the directory so a surviving service cannot lose files.
    await rm(root, { recursive: true });
  }, 250_000);
});
