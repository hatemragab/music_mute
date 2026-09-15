# I02 execution handoff: Windows native host

Prepared while I01 review corrections remain active. This is not an instruction
to run a real installer, register a real task, reboot a machine or publish artifacts.
I02 remains not started. Start implementation only after the consumed I01 contract
has its scoped review checkpoint; preserve all existing shared and unrelated edits.

## Scope and existing implementation

Implement `musicmute_worker/platforms/windows.py`, native Windows helpers under
`worker/install/windows/`, and focused native/adapter tests. Wire the fixed Windows
factory into `setup_host.main`; it currently refuses every real native host.
No config-selected Python modules, shell snippets or plugin-loading escape hatch.
Do not bring back removed `windows-worker` scripts, raw keys, old configuration
decoders, registry shortcuts, migrations or legacy adapters.

Reuse `processes.SingleInstance` and the existing Windows Job Object creation and
shutdown code. `PROC_THREAD_ATTRIBUTE_JOB_LIST` puts children in kill-on-close
containment at creation. Extend a distinct host slot if needed; do not give the
long-lived worker host and its numerical engine the same named slot. `ContainedProcess`
currently sends standard streams to devnull, so authenticated bounded IPC needs an
explicit channel, not parsing raw worker logs. Existing `KeepAwake` owns/restores
the thread execution request and allows display sleep; do not rewrite power plans.

Read the original tracked `HEAD:windows-worker/Install-Autostart.ps1` only as a
reference for its task API mechanics. It creates an AtStartup password-logon,
limited-principal task with no execution limit, IgnoreNew, bounded restart and
StartWhenAvailable. It validates task ownership before replacement and obtains the
Windows password via local Get-Credential, never a PIN or command argument. Its
paths, raw configuration and invocation are obsolete and must not be restored.

## Consumed native contract

The current `SetupAdapter` has actual callers for detection, machine exclusion,
bootstrap exclusion, secret storage, directory flush, service liveness, boot task
installation/removal, service evidence, worker boundary IPC, descendant stop and
child creation. Missing capabilities must fail; a filesystem marker is not service
liveness. Machine acquisition is nonblocking so the service-start/repair race
cannot leave a CLI waiting on the service's lifetime lock.

Shared `run_worker` resolves the actual candidate after W04 recovery, polls the
native child's exit at a bounded interval and monitors mailbox/update policy.
Use fixed module/arguments to run that host from the protected installed launcher.
Do not implement a second claim loop or move assignment ownership into native code.
`read_worker_boundary` transports the existing child's `Worker.update_boundary`;
shared runtime decides when ownership/terminal/cleanup are safe, then native code
stops and verifies the entire containment. Never manufacture four true booleans.

Use a bounded, authenticated local IPC channel with the exact contained child.
Validate peer identity/process association and message schema; do not expose a
network listener, leak tokens through environment/argv, or let another same-machine
worker impersonate the child. A timeout or malformed response holds admission.

## Bootstrap integration that must be closed

The current PowerShell template has source-only Windows coverage. Execute parser
and helper tests under built-in Windows PowerShell, then actual native fixtures.
It selects immutable bundles from H01-rendered pins, stores current host config in
ProgramData/MusicMute/config, and holds state/bootstrap.lock via FileShare.None.
The Python native adapter must use the identical exclusion during event import.

Protect logical `setup-identity` and `worker-token` using DPAPI and narrowly scoped
ACLs, consistently on both sides of the pre-Python handoff. Current bootstrap
setup identity is protected by administrator/SYSTEM ACLs but still JSON on disk;
DPAPI wrapping and read-back must be implemented before Windows publication.
Choose/document DPAPI scope and entropy with the actual service principal. Do not
add a plaintext compatibility decoder. Coordinate the template and adapter as one
new-format change; no existing deployed worker schema needs migration.

The service's limited principal must actually read its private launcher, model and
DPAPI credentials. Current administrator/SYSTEM-only bootstrap directories are not
proof a limited account can do this. Verify and bind the exact principal/ACL/task
definition instead of broadening access to Everyone. Preserve unknown or differently
owned tasks. Observe real boot identity and task execution context; installing a
task or an interactive GPU run must not set unattendedRebootPassed.

Prove Windows atomic state/secret writes through the native durability boundary
consumed by W04. A flushed temporary file plus an unverified rename is not directory
crash proof. Keep configured identity/journals/events outside release replacement.
I01 native Retry-After and aggregate spool follow-up is owned separately while this
brief is prepared; consume its final reporting contract, do not duplicate it.

## Validation and limits

Add focused fault/lifecycle tests for missing DPAPI identity, changed principal,
task ownership mismatch, liveness/lock races, Job Object descendant cleanup,
malformed IPC, denied directory flush and same-machine repair. Build/factory tests
must instantiate the concrete adapter; a protocol mock alone does not close I02.

Run Windows-native helper tests, then qualification and one real separation from
the installed task while signed out and after reboot, only on an explicitly
authorized test machine. Record GPU/driver/provider/task account/boot evidence
without credentials. If native hardware or authorization is unavailable, keep
that acceptance open and continue other locally implementable tasks. No profile
becomes qualified or stable from source tests or hosted runners without its GPU.
