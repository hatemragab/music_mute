param([string]$PythonExe)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if (-not $PythonExe) {
    $candidates = @((Join-Path $PSScriptRoot '.venv\Scripts\python.exe'), (Join-Path (Split-Path $PSScriptRoot -Parent) '.venv\Scripts\python.exe'))
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) { $PythonExe = $candidate; break }
    }
}
if (-not $PythonExe) { $PythonExe = Read-Host 'Full path to the python.exe in your working .venv\Scripts folder' }
$PythonExe = (Resolve-Path -LiteralPath $PythonExe).Path
& $PythonExe -c 'import sys; assert sys.version_info >= (3,11)'
if ($LASTEXITCODE -ne 0) { throw 'Python check failed' }
$workerId = (Read-Host 'Worker ID (lowercase letters, digits and hyphens) [z440]').Trim()
if (-not $workerId) { $workerId = 'z440' }
if ($workerId -cnotmatch '^[a-z0-9][a-z0-9-]{0,63}$') {
    throw 'Worker ID must be 1..64 lowercase letters, digits, or hyphens and start with a letter or digit'
}
$baseUrl = (Read-Host 'Backend URL including /api/v1 (for example https://your-api.example/api/v1)').TrimEnd('/')
$uri = [Uri]$baseUrl
if ($uri.Scheme -ne 'https' -or -not $baseUrl.EndsWith('/api/v1') -or $uri.Query -or $uri.Fragment -or $uri.UserInfo) {
    throw 'Use an HTTPS backend URL ending with /api/v1, without credentials or query'
}
$configPath = Join-Path $PSScriptRoot 'worker.config.json'
& $PythonExe -m musicmute_worker --config $configPath --configure-installation --api-base-url $baseUrl --worker-id $workerId
if ($LASTEXITCODE -ne 0) { throw 'Worker configuration was not saved. Stop the running worker or reconcile its active assignment, then retry.' }
$PythonExe | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $PSScriptRoot 'python.path')
$secret = Read-Host 'Existing RAW worker secret (not its SHA-256 digest; input is hidden)' -AsSecureString
try {
    $secret | ConvertFrom-SecureString | Set-Content -Encoding ASCII -LiteralPath (Join-Path $PSScriptRoot 'worker-secret.dpapi')
} finally { $secret.Dispose() }
Write-Host "Saved worker identity '$workerId'. The secret is encrypted for this Windows account. Your Python environment was not changed."
Write-Host 'Next: powershell -ExecutionPolicy Bypass -File .\Start-Worker.ps1 -Check'
