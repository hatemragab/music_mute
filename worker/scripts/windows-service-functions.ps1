# Shared native Windows service policy and recovery operations.
# Loading this file defines functions; callers own the operator lock.
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ServiceName = "MusicMuteWorker"
$LocalServiceSid = "*S-1-5-19"
$SystemSid = "*S-1-5-18"
$AdministratorsSid = "*S-1-5-32-544"
$ModelBytes = 66759214

function Assert-Administrator {
  $Identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $Principal = New-Object Security.Principal.WindowsPrincipal($Identity)
  if (-not $Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "This command requires an elevated administrator shell."
  }
}

function New-OperatorLock([string]$RootPath, [string]$RelativePath = 'state\operator.lock') {
  # Match runtime/native-lock.ts. The installer and CLI must exclude each other,
  # not merely other invocations of their own entry point. No client data is read.
  $Ancestor = $RootPath
  while ($Ancestor -ne "") {
    if (Test-Path -LiteralPath $Ancestor) {
      $Item = Get-Item -LiteralPath $Ancestor -Force
      if (-not $Item.PSIsContainer -or ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "The installation root must not traverse a reparse point."
      }
    }
    $Ancestor = Split-Path -Parent $Ancestor
  }
  if ($RootPath -notmatch '^[A-Za-z]:\\') {
    throw "The installation root must be on a local drive."
  }
  $Identity = [IO.Path]::GetFullPath((Join-Path $RootPath $RelativePath)).ToLowerInvariant()
  $Hash = [Security.Cryptography.SHA256]::Create()
  try {
    $Digest = [BitConverter]::ToString($Hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($Identity))).Replace('-', '').ToLowerInvariant()
  } finally { $Hash.Dispose() }
  if ($null -eq ('MusicMute.OperatorPipe' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
namespace MusicMute {
  public static class OperatorPipe {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern SafeFileHandle CreateNamedPipeW(string name, uint openMode,
      uint pipeMode, uint maxInstances, uint outBuffer, uint inBuffer,
      uint timeout, IntPtr securityAttributes);
  }
}
'@
  }
  # PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE; reject remote clients.
  $Handle = [MusicMute.OperatorPipe]::CreateNamedPipeW("\\.\pipe\musicmute-lock-$Digest", 0x00080003, 8, 1, 0, 0, 0, [IntPtr]::Zero)
  if ($Handle.IsInvalid) {
    $Handle.Dispose()
    throw "Another MusicMute operation owns this lock, or Windows denied lock creation."
  }
  return $Handle
}

function Assert-RegularFile([string]$Path, [string]$Label, [long]$MaximumBytes) {
  if (-not [IO.Path]::IsPathRooted($Path)) {
    throw "$Label must be an absolute path."
  }
  $Item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if ($Item.PSIsContainer -or ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw "$Label is unsafe."
  }
  if ($Item.Length -lt 1 -or $Item.Length -gt $MaximumBytes) {
    throw "$Label has an invalid size."
  }
  return $Item
}

function Invoke-Checked([string]$FilePath, [string[]]$Arguments) {
  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "A private Windows worker command failed."
  }
}

function Copy-ReleaseTree([string]$Source, [string]$Destination) {
  # Windows PowerShell 5 Copy-Item cannot reliably copy the long paths in the
  # locked Node/Python closure. Robocopy supports them without registry changes.
  # Keep destination ACL inheritance, omit alternate streams, never mirror/delete
  # destination content, and bound failures instead of its default million retries.
  $Robocopy = Join-Path $env:SystemRoot "System32\robocopy.exe"
  & $Robocopy $Source $Destination /E /COPY:DATX /DCOPY:DATX /XJ /R:0 /W:0 /MT:8 /NFL /NDL /NP /NJH /NJS
  if ($LASTEXITCODE -lt 0 -or $LASTEXITCODE -ge 8) {
    throw "The verified Windows release could not be copied."
  }
}

function Invoke-WorkerCli([string]$ReleaseRoot, [string[]]$Arguments) {
  $Node = Join-Path $ReleaseRoot "runtime\node\node.exe"
  $Cli = Join-Path $ReleaseRoot "app\dist\src\cli\main.js"
  Assert-RegularFile $Node "private Node" ([long]::MaxValue) | Out-Null
  Assert-RegularFile $Cli "worker CLI" (16MB) | Out-Null
  Push-Location (Join-Path $ReleaseRoot "app")
  try {
    $Output = & $Node $Cli @Arguments
    if ($LASTEXITCODE -ne 0) {
      throw "Windows release verification failed."
    }
    return $Output
  } finally {
    Pop-Location
  }
}

function Read-ReleaseManifest([string]$ReleaseRoot) {
  $Lines = @(Invoke-WorkerCli $ReleaseRoot @("windows", "verify", "--release", $ReleaseRoot))
  if ($Lines.Count -ne 1) {
    throw "Windows release verification returned invalid output."
  }
  $Result = $Lines[0] | ConvertFrom-Json
  if ($Result.status -ne "ok" -or $Result.action -ne "verify") {
    throw "Windows release verification returned invalid output."
  }
  return $Result
}

function Set-DirectoryAcl([string]$Path, [string]$ServicePermission) {
  $Icacls = Join-Path $env:SystemRoot "System32\icacls.exe"
  Invoke-Checked $Icacls @(
    $Path,
    "/inheritance:r",
    "/grant:r",
    "${SystemSid}:(OI)(CI)F",
    "${AdministratorsSid}:(OI)(CI)F",
    "${LocalServiceSid}:(OI)(CI)$ServicePermission"
  )
}

function Set-PrivateFileAcl([string]$Path) {
  $Icacls = Join-Path $env:SystemRoot "System32\icacls.exe"
  Invoke-Checked $Icacls @(
    $Path,
    "/inheritance:r",
    "/grant:r",
    "${SystemSid}:F",
    "${AdministratorsSid}:F",
    "${LocalServiceSid}:R"
  )
}

function Set-ExecutableFileAcl([string]$Path) {
  $Icacls = Join-Path $env:SystemRoot "System32\icacls.exe"
  Invoke-Checked $Icacls @(
    $Path,
    "/inheritance:r",
    "/grant:r",
    "${SystemSid}:F",
    "${AdministratorsSid}:F",
    "${LocalServiceSid}:RX"
  )
}

function Write-Utf8NoBom([string]$Path, [string]$Value) {
  $Encoding = New-Object System.Text.UTF8Encoding($false)
  [IO.File]::WriteAllText($Path, $Value, $Encoding)
}

function Write-DurablePrivateFile([string]$Path, [byte[]]$Bytes) {
  $Stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try {
    $Stream.Write($Bytes, 0, $Bytes.Length)
    $Stream.Flush($true)
  } finally { $Stream.Dispose() }
  Set-PrivateFileAcl $Path | Out-Null
}

function Get-RecoveryFiles([string]$RootPath) {
  # Destinations come from trusted code, never paths supplied by a journal.
  return [ordered]@{
    config = @{ path = (Join-Path $RootPath 'state\runtime.json'); limit = 65536; executable = $false }
    credential = @{ path = (Join-Path $RootPath 'state\machine.credential'); limit = 128; executable = $false }
    wrapper = @{ path = (Join-Path $RootPath 'service\MusicMuteWorkerService.exe'); limit = 32MB; executable = $true }
    xml = @{ path = (Join-Path $RootPath 'service\MusicMuteWorkerService.xml'); limit = 65536; executable = $false }
    active = @{ path = (Join-Path $RootPath 'state\active-release.json'); limit = 4096; executable = $false }
    lifecycle = @{ path = (Join-Path $RootPath 'state\lifecycle.json'); limit = 4096; executable = $false }
    updateState = @{ path = (Join-Path $RootPath 'service\update-state.json'); limit = 65536; executable = $false }
  }
}

function Assert-RecoveryPath([string]$Path, [bool]$Directory) {
  $Item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if ($Item.PSIsContainer -ne $Directory -or ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'The operation recovery path is unsafe.'
  }
  $Acl = Get-Acl -LiteralPath $Path
  foreach ($Rule in $Acl.Access) {
    if ($Rule.AccessControlType -ne 'Allow') { continue }
    $Sid = $Rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    if ($Sid -notin @('S-1-5-18', 'S-1-5-19', 'S-1-5-32-544') -or
        ($Sid -eq 'S-1-5-19' -and (([long]$Rule.FileSystemRights -band 852246) -ne 0))) {
      throw 'The operation recovery permissions are unsafe.'
    }
  }
}

function Initialize-ServicePolicyInterop {
  if ($null -ne ('MusicMute.ServicePolicy' -as [type])) { return }
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
namespace MusicMute {
  public sealed class FailurePolicy {
    public uint ResetPeriod;
    public uint[] Types;
    public uint[] Delays;
    public bool NonCrash;
    public bool DelayedAutoStart;
  }
  public static class ServicePolicy {
    [StructLayout(LayoutKind.Sequential)] struct Action { public uint Type, Delay; }
    [StructLayout(LayoutKind.Sequential)] struct FailureActions {
      public uint ResetPeriod; public IntPtr Reboot, Command; public uint Count; public IntPtr Actions;
    }
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern IntPtr OpenSCManagerW(string machine, string database, uint access);
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern IntPtr OpenServiceW(IntPtr manager, string name, uint access);
    [DllImport("advapi32.dll", SetLastError=true)]
    static extern bool CloseServiceHandle(IntPtr handle);
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool QueryServiceConfig2W(IntPtr service, uint level, IntPtr data, uint size, out uint needed);
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool ChangeServiceConfig2W(IntPtr service, uint level, IntPtr data);
    static IntPtr Open(string name, uint access) {
      IntPtr manager=OpenSCManagerW(null,null,1);
      if(manager==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
      try {
        IntPtr service=OpenServiceW(manager,name,access);
        if(service==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        return service;
      } finally { CloseServiceHandle(manager); }
    }
    static IntPtr Query(IntPtr service, uint level) {
      uint needed;
      QueryServiceConfig2W(service,level,IntPtr.Zero,0,out needed);
      if(needed<4 || needed>16384) throw new InvalidOperationException("Invalid SCM policy size.");
      IntPtr data=Marshal.AllocHGlobal((int)needed);
      if(!QueryServiceConfig2W(service,level,data,needed,out needed)) {
        int error=Marshal.GetLastWin32Error(); Marshal.FreeHGlobal(data); throw new Win32Exception(error);
      }
      return data;
    }
    static bool ReadFlag(IntPtr service, uint level) {
      IntPtr data=Query(service,level);
      try { return Marshal.ReadInt32(data)!=0; } finally { Marshal.FreeHGlobal(data); }
    }
    static void WriteFlag(IntPtr service,uint level,bool value) {
      IntPtr data=Marshal.AllocHGlobal(4);
      try { Marshal.WriteInt32(data,value?1:0); Change(service,level,data); }
      finally { Marshal.FreeHGlobal(data); }
    }
    static void Change(IntPtr service,uint level,IntPtr data) {
      if(!ChangeServiceConfig2W(service,level,data)) throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    public static FailurePolicy Read(string name) {
      IntPtr service=Open(name,1);
      try {
        IntPtr data=Query(service,2);
        try {
          var value=(FailureActions)Marshal.PtrToStructure(data,typeof(FailureActions));
          if(value.Count>16 || (value.Count>0 && value.Actions==IntPtr.Zero) ||
             !String.IsNullOrEmpty(Marshal.PtrToStringUni(value.Reboot)) ||
             !String.IsNullOrEmpty(Marshal.PtrToStringUni(value.Command)))
            throw new InvalidOperationException("Unsupported SCM recovery policy.");
          var policy=new FailurePolicy {ResetPeriod=value.ResetPeriod,Types=new uint[value.Count],Delays=new uint[value.Count],NonCrash=ReadFlag(service,4),DelayedAutoStart=ReadFlag(service,3)};
          for(int i=0;i<value.Count;i++) {
            var action=(Action)Marshal.PtrToStructure(IntPtr.Add(value.Actions,i*8),typeof(Action));
            if(action.Type>1 || action.Delay>60000) throw new InvalidOperationException("Unsupported SCM recovery action.");
            policy.Types[i]=action.Type;policy.Delays[i]=action.Delay;
          }
          return policy;
        } finally { Marshal.FreeHGlobal(data); }
      } finally { CloseServiceHandle(service); }
    }
    public static void Write(string name,uint resetPeriod,uint[] types,uint[] delays,bool nonCrash,bool delayed) {
      if(types==null || delays==null || types.Length!=delays.Length || types.Length>16) throw new ArgumentException("Invalid recovery actions.");
      for(int i=0;i<types.Length;i++) if(types[i]>1 || delays[i]>60000) throw new ArgumentException("Invalid recovery action.");
      IntPtr service=Open(name,0x12);
      IntPtr actions=Marshal.AllocHGlobal(Math.Max(8,types.Length*8));
      IntPtr data=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(FailureActions)));
      try {
        for(int i=0;i<types.Length;i++) Marshal.StructureToPtr(new Action {Type=types[i],Delay=delays[i]},IntPtr.Add(actions,i*8),false);
        var value=new FailureActions {ResetPeriod=resetPeriod,Count=(uint)types.Length,Actions=actions};
        Marshal.StructureToPtr(value,data,false);Change(service,2,data);
        WriteFlag(service,4,nonCrash);WriteFlag(service,3,delayed);
      } finally { Marshal.FreeHGlobal(data);Marshal.FreeHGlobal(actions);CloseServiceHandle(service); }
    }
  }
}
'@
}

function Test-ServicePolicyInteger($Value, [long]$Maximum) {
  return (($Value -is [int] -or $Value -is [long] -or $Value -is [uint32]) -and $Value -ge 0 -and $Value -le $Maximum)
}

function Assert-ServicePolicy($Policy) {
  if ($null -eq $Policy -or $Policy.schemaVersion -isnot [int] -or $Policy.schemaVersion -ne 1 -or $Policy.startMode -isnot [string] -or $Policy.startMode -notin @('Auto','Manual','Disabled') -or
      $Policy.delayedAutoStart -isnot [bool] -or $Policy.nonCrash -isnot [bool] -or
      -not (Test-ServicePolicyInteger $Policy.resetPeriod ([long][uint32]::MaxValue)) -or
      $Policy.types -isnot [array] -or $Policy.delays -isnot [array] -or
      $Policy.types.Count -ne $Policy.delays.Count -or $Policy.types.Count -gt 16) {
    throw 'The saved SCM recovery policy is invalid.'
  }
  for ($Index=0; $Index -lt $Policy.types.Count; $Index++) {
    if (-not (Test-ServicePolicyInteger $Policy.types[$Index] 1) -or
        -not (Test-ServicePolicyInteger $Policy.delays[$Index] 60000)) {
      throw 'The saved SCM recovery action is invalid.'
    }
  }
}

function Get-ServicePolicy([string]$RootPath) {
  Assert-ManagedService $RootPath
  $Native=Get-CimInstance Win32_Service -Filter "Name='$ServiceName'"
  if ($null -eq $Native) { return $null }
  Initialize-ServicePolicyInterop
  $Policy=[MusicMute.ServicePolicy]::Read($ServiceName)
  $Value=@{schemaVersion=1;startMode=[string]$Native.StartMode;delayedAutoStart=[bool]$Policy.DelayedAutoStart;nonCrash=[bool]$Policy.NonCrash;resetPeriod=[long]$Policy.ResetPeriod;types=@($Policy.Types);delays=@($Policy.Delays)}
  Assert-ServicePolicy $Value
  return $Value
}

function Set-ServicePolicy([string]$RootPath, $Policy) {
  Assert-ServicePolicy $Policy
  Assert-ManagedService $RootPath
  Initialize-ServicePolicyInterop
  $Mode=switch ($Policy.startMode) { 'Auto' { if($Policy.delayedAutoStart){'delayed-auto'}else{'auto'} }; 'Manual' {'demand'}; 'Disabled' {'disabled'} }
  Invoke-Checked (Join-Path $env:SystemRoot 'System32\sc.exe') @('config',$ServiceName,'start=',$Mode) | Out-Null
  [MusicMute.ServicePolicy]::Write($ServiceName,[uint32]$Policy.resetPeriod,[uint32[]]$Policy.types,[uint32[]]$Policy.delays,$Policy.nonCrash,$Policy.delayedAutoStart)
  $Actual=Get-ServicePolicy $RootPath
  foreach($Key in @('startMode','delayedAutoStart','nonCrash','resetPeriod')) {
    if($Actual[$Key] -ne $Policy.$Key) { throw 'SCM recovery policy did not match the requested state.' }
  }
  if(($Actual.types -join ',') -cne ($Policy.types -join ',') -or ($Actual.delays -join ',') -cne ($Policy.delays -join ',')) {
    throw 'SCM recovery actions did not match the requested state.'
  }
}

function Disable-ServiceRestarts([string]$RootPath, $SavedPolicy = $null) {
  $Current=Get-ServicePolicy $RootPath
  if ($null -eq $Current) { return $null }
  # Windows cannot cancel a queued SCM restart. Keep the service disabled until
  # every previously allowed restart delay has elapsed before enabling a task.
  $Delay=0
  foreach($Policy in @($Current,$SavedPolicy)) {
    if($null -eq $Policy) { continue }
    Assert-ServicePolicy $Policy
    for($Index=0;$Index -lt $Policy.types.Count;$Index++) {
      if($Policy.types[$Index] -eq 1) { $Delay=[Math]::Max($Delay,[int]$Policy.delays[$Index]) }
    }
  }
  Set-ServicePolicy $RootPath @{schemaVersion=1;startMode='Disabled';delayedAutoStart=$false;nonCrash=$false;resetPeriod=0;types=@(0);delays=@(0)}
  return @{clock=[Diagnostics.Stopwatch]::StartNew();delay=$Delay}
}

function Wait-ServiceRestartQueue($Quiet) {
  if ($null -eq $Quiet) { return }
  while($Quiet.clock.ElapsedMilliseconds -le $Quiet.delay) { Start-Sleep -Milliseconds 100 }
}

function Enable-QualificationService([string]$RootPath) {
  Set-ServicePolicy $RootPath @{schemaVersion=1;startMode='Manual';delayedAutoStart=$false;nonCrash=$false;resetPeriod=0;types=@(0);delays=@(0)}
}

# Caller owns the same operator lock used by installation and lifecycle commands.
# Explicit stop always recovers to stopped, even if its caller is interrupted.
function Stop-ManagedService([string]$RootPath, [string]$Version) {
  Assert-ManagedService $RootPath
  if ($Version -cnotmatch '^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$') { throw 'Stop release identity is invalid.' }
  $Native = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'"
  if ($null -eq $Native -or $Native.State -notin @('Running', 'Stopped')) { throw 'Stop requires a stable installed service.' }
  Save-OperationJournal $RootPath $true $false $Version '' '' $Version
  try {
    $Saved = (Read-OperationJournal $RootPath).servicePolicy
    $Quiet = Disable-ServiceRestarts $RootPath $Saved
    $Controller = Get-Service -Name $ServiceName -ErrorAction Stop
    try {
      if ($Controller.Status -ne [ServiceProcess.ServiceControllerStatus]::Stopped) {
        Stop-Service -InputObject $Controller
        $Controller.WaitForStatus([ServiceProcess.ServiceControllerStatus]::Stopped, [TimeSpan]::FromSeconds(45))
      }
    } finally { $Controller.Dispose() }
    Wait-ServiceRestartQueue $Quiet
    $Stopped = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'"
    if ($null -eq $Stopped -or $Stopped.State -ne 'Stopped' -or $Stopped.ProcessId -ne 0) { throw 'Windows worker did not stop.' }
    Set-ServicePolicy $RootPath $Saved
    Complete-OperationJournal $RootPath
  } catch {
    $Failure = $_
    Restore-OperationJournal $RootPath $true
    throw $Failure
  }
}

function Save-OperationJournal([string]$RootPath, [bool]$ServiceExisted, [bool]$WasRunning, [string]$PreviousVersion, [string]$ScratchLeaf = '', [string]$FixtureLeaf = '', [string]$RecoveryVersion = '', [string]$UpdateCandidate = '', [byte[]]$OriginalLifecycle = $null) {
  $JournalRoot = Join-Path $RootPath 'service\operation-recovery'
  if (Test-Path -LiteralPath $JournalRoot) { throw 'An unfinished operation requires recovery.' }
  $Preparing = Join-Path $RootPath ("service\.operation-$([guid]::NewGuid()).preparing")
  New-Item -ItemType Directory -Path $Preparing | Out-Null
  Set-DirectoryAcl $Preparing 'RX' | Out-Null
  try {
    $Snapshots = [ordered]@{}
    $Files = Get-RecoveryFiles $RootPath
    foreach ($Key in $Files.Keys) {
      $File = $Files[$Key]
      $Exists = Test-Path -LiteralPath $File.path
      if ($Exists) {
        Assert-RegularFile $File.path 'operation snapshot' $File.limit | Out-Null
        $Backup = Join-Path $Preparing "$Key.bin"
        $Bytes = if ($Key -eq 'lifecycle' -and $null -ne $OriginalLifecycle) { $OriginalLifecycle } else { [IO.File]::ReadAllBytes($File.path) }
        if ($Bytes.Length -gt $File.limit) { throw 'Operation snapshot exceeds its size limit.' }
        Write-DurablePrivateFile $Backup $Bytes
        $Snapshots[$Key] = @{ existed = $true; sha256 = (Get-FileHash -LiteralPath $Backup -Algorithm SHA256).Hash.ToLowerInvariant() }
      } else {
        $Snapshots[$Key] = @{ existed = $false; sha256 = $null }
      }
    }
    $ServicePolicy = if ($ServiceExisted) { Get-ServicePolicy $RootPath } else { $null }
    if ($ServiceExisted -and $null -eq $ServicePolicy) { throw 'The service disappeared before journaling its policy.' }
    $Journal = @{ schemaVersion = 3; servicePolicy = $ServicePolicy; serviceExisted = $ServiceExisted; wasRunning = $WasRunning; previousVersion = $PreviousVersion; recoveryVersion = $RecoveryVersion; updateCandidate = $UpdateCandidate; files = $Snapshots; scratchLeaf = $ScratchLeaf; fixtureLeaf = $FixtureLeaf }
    $Encoding = New-Object Text.UTF8Encoding($false)
    Write-DurablePrivateFile (Join-Path $Preparing 'journal.json') ($Encoding.GetBytes(($Journal | ConvertTo-Json -Depth 7 -Compress)))
    # No installed service/configuration is changed before this atomic commit.
    [IO.Directory]::Move($Preparing, $JournalRoot)
  } finally {
    if (Test-Path -LiteralPath $Preparing) { Remove-Item -LiteralPath $Preparing -Recurse -Force }
  }
}

function Read-OperationJournal([string]$RootPath) {
  $JournalRoot = Join-Path $RootPath 'service\operation-recovery'
  if (-not (Test-Path -LiteralPath $JournalRoot)) { return $null }
  Assert-RecoveryPath (Join-Path $RootPath 'service') $true
  Assert-RecoveryPath $JournalRoot $true
  $JournalPath = Join-Path $JournalRoot 'journal.json'
  Assert-RegularFile $JournalPath 'operation journal' 16384 | Out-Null
  Assert-RecoveryPath $JournalPath $false
  $Journal = [IO.File]::ReadAllText($JournalPath) | ConvertFrom-Json
  if ($Journal.schemaVersion -ne 3 -or $Journal.serviceExisted -isnot [bool] -or $Journal.wasRunning -isnot [bool] -or
      $Journal.recoveryVersion -isnot [string] -or
      ($Journal.recoveryVersion -ne '' -and $Journal.recoveryVersion -cnotmatch '^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$') -or
      $Journal.updateCandidate -isnot [string] -or
      ($Journal.updateCandidate -ne '' -and ($Journal.updateCandidate -cne $Journal.recoveryVersion -or -not $Journal.serviceExisted -or $Journal.updateCandidate -ceq $Journal.previousVersion)) -or
      $Journal.previousVersion -isnot [string] -or
      ($Journal.previousVersion -ne '' -and $Journal.previousVersion -cnotmatch '^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$') -or
      ($Journal.wasRunning -and -not $Journal.serviceExisted) -or
      ($Journal.serviceExisted -and $Journal.previousVersion -eq '')) {
    throw 'The operation journal is invalid.'
  }
  if ($Journal.serviceExisted) { Assert-ServicePolicy $Journal.servicePolicy }
  elseif ($null -ne $Journal.servicePolicy) { throw 'An absent service cannot have a saved SCM policy.' }
  $Files = Get-RecoveryFiles $RootPath
  if ($Journal.scratchLeaf -isnot [string] -or $Journal.fixtureLeaf -isnot [string] -or
      (($Journal.scratchLeaf -eq '') -ne ($Journal.fixtureLeaf -eq '')) -or
      ($Journal.scratchLeaf -ne '' -and ($Journal.scratchLeaf -cnotmatch '^qualification-[0-9a-f-]{36}$' -or $Journal.fixtureLeaf -cnotmatch '^benchmark-fixture-[0-9a-f-]{36}\.[a-z0-9]{1,10}$'))) {
    throw 'The operation scratch identity is invalid.'
  }
  if (@($Journal.files.PSObject.Properties).Count -ne $Files.Count) { throw 'The operation snapshot inventory is invalid.' }
  $Expected = @('journal.json')
  foreach ($Key in $Files.Keys) {
    $Snapshot = $Journal.files.$Key
    if ($null -eq $Snapshot -or $Snapshot.existed -isnot [bool]) { throw 'The operation snapshot is invalid.' }
    if ($Snapshot.existed) {
      if ($Snapshot.sha256 -isnot [string] -or $Snapshot.sha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'The operation snapshot digest is invalid.' }
      $Backup = Join-Path $JournalRoot "$Key.bin"
      Assert-RegularFile $Backup 'operation snapshot' $Files[$Key].limit | Out-Null
      Assert-RecoveryPath $Backup $false
      if ((Get-FileHash -LiteralPath $Backup -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Snapshot.sha256) {
        throw 'The operation snapshot content changed.'
      }
      $Expected += "$Key.bin"
    } elseif ($null -ne $Snapshot.sha256) { throw 'The absent operation snapshot has a digest.' }
  }
  $Actual = @(Get-ChildItem -LiteralPath $JournalRoot -Force)
  if ($Actual.Count -ne $Expected.Count -or @($Actual | Where-Object { $_.Name -notin $Expected }).Count -ne 0) {
    throw 'The operation recovery inventory is invalid.'
  }
  if ($Journal.serviceExisted) {
    if (@('wrapper', 'xml', 'active' | Where-Object { -not $Journal.files.$_.existed }).Count -ne 0) {
      throw 'The previous installed service snapshot is incomplete.'
    }
    if (-not $Journal.files.config.existed -or -not $Journal.files.credential.existed) {
      # Confirmed unpair removes both files after a durable stop. Recovery may
      # preserve that stopped service, but must never restart an unpaired one.
      if ($Journal.wasRunning -or $Journal.files.config.existed -or $Journal.files.credential.existed) {
        throw 'The previous installed service snapshot is incomplete.'
      }
      $ReceiptPath = Join-Path $RootPath 'service\unpaired.json'
      Assert-RegularFile $ReceiptPath 'confirmed unpair receipt' 4096 | Out-Null
      Assert-RecoveryPath $ReceiptPath $false
      $ReceiptAcl = Get-Acl -LiteralPath $ReceiptPath
      if ($ReceiptAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin @('S-1-5-18', 'S-1-5-32-544')) {
        throw 'The confirmed unpair receipt owner is unsafe.'
      }
      $Receipt = [IO.File]::ReadAllText($ReceiptPath) | ConvertFrom-Json
      $ConfirmedAt = [DateTimeOffset]::MinValue
      if ((($Receipt.PSObject.Properties.Name | Sort-Object) -join ',') -cne 'confirmedAt,machineId,schemaVersion' -or
          $Receipt.schemaVersion -isnot [int] -or $Receipt.schemaVersion -ne 1 -or
          $Receipt.machineId -isnot [string] -or $Receipt.machineId -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' -or
          $Receipt.confirmedAt -isnot [string] -or -not [DateTimeOffset]::TryParse($Receipt.confirmedAt, [ref]$ConfirmedAt)) {
        throw 'The confirmed unpair receipt is invalid.'
      }
    }
  }
  return $Journal
}

function Complete-OperationJournal([string]$RootPath) {
  $JournalRoot = Join-Path $RootPath 'service\operation-recovery'
  if (-not (Test-Path -LiteralPath $JournalRoot)) { return }
  $Journal = Read-OperationJournal $RootPath
  if ($Journal.scratchLeaf -ne '') {
    Remove-OperationScratch (Join-Path $RootPath "state\tmp\$($Journal.scratchLeaf)")
    $Fixture = Join-Path $RootPath "state\$($Journal.fixtureLeaf)"
    if (Test-Path -LiteralPath $Fixture) {
      Assert-RegularFile $Fixture 'benchmark fixture' (512MB) | Out-Null
      Remove-Item -LiteralPath $Fixture -Force
    }
  }
  $Completed = Join-Path $RootPath ("service\.operation-$([guid]::NewGuid()).completed")
  # Once renamed, a later command cannot mistake successful work for a rollback.
  [IO.Directory]::Move($JournalRoot, $Completed)
  Remove-Item -LiteralPath $Completed -Recurse -Force
}

function Remove-OperationScratch([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  $Item = Get-Item -LiteralPath $Path -Force
  if ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Benchmark scratch contains a reparse point.' }
  if ($Item.PSIsContainer) {
    foreach ($Child in @(Get-ChildItem -LiteralPath $Path -Force)) {
      Remove-OperationScratch $Child.FullName
    }
  }
  Remove-Item -LiteralPath $Path -Force
}

function Remove-QualificationWorkspace([string]$RootPath, [string]$ReportPath) {
  if (-not (Test-Path -LiteralPath $ReportPath -PathType Leaf)) { return }
  Assert-RegularFile $ReportPath 'qualification report' 65536 | Out-Null
  $Report = [IO.File]::ReadAllText($ReportPath) | ConvertFrom-Json
  if ($Report.status -cne 'PASS' -or $Report.schemaVersion -ne 1) { throw 'Qualification cleanup evidence is invalid.' }
  $Output = [IO.Path]::GetFullPath([string]$Report.uploadCandidate.path)
  $WorkRoot = [IO.Path]::GetFullPath((Join-Path $RootPath 'state\attempts'))
  $Prefix = $WorkRoot.TrimEnd('\') + '\'
  if (-not $Output.StartsWith($Prefix, [StringComparison]::OrdinalIgnoreCase)) { return }
  $Relative = $Output.Substring($Prefix.Length)
  $Uuid = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
  if ($Relative -notmatch "^qualification-($Uuid)\\(?:vocals\.mp3|$Uuid\\output\\vocals\.mp3)$") { return }
  $Workspace = Join-Path $WorkRoot ("qualification-" + $Matches[1])
  if (-not (Test-Path -LiteralPath $Workspace)) { return }
  foreach ($Directory in @($WorkRoot, (Split-Path -Parent $WorkRoot), $RootPath)) {
    $Item = Get-Item -LiteralPath $Directory -Force -ErrorAction Stop
    if (-not $Item.PSIsContainer -or ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw 'Qualification cleanup path is unsafe.'
    }
  }
  # The generated workspace alone is removed. Reports, installed fixtures and
  # production attempt directories remain outside this bounded path.
  Remove-OperationScratch $Workspace
}

function Assert-ManagedService([string]$RootPath) {
  $Service = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'"
  if ($null -ne $Service -and
      ($Service.StartName -ine 'NT AUTHORITY\LocalService' -or
       $Service.PathName.Trim('"') -ine (Join-Path $RootPath 'service\MusicMuteWorkerService.exe'))) {
    throw 'The installed Windows service identity does not match MusicMute.'
  }
}

function Restore-OperationJournal([string]$RootPath, [bool]$LeaveStopped = $false) {
  $Journal = Read-OperationJournal $RootPath
  if ($null -eq $Journal) { return }
  Assert-ManagedService $RootPath
  $Quiet = Disable-ServiceRestarts $RootPath $Journal.servicePolicy
  $Files = Get-RecoveryFiles $RootPath
  $WrapperPath = $Files.wrapper.path
  $Service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  if ($null -ne $Service) {
    try {
      if ($Service.Status -ne [ServiceProcess.ServiceControllerStatus]::Stopped) {
        Stop-Service -InputObject $Service
        $Service.WaitForStatus([ServiceProcess.ServiceControllerStatus]::Stopped, [TimeSpan]::FromSeconds(45))
      }
    } finally { $Service.Dispose() }
    if (-not $Journal.serviceExisted) {
      Invoke-Checked (Join-Path $env:SystemRoot 'System32\sc.exe') @('delete', $ServiceName)
    }
  }
  Wait-ServiceRestartQueue $Quiet
  foreach ($Key in $Files.Keys) {
    $File = $Files[$Key]
    $Snapshot = $Journal.files.$Key
    $Contents = if ($Snapshot.existed) { [IO.File]::ReadAllBytes((Join-Path $RootPath "service\operation-recovery\$Key.bin")) } else { $null }
    Restore-ManagedFile $File.path $Snapshot.existed $Contents $File.executable
  }
  if ($Journal.serviceExisted) {
    Read-ReleaseManifest (Join-Path $RootPath "releases\$($Journal.previousVersion)") | Out-Null
    if (-not (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue)) { Invoke-Checked $WrapperPath @('install') }
    Set-ServicePolicy $RootPath $Journal.servicePolicy
    if ($Journal.wasRunning -and -not $LeaveStopped) {
      $After = [DateTimeOffset]::UtcNow
      Invoke-Checked $WrapperPath @('start')
      Test-InstalledRuntime $RootPath $Journal.previousVersion $After
    }
  }
  if ($Journal.updateCandidate -ne '') {
    $RecoveryRelease = Join-Path $RootPath "releases\$($Journal.recoveryVersion)"
    Read-ReleaseManifest $RecoveryRelease | Out-Null
    Invoke-WorkerCli $RecoveryRelease @('windows', 'update-quarantine', '--root', $RootPath, '--version', $Journal.updateCandidate) | Out-Null
  }
  Complete-OperationJournal $RootPath
}

function Copy-PrivateFile([string]$Source, [string]$Destination) {
  $Temporary = "$Destination.$([guid]::NewGuid()).tmp"
  try {
    $InputStream = [IO.File]::OpenRead($Source)
    try {
      $OutputStream = [IO.File]::Open($Temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
      try { $InputStream.CopyTo($OutputStream); $OutputStream.Flush($true) }
      finally { $OutputStream.Dispose() }
    } finally { $InputStream.Dispose() }
    Set-PrivateFileAcl $Temporary
    Move-Item -LiteralPath $Temporary -Destination $Destination -Force
  }
  finally {
    if (Test-Path -LiteralPath $Temporary -PathType Leaf) {
      Remove-Item -LiteralPath $Temporary -Force -ErrorAction SilentlyContinue
    }
  }
}

function Assert-ReportDestination([string]$RootPath, [string]$Destination) {
  if ($Destination -notmatch '^[A-Za-z]:\\' -or $Destination.Substring(2).Contains(':') -or
      [IO.Path]::GetFullPath($Destination) -cne $Destination -or -not $Destination.EndsWith('.json')) {
    throw 'The report must use a normalized local .json path.'
  }
  $RootPrefix = $RootPath.TrimEnd('\') + '\'
  if ($Destination.Equals($RootPath, [StringComparison]::OrdinalIgnoreCase) -or
      $Destination.StartsWith($RootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    $Parent = [IO.Path]::GetDirectoryName($Destination)
    $Name = [IO.Path]::GetFileName($Destination)
    if (-not $Parent.Equals((Join-Path $RootPath 'state'), [StringComparison]::OrdinalIgnoreCase) -or
        $Name -cnotmatch '^benchmark-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.json$') {
      throw 'The report cannot modify installation files.'
    }
  }
  $Ancestor = Split-Path -Parent $Destination
  while ($Ancestor -ne '') {
    $Item = Get-Item -LiteralPath $Ancestor -Force -ErrorAction Stop
    if (-not $Item.PSIsContainer -or ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw 'The report directory must not traverse a reparse point.'
    }
    $Ancestor = Split-Path -Parent $Ancestor
  }
}

function Export-PrivateFileExclusive([string]$Source, [string]$Destination) {
  Assert-ReportDestination $Root $Destination
  if (Test-Path -LiteralPath $Destination) {
    throw "The qualification output already exists."
  }
  $Parent = Split-Path -Parent $Destination
  $ParentItem = Get-Item -LiteralPath $Parent -Force -ErrorAction Stop
  if (-not $ParentItem.PSIsContainer -or ($ParentItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw "The qualification output directory is unsafe."
  }
  $Temporary = Join-Path $Parent ".$([IO.Path]::GetFileName($Destination)).$([guid]::NewGuid()).tmp"
  try {
    Copy-Item -LiteralPath $Source -Destination $Temporary -ErrorAction Stop
    Set-PrivateFileAcl $Temporary
    [IO.File]::Move($Temporary, $Destination)
  } finally {
    if (Test-Path -LiteralPath $Temporary -PathType Leaf) {
      Remove-Item -LiteralPath $Temporary -Force -ErrorAction SilentlyContinue
    }
  }
}

function Restore-ManagedFile(
  [string]$Path,
  [bool]$Existed,
  [byte[]]$Contents,
  [bool]$Executable
) {
  if (-not $Existed) {
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
      Remove-Item -LiteralPath $Path -Force
    }
    return
  }
  if ($null -eq $Contents) {
    throw "A rollback file snapshot is missing."
  }
  $Temporary = "$Path.$([guid]::NewGuid()).rollback"
  try {
    [IO.File]::WriteAllBytes($Temporary, $Contents)
    if ($Executable) {
      Set-ExecutableFileAcl $Temporary
    } else {
      Set-PrivateFileAcl $Temporary
    }
    Move-Item -LiteralPath $Temporary -Destination $Path -Force
  } finally {
    if (Test-Path -LiteralPath $Temporary -PathType Leaf) {
      Remove-Item -LiteralPath $Temporary -Force -ErrorAction SilentlyContinue
    }
  }
}

function Assert-RuntimeConfig(
  [string]$Path,
  [string]$InstalledRelease,
  [string]$StateRoot
) {
  $Raw = [IO.File]::ReadAllText($Path)
  $Runtime = $Raw | ConvertFrom-Json
  $Expected = @{
    engineRoot = (Join-Path $InstalledRelease "app\engine")
    pythonPath = (Join-Path $InstalledRelease "runtime\python\python.exe")
    ffmpegPath = (Join-Path $InstalledRelease "runtime\bin\ffmpeg.exe")
    ffprobePath = (Join-Path $InstalledRelease "runtime\bin\ffprobe.exe")
    workRoot = (Join-Path $StateRoot "attempts")
    modelCacheRoot = (Join-Path $StateRoot "models")
    credentialFile = (Join-Path $StateRoot "machine.credential")
    localLifecyclePath = (Join-Path $StateRoot "lifecycle.json")
    localRuntimeStatusPath = (Join-Path $StateRoot "runtime-status.json")
  }
  foreach ($Name in $Expected.Keys) {
    if ([string]::Compare([string]$Runtime.$Name, $Expected[$Name], $true) -ne 0) {
      throw "Runtime config does not match the private installation layout."
    }
  }
  $Slots = @($Runtime.slots)
  if ($null -eq $Runtime.slots -or $Slots.Count -lt 1 -or $Slots.Count -gt 2) {
    throw "Windows requires one or two qualified slots."
  }
  if ($Slots.Count -eq 2 -and (
      $Runtime.validatedMaxWorkersPerGpu -ne 2 -or
      [string]$Runtime.capacityValidationFile -ine (Join-Path $StateRoot 'capacity-validation.json'))) {
    throw 'Two Windows slots require installed capacity approval.'
  }
  for ($Index = 0; $Index -lt $Slots.Count; $Index++) {
    $Slot = $Slots[$Index]
    $HasDirectMlDeviceId = $Slot.PSObject.Properties.Name -contains "directmlDeviceId"
    if ($Slot.provider -ne 'directml' -or -not $HasDirectMlDeviceId -or
        $Slot.directmlDeviceId -ne 0 -or $Slot.gpuId -ne 'gpu0' -or $Slot.slotIndex -ne $Index) {
      throw 'Windows slots must select DirectML adapter 0 with consecutive indexes.'
    }
  }
  # The runtime additionally verifies the complete receipt, installed inventory,
  # driver and output measurements before opening a backend session or claiming.
}

function Set-RuntimeEnvironment([string]$StateRoot) {
  $env:HOME = $StateRoot
  $env:TEMP = Join-Path $StateRoot "tmp"
  $env:TMP = $env:TEMP
  $env:XDG_CACHE_HOME = Join-Path $StateRoot "cache"
  $env:NUMBA_CACHE_DIR = Join-Path $StateRoot "cache\numba"
  $env:MPLCONFIGDIR = Join-Path $StateRoot "cache\matplotlib"
  $env:PYTHONDONTWRITEBYTECODE = "1"
  $env:PYTHONNOUSERSITE = "1"
}

function Install-Model(
  [string]$InstalledRelease,
  [string]$StateRoot,
  [string]$Source
) {
  $Python = Join-Path $InstalledRelease "runtime\python\python.exe"
  $Engine = Join-Path $InstalledRelease "app\engine"
  $ModelCache = Join-Path $StateRoot "models"
  Set-RuntimeEnvironment $StateRoot
  Push-Location $Engine
  try {
    $Output = & $Python -m musicmute_engine.model_tool --source $Source --model-cache $ModelCache
    if ($LASTEXITCODE -ne 0) {
      throw "The qualified model could not be installed."
    }
    $Result = $Output | ConvertFrom-Json
    if ($Result.status -ne "ok" -or [long]$Result.modelBytes -ne $ModelBytes) {
      throw "The model installer returned invalid output."
    }
  } finally {
    Pop-Location
  }
}

function Wait-WorkerQualification(
  [string]$InstalledRelease,
  [string]$ReportPath,
  [string]$ExpectedFixtureSha256,
  [int]$TimeoutSeconds = 2400
) {
  $Deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
  while ([DateTimeOffset]::UtcNow -lt $Deadline) {
    if (Test-Path -LiteralPath $ReportPath -PathType Leaf) {
      Assert-RegularFile $ReportPath "qualification report" 65536 | Out-Null
      Set-PrivateFileAcl $ReportPath
      $Lines = @(Invoke-WorkerCli $InstalledRelease @(
        "windows", "qualification-check",
        "--report", $ReportPath,
        "--fixture-sha256", $ExpectedFixtureSha256
      ))
      if ($Lines.Count -ne 1) {
        throw "The qualification verifier returned invalid output."
      }
      $Result = $Lines[0] | ConvertFrom-Json
      if (
        $Result.status -ne "ok" -or
        $Result.action -ne "qualification-check" -or
        [int]$Result.recipeCount -lt 1
      ) {
        throw "The qualification verifier returned invalid output."
      }
      return
    }
    $Service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if (
      $null -eq $Service -or
      $Service.Status -eq [ServiceProcess.ServiceControllerStatus]::Stopped
    ) {
      throw "The MusicMute DirectML qualification service failed."
    }
    Start-Sleep -Milliseconds 500
  }
  throw "The MusicMute DirectML qualification service timed out."
}

function Wait-WorkerBenchmark([string]$InstalledRelease, [string]$ReportPath, [string]$NormalizedPath, [string]$ExpectedFixtureSha256, [Diagnostics.Stopwatch]$Clock) {
  while ($Clock.Elapsed.TotalSeconds -lt 7200) {
    if (Test-Path -LiteralPath $ReportPath -PathType Leaf) {
      Assert-RegularFile $ReportPath 'benchmark report' (4MB) | Out-Null
      Set-PrivateFileAcl $ReportPath | Out-Null
      $CheckAction = if ($BenchmarkWorkers -eq 2) { 'capacity-check' } else { 'benchmark-check' }
      $CheckArguments = @(
        'windows', $CheckAction, '--report', $ReportPath,
        '--fixture-sha256', $ExpectedFixtureSha256,
        '--warmup-runs', ([string]$WarmupRuns), '--measured-runs', ([string]$MeasuredRuns),
        '--output', $NormalizedPath
      )
      if ($BenchmarkWorkers -eq 1) {
        $CheckArguments += @('--recipe', $BenchmarkRecipe, '--process-wall-seconds', $Clock.Elapsed.TotalSeconds.ToString('R', [Globalization.CultureInfo]::InvariantCulture))
      }
      $Result = (Invoke-WorkerCli $InstalledRelease $CheckArguments) | ConvertFrom-Json
      if ($Result.status -ne 'ok' -or $Result.action -ne $CheckAction -or $Result.measuredRuns -ne $MeasuredRuns) {
        throw 'The benchmark verifier returned invalid output.'
      }
      Set-PrivateFileAcl $NormalizedPath | Out-Null
      return
    }
    $Service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($null -eq $Service -or $Service.Status -eq [ServiceProcess.ServiceControllerStatus]::Stopped) {
      throw 'The MusicMute benchmark service stopped without a complete report.'
    }
    Start-Sleep -Milliseconds 500
  }
  throw 'The MusicMute benchmark timed out.'
}

function Wait-WorkerRuntimeStarted(
  [string]$StateRoot,
  [DateTimeOffset]$NotBefore,
  [int]$TimeoutSeconds = 60
) {
  $EventsPath = Join-Path $StateRoot "logs\events.jsonl"
  $Deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
  while ([DateTimeOffset]::UtcNow -lt $Deadline) {
    if (Test-Path -LiteralPath $EventsPath -PathType Leaf) {
      foreach ($Line in @(Get-Content -LiteralPath $EventsPath -Tail 100 -ErrorAction SilentlyContinue)) {
        try {
          $Record = $Line | ConvertFrom-Json
          if ($Record.event.kind -ne "started") {
            continue
          }
          $RecordedAt = [DateTimeOffset]::Parse(
            [string]$Record.recordedAt,
            [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::RoundtripKind
          )
          if ($RecordedAt -ge $NotBefore) {
            return
          }
        } catch {
          # Ignore an incomplete tail read; the bounded spool is validated by the runtime.
        }
      }
    }
    Start-Sleep -Milliseconds 500
  }
  throw "The MusicMute worker did not complete runtime startup."
}

function Test-InstalledRuntime(
  [string]$Root,
  [string]$Version,
  [DateTimeOffset]$StartedAfter = [DateTimeOffset]::MinValue
) {
  $ReleaseRoot = Join-Path $Root "releases\$Version"
  Read-ReleaseManifest $ReleaseRoot | Out-Null
  $StateRoot = Join-Path $Root "state"
  $Python = Join-Path $ReleaseRoot "runtime\python\python.exe"
  $Engine = Join-Path $ReleaseRoot "app\engine"
  Set-RuntimeEnvironment $StateRoot
  $Arguments = @(
    "-m", "musicmute_engine.service_doctor",
    "--provider", "directml",
    "--model-cache", (Join-Path $StateRoot "models"),
    "--ffmpeg", (Join-Path $ReleaseRoot "runtime\bin\ffmpeg.exe"),
    "--ffprobe", (Join-Path $ReleaseRoot "runtime\bin\ffprobe.exe")
  )
  Push-Location $Engine
  try {
    $Output = & $Python @Arguments
    if ($LASTEXITCODE -ne 0) {
      throw "The private DirectML runtime doctor failed."
    }
    $Result = $Output | ConvertFrom-Json
    if ($Result.status -ne "ok" -or $Result.provider -ne "DmlExecutionProvider") {
      throw "The private DirectML runtime doctor returned invalid output."
    }
  } finally {
    Pop-Location
  }
  $Service = Get-Service -Name $ServiceName -ErrorAction Stop
  if ($Service.Status -ne [ServiceProcess.ServiceControllerStatus]::Running) {
    throw "The MusicMute Windows service is not running."
  }
  if ($StartedAfter -ne [DateTimeOffset]::MinValue) {
    Wait-WorkerRuntimeStarted $StateRoot $StartedAfter
  }
}

function Read-ActiveVersion([string]$StateRoot) {
  $Path = Join-Path $StateRoot "active-release.json"
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return ""
  }
  $Value = [IO.File]::ReadAllText($Path) | ConvertFrom-Json
  if ($Value.releaseVersion -notmatch "^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$") {
    throw "The active release marker is invalid."
  }
  return [string]$Value.releaseVersion
}

function Write-ActiveVersion([string]$StateRoot, [string]$Version) {
  $Path = Join-Path $StateRoot "active-release.json"
  $Temporary = "$Path.$([guid]::NewGuid()).tmp"
  Write-Utf8NoBom $Temporary ((@{ releaseVersion = $Version } | ConvertTo-Json -Compress) + [Environment]::NewLine)
  Set-PrivateFileAcl $Temporary
  Move-Item -LiteralPath $Temporary -Destination $Path -Force
}

function Invoke-Reactivate([string]$RootPath, [string]$ReleasePath) {
  if ($ReleasePath -eq '') { throw 'Reactivation requires the preserved release.' }
  $ReleaseRoot = [IO.Path]::GetFullPath($ReleasePath)
  $Version = [IO.Path]::GetFileName($ReleaseRoot)
  if ($Version -cnotmatch '^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$' -or
      $ReleaseRoot -ine (Join-Path $RootPath "releases\$Version")) {
    throw 'Reactivation requires the exact installed immutable release.'
  }
  foreach ($Directory in @($RootPath, (Join-Path $RootPath 'service'), (Join-Path $RootPath 'releases'), $ReleaseRoot)) {
    Assert-RecoveryPath $Directory $true
  }
  $Manifest = Read-ReleaseManifest $ReleaseRoot
  if ([string]$Manifest.releaseVersion -cne $Version) { throw 'Preserved release identity does not match its directory.' }
  Assert-ManagedService $RootPath
  if ($null -ne (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue)) {
    throw 'The service is already registered; use start or recover.'
  }
  $Files = Get-RecoveryFiles $RootPath
  foreach ($Key in @('wrapper', 'xml', 'active')) {
    if (Test-Path -LiteralPath $Files[$Key].path) {
      throw 'Incomplete activation files require inspection before reactivation.'
    }
  }
  # Revalidate all config paths, credentials and capacity under the operator lock.
  # This command performs no enrollment, backend request or processing.
  Invoke-WorkerCli $ReleaseRoot @('windows', 'config-check', '--root', $RootPath, '--version', $Version) | Out-Null
  Save-OperationJournal $RootPath $false $false '' '' '' $Version
  try {
    Copy-PrivateFile (Join-Path $ReleaseRoot 'runtime\service\MusicMuteWorkerService.exe') $Files.wrapper.path
    Set-ExecutableFileAcl $Files.wrapper.path
    Invoke-WorkerCli $ReleaseRoot @('windows', 'service-config', '--root', $RootPath, '--version', $Version, '--output', $Files.xml.path) | Out-Null
    Set-PrivateFileAcl $Files.xml.path
    Invoke-Checked $Files.wrapper.path @('install')
    $StartedAfter = [DateTimeOffset]::UtcNow
    Invoke-Checked $Files.wrapper.path @('start')
    Test-InstalledRuntime $RootPath $Version $StartedAfter
    Write-ActiveVersion (Join-Path $RootPath 'state') $Version
    Complete-OperationJournal $RootPath
  } catch {
    try { Restore-OperationJournal $RootPath }
    catch { Write-Warning 'Reactivation rollback requires Recover; the durable journal is preserved.' }
    throw
  }
}

function Invoke-Uninstall([string]$Root) {
  Assert-ManagedService $Root
  $ServiceRoot = Join-Path $Root "service"
  $Wrapper = Join-Path $ServiceRoot "MusicMuteWorkerService.exe"
  $Journaled = $false
  try {
    $Native = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'"
    if ($null -ne $Native) {
      if ($Native.State -notin @('Running', 'Stopped')) { throw 'Uninstall requires a stable installed service.' }
      Assert-RegularFile $Wrapper 'installed service wrapper' (64MB) | Out-Null
      $Version = Read-ActiveVersion (Join-Path $Root 'state')
      if ($Version -eq '') { throw 'Uninstall requires the active release identity.' }
      # A rejected or interrupted drain must never trigger rollback that stops
      # active work. Enter the removal transaction only after acknowledgement.
      Wait-WorkerDrain $Root $false | Out-Null
      Save-OperationJournal $Root $true $false $Version '' '' $Version
      $Journaled = $true
      $Quiet = Disable-ServiceRestarts $Root (Read-OperationJournal $Root).servicePolicy
      Stop-RegisteredWorker $Root
      Wait-ServiceRestartQueue $Quiet
      $Stopped = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'"
      if ($null -eq $Stopped -or $Stopped.State -ne 'Stopped' -or $Stopped.ProcessId -ne 0) { throw 'Windows worker did not stop for uninstall.' }
      Invoke-Checked $Wrapper @('uninstall')
      $Deletion = [Diagnostics.Stopwatch]::StartNew()
      while ($null -ne (Get-CimInstance Win32_Service -Filter "Name='$ServiceName'")) {
        if ($Deletion.Elapsed.TotalSeconds -ge 30) { throw 'Service deletion is still pending; activation files are preserved.' }
        Start-Sleep -Milliseconds 250
      }
    }
    foreach ($Path in @(
      (Join-Path $ServiceRoot "MusicMuteWorkerService.xml"),
      $Wrapper,
      (Join-Path $Root "state\active-release.json")
    )) {
      if (Test-Path -LiteralPath $Path -PathType Leaf) {
        Remove-Item -LiteralPath $Path -Force
      }
    }
    if ($Journaled) { Complete-OperationJournal $Root }
  } catch {
    $Failure = $_
    if ($Journaled) { Restore-OperationJournal $Root $true }
    throw $Failure
  }
  Write-Output "MusicMute Windows service: uninstalled; releases and state preserved"
}

function Wait-WorkerDrain([string]$RootPath, [bool]$Force) {
  Assert-ManagedService $RootPath
  $Native = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'"
  if ($null -eq $Native -or $Native.State -notin @('Running', 'Stopped')) { throw 'Update requires a stable installed service.' }
  $LifecyclePath = Join-Path $RootPath 'state\lifecycle.json'
  $LifecycleLock = New-OperatorLock $RootPath 'state\lifecycle.json.lock.guard'
  try {
    Assert-RegularFile $LifecyclePath 'local lifecycle' 4096 | Out-Null
    $OriginalLifecycle = [IO.File]::ReadAllBytes($LifecyclePath)
    $Lifecycle = [Text.Encoding]::UTF8.GetString($OriginalLifecycle) | ConvertFrom-Json
    if ($Lifecycle.schemaVersion -ne 1 -or $Lifecycle.intent -notin @('active','paused','draining') -or
        ($Lifecycle.revision -isnot [int] -and $Lifecycle.revision -isnot [long]) -or
        $Lifecycle.revision -lt 1 -or $Lifecycle.revision -ge 9007199254740991) { throw 'Local lifecycle is invalid.' }
    $Revision = $Lifecycle.revision + 1
    $Lifecycle.intent = 'draining'; $Lifecycle.revision = $Revision; $Lifecycle.updatedAt = [DateTimeOffset]::UtcNow.ToString('o')
    $Temporary = "$LifecyclePath.$([guid]::NewGuid()).tmp"
    try {
      Write-DurablePrivateFile $Temporary ([Text.Encoding]::UTF8.GetBytes(($Lifecycle | ConvertTo-Json -Compress)))
      Move-Item -LiteralPath $Temporary -Destination $LifecyclePath -Force
    } finally { if (Test-Path -LiteralPath $Temporary) { Remove-Item -LiteralPath $Temporary -Force } }
  } finally { $LifecycleLock.Dispose() }
  # A queued SCM restart may start while the journal is being prepared. Publish
  # draining even for a stopped service so that replacement cannot claim work.
  $Native = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'"
  if ($null -eq $Native -or $Native.State -notin @('Running', 'Stopped')) { throw 'Service state changed while publishing drain; retry after the transition.' }
  if ($Native.State -eq 'Stopped') { return @{originalLifecycle=$OriginalLifecycle} }
  $Children = @()
  if ($Native.State -eq 'Running') {
    $Children = @(Get-CimInstance Win32_Process -Filter ("ParentProcessId=" + $Native.ProcessId) | Where-Object {
      $_.Name -eq 'node.exe' -and $_.ExecutablePath.StartsWith((Join-Path $RootPath 'releases') + '\', [StringComparison]::OrdinalIgnoreCase)
    })
  }
  if ($Native.State -eq 'Running' -and -not $Force -and $Children.Count -ne 1) { throw 'Current runtime identity is unavailable; use update --force only to interrupt work.' }
  if (-not $Force) {
    $Clock = [Diagnostics.Stopwatch]::StartNew()
    $StatusPath = Join-Path $RootPath 'state\runtime-status.json'
    while ($true) {
      Assert-RegularFile $StatusPath 'current runtime status' (1MB) | Out-Null
      $Snapshot = [IO.File]::ReadAllText($StatusPath) | ConvertFrom-Json
      $Updated = [DateTimeOffset]::Parse([string]$Snapshot.updatedAt)
      if ($Snapshot.schemaVersion -ne 1 -or $Snapshot.processId -ne $Children[0].ProcessId -or
          $Updated -lt $Children[0].CreationDate.ToUniversalTime() -or
          ([DateTimeOffset]::UtcNow - $Updated).TotalSeconds -gt 180 -or $Snapshot.activeAttemptIds -isnot [array]) {
        throw 'Current runtime status is unsafe for graceful update.'
      }
      $Acknowledged = $Snapshot.PSObject.Properties.Name -contains 'observedLifecycle' -and
        $null -ne $Snapshot.observedLifecycle -and $Snapshot.observedLifecycle.revision -eq $Revision -and
        $Snapshot.observedLifecycle.intent -eq 'draining'
      if ($Acknowledged -and $Snapshot.activeAttemptIds.Count -eq 0) { break }
      if ($Clock.Elapsed.TotalMinutes -ge 10) { throw 'Update drain timed out; retry after work finishes or use --force.' }
      Start-Sleep -Milliseconds 500
    }
  }
  return @{originalLifecycle=$OriginalLifecycle}
}

function Stop-RegisteredWorker([string]$RootPath) {
  Assert-ManagedService $RootPath
  $Native = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'"
  if ($null -eq $Native -or $Native.State -notin @('Running', 'Stopped')) { throw 'Stop requires a stable installed service.' }
  if ($Native.State -eq 'Running') {
    $Service = Get-Service -Name $ServiceName -ErrorAction Stop
    try {
      Stop-Service -InputObject $Service
      $Service.WaitForStatus([ServiceProcess.ServiceControllerStatus]::Stopped, [TimeSpan]::FromSeconds(45))
    } finally { $Service.Dispose() }
  }
  $Stopped = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'"
  if ($null -eq $Stopped -or $Stopped.State -ne 'Stopped' -or $Stopped.ProcessId -ne 0) { throw 'Windows worker did not stop.' }
}

function Stop-WorkerForUpdate([string]$RootPath, [bool]$Force) {
  Wait-WorkerDrain $RootPath $Force | Out-Null
  Stop-RegisteredWorker $RootPath
}
