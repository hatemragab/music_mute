[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("Stage", "Benchmark", "Install", "Repair", "Update", "Reactivate", "Recover", "Doctor", "ResetRestartBudget", "Uninstall")]
  [string]$Action,

  [string]$Release = "",
  [string]$UpdateRequest = "",
  [string]$Config = "",
  [string]$Credential = "",
  [string]$ModelSource = "",
  [string]$FixtureSource = "",
  [string]$FixtureSha256 = "",
  [string]$QualificationOutput = "",
  [string]$BenchmarkRecipe = "",
  [switch]$LeaveStopped,
  [ValidateSet(1, 2)][int]$BenchmarkWorkers = 1,
  [ValidateRange(0, 2)][int]$WarmupRuns = 1,
  [ValidateRange(3, 10)][int]$MeasuredRuns = 3,
  [string]$InstallRoot = "$env:ProgramData\MusicMuteWorker"
)

. (Join-Path $PSScriptRoot 'windows-service-functions.ps1')

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
$OperatorLock = $null
try {
  try {
    $HasMutex = $Mutex.WaitOne(0)
  } catch [Threading.AbandonedMutexException] {
    # WaitOne acquired ownership even though the previous process died.
    $HasMutex = $true
  }
  if (-not $HasMutex) {
    throw "Another MusicMute worker installation command is running."
  }
  $OperatorLock = New-OperatorLock $Root
  Restore-OperationJournal $Root ($Action -eq 'Recover' -and $LeaveStopped)
  if ($Action -eq "Recover") {
    Write-Output 'MusicMute Windows operation recovery complete.'
    return
  }
  Assert-ManagedService $Root
  if ($LeaveStopped -and $Action -notin @('Install', 'Repair', 'Recover')) {
    throw 'LeaveStopped is valid only for Install, Repair or Recover.'
  }
  if ($Action -eq 'Reactivate') {
    if ($Config -ne '' -or $Credential -ne '' -or $ModelSource -ne '' -or $FixtureSource -ne '' -or $FixtureSha256 -ne '' -or $QualificationOutput -ne '') {
      throw 'Reactivation uses only the preserved installation.'
    }
    Invoke-Reactivate $Root $Release
    Write-Output 'MusicMute Windows service reactivated from the preserved release.'
    return
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

  $Updating = $Action -eq 'Update'
  $UpdatePlan = $null
  if (($UpdateRequest -ne '') -ne $Updating) { throw 'Update requires its private signed request; other actions do not accept one.' }
  if ($Updating) {
    if ($Release -eq '' -or $Config -ne '' -or $Credential -ne '' -or $ModelSource -ne '' -or $FixtureSource -ne '' -or $FixtureSha256 -ne '' -or $LeaveStopped) {
      throw 'Update accepts only a signed request and prepared release.'
    }
    $RequestItem = Assert-RegularFile $UpdateRequest 'update request' 65536
    Assert-RecoveryPath $RequestItem.FullName $false
    Assert-RecoveryPath $RequestItem.DirectoryName $true
    $Lines = @(Invoke-WorkerCli $Release @('windows', 'update-plan', '--root', $Root, '--request', $RequestItem.FullName, '--release', $Release))
    if ($Lines.Count -ne 1) { throw 'Update preparation returned invalid output.' }
    $UpdatePlan = $Lines[0] | ConvertFrom-Json
    if ($UpdatePlan.schemaVersion -ne 1 -or $UpdatePlan.force -isnot [bool]) { throw 'Update plan is invalid.' }
    $Config = [string]$UpdatePlan.configPath
    $Credential = [string]$UpdatePlan.credentialPath
    $ModelSource = [string]$UpdatePlan.modelPath
    $FixtureSource = [string]$UpdatePlan.fixturePath
    $FixtureSha256 = [string]$UpdatePlan.fixtureSha256
  }

  $BenchmarkOnly = $Action -eq 'Benchmark'
  $StagingOnly = $Action -in @('Stage', 'Benchmark')
  if ($BenchmarkWorkers -eq 2) {
    if (-not $BenchmarkOnly -or $BenchmarkRecipe -ne '' -or $WarmupRuns -lt 1) { throw 'Two-worker capacity requires Benchmark, warmup, and every canonical recipe.' }
  } elseif ($BenchmarkOnly -ne ($BenchmarkRecipe -ne '')) { throw 'Benchmark requires a recipe; other actions do not accept one.' }
  if ($QualificationOutput -ne "" -and -not $StagingOnly) {
    throw "QualificationOutput is valid only for Stage or Benchmark."
  }
  $QualificationOutputPath = ""
  if ($QualificationOutput -ne "") {
    if (-not [IO.Path]::IsPathRooted($QualificationOutput)) {
      throw "The qualification output must be an absolute path."
    }
    $QualificationOutputPath = [IO.Path]::GetFullPath($QualificationOutput)
    Assert-ReportDestination $Root $QualificationOutput
    if (Test-Path -LiteralPath $QualificationOutputPath) {
      throw "The qualification output already exists."
    }
  }
  if (
    $Release -eq "" -or
    (-not $BenchmarkOnly -and $ModelSource -eq "") -or
    $FixtureSource -eq "" -or
    $FixtureSha256 -eq "" -or
    (-not $StagingOnly -and ($Config -eq "" -or $Credential -eq ""))
  ) {
    throw "Stage requires Release, ModelSource, FixtureSource and FixtureSha256; Install and Repair also require Config and Credential."
  }
  $ReleaseRoot = [IO.Path]::GetFullPath($Release)
  if (
    -not $BenchmarkOnly -and -not $Updating -and (
      $ReleaseRoot -eq $Root -or
      $ReleaseRoot.StartsWith($Root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
    )
  ) {
    throw "The release source must be outside the installation root."
  }
  $ConfigItem = $null
  $CredentialItem = $null
  if (-not $StagingOnly) {
    $ConfigItem = Assert-RegularFile $Config "runtime config" 65536
    $CredentialItem = Assert-RegularFile $Credential "machine credential" 128
  }
  $ModelItem = $null
  if (-not $BenchmarkOnly) {
    $ModelItem = Assert-RegularFile $ModelSource "model source" $ModelBytes
    if ($ModelItem.Length -ne $ModelBytes) { throw "The model source size is invalid." }
  }
  $FixtureItem = Assert-RegularFile $FixtureSource "qualification fixture" $(if ($BenchmarkOnly) { 512MB } else { 64MB })
  if (
    (-not $BenchmarkOnly -and -not [string]::Equals(
      [IO.Path]::GetExtension($FixtureItem.FullName),
      ".wav",
      [StringComparison]::OrdinalIgnoreCase
    )) -or
    $FixtureSha256 -cnotmatch "^[a-f0-9]{64}$" -or
    (Get-FileHash -Algorithm SHA256 -LiteralPath $FixtureItem.FullName).Hash.ToLowerInvariant() -cne $FixtureSha256
  ) {
    throw "The qualification fixture is invalid."
  }
  $Manifest = Read-ReleaseManifest $ReleaseRoot
  $Version = [string]$Manifest.releaseVersion
  if ($Updating -and $Version -cne $UpdatePlan.releaseVersion) { throw 'Update candidate identity changed.' }
  $ReleasesRoot = Join-Path $Root "releases"
  $InstalledRelease = Join-Path $ReleasesRoot $Version
  if ($BenchmarkOnly -and $ReleaseRoot -ine $InstalledRelease) {
    throw 'Benchmarks require an already installed immutable release.'
  }
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
  $LifecyclePath = Join-Path $StateRoot "lifecycle.json"
  if (-not (Test-Path -LiteralPath $LifecyclePath)) {
    Write-Utf8NoBom $LifecyclePath ((@{ schemaVersion = 1; intent = "active"; revision = 1; updatedAt = [DateTimeOffset]::UtcNow.ToString("o") } | ConvertTo-Json -Compress) + [Environment]::NewLine)
  }
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
      Copy-ReleaseTree $ReleaseRoot $Staging
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
  $FixtureExtension = if ($BenchmarkOnly) { [IO.Path]::GetExtension($FixtureItem.FullName).ToLowerInvariant() } else { '.wav' }
  if ($FixtureExtension -notmatch '^\.[a-z0-9]{1,10}$') { throw 'The fixture extension is invalid.' }
  $QualificationFixture = Join-Path $StateRoot $(if ($BenchmarkOnly) { "benchmark-fixture-$([guid]::NewGuid())$FixtureExtension" } else { "qualification-fixture-$FixtureSha256$FixtureExtension" })
  $QualificationReport = Join-Path $StateRoot "qualification-$([guid]::NewGuid()).json"
  $NormalizedReport = "$QualificationReport.normalized.json"
  $BenchmarkWork = Join-Path (Join-Path $StateRoot 'tmp') ([IO.Path]::GetFileNameWithoutExtension($QualificationReport))
  $PreviousVersion = Read-ActiveVersion $StateRoot
  $RuntimeConfigExisted = Test-Path -LiteralPath $RuntimeConfigPath -PathType Leaf
  $CredentialExisted = Test-Path -LiteralPath $CredentialPath -PathType Leaf
  $WrapperExisted = Test-Path -LiteralPath $Wrapper -PathType Leaf
  $ServiceXmlExisted = Test-Path -LiteralPath $ServiceXml -PathType Leaf
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
  if ($ServiceWasRunning) {
    if (-not $Updating) { throw 'Drain and stop MusicMuteWorker before installation, repair or qualification.' }
  }
  if ($Updating -and (-not $ServiceExists -or $PreviousVersion -cne $UpdatePlan.previousVersion)) { throw 'Update requires its original installed service.' }
  if ($Updating) { $LeaveStopped = -not $ServiceWasRunning }
  if (-not $BenchmarkOnly) { Install-Model $InstalledRelease $StateRoot $ModelItem.FullName }
  $ActiveXml = ""
  $QualificationExported = $false
  $QualificationXml = "$ServiceXml.$([guid]::NewGuid()).qualification.tmp"
  $ScratchLeaf = if ($BenchmarkOnly) { [IO.Path]::GetFileName($BenchmarkWork) } else { '' }
  $FixtureLeaf = if ($BenchmarkOnly) { [IO.Path]::GetFileName($QualificationFixture) } else { '' }
  if ($BenchmarkOnly -and $BenchmarkWorkers -eq 2) {
    # A failed rerun must not leave an earlier capacity approval usable.
    $CapacityPath = Join-Path $StateRoot 'capacity-validation.json'
    Write-Utf8NoBom $CapacityPath ((@{ schemaVersion = 3; status = 'IN_PROGRESS'; startedAt = [DateTimeOffset]::UtcNow.ToString('o') } | ConvertTo-Json -Compress) + [Environment]::NewLine)
    Set-PrivateFileAcl $CapacityPath
  }
  # Draining is not a rollback operation: if it fails or is interrupted, leave
  # active attempts alone. Preserve the original intent in the later snapshot.
  $OriginalLifecycle = $null
  if ($Updating) {
    $Drained = Wait-WorkerDrain $Root $UpdatePlan.force
    if ($null -ne $Drained) { $OriginalLifecycle = $Drained.originalLifecycle }
  }
  Save-OperationJournal $Root $ServiceExists $ServiceWasRunning $PreviousVersion $ScratchLeaf $FixtureLeaf $Version $(if ($Updating) { $Version } else { '' }) -OriginalLifecycle $OriginalLifecycle
  try {
    $SavedPolicy = (Read-OperationJournal $Root).servicePolicy
    $Quiet = Disable-ServiceRestarts $Root $SavedPolicy
    if ($Updating) { Stop-RegisteredWorker $Root }
    Wait-ServiceRestartQueue $Quiet
    if ($BenchmarkOnly) { New-Item -ItemType Directory -Path $BenchmarkWork | Out-Null }
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
    $ServiceConfigArguments = @(
      "windows", "service-config",
      "--root", $Root,
      "--version", $Version,
      "--output", $QualificationXml,
      "--qualification-fixture", $QualificationFixture,
      "--qualification-fixture-sha256", $FixtureSha256,
      "--qualification-report", $QualificationReport
    )
    if ($BenchmarkOnly) {
      $ServiceConfigArguments += @('--benchmark-warmup-runs', ([string]$WarmupRuns), '--benchmark-measured-runs', ([string]$MeasuredRuns))
      if ($BenchmarkWorkers -eq 2) { $ServiceConfigArguments += @('--benchmark-workers', '2') }
      else { $ServiceConfigArguments += @('--benchmark-recipe', $BenchmarkRecipe) }
    }
    Invoke-WorkerCli $InstalledRelease $ServiceConfigArguments | Out-Null
    Set-PrivateFileAcl $QualificationXml
    Move-Item -LiteralPath $QualificationXml -Destination $ServiceXml -Force
    if (-not $ServiceExists) {
      Invoke-Checked $Wrapper @("install")
    }
    Enable-QualificationService $Root
    $BenchmarkClock = [Diagnostics.Stopwatch]::StartNew()
    Invoke-Checked $Wrapper @("start")
    if ($BenchmarkOnly) {
      Wait-WorkerBenchmark $InstalledRelease $QualificationReport $NormalizedReport $FixtureSha256 $BenchmarkClock
    } else {
      Wait-WorkerQualification $InstalledRelease $QualificationReport $FixtureSha256
    }
    $QualificationService = Get-Service -Name $ServiceName -ErrorAction Stop
    if ($QualificationService.Status -ne [ServiceProcess.ServiceControllerStatus]::Stopped) {
      Invoke-Checked $Wrapper @("stopwait")
    }
    if (-not $ServiceExists) {
      Invoke-Checked $Wrapper @("uninstall")
    }
    if ($StagingOnly) {
      Restore-OperationJournal $Root
      if ($BenchmarkOnly -and $BenchmarkWorkers -eq 2) {
        Invoke-WorkerCli $InstalledRelease @('windows', 'capacity-approve', '--root', $Root, '--version', $Version, '--report', $NormalizedReport)
      }
      if ($QualificationOutputPath -ne "") {
        if ($BenchmarkOnly) { Export-PrivateFileExclusive $NormalizedReport $QualificationOutputPath }
        else { Export-PrivateFileExclusive $QualificationReport $QualificationOutputPath }
        $QualificationExported = $true
      }
    } else {
      Move-Item -LiteralPath $ActiveXml -Destination $ServiceXml -Force
      if ($Updating) {
        # Restore active/paused/draining intent before operational startup. The
        # journal continues to fence claims until activation and sequence commit.
        Copy-PrivateFile (Join-Path $Root 'service\operation-recovery\lifecycle.bin') (Join-Path $StateRoot 'lifecycle.json')
        Invoke-WorkerCli $InstalledRelease @('windows', 'config-check', '--root', $Root, '--version', $Version) | Out-Null
      }
      if (-not $ServiceExists) {
        Invoke-Checked $Wrapper @("install")
      }
      if ($ServiceExists) { Set-ServicePolicy $Root $SavedPolicy }
      # Qualification already exercised this release as LocalService. A manual
      # update of a stopped worker must not enable operational processing.
      if (-not $LeaveStopped) {
        $StartedAfter = [DateTimeOffset]::UtcNow
        Invoke-Checked $Wrapper @("start")
        Test-InstalledRuntime $Root $Version $StartedAfter
      }
      Write-ActiveVersion $StateRoot $Version
      if ($Updating) { Copy-PrivateFile ([string]$UpdatePlan.statePath) (Join-Path $Root 'service\update-state.json') }
      Complete-OperationJournal $Root
    }
  } catch {
    try {
      Restore-OperationJournal $Root
    } catch {
      Write-Warning 'Automatic rollback failed. The durable journal is preserved; run Recover before further mutations.'
    }
    if (-not $BenchmarkOnly -and (Test-Path -LiteralPath $QualificationReport -PathType Leaf)) {
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
  if ($null -ne $OperatorLock) { $OperatorLock.Dispose() }
  if ($HasMutex) {
    $Mutex.ReleaseMutex()
  }
  $Mutex.Dispose()
}
