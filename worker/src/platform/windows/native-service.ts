import { execFile } from "node:child_process";
import { win32 } from "node:path";
import { promisify } from "node:util";
import { readWindowsActiveVersion } from "./active-release.js";
import { verifyWindowsRelease } from "./release-manifest.js";
import {
  createWindowsReleaseLayout,
  type WindowsServiceLayout,
} from "./service-definition.js";

const execute = promisify(execFile);
export type WindowsServiceState = "absent" | "stopped" | "running" | "pending";
export interface WindowsServiceStatus {
  state: WindowsServiceState;
  processId: number | null;
  runtimeProcessId: number | null;
  runtimeStartedAt: string | null;
}
export interface WindowsServiceActions {
  inspect(): Promise<WindowsServiceStatus>;
  start(): Promise<void>;
  stop(): Promise<void>;
  assertPrivateInstallation(): Promise<void>;
}

/** SCM control uses a fixed service ID and validates its account and executable. */
export class WindowsServiceController implements WindowsServiceActions {
  constructor(private readonly layout: WindowsServiceLayout) {}

  async inspect(): Promise<WindowsServiceStatus> {
    const output = await this.run(`
$Service = Get-CimInstance Win32_Service -Filter "Name='MusicMuteWorker'"
if ($null -eq $Service) { '{"state":"absent","processId":null,"runtimeProcessId":null,"runtimeStartedAt":null}'; return }
Assert-Service $Service
$State = switch ($Service.State) { 'Running' { 'running' } 'Stopped' { 'stopped' } default { 'pending' } }
$Children = @()
if ($Service.ProcessId -gt 0) {
  $Children = @(Get-CimInstance Win32_Process -Filter ("ParentProcessId=" + $Service.ProcessId) | Where-Object {
    $_.Name -eq 'node.exe' -and $_.ExecutablePath.StartsWith((Join-Path $Root 'releases') + '\\', [StringComparison]::OrdinalIgnoreCase)
  })
}
@{
  state=$State
  processId=if ($Service.ProcessId -gt 0) { [int]$Service.ProcessId } else { $null }
  runtimeProcessId=if ($Children.Count -eq 1) { [int]$Children[0].ProcessId } else { $null }
  runtimeStartedAt=if ($Children.Count -eq 1) { $Children[0].CreationDate.ToUniversalTime().ToString('o') } else { $null }
} | ConvertTo-Json -Compress
`);
    const value = JSON.parse(output) as WindowsServiceStatus;
    if (
      !["absent", "stopped", "running", "pending"].includes(value.state) ||
      [value.processId, value.runtimeProcessId].some(
        (pid) => pid !== null && (!Number.isSafeInteger(pid) || pid < 1),
      ) ||
      (value.runtimeStartedAt !== null &&
        (typeof value.runtimeStartedAt !== "string" ||
          !Number.isFinite(Date.parse(value.runtimeStartedAt))))
    )
      throw new TypeError("Windows service status is invalid");
    return value;
  }

  async start(): Promise<void> {
    await this.transition("Running");
  }
  async stop(): Promise<void> {
    // The caller owns the operator lock. Reuse maintenance's durable SCM
    // recovery policy, including when a crashed service is already stopped.
    const version = await readWindowsActiveVersion(this.layout);
    const release = createWindowsReleaseLayout(this.layout, version);
    const manifest = await verifyWindowsRelease(release.releaseRoot);
    const helper = "installer/windows-service-functions.ps1";
    if (
      !manifest.entries.some(
        (entry) => entry.path === helper && entry.kind === "file",
      )
    )
      throw new Error("Installed runtime lacks Windows service stop support");
    const helperPath = win32
      .join(release.releaseRoot, "installer", "windows-service-functions.ps1")
      .replaceAll("'", "''");
    await this.run(
      `
. '${helperPath}'
Assert-Administrator
Stop-ManagedService $Root '${version}'
`,
      240_000,
    );
  }

  /** Caller owns the operator lock and has already drained and stopped work. */
  async uninstall(): Promise<void> {
    await this.run(`
$Service=Get-CimInstance Win32_Service -Filter "Name='MusicMuteWorker'"
if ($null -eq $Service) { return }
Assert-Service $Service
if ($Service.State -ne 'Stopped' -or $Service.ProcessId -ne 0) { throw 'Stop the worker before uninstalling.' }
$Result=Invoke-CimMethod -InputObject $Service -MethodName Delete
if ($Result.ReturnValue -ne 0) { throw 'Service deletion failed.' }
$Timer=[Diagnostics.Stopwatch]::StartNew()
while ($null -ne (Get-CimInstance Win32_Service -Filter "Name='MusicMuteWorker'")) {
  if ($Timer.Elapsed.TotalSeconds -ge 30) { throw 'Service deletion is still pending.' }
  Start-Sleep -Milliseconds 250
}
`);
  }

  async assertPrivateInstallation(): Promise<void> {
    await this.run(`
$Identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$Principal = New-Object Security.Principal.WindowsPrincipal($Identity)
if (-not $Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) -and $Identity.User.Value -ne 'S-1-5-19') {
  throw 'Use an elevated administrator shell for the Windows worker CLI.'
}
foreach ($Path in @($Root, (Join-Path $Root 'state'), (Join-Path $Root 'service'), (Join-Path $Root 'releases'))) {
  $Item = Get-Item -LiteralPath $Path -Force
  if (-not $Item.PSIsContainer -or ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unsafe Windows installation directory.' }
  $Acl = Get-Acl -LiteralPath $Path
  foreach ($Rule in $Acl.Access) {
    $Sid = $Rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    if ($Rule.AccessControlType -eq 'Allow' -and $Sid -notin @('S-1-5-18', 'S-1-5-19', 'S-1-5-32-544')) { throw 'Windows installation permissions are not private.' }
    if ($Rule.AccessControlType -eq 'Allow' -and $Sid -eq 'S-1-5-19' -and $Path -ne (Join-Path $Root 'state') -and (([long]$Rule.FileSystemRights -band 852246) -ne 0)) {
      throw 'LocalService must not be able to modify installed executable directories.'
    }
  }
}
`);
  }

  private async transition(target: "Running" | "Stopped"): Promise<void> {
    await this.run(`
$Service = Get-CimInstance Win32_Service -Filter "Name='MusicMuteWorker'"
if ($null -eq $Service) { throw 'Windows worker service is not installed.' }
Assert-Service $Service
$Controller = Get-Service -Name 'MusicMuteWorker'
if ($Controller.Status -ne '${target}') {
  ${target === "Running" ? "Start-Service" : "Stop-Service"} -InputObject $Controller
  $Controller.WaitForStatus([ServiceProcess.ServiceControllerStatus]::${target}, [TimeSpan]::FromSeconds(45))
}
`);
  }

  private async run(body: string, timeout = 60_000): Promise<string> {
    if (process.platform !== "win32")
      throw new TypeError("Windows service control requires Windows");
    const root = this.layout.installRoot.replaceAll("'", "''");
    const script = `
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$Root='${root}'
function Assert-Service($Service) {
  $Expected = Join-Path $Root 'service\\MusicMuteWorkerService.exe'
  if ($Service.StartName -ne 'NT AUTHORITY\\LocalService' -or $Service.PathName.Trim('"') -ine $Expected) {
    throw 'Windows service identity does not match this installation.'
  }
}
${body}`;
    const systemRoot = process.env.SystemRoot;
    if (
      systemRoot === undefined ||
      !/^[A-Za-z]:\\[^\r\n\0]+$/u.test(systemRoot)
    )
      throw new TypeError("Windows system directory is unavailable");
    try {
      const result = await execute(
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
          "-ExecutionPolicy",
          "RemoteSigned",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ],
        { windowsHide: true, timeout, maxBuffer: 64 * 1024 },
      );
      return result.stdout.trim();
    } catch {
      // Raw PowerShell error streams can include paths or command contents.
      throw new Error(
        "Windows service operation failed; check elevation, installation ACLs and service identity",
      );
    }
  }
}
