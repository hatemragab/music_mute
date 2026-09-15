# I01 shared implementation review

Date: 2026-09-15. Bounded independent review of installation state, installer,
shared runtime/host/control and their launcher/worker/client seams. Native bootstrap
templates are in a separate review; no product source was edited here.

## Actionable findings

1. **P2 — recover a transient operational hold when current policy permits it.**
   `setup_host.py:292–306` handles hold/prepare but has no `action == none` recovery
   path; its exception handler persists a hold after any transient control error.
   Startup also validates readiness only when the hold was already clear
   (`setup_host.py:251`), so restarting does not recover this case. Independently
   exercised the real monitored Launcher with the existing synthetic host fixture:
   initial policy none/readiness success, one OSError from policy, then healthy
   policy none. After all three policy calls, hold remains true and readiness has
   been called only once. Healthy workers consequently stop taking work until a
   manual repair. Distinguish persistent local pause from a recoverable operational
   hold, and reacquire boundary/runtime/readiness permission before clearing the
   latter. Cover outage/recovery and restart with an existing hold.

2. **P2 — do not stop/restart an already committed target on every policy poll.**
   `setup_host.py:299–303` ignores `coordinator.prepare()`'s result, then stops the
   child and returns restart code 75 even when prepare/activate both return
   `committed` for the same revision. Backend getUpdateDecision intentionally keeps
   returning prepare at stage running until independent processing verification.
   A focused closure reproduction using fixture coordinator committed results
   observed one stop and monitor return 75 without any new activation. This causes
   needless repeated restarts/qualification, eventually also spending the bounded
   qualification budget. Restart only after an actual environment transition and
   keep the committed running candidate processing. The current source has no
   caller of `verify_processing`; account for the running-to-verified integration
   rather than assuming backend action will immediately become none.

3. **P2 — distinguish stale ownership records from a live command consumer.**
   `setup_host.py:142–150` queues maintenance solely because launcher-owner.json
   exists. Launcher deliberately retains that record after interrupted stop/crash
   so the next lock owner can reconcile it. If the service is stopped after such
   a failure, repair or uninstall therefore returns queued with nobody consuming
   the request and never enters machine-lock recovery. Use native liveness and/or
   a safe nonblocking exclusion protocol to choose between live mailbox delivery
   and stopped-host reconciliation, without treating file existence as proof of
   a running service. Test a retained ownership record with a dead service.

## Independent checks

Using `/tmp/musicmute-w04-resume-python/bin/python` with `PYTHONPATH=worker`, a
combined unittest discovery of `test_installer.py`, `test_setup_runtime.py`,
`test_setup_host.py`, `test_runtime_claims.py` and `test_launcher.py` passed:
**59 tests**, zero failures, 5.247 seconds. Separately executed the two reproductions
above; they confirm host state-machine behavior using synthetic control/runtime
boundaries, not GPU or native-service proof.

Reviewed that preparation consumes W03 verification/extraction and W02 runtime
construction, validates retained runtime/source inventories, and sends concrete
qualification/readiness bodies. Ownership fencing preserves recovery-only worker
calls; local uninstall retains identity/journals/assets. No important additional
issue established in those inspected paths during this bounded review.

## Disposition and limits

Corrections requested for the three host lifecycle findings before shared-scope
approval. Native adapters, real authenticated child IPC/containment, hardware
qualification and unattended boot are still unavailable and are not established
by these tests. CLI refusal without a statically registered native adapter is
explicit, not an assertion of working installation. No native operations, live
database, credentials, deployment, commit or publication were used.

## Shared fix round 1 re-review

The original three findings are addressed: readiness restoration now handles a
recoverable hold while respecting local pause and incomplete activation ownership;
matching committed targets do not stop/restart on every prepare decision; native
service liveness selects mailbox delivery and stopped-host recovery rechecks the
retained ownership record under machine exclusion. Added regressions cover these
cases and retain failed native stop evidence.

Independently ran combined discovery for `test_setup_host.py`,
`test_setup_runtime.py`, `test_update_activation.py`, `test_update_recovery.py`,
`test_launcher.py` and `test_runtime_claims.py`, using the exact interpreter above:
**81 passed**, zero failures, 7.740 seconds.

**New P2 in the added automatic verification path:**
`update/coordinator.py:verify_available_processing` accepts a completed-processing
hint based only on releaseId, and calls `_flush_status` before reading any new hint.
The hint persists across activation retries of the same release. Backend verification
requires the successful attempt to start after this activation's runningAt, so an
old same-release attempt is definitively rejected. The coordinator has already
persisted that attempt in pendingStatus and thereafter replays it forever. A newer
valid hint cannot replace it, and host monitor failure handling keeps claims held.

Independent real-journal Fixture reproduction: commit candidate; save an ineligible
same-release attempt hint; verification raises `No independent processing evidence`;
replace the hint with a backend-valid attempt and retry. Verification still raises
the same error and pendingStatus still names the old attempt. This reproduces the
durable blockage, using the fixture's rejection instead of actual HTTP 400.

Bind hint eligibility to the activation/revision or otherwise exclude pre-activation
work, and handle definitive verification rejection without leaving an impossible
pending transition blocking all later control. Preserve exact payload replay for
uncertain/transient responses. Add stale same-release retry plus subsequent valid
completion coverage. Backend acceptance remains the verification authority.

Disposition: original three findings closed; correction requested for the newly
introduced automatic-verification liveness issue before shared-scope approval.

## Shared fix round 2 re-review

The automatic-verification P2 is **addressed**. Processing hints now carry the
pre-processing release/revision/attempt binding, preserve that binding when the
same attempt resumes, and publish it only after acknowledged terminal cleanup.
Old-revision or unbound hints remain ineligible. Definitive 400/409/422 responses
retire only the optional verified transition and leave a bounded rejection record;
a fresh eligible hint can proceed. Network/429/5xx/authentication failures still
retain exact pending bytes, and lost successful acknowledgements remain replayable.
The backend remains the authority for actual successful processing and runningAt.

Independently ran combined discovery for `test_update_activation.py`,
`test_update_recovery.py`, `test_setup_runtime.py`, `test_setup_host.py`,
`test_worker.py`, `test_execution_worker.py` and `test_reliability.py` using the same
exact interpreter: **87 passed**, zero failures, 25.721 seconds. Inspected the
same-release old-revision guard, rejected-then-valid hint regression, retained
capture through cleanup retry, and unchanged uncertain-response replay semantics.
Root's separately executed actual HTTP 400/verified/lost-ACK evidence is documented
in I01-processing-verification.md; it was read, not rerun by this review.

No new important issue established in the bounded correction. **Approved for the
reviewed shared-source scope.** This does not complete I01: native bootstrap retry
and aggregate-cap gaps, adapter integration, Windows/native GPU and boot proof,
publication and deployment remain the explicitly separate gates.
