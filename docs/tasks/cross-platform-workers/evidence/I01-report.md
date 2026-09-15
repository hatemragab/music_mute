# I01 shared setup implementation report

Status: **shared source held for independent review**. This is local source and
isolated fixture evidence. I01 is not declared complete; unpublished bootstrap
trust, unqualified F01 profiles and actual native host/service/GPU/boot evidence
remain gates. No credentials, real databases, services or deployments were used.

## Shared implementation

- `installation_state.py` persists/read-verifies protected provisional identity
  before registration; bounded schema-3 setup history and pairing request bodies
  survive restart. A distinct permanent token is persisted before fixing its
  digest. Expired pairing requests need an explicit retry and keep the same token.
- `installer.py` uses the actual installation registration/status/qualification/
  pairing APIs. Permanent identity precedes local binding. Later repair uses
  permanent qualification/runtime/readiness without registering another session
  or consulting expired setup authentication. Rejected readiness retains a hold.
- `setup_runtime.py` is a concrete ActivationRuntime. It consumes W03 verified
  extraction, exact signed profile binding, W02 hardware filtering/preparation,
  QualificationRunner and actual setup/permanent qualification methods. It
  inventories source/runtime files, constructs private environments at permanent
  attempt paths, retains interrupted attempts, and consumes the returned report ID
  for readiness. No callback manufactures local profile approval or reboot proof.
- `setup_host.py` assembles unpaired scoped services without forging a paired
  InstallationBinding. The service path constructs W04 records at state/updates,
  recovers transactions inside the launcher lock, resolves the active child afterward,
  and supplies the actual prepared runtime, source and Config to native creation.
- `Launcher.run` has a consumed monitored service path: bounded native
  `poll_exit(5)`, scoped lock-bound callbacks, policy polling every 30 seconds,
  durable pause/repair/uninstall mailbox and safe restart after selected updates.
  Missing native polling fails before authorization. The one-shot blocking path
  remains for existing diagnostic/boundary tests, not the service host.
- Shared stopped-host maintenance calls the actual Worker's recovery-only
  identity/claim/reconcile/cleanup logic without inference. Live ownership evidence
  is the child's existing Worker.update_boundary transported through native IPC;
  native code supplies only stopping and descendant verification. A stale empty
  recovery observation is cleared before every new claim request, preventing an
  in-flight fresh claim from looking idle during a concurrent hold.
- Native bootstrap import now requires the separate native bootstrap lock inside
  machine exclusion. Missing lock support fails before import. The native writer
  must release that lock before invoking Python. Actual cross-process OS behavior
  still needs native validation.

Uninstall removes only the native boot mechanism after strict resolved ownership,
terminal, cleanup-acknowledged and descendant-stop evidence. It retains installation
identity, journals, runtime/model assets and events. Local pause persists separately
so an update policy cannot silently re-enable it.

## Validation and failure transcripts

Exact interpreter: `/tmp/musicmute-w04-resume-python/bin/python`, CPython 3.12.13.
Commands use `PYTHONPATH=worker`; no global dependencies were modified.

- Combined discovery of test_installer.py, test_setup_*.py, test_update_*.py,
  test_launcher.py, test_runtime_claims.py, test_worker.py,
  test_execution_worker.py and test_reliability.py: **141 passed in 26.087 seconds**
  in the final shared-source run. The W03 ZIP duplicate-entry warning is intentional.
- Installer tests exercise protected identity reuse/cloning refusal, token and
  operation retention after uncertain pairing, explicit expiry retry, bounded
  polling, dependency failure before pairing/service, raw-error exclusion,
  permanent repair under rejected readiness and exact control route/auth scopes.
- Dependency failure transcript: first attempt records install /
  DEPENDENCY_RECIPE_UNAVAILABLE / attempt 1; rerun records attempt 2 with the same
  installation identity, no second registration, no service call and no pairing
  request. Separate preparation tests retain the failed runtime directory and
  prepare the retry at another permanent path; no venv relocation occurs.
- Runtime fixtures exercise actual durable inventory records and changed-code
  rejection, complete qualification request bodies, permanent versus scoped routes,
  and readiness using the returned report ID while bootVerified remains false.
  Synthetic binaries, model bytes and qualification results are explicitly
  substituted; they are not native GPU/dependency installation proof.
- Real shared Launcher tests observe a policy hold and a pause mailbox receipt
  while the same synthetic child remains running under its lifetime lock.
  Callback use after return fails, and missing native polling cannot authorize it.
- Worker maintenance tests observe only identity and claim/recovery requests,
  no transfer/inference, and rejection before network use without native stop proof.
- Scoped `uvx ruff format --check`: 12 files already formatted. Scoped
  `uvx ruff check --ignore TRY004`: passed; ignored TRY004 is the existing
  launcher read_record convention. New fixture lint required no broader ignores.
- `PYTHONPATH=worker .../python -m compileall -q worker/musicmute_worker`: passed.

## Remaining integration limits

The CLI module fails explicitly until I02–I04 statically register their actual
native host. The native adapters must implement SetupAdapter/ServiceChild with
real protected storage, bootstrap/machine locks, authenticated IPC, directory
flush, stable service invocation and complete descendant containment. No dynamic
config-selected plugin import or fake native success path was introduced.

F01 profiles remain unqualified; source setup refuses an unapproved target. H01
must package the documented profile.json/runtime-lock.json/musicmute_worker layout
and provide authenticated immutable bootstrap pins/root. Native entrypoint,
renderer/importer tests and the backend maintenance-route fix are root-owned work;
their separate results must be appended rather than inferred from this report.

Mailbox records are bounded to 32 retained commands/receipts and fail visibly when
full. No automatic destructive cleanup was added. Static/source fixtures do not
prove reboot survival, platform permission prompts, physical power loss, GPU
execution, published trust or real fleet admission. No commit, push, publish,
deployment, native service operation or real data mutation occurred.

## Shared review correction round 1

All three P2 findings in I01-shared-review.md were reproduced before changing
their source paths. Four regressions initially failed: transient hold remained
set; startup with an existing hold refused authorization; a committed policy
restarted and unexpectedly consumed another policy response; stale ownership
returned a queued command instead of entering repair.

- Healthy `none` now reacquires current boundary/runtime/readiness permission
  even with an existing operational hold. A live child is first safely stopped
  and then restarted through normal startup; local pause and incomplete or
  quarantined W04 transactions cannot be bypassed by this path.
- The coordinator exposes an exact committed revision/target/pointer predicate.
  The monitor keeps that target running without preparation, stop or activation.
  Preparation outcomes that are not prepared/waiting cannot trigger a restart.
- Successful shared Worker cleanup writes a release-bound completed-attempt hint
  only after backend cleanup acknowledgement. The monitored coordinator consumes
  it through existing verify_processing; backend acceptance remains the authority.
  Wrong-release hints do not verify. Lost verification acknowledgements replay
  the identical durable pending status before policy is fetched again. This hint
  uses the existing worker atomic-file mechanism; losing it at power loss merely
  leaves the rollout running until later successful work, never grants readiness.
- Local actions query strict native service liveness instead of treating a
  retained filename as a live consumer. Stopped-host actions acquire the same
  fail-fast native lock and run the launcher's shared retained-owner recovery.
  Failed descendant verification preserves that record and prevents uninstall.
  Native acquisition must report busy if the service starts between liveness
  observation and lock acquisition; it must not wait indefinitely.

Final correction validation with the same exact CPython 3.12.13 interpreter:
**151 tests passed in 26.372 seconds**, using the combined patterns listed above.
This includes live policy/mailbox regression tests, completed-target matching,
cleanup-acknowledged processing hints, wrong-release rejection and uncertain
verification replay. Scoped Ruff checks passed with the existing launcher TRY004
ignored; formatting and compileall passed. No native service/GPU tests were run.

The native integration documentation now matches root's actual bootstrap contract:
POSIX action is positional (`sh install.sh install`); macOS uses
`lockf -s -t0 9` (BSD flock) and Linux uses `flock -n 9`; Python adapters must use
`fcntl.flock` on both. Windows retains exclusive FileShare.None handling.
Shared correction source is held again for independent re-review.

## Shared review correction round 2

Reproduced the new verification liveness defect using the actual coordinator and
durable Fixture: a definitive HTTP 409 for an old hint left pendingStatus pointing
to that attempt, and replacement with a valid completed attempt still retransmitted
the old one. Both observed submissions used the stale attempt.

The Worker now captures releaseId, policyRevision and attemptId before processing,
keeps that original capture when recovering the same attempt, and emits the captured
hint only after terminal cleanup acknowledgement. It does not assign the current
activation identity at cleanup time. Current coordinator verification requires
the exact revision and release; pre-existing unbound hints are preserved but cannot
be used as evidence. There is no schema migration or historical-record conversion.

A definitive HTTP 400/409/422 for the optional verified transition records a bounded
rejection receipt and clears that impossible pending transition while leaving the
rollout running. The rejected attempt is not resubmitted for the same revision;
a later eligible hint can verify. This retirement is limited to verified status.
Network failures, HTTP 429/5xx, authentication failures and malformed/uncertain
responses retain the identical pending payload. Lost accepted acknowledgements
remain idempotent. Backend acceptance still supplies verification authority.

Validation with the same exact interpreter: **154 tests passed in 26.097 seconds**
using the previously listed combined patterns. New checks cover same-release old
revision rejection, fresh completion after definitive rejection, capture retention
across a revision change, and exact retry bytes for 429/503/401 and lost responses.
Scoped Ruff lint, four-file format check and compileall passed. No bootstrap files,
native service, real database or deployment were touched in this correction.
Shared source is held for round-2 re-review; native Retry-After/accounting work was
paused before edits and remains a separate open task.
