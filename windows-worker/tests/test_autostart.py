import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

POWERSHELL = (
    os.environ.get("MUSICMUTE_TEST_POWERSHELL")
    or shutil.which("pwsh")
    or shutil.which("powershell.exe")
)
INSTALLER = Path(__file__).resolve().parents[1] / "Install-Autostart.ps1"


@unittest.skipUnless(POWERSHELL, "PowerShell runtime is required for installer mocks")
class AutostartTests(unittest.TestCase):
    def run_scenario(self, scenario):
        source = INSTALLER.read_text()
        self.assertIn(
            "function Install-WorkerAutostart",
            source,
            "Installer has no safely testable registration entry point",
        )
        # Every OS-facing function is replaced before invoking the installer.
        # Dot sourcing must define functions only; it must never install a task.
        harness = r"""
$ErrorActionPreference = 'Stop'
. '__INSTALLER__'
$script:task = $null
$script:registrations = 0
$script:credentialPrompts = 0
$script:context = [pscustomobject]@{
    User = 'Z440\worker'; Sid = 'S-1-5-21-123-1001'; Root = 'C:\Worker'
    Script = 'C:\Worker\Start-Worker.ps1'
    PowerShell = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
    Arguments = '-NoProfile -ExecutionPolicy Bypass -File "C:\Worker\Start-Worker.ps1"'
}
function Get-WorkerAutostartContext { return $script:context }
function Get-WorkerAccountSid($UserId) {
    if ($UserId -in @('Z440\worker', 'S-1-5-21-123-1001')) { return 'S-1-5-21-123-1001' }
    return 'S-1-5-21-123-1002'
}
function Get-ScheduledTask { param($TaskPath) return $script:task }
function New-ScheduledTaskAction {
    param($Execute, $Argument, $WorkingDirectory)
    [pscustomobject]@{ Execute=$Execute; Arguments=$Argument; WorkingDirectory=$WorkingDirectory }
}
function New-ScheduledTaskTrigger {
    param([switch]$AtStartup)
    if (-not $AtStartup) { throw 'Expected boot trigger' }
    [pscustomobject]@{ CimClass=[pscustomobject]@{CimClassName='MSFT_TaskBootTrigger'}; Enabled=$true }
}
function New-ScheduledTaskPrincipal {
    param($UserId, $LogonType, $RunLevel)
    [pscustomobject]@{ UserId=$UserId; LogonType=$LogonType; RunLevel=$RunLevel }
}
function New-ScheduledTaskSettingsSet {
    param($MultipleInstances, $RestartCount, $RestartInterval, $ExecutionTimeLimit,
          [switch]$StartWhenAvailable, [switch]$AllowStartIfOnBatteries,
          [switch]$DontStopIfGoingOnBatteries)
    [pscustomobject]@{
        Enabled=$true; MultipleInstances=$MultipleInstances; RestartCount=$RestartCount
        RestartInterval=$RestartInterval; ExecutionTimeLimit=$ExecutionTimeLimit
        StartWhenAvailable=[bool]$StartWhenAvailable
        DisallowStartIfOnBatteries=(-not $AllowStartIfOnBatteries)
        StopIfGoingOnBatteries=(-not $DontStopIfGoingOnBatteries)
    }
}
function New-ScheduledTask {
    param($Action, $Trigger, $Principal, $Settings, $Description)
    [pscustomobject]@{ TaskName='MusicMute Windows Worker'; Actions=@($Action)
        Triggers=@($Trigger); Principal=$Principal; Settings=$Settings; State='Ready' }
}
function Get-Credential {
    param($UserName, $Message)
    $script:credentialPrompts++
    [pscredential]::new($UserName, (ConvertTo-SecureString 'synthetic-test-password' -AsPlainText -Force))
}
function Register-ScheduledTask {
    param($TaskName, $TaskPath, $InputObject, $User, $Password, [switch]$Force)
    if ($TaskPath -ne '\' -or $User -ne $script:context.User -or $Password -ne 'synthetic-test-password') {
        throw 'Incorrect registration inputs'
    }
    $script:registrations++
    $script:task = $InputObject
}
function Expect-Failure($Action, $Message) {
    $caught = $false
    try { & $Action } catch {
        $caught = $true
        if ($_.Exception.Message -notmatch $Message) { throw "Unexpected error: $($_.Exception.Message)" }
    }
    if (-not $caught) { throw 'Expected an installation refusal' }
}
__SCENARIO__
"""
        harness = harness.replace("__INSTALLER__", str(INSTALLER).replace("'", "''"))
        harness = harness.replace("__SCENARIO__", scenario)
        with tempfile.TemporaryDirectory(
            prefix="musicmute-autostart-test-"
        ) as directory:
            path = Path(directory) / "test.ps1"
            path.write_text(harness)
            result = subprocess.run(
                [
                    POWERSHELL,
                    "-NoLogo",
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    str(path),
                ],
                capture_output=True,
                text=True,
                timeout=30,
                check=False,
            )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_boot_task_policy_and_read_only_check(self):
        self.run_scenario(r"""
Install-WorkerAutostart
Install-WorkerAutostart -Check
if ($script:registrations -ne 1 -or $script:credentialPrompts -ne 1) { throw 'Check changed registration' }
if ($script:task.Principal.LogonType -ne 'Password') { throw 'Interactive logon required' }
if ($script:task.Principal.RunLevel -ne 'Limited') { throw 'Worker was elevated' }
if ($script:task.Settings.RestartCount -ne 255 -or $script:task.Settings.RestartInterval.TotalMinutes -ne 1) { throw 'Unsupported restart policy' }
if ($script:task.Settings.ExecutionTimeLimit -ne [TimeSpan]::Zero) { throw 'Worker lifetime is capped' }
if (-not $script:task.Settings.StartWhenAvailable) { throw 'Missed boot is not recovered' }
if ($script:task.Settings.MultipleInstances -ne 'IgnoreNew') { throw 'Overlapping workers allowed' }
""")

    def test_existing_task_requires_explicit_replacement(self):
        self.run_scenario(r"""
Install-WorkerAutostart
Expect-Failure { Install-WorkerAutostart } 'ReplaceExisting'
if ($script:registrations -ne 1 -or $script:credentialPrompts -ne 1) { throw 'Refusal changed credentials/task' }
Install-WorkerAutostart -ReplaceExisting
if ($script:registrations -ne 2) { throw 'Owned stopped task was not updated' }
""")

    def test_replacement_refuses_other_account_folder_or_action(self):
        for mutation in (
            r"$script:task.Principal.UserId = 'Z440\other'",
            r"$script:task.Actions[0].WorkingDirectory = 'C:\OtherWorker'",
            "$script:task.Actions[0].Arguments += ' -Once'",
            "$script:task.Actions[0].Execute = 'other.exe'",
            "$script:task.Actions += $script:task.Actions[0]",
        ):
            with self.subTest(mutation=mutation):
                self.run_scenario(
                    "Install-WorkerAutostart\n"
                    + mutation
                    + r"""
Expect-Failure { Install-WorkerAutostart -ReplaceExisting } 'ownership|folder|action|account'
if ($script:registrations -ne 1 -or $script:credentialPrompts -ne 1) { throw 'Unrelated task was changed' }
"""
                )

    def test_replacement_refuses_running_or_queued_worker(self):
        for state in ("Running", "Queued"):
            with self.subTest(state=state):
                self.run_scenario(
                    "Install-WorkerAutostart\n$script:task.State = '"
                    + state
                    + "'\n"
                    + r"""
Expect-Failure { Install-WorkerAutostart -ReplaceExisting } 'running|queued'
if ($script:registrations -ne 1 -or $script:credentialPrompts -ne 1) { throw 'Active worker was changed' }
"""
                )

    def test_old_sign_in_task_can_only_be_explicitly_migrated(self):
        self.run_scenario(r"""
Install-WorkerAutostart
$script:task.Principal.LogonType = 'Interactive'
$script:task.Triggers[0].CimClass.CimClassName = 'MSFT_TaskLogonTrigger'
$script:task.Actions[0].Execute = 'powershell.exe'
Expect-Failure { Install-WorkerAutostart -Check } 'boot|password'
Install-WorkerAutostart -ReplaceExisting
Install-WorkerAutostart -Check
""")

    def test_wrong_credential_account_is_refused(self):
        self.run_scenario(r"""
function Get-Credential {
    param($UserName, $Message)
    [pscredential]::new('Z440\other', (ConvertTo-SecureString 'synthetic' -AsPlainText -Force))
}
Expect-Failure { Install-WorkerAutostart } 'same.*account'
if ($script:registrations -ne 0) { throw 'Another account was registered' }
""")

    def test_missing_task_check_never_installs(self):
        self.run_scenario(r"""
Expect-Failure { Install-WorkerAutostart -Check } 'not installed'
if ($script:registrations -ne 0 -or $script:credentialPrompts -ne 0) { throw 'Check installed a task' }
""")

    def test_rechecks_task_after_password_prompt_before_replacing(self):
        self.run_scenario(r"""
Install-WorkerAutostart
function Get-Credential {
    param($UserName, $Message)
    $script:task.State = 'Running'
    [pscredential]::new($UserName, (ConvertTo-SecureString 'synthetic-test-password' -AsPlainText -Force))
}
Expect-Failure { Install-WorkerAutostart -ReplaceExisting } 'running|queued'
if ($script:registrations -ne 1) { throw 'Worker became active while prompting and was replaced' }
""")

    def test_readback_accepts_provider_duration_format_and_detects_disabled_task(self):
        self.run_scenario(r"""
Install-WorkerAutostart
$script:task.Settings.RestartInterval = 'PT1M'
$script:task.Settings.ExecutionTimeLimit = 'PT0S'
Install-WorkerAutostart -Check
$script:task.Settings | Add-Member -NotePropertyName Enabled -NotePropertyValue $false -Force
Expect-Failure { Install-WorkerAutostart -Check } 'availability'
""")


if __name__ == "__main__":
    unittest.main()
