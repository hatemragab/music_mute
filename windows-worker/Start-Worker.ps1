param([switch]$Check, [switch]$Once, [switch]$SelfTest)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$pythonFile = Join-Path $PSScriptRoot 'python.path'
if (-not (Test-Path -LiteralPath $pythonFile)) { throw 'Run Configure-Worker.ps1 first' }
$pythonExe = (Get-Content -Raw -LiteralPath $pythonFile).Trim()
if (-not (Test-Path -LiteralPath $pythonExe)) { throw 'Saved Python executable was not found' }
if ($SelfTest) {
    & $pythonExe -m unittest discover -s tests -v
    exit $LASTEXITCODE
}
$workerArgs = @('-m', 'musicmute_worker', '--config', (Join-Path $PSScriptRoot 'worker.config.json'))
if ($Check) { $workerArgs += '--check' }
if ($Once) { $workerArgs += '--once' }
try {
    if (-not $Check) {
        $secure = (Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'worker-secret.dpapi')).Trim() | ConvertTo-SecureString
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        try { $env:MUSICMUTE_WORKER_SECRET = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
        finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer); $secure.Dispose() }
    }
    & $pythonExe @workerArgs
    $result = $LASTEXITCODE
} finally { Remove-Item Env:\MUSICMUTE_WORKER_SECRET -ErrorAction SilentlyContinue }
exit $result
