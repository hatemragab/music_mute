param([switch]$ReplaceExisting, [switch]$Check)
$ErrorActionPreference = 'Stop'

function Get-WorkerAccountSid {
    param([string]$UserId)
    if ($UserId -match '^S-1-') {
        return ([Security.Principal.SecurityIdentifier]::new($UserId)).Value
    }
    return ([Security.Principal.NTAccount]::new($UserId)).Translate([Security.Principal.SecurityIdentifier]).Value
}

function Get-WorkerAutostartContext {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
        throw 'Autostart setup requires Windows. No settings were changed.'
    }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $root = (Resolve-Path -LiteralPath $PSScriptRoot).Path
    foreach ($name in @('Start-Worker.ps1', 'worker.config.json', 'python.path', 'worker-secret.dpapi')) {
        if (-not (Test-Path -LiteralPath (Join-Path $root $name) -PathType Leaf)) {
            throw 'Worker setup is incomplete. Run Configure-Worker.ps1 and Start-Worker.ps1 -Check first.'
        }
    }
    $python = (Get-Content -Raw -LiteralPath (Join-Path $root 'python.path')).Trim()
    if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
        throw 'Saved Python executable was not found. Run Configure-Worker.ps1 first.'
    }
    # Validate account access without converting the worker bearer secret to text.
    $secret = $null
    try {
        $secret = (Get-Content -Raw -LiteralPath (Join-Path $root 'worker-secret.dpapi')).Trim() | ConvertTo-SecureString
        if ($secret.Length -eq 0) { throw 'Empty secret' }
    } catch {
        throw 'The configured worker secret cannot be decrypted. Use the same Windows account that ran Configure-Worker.ps1.'
    } finally {
        if ($null -ne $secret) { $secret.Dispose() }
    }
    $scriptPath = Join-Path $root 'Start-Worker.ps1'
    return [pscustomobject]@{
        User = $identity.Name
        Sid = $identity.User.Value
        Root = $root
        Script = $scriptPath
        PowerShell = (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe')
        Arguments = ('-NoProfile -ExecutionPolicy Bypass -File "' + $scriptPath + '"')
    }
}

function Assert-WorkerTaskOwnership {
    param($Task, $Context)
    try { $taskSid = Get-WorkerAccountSid $Task.Principal.UserId }
    catch { throw 'Existing task account ownership could not be verified. Inspect it in Task Scheduler.' }
    if ($taskSid -ne $Context.Sid) {
        throw 'Existing task belongs to another Windows account; refusing replacement.'
    }
    $actions = @($Task.Actions)
    if ($actions.Count -ne 1 -or
        $actions[0].Execute -notin @('powershell.exe', $Context.PowerShell) -or
        $actions[0].Arguments -cne $Context.Arguments -or
        $actions[0].WorkingDirectory -ine $Context.Root) {
        throw 'Existing task action or worker folder does not match this installation; refusing replacement.'
    }
}

function Assert-WorkerTaskSettings {
    param($Task, $Context)
    Assert-WorkerTaskOwnership $Task $Context
    $triggers = @($Task.Triggers)
    if ($Task.Principal.LogonType -ne 'Password' -or
        $Task.Principal.RunLevel -ne 'Limited' -or
        $triggers.Count -ne 1 -or
        $triggers[0].CimClass.CimClassName -ne 'MSFT_TaskBootTrigger' -or
        -not $triggers[0].Enabled) {
        throw 'Task does not have the expected boot trigger and password logon. Rerun with -ReplaceExisting after stopping the worker.'
    }
    $settings = $Task.Settings
    # The ScheduledTasks provider returns ISO 8601 durations; mocks may use TimeSpan.
    $interval = $settings.RestartInterval
    if ($interval -isnot [TimeSpan]) { $interval = [Xml.XmlConvert]::ToTimeSpan($interval) }
    $limit = $settings.ExecutionTimeLimit
    if ($limit -isnot [TimeSpan]) { $limit = [Xml.XmlConvert]::ToTimeSpan($limit) }
    if ($settings.RestartCount -ne 255 -or $interval -ne (New-TimeSpan -Minutes 1) -or
        $limit -ne [TimeSpan]::Zero -or -not $settings.StartWhenAvailable -or -not $settings.Enabled -or
        $settings.MultipleInstances -ne 'IgnoreNew' -or
        $settings.DisallowStartIfOnBatteries -or $settings.StopIfGoingOnBatteries) {
        throw 'Task availability settings differ from this installer. Inspect Task Scheduler before replacing the task.'
    }
}

function Install-WorkerAutostart {
    param([switch]$ReplaceExisting, [switch]$Check)
    if ($Check -and $ReplaceExisting) { throw 'Use -Check or -ReplaceExisting, not both.' }
    $context = Get-WorkerAutostartContext
    $taskName = 'MusicMute Windows Worker'
    $existing = @(Get-ScheduledTask -TaskPath '\' | Where-Object TaskName -EQ $taskName)
    if ($existing.Count -gt 1) { throw 'Task ownership is ambiguous; inspect Task Scheduler.' }
    if ($Check) {
        if ($existing.Count -eq 0) { throw 'Autostart task is not installed.' }
        Assert-WorkerTaskSettings $existing[0] $context
        Write-Host 'Autostart definition and local account access checks passed. Reboot/sign-out verification is still required.'
        return
    }
    if ($existing.Count -eq 1) {
        Assert-WorkerTaskOwnership $existing[0] $context
        if (-not $ReplaceExisting) {
            throw 'Task already exists. Use -Check to inspect it, or -ReplaceExisting to update this same worker/account.'
        }
        if ($existing[0].State -in @('Running', 'Queued')) {
            throw 'The existing worker task is running or queued. Finish or stop it deliberately before replacement; no worker was stopped.'
        }
    }

    $action = New-ScheduledTaskAction -Execute $context.PowerShell -Argument $context.Arguments -WorkingDirectory $context.Root
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal -UserId $context.User -LogonType Password -RunLevel Limited
    # The task XML count is an unsigned byte; the minimum restart interval is one minute.
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 255 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    $definition = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Processes MusicMute jobs at boot using the configured Windows account and Python environment.'
    $credential = Get-Credential -UserName $context.User -Message 'Enter this account''s Windows password (not a PIN) for Task Scheduler boot startup. Windows stores it securely for the task.'
    if ($null -eq $credential) { throw 'Credential entry cancelled; no task was changed.' }
    try {
        if ((Get-WorkerAccountSid $credential.UserName) -ne $context.Sid) {
            throw 'Enter credentials for the same Windows account that configured this worker.'
        }
        # A password prompt can remain open for minutes. Verify ownership and
        # activity again before updating a task that may have changed meanwhile.
        $current = @(Get-ScheduledTask -TaskPath '\' | Where-Object TaskName -EQ $taskName)
        if ($current.Count -ne $existing.Count) {
            throw 'Task ownership changed during credential entry. Inspect Task Scheduler and rerun.'
        }
        if ($current.Count -eq 1) {
            Assert-WorkerTaskOwnership $current[0] $context
            if ($current[0].State -in @('Running', 'Queued')) {
                throw 'The worker task is now running or queued. Finish or stop it deliberately before replacement.'
            }
        }
        try {
            # Password exists only in process memory for this local API call. Never
            # pass it to a child command, write it to a file, or include it in errors.
            Register-ScheduledTask -TaskName $taskName -TaskPath '\' -InputObject $definition -User $context.User -Password $credential.GetNetworkCredential().Password -Force:($existing.Count -eq 1) | Out-Null
        } catch {
            throw 'Task registration failed. Check the Windows password and Log on as a batch job policy. If access is denied, open PowerShell as administrator under this same account and rerun; setup never elevates automatically.'
        }
    } finally {
        $credential.Password.Dispose()
        $credential = $null
    }
    $installed = @(Get-ScheduledTask -TaskPath '\' | Where-Object TaskName -EQ $taskName)
    if ($installed.Count -ne 1) { throw 'Task registration could not be verified. Inspect Task Scheduler before continuing.' }
    Assert-WorkerTaskSettings $installed[0] $context
    Write-Host 'Installed for Windows boot under the configured account, without interactive sign-in.'
    Write-Host 'Definition verified. Next: Start-ScheduledTask -TaskName "MusicMute Windows Worker"'
    Write-Host 'Reboot and sign-out tests on this PC are required. Rerun with -Check for read-only setup verification.'
}

# Dot sourcing exposes the validation functions without modifying Task Scheduler.
if ($MyInvocation.InvocationName -ne '.') {
    Install-WorkerAutostart -ReplaceExisting:$ReplaceExisting -Check:$Check
}
