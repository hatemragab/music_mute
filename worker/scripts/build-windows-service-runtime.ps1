[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$OutputPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$WinSWVersion = "2.12.0"
$WinSWUrl = "https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe"
$WinSWSha256 = "05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da"
$LicenseUrl = "https://raw.githubusercontent.com/winsw/winsw/v2.12.0/LICENSE.txt"
$LicenseSha256 = "1cdf703c10a70e5973bf3acf2a5eeabe7746237155b92db2034aeae26fdf7802"

if (
  [Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or
  -not [Environment]::Is64BitOperatingSystem
) {
  throw "The Windows service runtime requires native 64-bit Windows."
}

$ResolvedOutput = [IO.Path]::GetFullPath($OutputPath)
if (Test-Path -LiteralPath $ResolvedOutput) {
  throw "The output path must not already exist."
}
$Parent = Split-Path -Parent $ResolvedOutput
if (-not (Test-Path -LiteralPath $Parent -PathType Container)) {
  throw "The output parent directory must already exist."
}

$Staging = Join-Path $Parent ("." + [IO.Path]::GetFileName($ResolvedOutput) + "." + [guid]::NewGuid() + ".building")
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

try {
  New-Item -ItemType Directory -Path $Staging -ErrorAction Stop | Out-Null
  $Executable = Join-Path $Staging "WinSW.exe"
  $License = Join-Path $Staging "LICENSE.txt"
  Invoke-WebRequest -UseBasicParsing -Uri $WinSWUrl -OutFile $Executable
  Invoke-WebRequest -UseBasicParsing -Uri $LicenseUrl -OutFile $License
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath $Executable).Hash.ToLowerInvariant() -ne $WinSWSha256) {
    throw "WinSW digest verification failed."
  }
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath $License).Hash.ToLowerInvariant() -ne $LicenseSha256) {
    throw "WinSW license digest verification failed."
  }
  $Manifest = [ordered]@{
    schemaVersion = 1
    component = "winsw-x64"
    version = $WinSWVersion
    executable = [ordered]@{ url = $WinSWUrl; sha256 = $WinSWSha256 }
    license = [ordered]@{ url = $LicenseUrl; sha256 = $LicenseSha256 }
  }
  $ManifestJson = ($Manifest | ConvertTo-Json -Depth 4) + [Environment]::NewLine
  $Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [IO.File]::WriteAllText((Join-Path $Staging "SOURCE-MANIFEST.json"), $ManifestJson, $Utf8NoBom)
  Move-Item -LiteralPath $Staging -Destination $ResolvedOutput
  Write-Output "MusicMute Windows service runtime: $ResolvedOutput"
} catch {
  if (Test-Path -LiteralPath $Staging) {
    Remove-Item -LiteralPath $Staging -Recurse -Force
  }
  throw
}
