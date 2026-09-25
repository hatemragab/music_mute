[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("Stage", "Install", "Repair", "Doctor", "ResetRestartBudget", "Uninstall")]
  [string]$Action,

  [string]$Release = "",
  [string]$Config = "",
  [string]$Credential = "",
  [string]$ModelSource = "",
  [string]$FixtureSource = "",
  [string]$FixtureSha256 = "",
  [string]$QualificationOutput = "",
  [string]$InstallRoot = "$env:ProgramData\MusicMuteWorker"
)

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

function Copy-PrivateFile([string]$Source, [string]$Destination) {
  $Temporary = "$Destination.$([guid]::NewGuid()).tmp"
  try {
    Copy-Item -LiteralPath $Source -Destination $Temporary -ErrorAction Stop
    Set-PrivateFileAcl $Temporary
    Move-Item -LiteralPath $Temporary -Destination $Destination -Force
  }
  finally {
    if (Test-Path -LiteralPath $Temporary -PathType Leaf) {
      Remove-Item -LiteralPath $Temporary -Force -ErrorAction SilentlyContinue
    }
  }
}

function Export-PrivateFileExclusive([string]$Source, [string]$Destination) {
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
  }
  foreach ($Name in $Expected.Keys) {
    if ([string]::Compare([string]$Runtime.$Name, $Expected[$Name], $true) -ne 0) {
      throw "Runtime config does not match the private installation layout."
    }
  }
  if ($null -eq $Runtime.slots -or @($Runtime.slots).Count -ne 1) {
    throw "The Windows MVP requires exactly one configured slot."
  }
  $Slot = @($Runtime.slots)[0]
  $HasDirectMlDeviceId = $Slot.PSObject.Properties.Name -contains "directmlDeviceId"
  if (
    $Slot.provider -ne "directml" -or
    -not $HasDirectMlDeviceId -or
    [int]$Slot.directmlDeviceId -ne 0
  ) {
    throw "The Windows MVP slot must select DirectML adapter 0."
  }
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
        [int]$Result.recipeCount -ne 4
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

function Invoke-Uninstall([string]$Root) {
  $ServiceRoot = Join-Path $Root "service"
  $Wrapper = Join-Path $ServiceRoot "MusicMuteWorkerService.exe"
  if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
    if (Test-Path -LiteralPath $Wrapper -PathType Leaf) {
      & $Wrapper stopwait 2>$null
      & $Wrapper uninstall
      if ($LASTEXITCODE -ne 0) {
        throw "The MusicMute Windows service could not be uninstalled."
      }
    } else {
      throw "The installed service wrapper is missing."
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
  Write-Output "MusicMute Windows service: uninstalled; releases and state preserved"
}

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  throw "This command runs only on Windows."
}
Assert-Administrator
$Root = [IO.Path]::GetFullPath($InstallRoot)
if ([IO.Path]::GetPathRoot($Root) -eq $Root) {
  throw "The installation root is unsafe."
}

$Mutex = New-Object Threading.Mutex($false, "Global\MusicMuteWorkerInstaller")
$HasMutex = $false
try {
  $HasMutex = $Mutex.WaitOne(0)
  if (-not $HasMutex) {
    throw "Another MusicMute worker installation command is running."
  }
  if ($Action -eq "Uninstall") {
    Invoke-Uninstall $Root
    return
  }
  $StateRoot = Join-Path $Root "state"
  if ($Action -eq "ResetRestartBudget") {
    $Service = Get-Service -Name $ServiceName -ErrorAction Stop
    if ($Service.Status -ne [ServiceProcess.ServiceControllerStatus]::Stopped) {
      throw "Stop MusicMuteWorker before resetting its restart budget."
    }
    $StateDirectory = Get-Item -LiteralPath $StateRoot -Force -ErrorAction Stop
    if (-not $StateDirectory.PSIsContainer -or ($StateDirectory.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw "The worker state directory is unsafe."
    }
    $BudgetPath = Join-Path $StateRoot "restart-budget.json"
    if (Test-Path -LiteralPath $BudgetPath) {
      Assert-RegularFile $BudgetPath "restart budget" 4096 | Out-Null
      # Preserve evidence and its ACL. On the next explicit start the worker creates
      # a fresh budget under the existing LocalService-writable state directory.
      $SavedBudget = Join-Path $StateRoot "restart-budget.reset.$([guid]::NewGuid()).json"
      Move-Item -LiteralPath $BudgetPath -Destination $SavedBudget -ErrorAction Stop
    }
    Write-Output "MusicMute Windows restart budget reset; service remains stopped. Start it after repairing the cause."
    return
  }
  if ($Action -eq "Doctor") {
    $Version = Read-ActiveVersion $StateRoot
    if ($Version -eq "") {
      throw "No active Windows worker release is recorded."
    }
    Test-InstalledRuntime $Root $Version
    Write-Output "MusicMute Windows service: OK ($Version)"
    return
  }

  $StagingOnly = $Action -eq "Stage"
  if ($QualificationOutput -ne "" -and -not $StagingOnly) {
    throw "QualificationOutput is valid only for Stage."
  }
  $QualificationOutputPath = ""
  if ($QualificationOutput -ne "") {
    if (-not [IO.Path]::IsPathRooted($QualificationOutput)) {
      throw "The qualification output must be an absolute path."
    }
    $QualificationOutputPath = [IO.Path]::GetFullPath($QualificationOutput)
    if (Test-Path -LiteralPath $QualificationOutputPath) {
      throw "The qualification output already exists."
    }
  }
  if (
    $Release -eq "" -or
    $ModelSource -eq "" -or
    $FixtureSource -eq "" -or
    $FixtureSha256 -eq "" -or
    (-not $StagingOnly -and ($Config -eq "" -or $Credential -eq ""))
  ) {
    throw "Stage requires Release, ModelSource, FixtureSource and FixtureSha256; Install and Repair also require Config and Credential."
  }
  $ReleaseRoot = [IO.Path]::GetFullPath($Release)
  if (
    $ReleaseRoot -eq $Root -or
    $ReleaseRoot.StartsWith($Root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
  ) {
    throw "The release source must be outside the installation root."
  }
  $ConfigItem = $null
  $CredentialItem = $null
  if (-not $StagingOnly) {
    $ConfigItem = Assert-RegularFile $Config "runtime config" 65536
    $CredentialItem = Assert-RegularFile $Credential "machine credential" 128
  }
  $ModelItem = Assert-RegularFile $ModelSource "model source" $ModelBytes
  if ($ModelItem.Length -ne $ModelBytes) {
    throw "The model source size is invalid."
  }
  $FixtureItem = Assert-RegularFile $FixtureSource "qualification fixture" (64MB)
  if (
    -not [string]::Equals(
      [IO.Path]::GetExtension($FixtureItem.FullName),
      ".wav",
      [StringComparison]::OrdinalIgnoreCase
    ) -or
    $FixtureSha256 -cnotmatch "^[a-f0-9]{64}$" -or
    (Get-FileHash -Algorithm SHA256 -LiteralPath $FixtureItem.FullName).Hash.ToLowerInvariant() -cne $FixtureSha256
  ) {
    throw "The qualification fixture is invalid."
  }
  $Manifest = Read-ReleaseManifest $ReleaseRoot
  $Version = [string]$Manifest.releaseVersion
  $ReleasesRoot = Join-Path $Root "releases"
  $InstalledRelease = Join-Path $ReleasesRoot $Version
  if (-not $StagingOnly) {
    Assert-RuntimeConfig $ConfigItem.FullName $InstalledRelease $StateRoot
  }

  foreach ($Path in @(
    $Root,
    $ReleasesRoot,
    $StateRoot,
    (Join-Path $StateRoot "attempts"),
    (Join-Path $StateRoot "models"),
    (Join-Path $StateRoot "cache"),
    (Join-Path $StateRoot "cache\numba"),
    (Join-Path $StateRoot "cache\matplotlib"),
    (Join-Path $StateRoot "tmp"),
    (Join-Path $StateRoot "logs"),
    (Join-Path $Root "service")
  )) {
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
  }
  Set-DirectoryAcl $Root "RX"
  Set-DirectoryAcl $ReleasesRoot "RX"
  Set-DirectoryAcl $StateRoot "M"
  Set-DirectoryAcl (Join-Path $Root "service") "RX"

  if (Test-Path -LiteralPath $InstalledRelease) {
    $InstalledManifest = Read-ReleaseManifest $InstalledRelease
    $SourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $ReleaseRoot "release-manifest.json")).Hash
    $InstalledHash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $InstalledRelease "release-manifest.json")).Hash
    if ($InstalledManifest.releaseVersion -ne $Version -or $SourceHash -ne $InstalledHash) {
      throw "The installed release version is immutable."
    }
  } else {
    $Staging = Join-Path $ReleasesRoot (".$Version.$([guid]::NewGuid()).installing")
    try {
      New-Item -ItemType Directory -Path $Staging | Out-Null
      Copy-Item -Path (Join-Path $ReleaseRoot "*") -Destination $Staging -Recurse -Force
      Read-ReleaseManifest $Staging | Out-Null
      Set-DirectoryAcl $Staging "RX"
      Move-Item -LiteralPath $Staging -Destination $InstalledRelease
    } catch {
      if (Test-Path -LiteralPath $Staging) {
        Remove-Item -LiteralPath $Staging -Recurse -Force
      }
      throw
    }
  }

  $ServiceRoot = Join-Path $Root "service"
  $Wrapper = Join-Path $ServiceRoot "MusicMuteWorkerService.exe"
  $ServiceXml = Join-Path $ServiceRoot "MusicMuteWorkerService.xml"
  $RuntimeConfigPath = Join-Path $StateRoot "runtime.json"
  $CredentialPath = Join-Path $StateRoot "machine.credential"
  $QualificationFixture = Join-Path $StateRoot "qualification-fixture-$FixtureSha256.wav"
  $QualificationReport = Join-Path $StateRoot "qualification-$([guid]::NewGuid()).json"
  $PreviousVersion = Read-ActiveVersion $StateRoot
  $RuntimeConfigExisted = Test-Path -LiteralPath $RuntimeConfigPath -PathType Leaf
  $CredentialExisted = Test-Path -LiteralPath $CredentialPath -PathType Leaf
  $WrapperExisted = Test-Path -LiteralPath $Wrapper -PathType Leaf
  $ServiceXmlExisted = Test-Path -LiteralPath $ServiceXml -PathType Leaf
  [byte[]]$PreviousRuntimeConfig = $null
  [byte[]]$PreviousCredential = $null
  [byte[]]$PreviousWrapper = $null
  $PreviousXml = $null
  if ($RuntimeConfigExisted) {
    $PreviousRuntimeConfig = [IO.File]::ReadAllBytes($RuntimeConfigPath)
  }
  if ($CredentialExisted) {
    $PreviousCredential = [IO.File]::ReadAllBytes($CredentialPath)
  }
  if ($WrapperExisted) {
    $PreviousWrapper = [IO.File]::ReadAllBytes($Wrapper)
  }
  if ($ServiceXmlExisted) {
    $PreviousXml = [IO.File]::ReadAllBytes($ServiceXml)
  }
  $InstalledService = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  $ServiceExists = $null -ne $InstalledService
  $ServiceWasRunning =
    $ServiceExists -and
    $InstalledService.Status -ne [ServiceProcess.ServiceControllerStatus]::Stopped
  if (
    $ServiceExists -and (
      $PreviousVersion -eq "" -or
      -not $RuntimeConfigExisted -or
      -not $CredentialExisted -or
      -not $WrapperExisted -or
      -not $ServiceXmlExisted
    )
  ) {
    throw "The installed service state is incomplete."
  }
  Install-Model $InstalledRelease $StateRoot $ModelItem.FullName
  $ActiveXml = ""
  $QualificationExported = $false
  $QualificationXml = "$ServiceXml.$([guid]::NewGuid()).qualification.tmp"
  try {
    if (
      $ServiceExists -and
      $InstalledService.Status -ne [ServiceProcess.ServiceControllerStatus]::Stopped
    ) {
      Invoke-Checked $Wrapper @("stopwait")
    }
    if (-not $StagingOnly) {
      Copy-PrivateFile $ConfigItem.FullName $RuntimeConfigPath
      Copy-PrivateFile $CredentialItem.FullName $CredentialPath
    }
    Copy-PrivateFile $FixtureItem.FullName $QualificationFixture
    Copy-PrivateFile (Join-Path $InstalledRelease "runtime\service\MusicMuteWorkerService.exe") $Wrapper
    Set-ExecutableFileAcl $Wrapper
    if (-not $StagingOnly) {
      $ActiveXml = "$ServiceXml.$([guid]::NewGuid()).active.tmp"
      Invoke-WorkerCli $InstalledRelease @(
        "windows", "service-config",
        "--root", $Root,
        "--version", $Version,
        "--output", $ActiveXml
      ) | Out-Null
      Set-PrivateFileAcl $ActiveXml
    }
    Invoke-WorkerCli $InstalledRelease @(
      "windows", "service-config",
      "--root", $Root,
      "--version", $Version,
      "--output", $QualificationXml,
      "--qualification-fixture", $QualificationFixture,
      "--qualification-fixture-sha256", $FixtureSha256,
      "--qualification-report", $QualificationReport
    ) | Out-Null
    Set-PrivateFileAcl $QualificationXml
    Move-Item -LiteralPath $QualificationXml -Destination $ServiceXml -Force
    if (-not $ServiceExists) {
      Invoke-Checked $Wrapper @("install")
    }
    Invoke-Checked $Wrapper @("start")
    Wait-WorkerQualification $InstalledRelease $QualificationReport $FixtureSha256
    $QualificationService = Get-Service -Name $ServiceName -ErrorAction Stop
    if ($QualificationService.Status -ne [ServiceProcess.ServiceControllerStatus]::Stopped) {
      Invoke-Checked $Wrapper @("stopwait")
    }
    if (-not $ServiceExists) {
      Invoke-Checked $Wrapper @("uninstall")
    }
    if ($StagingOnly) {
      if ($ServiceExists) {
        Restore-ManagedFile $Wrapper $WrapperExisted $PreviousWrapper $true
        Restore-ManagedFile $ServiceXml $ServiceXmlExisted $PreviousXml $false
        if ($ServiceWasRunning) {
          $RestoredAfter = [DateTimeOffset]::UtcNow
          Invoke-Checked $Wrapper @("start")
          Test-InstalledRuntime $Root $PreviousVersion $RestoredAfter
        }
      }
      if ($QualificationOutputPath -ne "") {
        Export-PrivateFileExclusive $QualificationReport $QualificationOutputPath
        $QualificationExported = $true
      }
    } else {
      Move-Item -LiteralPath $ActiveXml -Destination $ServiceXml -Force
      if (-not $ServiceExists) {
        Invoke-Checked $Wrapper @("install")
      }
      $StartedAfter = [DateTimeOffset]::UtcNow
      Invoke-Checked $Wrapper @("start")
      Test-InstalledRuntime $Root $Version $StartedAfter
      Write-ActiveVersion $StateRoot $Version
    }
  } catch {
    try {
      $RollbackService = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
      if (
        $null -ne $RollbackService -and
        $RollbackService.Status -ne [ServiceProcess.ServiceControllerStatus]::Stopped
      ) {
        Invoke-Checked $Wrapper @("stopwait")
      }
      if (-not $ServiceExists -and (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue)) {
        Invoke-Checked $Wrapper @("uninstall")
      }
      Restore-ManagedFile $RuntimeConfigPath $RuntimeConfigExisted $PreviousRuntimeConfig $false
      Restore-ManagedFile $CredentialPath $CredentialExisted $PreviousCredential $false
      Restore-ManagedFile $Wrapper $WrapperExisted $PreviousWrapper $true
      Restore-ManagedFile $ServiceXml $ServiceXmlExisted $PreviousXml $false
      if ($ServiceExists) {
        Write-ActiveVersion $StateRoot $PreviousVersion
        if ($ServiceWasRunning) {
          $RollbackStartedAfter = [DateTimeOffset]::UtcNow
          Invoke-Checked $Wrapper @("start")
          Test-InstalledRuntime $Root $PreviousVersion $RollbackStartedAfter
        }
      }
    } catch {
      Write-Warning "Automatic rollback also failed; inspect the preserved installation."
    }
    if (Test-Path -LiteralPath $QualificationReport -PathType Leaf) {
      Remove-Item -LiteralPath $QualificationReport -Force -ErrorAction SilentlyContinue
    }
    if ($QualificationExported -and (Test-Path -LiteralPath $QualificationOutputPath -PathType Leaf)) {
      Remove-Item -LiteralPath $QualificationOutputPath -Force -ErrorAction SilentlyContinue
    }
    throw
  } finally {
    foreach ($Temporary in @($ActiveXml, $QualificationXml)) {
      if ($Temporary -ne "" -and (Test-Path -LiteralPath $Temporary -PathType Leaf)) {
        Remove-Item -LiteralPath $Temporary -Force -ErrorAction SilentlyContinue
      }
    }
  }
  $ReportedQualification = if ($QualificationOutputPath -ne "") { $QualificationOutputPath } else { $QualificationReport }
  Write-Output "MusicMute Windows service: $($Action.ToLowerInvariant()) complete ($Version); qualification report: $ReportedQualification"
} finally {
  if ($HasMutex) {
    $Mutex.ReleaseMutex()
  }
  $Mutex.Dispose()
}
