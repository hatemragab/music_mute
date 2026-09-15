# W02 recovery-only claim review

Date: 2026-09-14. Scope: the new recovery-only claim endpoint and Python client
interaction. Read-only source review; no implementation edits and no broad suite
rerun. This is not GPU, device, service, release, or production qualification.

## Verdict

No blocking findings in the reviewed change.

- `backend/src/worker/worker.controller.ts`: `POST claim/recovery` retains worker
  authentication, accepts only the recovery DTO, calls `claim(..., true)`, and
  returns 204 with `X-Worker-Reason: NO_OWNED_ASSIGNMENT` when ownership is absent.
  Cleanup metadata only exempts the processing-enabled gate; the guard still
  authenticates the bearer token.
- `backend/src/worker/worker-coordinator.service.ts`: recovery-only returns before
  readiness evaluation, queue selection, or new-attempt creation. Existing
  ownership must match worker, session, and live control/lease state; conflicting
  or expired ownership uses the existing recovery-required response. Both paths
  retain the registry transaction fence, including installation, lifecycle,
  credential and control-revision checks.
- `worker/musicmute_worker/worker.py`: missing or rejected runtime selects only
  `claim/recovery`, omits long-poll fields, and propagates the qualification error
  when there is no assignment. Owned recovery is journaled before `run_once`
  revalidates the runtime; failed validation occurs before lease acquisition,
  media download, and inference. Existing process-stop, reconcile, terminal
  cleanup, and journal-retention ordering remains in place.

## Validation and remaining coverage

Executed:

```sh
PYTHONPATH=worker python3 -m unittest discover -s worker/tests -p test_runtime_claims.py -v
```

Result: 3 tests passed, covering missing runtime, rejected qualification, and
owned-attempt discovery without a fresh claim.

Inspected the HTTP tests for restricted fields, 204 behavior, and authenticated
cleanup while processing is disabled. Inspected coordinator integration coverage
for zero fresh attempts, missing runtime, owned recovery, and wrong-session
conflict. Their latest execution is owned by the root task and was not rerun here.

Nonblocking coverage recommendation: add a `run_once` regression asserting that
an owned assignment recovered under rejected qualification stays journaled and
never reaches download/inference. The current ordering establishes that property
by source inspection; the three focused tests exercise `_claim` only.
