# I01 setup integration handoff

Prepared during W03 review; I01 has not started. Read the approved I01 task,
contracts and completed W04 interfaces before implementation. No native service
operation, publication, migration or legacy adapter is authorized by this brief.

Reuse these existing boundaries:

- `hardware.detect_hardware(disk_path)` and `compatible_profiles` provide bounded
  discovery and candidate filtering. Discovery is not GPU qualification; missing
  VRAM/driver information stays unavailable, never zero or inferred success.
- `profiles.prepare_runtime(profile, lock_path, root, cache)` prepares a private
  runtime from hash-bound Python, wheels, FFmpeg and ffprobe. Supply its final
  versioned root; do not relocate the environment after preparing/inventorying it.
- `qualification.QualificationRunner.qualify` and `qualify_candidates` run actual
  profile checks. Local candidate evidence cannot manufacture a published approved
  profile. All native profile qualification gates remain open at this handoff.
- `Launcher.maintenance` provides W03 reporting/trust/cache services only after a
  valid existing installation binding. Initial unpaired setup must construct its
  scoped services from protected provisional identity without fabricating a worker
  binding to satisfy that factory. The installer must keep those lifecycles clear.
- Native adapters currently contain protocols only in `platforms/base.py`.
  I02/I03/I04 supply actual boot/service implementations; I01 tests must label
  injected adapters as fixtures and must not turn those tests into boot proof.

Persist the installation UUID and random scoped token before first registration;
send only its digest to registration. Registration/status supply authenticated
clock data for reporting. Persist the distinct permanent worker token before
pairing fixes its digest. Codes are local display only and expire after 15 minutes;
never put them in remote logs or automatically renew them indefinitely.

Use actual B02 qualification bodies (`runtime`, `qualificationReport`,
`serviceBindingSha256`), then the returned report ID for pairing. Approval alone
does not authorize processing. Finish through permanent-auth identity/readiness
and obey backend drain/revoke/build policy. Later paired repair uses permanent
`POST /worker/qualification`; it must not rebind the stable worker to a new setup
identity merely because the initial reporting capability expired.

The pre-Python shell/PowerShell reporting handoff needs shared bounded fixtures
with W03: allowlisted event fields, secret redaction before persistence, immutable
event IDs/payloads once delivery is uncertain, clock/retry behavior, retention and
explicit loss accounting. Do not upload arbitrary command stdout/stderr. Initial
script download failure before any code executes is a documented visibility limit.

Bootstrap trust provisioning is an explicit integration requirement: the native
entrypoint establishes the authenticated launcher environment and embedded root
before W03's TUF verifier can run. Do not let unsigned downloaded metadata select
its own trust root, or silently depend on preinstalled Python/pip/GPU packages.
H01/H02 publication and real native service proof remain separate gates.

## W04 concrete integration responsibility

W04 now supplies an `ActivationRuntime` protocol and a coordinator that runs inside
the launcher lifecycle lock. I01 must wire a shared concrete runtime implementation
using W02 preparation/qualification, W03 authenticated bundle extraction and the
actual control-client runtime/qualification/readiness methods. Delegate only native
service, containment and directory-flush operations to I02/I03/I04; do not duplicate
the setup/update workflow separately for each OS or leave these callbacks unused.

Construct durable update records at `paths.state / "updates"`, recover an
interrupted transaction before selecting the active child, and use the launcher's
lock-bound maintenance services inside its callback. The child factory resolves
the active pointer after recovery. Native bootstrap must consume the separate
launcher handoff/recovery record and retain the known working executable. Windows
requires its actual directory-flush implementation because the default rejects
unsupported durability there. Check W04's final reviewed report before wiring;
its local marker-file tests are not real managed-environment or service proof.

Permanent qualification currently lacks the maintenance-route marker used by
runtime/readiness/update endpoints: WorkerAuthGuard rejects it with HTTP 503 when
`AUDIO_PROCESSING_ENABLED` is false. Address this when wiring concrete maintenance
qualification, retaining permanent credential/installation checks and report
quotas. Add an actual route/guard regression; do not weaken fresh-claim gating.
W04 review records this as an I01 integration obligation, not proof that updating
an installed machine already works while processing is disabled.
