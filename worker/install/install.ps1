# Release packaging renders this source template; it is not a published installer.
param([ValidateSet('install','repair','pause','status','uninstall','pairing-retry')][string]$Action = 'install')
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Recipe = $null
# @@RECIPE@@

if ($null -eq $Recipe) { throw 'MusicMute setup stopped: BOOTSTRAP_NOT_CONFIGURED' }
if ($PSVersionTable.PSEdition -ne 'Desktop') { throw 'MusicMute setup stopped: WINDOWS_POWERSHELL_REQUIRED. Run the published command with built-in powershell.exe.' }
$Principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (!$Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'MusicMute setup stopped: ADMINISTRATOR_REQUIRED' }
$Arch = switch ([Environment]::GetEnvironmentVariable('PROCESSOR_ARCHITEW6432')) {
    'ARM64' { 'arm64' }
    'AMD64' { 'x64' }
    default {
        switch ($env:PROCESSOR_ARCHITECTURE) {
            'ARM64' { 'arm64' }
            'AMD64' { 'x64' }
            default { throw 'UNSUPPORTED_PLATFORM' }
        }
    }
}
$Bundle = @($Recipe.bundles | Where-Object { $_.os -eq 'windows' -and $_.arch -eq $Arch })
if ($Bundle.Count -ne 1) { throw 'UNSUPPORTED_PLATFORM' }
$Bundle = $Bundle[0]
$Base = Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'MusicMute'
$Utf8 = New-Object Text.UTF8Encoding($false)
function Protect-Directory([string]$Path) {
    $Cursor = $Path
    while ($Cursor) {
        if (Test-Path -LiteralPath $Cursor) {
            $Item = Get-Item -Force -LiteralPath $Cursor
            if ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'UNSAFE_STATE_PATH' }
        }
        $Parent = Split-Path -Parent $Cursor
        if ($Parent -eq $Cursor) { break }
        $Cursor = $Parent
    }
    $SystemSid = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
    $AdminSid = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')
    if (Test-Path -LiteralPath $Path) {
        if (!(Get-Item -Force -LiteralPath $Path).PSIsContainer) { throw 'UNSAFE_STATE_PATH' }
        $Acl = Get-Acl -LiteralPath $Path
        if (!$Acl.AreAccessRulesProtected) { throw 'UNSAFE_STATE_PERMISSIONS' }
        if ($Acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin @($SystemSid.Value, $AdminSid.Value)) { throw 'UNSAFE_STATE_PERMISSIONS' }
        foreach ($Rule in $Acl.Access) {
            $Sid = $Rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
            if ($Rule.AccessControlType -eq 'Allow' -and $Sid -notin @($SystemSid.Value, $AdminSid.Value)) { throw 'UNSAFE_STATE_PERMISSIONS' }
        }
    } else {
        $Acl = New-Object Security.AccessControl.DirectorySecurity
        $Acl.SetAccessRuleProtection($true, $false)
        $Acl.SetOwner($AdminSid)
        foreach ($Sid in @($SystemSid, $AdminSid)) {
            $Rule = New-Object Security.AccessControl.FileSystemAccessRule($Sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
            $Acl.AddAccessRule($Rule)
        }
        # Windows PowerShell/.NET Framework creates the directory with its DACL.
        [IO.Directory]::CreateDirectory($Path, $Acl) | Out-Null
    }
}
Protect-Directory $Base
$Paths = [ordered]@{}
foreach ($Name in @('identity','config','state','releases','models','journals','events')) {
    $Paths[$Name] = Join-Path $Base $Name
    Protect-Directory $Paths[$Name]
}
$NativeEvents = Join-Path $Paths.events 'bootstrap'
Protect-Directory $NativeEvents
Protect-Directory (Join-Path $Paths.state 'setup')
$LockPath = Join-Path $Paths.state 'bootstrap.lock'
# Kernel file sharing gives automatic lock release on crash; keep the file itself.
if ((Test-Path -LiteralPath $LockPath) -and ((Get-Item -Force -LiteralPath $LockPath).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'UNSAFE_STATE_PATH' }
$Lock = [IO.File]::Open($LockPath, 'OpenOrCreate', 'ReadWrite', 'None')
function Save-Json([string]$Path, $Value) {
    if ((Test-Path -LiteralPath $Path) -and ((Get-Item -Force -LiteralPath $Path).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'UNSAFE_STATE_PATH' }
    $Bytes = $Utf8.GetBytes(($Value | ConvertTo-Json -Depth 16 -Compress))
    $Temporary = $Path + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    $File = [IO.File]::Open($Temporary, 'CreateNew', 'Write', 'None')
    try { $File.Write($Bytes, 0, $Bytes.Length); $File.Flush($true) } finally { $File.Dispose() }
    if ([IO.File]::Exists($Path)) { [IO.File]::Replace($Temporary, $Path, $null) }
    else { [IO.File]::Move($Temporary, $Path) }
}
function Get-Digest([byte[]]$Bytes) {
    $Sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($Sha.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $Sha.Dispose() }
}
$RetryPath = Join-Path $Paths.state 'setup\retry-after.json'
$RetryDefault = 900
# Durable server backoff. A one-shot entrypoint still has to remember a
# Retry-After across manual reruns, otherwise an operator retry loop hammers a
# throttled endpoint and the follow-on error report has no deadline at all.
$script:RetryDeadline = 0
function Get-NowSeconds { return [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() }
function Read-Retry {
    $script:RetryDeadline = 0
    if (!(Test-Path -LiteralPath $RetryPath)) { return }
    # A corrupt or linked record fails visibly rather than silently unblocking.
    $Item = Get-Item -Force -LiteralPath $RetryPath
    if (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $Item.Length -gt 4096 -or $Item.Length -eq 0) { throw 'UNSAFE_STATE_PATH' }
    $Value = [IO.File]::ReadAllText($RetryPath, $Utf8) | ConvertFrom-Json
    # ConvertFrom-Json may yield Int32 or Int64 here; bind through text so an
    # epoch written by either shape is accepted and overflow is impossible.
    $Text = [string]$Value.deadlineEpoch
    if ($Value.schemaVersion -ne 3 -or $Text -notmatch '^\d{1,10}$') { throw 'UNSAFE_STATE_PATH' }
    $script:RetryDeadline = [long]$Text
}
function Test-RetryBlocked { return ((Get-NowSeconds) -lt $script:RetryDeadline) }
function Save-Retry([string]$Code, [int]$Delay) {
    $script:RetryDeadline = (Get-NowSeconds) + $Delay
    Save-Json $RetryPath ([ordered]@{deadlineEpoch=$script:RetryDeadline; code=$Code; schemaVersion=3})
}
function Clear-Retry {
    $script:RetryDeadline = 0
    if (Test-Path -LiteralPath $RetryPath) { Remove-Item -Force -LiteralPath $RetryPath }
}
function Get-RetryDelay($Error) {
    # Only a deadline the server actually asked for is persisted; a transport
    # failure must not invent backoff the server never requested.
    try {
        $Response = $Error.Exception.Response
        if ($null -eq $Response) { return 0 }
        $Header = $Response.Headers['Retry-After']
        # An HTTP-date header is not reinterpreted here; the bounded default is
        # used instead of guessing a wall-clock conversion.
        if ($Header -match '^\s*\d{1,6}\s*$') {
            $Value = [int]$Header.Trim()
            if ($Value -ge 1 -and $Value -le 86400) { return $Value }
        }
        if ($Header) { return $RetryDefault }
    } catch { }
    return 0
}
function Invoke-Control([string]$Path, $Body, [bool]$Authenticated) {
    # A durable server deadline outranks a manual rerun: no request is sent at all.
    if (Test-RetryBlocked) { throw 'REPORTING_UNAVAILABLE' }
    $Request = [Net.HttpWebRequest]::Create($Recipe.apiBaseUrl + $Path)
    $Request.AllowAutoRedirect = $false
    $Request.Proxy = $null
    $Request.Timeout = 30000
    $Request.ReadWriteTimeout = 30000
    if ($Authenticated) { $Request.Headers['Authorization'] = 'Bearer ' + $Identity.installationToken }
    if ($null -ne $Body) {
        $Request.Method = 'POST'; $Request.ContentType = 'application/json'
        $Bytes = $Utf8.GetBytes(($Body | ConvertTo-Json -Depth 16 -Compress))
        $Request.ContentLength = $Bytes.Length
        $Stream = $Request.GetRequestStream()
        try { $Stream.Write($Bytes, 0, $Bytes.Length) } finally { $Stream.Dispose() }
    }
    try {
        $Response = $Request.GetResponse()
    } catch [Net.WebException] {
        $Delay = Get-RetryDelay $_
        if ($Delay -gt 0) { Save-Retry 'REPORTING_UNAVAILABLE' $Delay }
        throw 'REPORTING_UNAVAILABLE'
    }
    try {
        if ([int]$Response.StatusCode -notin @(200, 201)) { throw 'REPORTING_UNAVAILABLE' }
        $Stream = $Response.GetResponseStream()
        $Buffer = New-Object byte[] 65537
        $Count = 0
        do { $Read = $Stream.Read($Buffer, $Count, $Buffer.Length - $Count); $Count += $Read } while ($Read -gt 0 -and $Count -lt $Buffer.Length)
        if ($Count -gt 65536) { throw 'REPORTING_RESPONSE_TOO_LARGE' }
        return ($Utf8.GetString($Buffer, 0, $Count) | ConvertFrom-Json)
    } finally { $Response.Dispose() }
}
function Send-SetupEvent([string]$Status, [string]$Code) {
    if (@(Get-ChildItem -Force -LiteralPath $NativeEvents).Count -ge 128) { throw 'EVENT_SPOOL_FULL' }
    $Stamp = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    $Delivery = 'queued'
    try {
        $State = Invoke-Control ('/worker-installations/' + $Identity.installationId) $null $true
        if ($State.serverTime -match '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$') { $Stamp = $State.serverTime; $Delivery = 'uncertain' }
    } catch { } # Keep local evidence without uploading a guessed clock timestamp.
    $Event = [ordered]@{eventId=[Guid]::NewGuid().ToString(); operationId=[Guid]::NewGuid().ToString(); sequence=1; category='installation'; stage='download'; status=$Status; occurredAt=$Stamp}
    if ($Code) { $Event.code = $Code }
    Save-Json (Join-Path $NativeEvents ($Event.eventId + '.json')) ([ordered]@{schemaVersion=3; installationId=$Identity.installationId; event=$Event; delivery=$Delivery})
    if ($Delivery -eq 'uncertain') {
        try { Invoke-Control ('/worker-installations/' + $Identity.installationId + '/events') @{events=@($Event)} $true | Out-Null } catch { }
    }
}
function Test-CachedBundle([string]$Destination) {
    if ((Get-Item -Force -LiteralPath $Destination).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'UNSAFE_STATE_PATH' }
    $InventoryPath = Join-Path $Destination '.bootstrap-inventory.json'
    $Inventory = [IO.File]::ReadAllText($InventoryPath, $Utf8) | ConvertFrom-Json
    $Files = @(Get-ChildItem -Force -Recurse -LiteralPath $Destination)
    if (@($Files | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count) { throw 'UNSAFE_STATE_PATH' }
    if (@($Files | Where-Object { !$_.PSIsContainer -and $_.FullName -ne $InventoryPath }).Count -ne @($Inventory).Count) { throw 'BOOTSTRAP_CACHE_INVALID' }
    foreach ($Entry in $Inventory) {
        if ($Entry.path -cnotmatch '^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)*$' -or $Entry.path -match '(^|/)\.\.?($|/)' -or $Entry.sha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'BOOTSTRAP_CACHE_INVALID' }
        if ((Get-FileHash -LiteralPath (Join-Path $Destination $Entry.path) -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Entry.sha256) { throw 'BOOTSTRAP_CACHE_INVALID' }
    }
}
$Stage = $null
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Read-Retry
    $Registry = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryView]::Registry64)
    try {
        $Cryptography = $Registry.OpenSubKey('SOFTWARE\Microsoft\Cryptography')
        try { $Machine = $Cryptography.GetValue('MachineGuid').ToLowerInvariant() }
        finally { if ($Cryptography) { $Cryptography.Dispose() } }
    } finally { $Registry.Dispose() }
    if ($Machine -notmatch '^[a-f0-9-]{36}$') { throw 'MACHINE_ID_UNAVAILABLE' }
    $Binding = Get-Digest ($Utf8.GetBytes("musicmute-worker-machine-v1`nwindows`n$Machine`n"))
    $IdentityPath = Join-Path $Paths.identity 'setup-identity.json'
    if (Test-Path -LiteralPath $IdentityPath) {
        $Item = Get-Item -Force -LiteralPath $IdentityPath
        if (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $Item.Length -gt 8192) { throw 'UNSAFE_IDENTITY' }
        $Identity = [IO.File]::ReadAllText($IdentityPath, $Utf8) | ConvertFrom-Json
        if ($Identity.schemaVersion -ne 3 -or $Identity.apiBaseUrl -cne $Recipe.apiBaseUrl -or $Identity.machineBindingSha256 -cne $Binding -or $Identity.installationToken -cnotmatch '^[a-f0-9]{64}$' -or $Identity.installationId -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$') { throw 'IDENTITY_BINDING_MISMATCH' }
    } else {
        foreach ($Record in @((Join-Path $Paths.state 'setup/setup.json'), (Join-Path $Paths.identity 'installation.json'), (Join-Path $Paths.config 'setup-host.json'))) {
            if (Test-Path -LiteralPath $Record) { throw 'MISSING_IDENTITY' }
        }
        $Random = [Security.Cryptography.RandomNumberGenerator]::Create()
        $Bytes = New-Object byte[] 32
        try { $Random.GetBytes($Bytes) } finally { $Random.Dispose() }
        $Token = ([BitConverter]::ToString($Bytes)).Replace('-', '').ToLowerInvariant()
        $Identity = [ordered]@{apiBaseUrl=$Recipe.apiBaseUrl; installationId=[Guid]::NewGuid().ToString(); installationToken=$Token; machineBindingSha256=$Binding; schemaVersion=3}
        Save-Json $IdentityPath $Identity
    }
    $Destination = Join-Path $Paths.releases ('bootstrap-' + $Bundle.sha256)
    $Config=Join-Path $Paths.config 'setup-host.json'
    $Cached = Test-Path -LiteralPath $Config
    if ($Cached) {
        $ConfigItem = Get-Item -Force -LiteralPath $Config
        if (($ConfigItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $ConfigItem.Length -gt 16384) { throw 'BOOTSTRAP_CACHE_INVALID' }
        $SavedConfig = [IO.File]::ReadAllText($Config, $Utf8) | ConvertFrom-Json
        $Destination = Split-Path -Parent (Split-Path -Parent $SavedConfig.launcherPath)
        if ((Split-Path -Parent $Destination) -cne $Paths.releases -or (Split-Path -Leaf $Destination) -cnotmatch '^bootstrap-[a-f0-9]{64}$' -or $SavedConfig.launcherPath -cne (Join-Path $Destination 'python\python.exe')) { throw 'BOOTSTRAP_CACHE_INVALID' }
    }
    if (!$Cached) {
    Invoke-Control '/worker-installations' @{installationId=$Identity.installationId; tokenSha256=(Get-Digest ($Utf8.GetBytes($Identity.installationToken))); installerBuild=$Recipe.installerBuild; os='windows'; arch=$Arch} $false | Out-Null
    Clear-Retry
    if (!(Test-Path -LiteralPath $Destination)) {
        $Drive = New-Object IO.DriveInfo([IO.Path]::GetPathRoot($Paths.releases))
        if ($Drive.AvailableFreeSpace -lt ([long]$Bundle.bytes + [long]$Bundle.expandedBytes + 16777216)) { throw 'INSUFFICIENT_DISK' }
        $Stage = Join-Path $Paths.releases ('.bootstrap-' + [Guid]::NewGuid().ToString('N'))
        Protect-Directory $Stage
        $Archive = Join-Path $Stage 'download.zip'
        $Request = [Net.HttpWebRequest]::Create($Bundle.url)
        $Request.AllowAutoRedirect=$false; $Request.Proxy=$null; $Request.Timeout=30000; $Request.ReadWriteTimeout=30000
        $Response = $Request.GetResponse()
        try {
            if ([int]$Response.StatusCode -ne 200) { throw 'DOWNLOAD_FAILED' }
            $InputStream=$Response.GetResponseStream(); $OutputStream=[IO.File]::Open($Archive,'CreateNew','Write','None')
            try {
                $Buffer=New-Object byte[] 65536; $Total=0L; $Deadline=[Diagnostics.Stopwatch]::StartNew()
                while (($Count=$InputStream.Read($Buffer,0,$Buffer.Length)) -gt 0) {
                    $Total += $Count
                    if ($Total -gt $Bundle.bytes -or $Deadline.Elapsed.TotalSeconds -gt 600) { throw 'DOWNLOAD_FAILED' }
                    $OutputStream.Write($Buffer,0,$Count)
                }
                $OutputStream.Flush($true)
            } finally { $OutputStream.Dispose() }
        } finally { $Response.Dispose() }
        if ((Get-Item -LiteralPath $Archive).Length -ne $Bundle.bytes -or (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Bundle.sha256) { throw 'CHECKSUM_MISMATCH' }
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $Zip=[IO.Compression.ZipFile]::OpenRead($Archive)
        $Extract=Join-Path $Stage 'bundle'; Protect-Directory $Extract
        try {
            $Total=0L; $Seen=@{}
            foreach ($Entry in $Zip.Entries) {
                $Name=$Entry.FullName
                if ($Name -cnotmatch '^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)*/?$' -or $Name -match '(^|/)\.\.?($|/)' -or $Name -match '(^|/)(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])([./]|$)' -or $Name -match '[.](/|$)' -or $Seen.ContainsKey($Name.TrimEnd('/'))) { throw 'ARTIFACT_UNSAFE_PATH' }
                $Seen[$Name.TrimEnd('/')]=$true
                $Type=($Entry.ExternalAttributes -shr 16) -band 61440
                if ($Type -notin @(0,16384,32768)) { throw 'ARTIFACT_UNSAFE_PATH' }
                $Total += $Entry.Length
                if ($Total -gt $Bundle.expandedBytes -or $Zip.Entries.Count -gt 100000) { throw 'ARTIFACT_SIZE_MISMATCH' }
                $Target=Join-Path $Extract $Name
                if ($Name.EndsWith('/')) { [IO.Directory]::CreateDirectory($Target) | Out-Null }
                else { [IO.Directory]::CreateDirectory((Split-Path -Parent $Target)) | Out-Null; [IO.Compression.ZipFileExtensions]::ExtractToFile($Entry,$Target,$false) }
            }
        } finally { $Zip.Dispose() }
        if ((Get-FileHash -LiteralPath (Join-Path $Extract $Bundle.rootPath) -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Bundle.rootSha256) { throw 'TRUST_ROOT_INVALID' }
        $Inventory = @(Get-ChildItem -File -Force -Recurse -LiteralPath $Extract | ForEach-Object {
            @{path=$_.FullName.Substring($Extract.Length + 1).Replace('\','/'); sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
        })
        Save-Json (Join-Path $Extract '.bootstrap-inventory.json') $Inventory
        [IO.Directory]::Move($Extract,$Destination)
    }
    if ((Get-FileHash -LiteralPath (Join-Path $Destination $Bundle.rootPath) -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Bundle.rootSha256) { throw 'TRUST_ROOT_INVALID' }
    $Interpreter=Join-Path $Destination $Bundle.pythonPath
    Save-Json $Config @{schemaVersion=3; apiBaseUrl=$Recipe.apiBaseUrl; paths=$Paths; distributionOrigin=$Recipe.distributionOrigin; bootstrapRootPath=(Join-Path $Destination $Bundle.rootPath); launcherPath=$Interpreter; launcherBuild=$Recipe.launcherBuild}
    Send-SetupEvent 'succeeded' ''
    }
    Test-CachedBundle $Destination
    $Interpreter=Join-Path $Destination $Bundle.pythonPath
} catch {
    # Only codes both the importer and the backend allowlist accept are reported.
    # UNSAFE_STATE_PATH is deliberately absent from that vocabulary and stays local.
    $SafeCode = if ($_.Exception.Message -in @('INSUFFICIENT_DISK','CHECKSUM_MISMATCH','DOWNLOAD_FAILED','REPORTING_UNAVAILABLE')) { $_.Exception.Message } else { 'INSTALLATION_FAILED' }
    if ($null -ne $Identity) { try { Send-SetupEvent 'failed' $SafeCode } catch { } }
    # Do not print raw web exceptions, response bodies, credentials or local paths.
    Write-Error 'MusicMute setup stopped: INSTALLATION_FAILED. Retained setup events will retry when reporting is available.' -ErrorAction Continue
    exit 1
} finally {
    if ($Stage -and (Test-Path -LiteralPath $Stage)) { Remove-Item -LiteralPath $Stage -Recurse -Force }
    $Lock.Dispose()
}
& $Interpreter -I -B -m musicmute_worker.setup_host --action $Action --config $Config
exit $LASTEXITCODE
