[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("Install", "Repair", "Doctor", "Uninstall")]
  [string]$Action,

  [string]$Release = "",
  [string]$Config = "",
  [string]$Credential = "",
  [string]$ModelSource = "",
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

function Test-InstalledRuntime([string]$Root, [string]$Version) {
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
  if ($Action -eq "Doctor") {
    $Version = Read-ActiveVersion $StateRoot
    if ($Version -eq "") {
      throw "No active Windows worker release is recorded."
    }
    Test-InstalledRuntime $Root $Version
    Write-Output "MusicMute Windows service: OK ($Version)"
    return
  }

  if ($Release -eq "" -or $Config -eq "" -or $Credential -eq "" -or $ModelSource -eq "") {
    throw "Install and Repair require Release, Config, Credential and ModelSource."
  }
  $ReleaseRoot = [IO.Path]::GetFullPath($Release)
  if (
    $ReleaseRoot -eq $Root -or
    $ReleaseRoot.StartsWith($Root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
  ) {
    throw "The release source must be outside the installation root."
  }
  $ConfigItem = Assert-RegularFile $Config "runtime config" 65536
  $CredentialItem = Assert-RegularFile $Credential "machine credential" 128
  $ModelItem = Assert-RegularFile $ModelSource "model source" $ModelBytes
  if ($ModelItem.Length -ne $ModelBytes) {
    throw "The model source size is invalid."
  }
  $Manifest = Read-ReleaseManifest $ReleaseRoot
  $Version = [string]$Manifest.releaseVersion
  $ReleasesRoot = Join-Path $Root "releases"
  $InstalledRelease = Join-Path $ReleasesRoot $Version
  Assert-RuntimeConfig $ConfigItem.FullName $InstalledRelease $StateRoot

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

  Copy-PrivateFile $ConfigItem.FullName (Join-Path $StateRoot "runtime.json")
  Copy-PrivateFile $CredentialItem.FullName (Join-Path $StateRoot "machine.credential")
  Install-Model $InstalledRelease $StateRoot $ModelItem.FullName

  $ServiceRoot = Join-Path $Root "service"
  $Wrapper = Join-Path $ServiceRoot "MusicMuteWorkerService.exe"
  $ServiceXml = Join-Path $ServiceRoot "MusicMuteWorkerService.xml"
  $PreviousVersion = Read-ActiveVersion $StateRoot
  $PreviousXml = $null
  if (Test-Path -LiteralPath $ServiceXml -PathType Leaf) {
    $PreviousXml = [IO.File]::ReadAllBytes($ServiceXml)
  }
  $ServiceExists = $null -ne (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue)
  if ($ServiceExists -and $null -eq $PreviousXml) {
    throw "The installed service definition is missing."
  }
  try {
    if ($ServiceExists) {
      & $Wrapper stopwait 2>$null
    }
    Copy-PrivateFile (Join-Path $InstalledRelease "runtime\service\MusicMuteWorkerService.exe") $Wrapper
    Set-ExecutableFileAcl $Wrapper
    $NewXml = "$ServiceXml.$([guid]::NewGuid()).tmp"
    Invoke-WorkerCli $InstalledRelease @(
      "windows", "service-config",
      "--root", $Root,
      "--version", $Version,
      "--output", $NewXml
    ) | Out-Null
    Set-PrivateFileAcl $NewXml
    Move-Item -LiteralPath $NewXml -Destination $ServiceXml -Force
    if ($ServiceExists) {
      # WinSW 2.x reloads its side-by-side XML when the service starts.
    } else {
      Invoke-Checked $Wrapper @("install")
    }
    Invoke-Checked $Wrapper @("start")
    Start-Sleep -Seconds 2
    Test-InstalledRuntime $Root $Version
    Write-ActiveVersion $StateRoot $Version
  } catch {
    try {
      if (Test-Path -LiteralPath $Wrapper -PathType Leaf) {
        & $Wrapper stopwait 2>$null
      }
      if ($null -ne $PreviousXml -and $PreviousVersion -ne "") {
        [IO.File]::WriteAllBytes($ServiceXml, $PreviousXml)
        Set-PrivateFileAcl $ServiceXml
        Invoke-Checked $Wrapper @("start")
        Write-ActiveVersion $StateRoot $PreviousVersion
      } elseif (-not $ServiceExists) {
        & $Wrapper uninstall 2>$null
      }
    } catch {
      Write-Warning "Automatic rollback also failed; inspect the preserved installation."
    }
    throw
  }
  Write-Output "MusicMute Windows service: $($Action.ToLowerInvariant()) complete ($Version)"
} finally {
  if ($HasMutex) {
    $Mutex.ReleaseMutex()
  }
  $Mutex.Dispose()
}
