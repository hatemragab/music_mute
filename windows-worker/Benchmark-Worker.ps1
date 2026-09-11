param(
    [Parameter(Mandatory = $true, Position = 0)][string[]]$InputFiles,
    [ValidateRange(1, 5)][int]$Repeats = 2,
    [switch]$CompareTwo,
    [string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
try {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
        throw 'Windows required'
    }
    $python = (Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'python.path')).Trim()
    if (-not (Test-Path -LiteralPath $python -PathType Leaf)) { throw 'Python missing' }
    $benchmarkArgs = @('-m', 'musicmute_worker.benchmark', '--config', (Join-Path $PSScriptRoot 'worker.config.json'), '--repeats', $Repeats)
    if ($CompareTwo) { $benchmarkArgs += '--compare-two' }
    if ($OutputDirectory) {
        $output = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputDirectory)
        $benchmarkArgs += @('--output-dir', $output)
    }
    # Resolve caller-relative input paths before entering the package directory.
    foreach ($inputPath in $InputFiles) {
        $benchmarkArgs += (Resolve-Path -LiteralPath $inputPath).Path
    }
    Set-Location -LiteralPath $PSScriptRoot
    Remove-Item Env:\MUSICMUTE_WORKER_SECRET -ErrorAction SilentlyContinue
    & $python @benchmarkArgs
    exit $LASTEXITCODE
} catch {
    Write-Host 'Benchmark could not start. Check Windows, python.path, configuration, and local input paths.'
    exit 2
}
