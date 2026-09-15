# W01 shared core and state extraction report

**Date:** 2026-09-14. **Status:** implementation and local checks complete; awaiting independent review. Native Windows/GPU/service/boot acceptance is not claimed.

## Implementation

Moved the 12 modules from `windows-worker/musicmute_worker/` into the single
`worker/musicmute_worker/` package: `__init__`, `__main__`, `benchmark`, `config`,
`engine`, `execution`, `media_limits`, `power`, `processes`, `progress`,
`transport`, and `worker`. The Windows `processes.py` and `power.py` contents are
byte-identical to their pre-move sources; named mutex/Job Object identities and
native containment/termination behavior are preserved. POSIX groups remain a
development/runtime mechanism, never proof of crash-safe descendant ownership.

Moved 18 test/support files to `worker/tests/`: `process_test_support.py` and
`test_account_cleanup`, `test_benchmark`, `test_engine`, `test_execution`,
`test_execution_worker`, `test_loop`, `test_media_limits`, `test_package`,
`test_power`, `test_processes`, `test_progress`, `test_progress_v2`,
`test_reliability`, `test_separator`, `test_transport`, `test_warm_worker`,
`test_worker`. New `test_launcher.py` and `worker_test_support.py` supply explicit
synthetic installation bindings and boundary regressions. F01 qualification
sources, tests and protocol fixture were not overwritten.

Moved `backend/separate.py` to `worker/musicmute_worker/separation.py`; no old-path
shim or second engine remains. Shared engine, one-shot worker and benchmark
invocations supply the explicit absolute model-cache directory. The separator
still uses the existing DirectML/Kim Vocal 2 implementation; W02 owns real
provider selection and qualified dependency recipes.

Added `runtime_types.py`, `platforms/base.py`, `launcher.py`, `supervisor.py` and
`pyproject.toml`. Typed protocols cover PlatformAdapter, EventSpool,
QualificationRunner, ReleaseVerifier, UpdateCoordinator and their wire structures.
They are integration interfaces, not implementations returning success. The
launcher imports only stdlib/shared stdlib modules; no GPU packages enter this
boundary. The shared queue loop remains callable by the authorized native child.

Configuration requires schema 3, approved worker/installation IDs, and seven
explicit absolute non-overlapping roots: identity, config, state, releases,
models, journals and events. Separator location is constrained to releases.
There is no default worker ID, cwd-derived state, legacy identity adoption or
idle rebinding adapter. Native protected binding bytes must match the persisted
identity and detected machine digest. Same-machine repair reuses that binding;
cloned files fail before child startup. Existing local installation, assignment,
session, execution, processing and cleanup schemas are rejected without conversion
or erasure. Media policy version 2 and separator execution/IPC versions remain
separate contracts and are not treated as old worker identity protocols.

Launcher ownership spans the native machine lock, persisted containment intent,
nonce/installation/PID/containment handshake, child processing authorization and
verified descendant stop. Failed stop retains the ownership record; a later
start must recover it before starting a new child. Assignment journals are not
deleted by launcher recovery. Installer repair and updater must use the same
native adapter lock. The tests use synthetic namespaces/adapters; they are not
native Linux/macOS service safety evidence.

The CLI requires an absolute config path and can validate its schema. Normal CLI
processing fails closed until a native adapter/child integration is supplied.
Native installers and signed distribution remain under development, as stated in
the new worker README and root/contributor links. No live one-command install URL
or qualified GPU recipe is advertised.

Moved `windows-worker/package.py` to `worker/package.py`. It creates a source-only
`worker/` archive including the single separator, nested platform modules,
contracts, qualification sources and tests, excluding installation state/secrets.
Removed obsolete Windows handoff scripts (`Configure-Worker.ps1`,
`Start-Worker.ps1`, `Install-Autostart.ps1`, `Benchmark-Worker.ps1`), the old example
config/README and `test_autostart.py`. No legacy installer import was introduced.

## Minimal backend identity integration

The previous protocol-3 identity response omitted installationId. W01 adds a
narrow `WorkerRegistryService.describeInstallation` query using the authenticated
worker ID **and current credential digest**, requiring enabled/draining state and
a valid installation UUID. Missing, revoked, incompatible or mismatched bindings
fail authentication; no fallback is decoded. `WorkerIdentityService` returns that
binding with protocol 3 and media policy 2. Focused controller/service and compiled
HTTP tests cover the response. Other pre-existing B01/B02/B04/B05 edits in these
files are outside W01 ownership.

## Validation actually run

- `PYTHONPATH=worker python3 -m unittest discover -s worker/tests -v`:
  **167 tests, OK, 14 skipped**, 37.893 seconds on this macOS host. Output was
  captured at `/tmp/musicmute-w01-tests.log`. Final count: original 161 minus
  15 retired tests plus 21 new boundary tests = 167.
- `PYTHONPATH=worker python3 -m unittest discover -s worker/tests/qualification -q`:
  **20 passed**. This separate directory is not recursively discovered by the
  required root suite because it has no test-package initializer.
- `python3 -m compileall -q worker/musicmute_worker`: passed from repository root.
- Existing cached Ruff 0.16.6: `format --check` passed for 20 changed Python files;
  `check --select F,E9 worker/musicmute_worker worker/tests/test_launcher.py
  worker/tests/worker_test_support.py worker/package.py` passed. Formatter diffs
  were applied with apply_patch; no global packages were installed.
- A temporary source archive was built and extracted. Its separator bytes equal
  the sole shared source; exactly one separator is present. From a different cwd,
  the extracted archive passed **21 boundary tests and 20 qualification tests**.
- `git diff --check`: passed. Scoped reference scan found no active old worker
  source/packager/installer paths in root/contributor docs, shared package or
  backend executable scope. Historical task/evidence records remain historical.
- Backend: `npm run typecheck`, 12 focused Vitest tests across identity,
  controller and registry files, `npm run build`, and
  `node --test test/worker-runtime.integration.mjs` (**1 passed**) succeeded.
  Scoped Prettier checks passed. The integration helper used isolated temporary
  MongoDB/Redis services. An initial new assertion expected HTTP 201; it was
  corrected to the existing explicit HTTP 200 contract and rerun successfully.

Skipped categories: **8 Windows-native tests** (Job Object crash containment,
handle lifecycle, stop snapshots/termination handles and cross-folder mutex) and
**6 NumPy/soundfile tests** (sample parity/local separator integration). FFmpeg
and POSIX exit-race checks ran on this host. Nine prior PowerShell skips disappear
because their obsolete installer was removed, not because native proof improved.

## Retired checks and replacements

Nine obsolete `AutostartTests` checks were removed with their installer:
`test_boot_task_policy_and_read_only_check`,
`test_existing_task_requires_explicit_replacement`,
`test_replacement_refuses_other_account_folder_or_action`,
`test_replacement_refuses_running_or_queued_worker`,
`test_old_sign_in_task_can_only_be_explicitly_migrated`,
`test_wrong_credential_account_is_refused`,
`test_missing_task_check_never_installs`,
`test_rechecks_task_after_password_prompt_before_replacing`,
`test_readback_accepts_provider_duration_format_and_detects_disabled_task`.
Their native installer/credential/service read-back replacements belong to
I02–I04; W01 makes no claim to have replaced native boot evidence with mocks.

Three old `ConfigurationLockTests` were removed:
`test_setup_refuses_configuration_write_while_worker_lock_is_held`,
`test_setup_persists_a_normal_first_machine_configuration`,
`test_setup_creates_state_directory_with_a_mutex_only_windows_lock`.
Three old installation tests were replaced:
`test_legacy_session_and_journal_are_bound_without_being_rewritten`,
`test_active_journal_identity_change_fails_without_mutating_state`,
`test_legacy_active_journal_without_binding_rejects_non_z440_transition`.
New boundary tests assert machine exclusion/repair, exact identity reuse, clone
and missing-binding rejection, unchanged active journals on identity changes,
old-schema rejection, cwd-independent restart, child handshake/failure recovery,
strict protocol identity, explicit model cache and GPU-free imports.

## Downstream handoffs and limits

- **W02:** consume these paths and interfaces, replace the preserved DirectML
  runtime with explicit qualified provider/profile recipes, and validate model
  hashes/media evidence. F01's 12 candidates remain unavailable. Resolve the
  documented Python 3.11/NumPy 2.5.3 conflict and absent platform wheels; no GPU
  recipe or dependency installability was proven here.
- **W03:** implement EventSpool/ReleaseVerifier with signed download validation,
  bounded durable event delivery and release/model state roots.
- **W04:** implement UpdateCoordinator/native child lifecycle using the same
  machine lock, handshake and verified stop contract; enforce policy, signed
  source transitions and actual local state-read bounds before activation or
  rollback. No release activation implementation is claimed by W01.
- **B06:** shared worker requires protocol 3 plus exact installationId before
  claim; consume the fixed backend identity response. Preserve owned-attempt
  selectors, media policy 2, retries/checksums/cancellation and terminal recovery.
- **I01–I04:** provide native secure storage, service identity/containment/lock
  implementations and service/boot proof. Paired identity/permanent credentials
  survive setup-token expiry; later qualification uses B02's permanent route.
  No Windows/macOS/Linux service or GPU boot proof is available from this host.

No commits, pushes, deployment, live worker operations, installed services,
real credentials, real journals, migrations, backfills or legacy imports were
performed. Unrelated Android/backend changes were preserved.
