# W04 independent source review

Date: 2026-09-15. Reviewed current held source, including untracked fleet files,
against W04, its execution brief, contracts and approved design. No product files,
native services, real databases or credentials were changed or accessed.

## Finding requiring correction

**P2 — preserve the verified target across native preparation.**
`worker/musicmute_worker/update/coordinator.py:217` passes the journal's target
dictionary directly to `runtime.prepare`. A callback that normalizes or modifies
that argument modifies the authoritative signed descriptor before the comparison
at lines 219–223. That comparison then compares against the modified object and
can accept it. Independent reproduction using the existing real-file Fixture:
start with a verified target having `compatibleSources=[]`; wrap runtime.prepare
to append an old-runtime `rollbackAllowed: true` entry to its argument, then call
the original prepare. `coordinator.prepare()` returns `prepared`, and the durable
activation target contains the added entry, although the policy/verifier target
still has an empty list. Subsequent policy checks fail, leaving a poisoned update
transaction. This demonstrates integrity loss and an update blocker, not a proven
unauthorized activation. Pass a deep copy into preparation, compare the returned
environment against the untouched verified target, and test mutation rejection.

## Independent validation

Using `/tmp/musicmute-w04-resume-python/bin/python` with `PYTHONPATH=worker`:

- `-m unittest discover -s worker/tests -p 'test_update_*.py'`: 47 passed.
- `-m unittest discover -s worker/tests -p 'test_launcher.py'`: 23 passed.
- `-m unittest discover -s worker/tests -p 'test_runtime_claims.py'`: 7 passed.
- Separate temporary-file reproduction above completed and demonstrated mutation.

Inspected the fault-injection assertions as well as running them. They verify
actual durable files, active environment markers, observed builds, held claims,
duplicate recovery and exact lost-response status payloads. Four-part strict
boundary evidence, post-validation policy refresh, old environment restoration,
readiness before hold release and launcher executable retention are exercised.
These tests use synthetic runtime callbacks; they do not prove real containment,
qualification, physical power-loss persistence or unattended boot.

## Integration boundaries

The protocol and lock-bound lifecycle callback are executable shared-core seams;
there is no concrete product `ActivationRuntime` or coordinator scheduler yet.
The explicit I01 handoff must implement these before claiming end-to-end updates.
`post_qualification` is defined in ControlClient but is not called by the current
coordinator. Qualification storage/readiness assembly currently remain callback
responsibilities, so the new I01 integration obligation is material.

`PermanentWorkerQualificationController.report` at
`backend/src/worker-installations/worker-installations.controller.ts:168` lacks
`WorkerCleanup`. `WorkerAuthGuard` rejects that route with 503 while processing is
disabled, unlike update-policy/status/runtime/readiness maintenance routes.
Treat this as a required downstream maintenance integration fix when I01 wires
qualification; the existing two-path control-client wire test does not exercise
it and must not be described as proving every control route during that state.

The Retry-After exception change and confined helper are consistent with the
existing control transport contract; root's separately executed backend checks
remain the source of integration execution evidence. Native adapters/GPU/boot,
real environment construction and stable bootstrap consumption remain downstream
gates, not requirements for the pure-core fixture run above.

Disposition: correction requested for the target-mutation finding; no other
important actionable core issue established in this bounded review.

## Fix round 1 independent re-review

The original P2 is **addressed**. Preparation now receives a deep copy of the
verified target, the returned environment is detached from native callback
ownership, and identity comparison uses the untouched journal target. Both
rollback/recovery reconciliation callbacks also receive detached candidate
descriptors. The new mutation regression verifies rejection plus unchanged
durable target, policy target, backend fixture policy, old active pointer and
preparing phase. The reconciliation regression verifies rollback cannot corrupt
the persisted candidate identity.

Independently reran with the same exact interpreter and `PYTHONPATH=worker`:
`-m unittest discover -s worker/tests -p 'test_update_activation.py'` (14 passed)
and `-m unittest discover -s worker/tests -p 'test_update_recovery.py'` (10 passed).
Inspected the correction and assertions; no new important issue found in this
fix scope. **Approved for the bounded W04 shared-core scope**, subject to the
unchanged downstream integration and native-proof limitations above.
