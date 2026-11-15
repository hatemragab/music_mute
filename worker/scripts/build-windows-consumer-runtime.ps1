# Build-time recipe only. Never installed or run by an end user.
# Private inputs are already prepared from the reviewed upstream/locked sources.
# This script assembles a NEW artifact; it never alters the installed app/worker.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$WorkerRoot,
  [Parameter(Mandatory = $true)][string]$OutputPath,
  [Parameter(Mandatory = $true)][string]$ReleaseVersion,
  [Parameter(Mandatory = $true)][string]$NodeRoot,
  [Parameter(Mandatory = $true)][string]$PythonRoot,
  [Parameter(Mandatory = $true)][string]$MediaRoot,
  [Parameter(Mandatory = $true)][string]$NativeBinary,
  [Parameter(Mandatory = $true)][string]$AgentRoot,
  [Parameter(Mandatory = $true)][string]$DownloaderRoot,
  [Parameter(Mandatory = $true)][string]$YoutubeRoot,
  [Parameter(Mandatory = $true)][string]$PnpmEntry,
  [Parameter(Mandatory = $true)][string]$SigningKeyPath,
  [Parameter(Mandatory = $true)][string]$SigningKeyId,
  [Parameter(Mandatory = $true)][long]$Sequence,
  [Parameter(Mandatory = $true)][string]$ExpiresAt
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or -not [Environment]::Is64BitProcess) {
  throw "Consumer runtime assembly requires native Windows x64; Python also verifies the actual native machine architecture."
}
if ($Sequence -lt 1 -or $ReleaseVersion -notmatch '^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$') {
  throw "A valid release version and monotonic positive sequence are required."
}
foreach ($InputRoot in @($WorkerRoot, $NodeRoot, $PythonRoot, $MediaRoot, $AgentRoot, $DownloaderRoot, $YoutubeRoot)) {
  if (-not [IO.Path]::IsPathRooted($InputRoot) -or -not (Test-Path -LiteralPath $InputRoot -PathType Container)) { throw "A required private input root is missing." }
  if ((Get-Item -LiteralPath $InputRoot).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Private input roots must not be reparse points." }
}
foreach ($InputFile in @($NativeBinary, $PnpmEntry, $SigningKeyPath)) {
  if (-not [IO.Path]::IsPathRooted($InputFile) -or -not (Test-Path -LiteralPath $InputFile -PathType Leaf)) { throw "A required native binary, pinned pnpm entry or external signing key is missing." }
  if ((Get-Item -LiteralPath $InputFile).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Private input files must not be reparse points." }
}
if ([IO.Path]::GetFileName($PnpmEntry) -notin @('pnpm.cjs', 'pnpm.js')) { throw "Use the pinned pnpm JavaScript entry point; no command shell shim is accepted." }
$ResolvedWorker = [IO.Path]::GetFullPath($WorkerRoot)
$ResolvedOutput = [IO.Path]::GetFullPath($OutputPath)
$OutputParent = Split-Path -Parent $ResolvedOutput
if (-not (Test-Path -LiteralPath $OutputParent -PathType Container) -or (Test-Path -LiteralPath $ResolvedOutput)) { throw "The output must be a new directory beneath an existing build parent." }
$Archive = Join-Path $OutputParent ("musicmute-runtime-windows-x64-user-" + $ReleaseVersion + ".zip")
foreach ($Destination in @($Archive, ($Archive + '.signed.json'), ($Archive + '.sha256'))) {
  if (Test-Path -LiteralPath $Destination) { throw "Immutable candidate outputs must not already exist." }
}
$NodeExe = Join-Path $NodeRoot 'node.exe'
$NodeVersion = & $NodeExe --version
if ($LASTEXITCODE -ne 0 -or $NodeVersion -ne 'v24.18.0') { throw "The private Node runtime must be exactly 24.18.0 x64." }
$PnpmVersion = & $NodeExe $PnpmEntry --version
if ($LASTEXITCODE -ne 0 -or $PnpmVersion -ne '10.14.0') { throw "The build pnpm entry must be exactly 10.14.0." }
$Requirements = [IO.Path]::GetFullPath((Join-Path $ResolvedWorker '..\tools\worker-gpu-feasibility\requirements-directml.lock.txt'))
if (-not (Test-Path -LiteralPath $Requirements -PathType Leaf)) { throw "The canonical locked DirectML requirements are missing." }
# Signing keys stay outside all source/runtime payload roots and output trees.
$ResolvedKey = [IO.Path]::GetFullPath($SigningKeyPath)
foreach ($PayloadRoot in @($ResolvedWorker, $NodeRoot, $PythonRoot, $MediaRoot, $AgentRoot, $DownloaderRoot, $YoutubeRoot, $ResolvedOutput)) {
  $Prefix = [IO.Path]::GetFullPath($PayloadRoot).TrimEnd('\') + '\'
  if ($ResolvedKey.StartsWith($Prefix, [StringComparison]::OrdinalIgnoreCase)) { throw "The signing key must remain outside every package input and output tree." }
}
$OptionsPath = Join-Path $OutputParent ('.musicmute-consumer-build-' + [guid]::NewGuid().ToString() + '.json')
$Options = [ordered]@{
  workerRoot = $ResolvedWorker; outputRoot = $ResolvedOutput; releaseVersion = $ReleaseVersion
  nodeRoot = [IO.Path]::GetFullPath($NodeRoot); pythonRoot = [IO.Path]::GetFullPath($PythonRoot)
  mediaRoot = [IO.Path]::GetFullPath($MediaRoot); nativeBinary = [IO.Path]::GetFullPath($NativeBinary)
  agentRoot = [IO.Path]::GetFullPath($AgentRoot); downloaderRoot = [IO.Path]::GetFullPath($DownloaderRoot)
  youtubeRoot = [IO.Path]::GetFullPath($YoutubeRoot); requirementsLockPath = $Requirements
}
$OldPnpmEntry = $env:npm_execpath
try {
  $env:npm_execpath = [IO.Path]::GetFullPath($PnpmEntry)
  Push-Location $ResolvedWorker
  try {
    # The offline store must already contain the frozen lock's exact artifacts.
    # No download, privileged install or updater is hidden inside this recipe.
    & $NodeExe $PnpmEntry install --offline --frozen-lockfile --ignore-scripts
    if ($LASTEXITCODE -ne 0) { throw "The offline locked worker build dependencies are unavailable." }
    & $NodeExe $PnpmEntry run build
    if ($LASTEXITCODE -ne 0) { throw "Worker compilation failed." }
  } finally { Pop-Location }
  [IO.File]::WriteAllText($OptionsPath, (($Options | ConvertTo-Json -Depth 4) + [Environment]::NewLine), (New-Object System.Text.UTF8Encoding($false)))
  $Builder = Join-Path $ResolvedWorker 'dist\src\platform\windows\consumer-package.js'
  & $NodeExe $Builder $OptionsPath $Archive $ResolvedKey $SigningKeyId ([string]$Sequence) $ExpiresAt
  if ($LASTEXITCODE -ne 0) { throw "Consumer assembly, inventory, archive or signing validation failed. No acceptance is claimed." }
  Write-Output "Consumer candidate assembled. Native install/GPU/driver/Chrome acceptance is still required."
} finally {
  $env:npm_execpath = $OldPnpmEntry
  if (Test-Path -LiteralPath $OptionsPath) { Remove-Item -LiteralPath $OptionsPath -Force }
}
