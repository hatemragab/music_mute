# B06 worker polling independent review

Reviewed 2026-09-14. Verdict: approved for the bounded polling-contract cleanup;
no actionable findings in this scope.

Reviewed the current `worker.py` claim path, `supervisor.py` queue loop,
`test_runtime_claims.py`, `test_loop.py`, and B06-worker-polling-followup.md.
The worker directory is currently untracked, so this is a scoped current-source
review against the documented change, not a clean Git before/after comparison.

- Qualified fresh claims send `waitSeconds` when nonzero and make exactly one
  API call. HTTP 400 propagates unchanged; no older request-contract retry or
  `long_poll_supported` state remains in the reviewed implementation.
- The supervisor retains its existing API rejection handling: nonretryable
  HTTP 400 closes the worker and returns exit code 2. Retryable failures retain
  bounded exponential delay and server retry-after handling.
- Explicit `claim_wait_seconds=0` pauses one second after idle; successful long
  polls continue immediately. One-shot runs explicitly use zero wait.
- GPU readiness validation still precedes fresh admission. Missing or failed
  qualification can discover existing ownership only through `claim/recovery`.
  Recovered ownership is journaled before runtime rejection, without acquiring
  a processing lease or downloading media, as covered by the focused tests.

Independent validation:
`PYTHONPATH=worker:worker/tests python3 -m unittest worker/tests/test_runtime_claims.py worker/tests/test_loop.py`
passed all nine tests (exit 0). No source edits or broader branch validation were
performed. No native-device, deployed-backend, GPU hardware, or production proof
is claimed. Media-policy legacy defaults and concurrent W03 work are outside this
review and remain subject to their separate reviews.
