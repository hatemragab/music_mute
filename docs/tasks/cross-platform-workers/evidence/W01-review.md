# W01 independent review

**Date:** 2026-09-14. **Verdict: approve the scoped shared-core extraction.**
No critical or important defect was found within the approved W01 boundary.
This is local source/test acceptance, not native installer, service containment,
GPU qualification, boot, distribution or production acceptance.

## Scope and inspection

Read W01, its execution brief/report, shared contracts, worker README/package
manifest and backend contributor instructions. Inspected the new untracked
package directly, not merely the tracked deletion diff. Compared moved queue,
transfer, engine, execution, progress and benchmark sources against HEAD.
`processes.py` and `power.py` are byte-identical to the old Windows sources;
the named mutex and Job Object implementation has not been weakened.

The extraction retains owned-attempt selectors, transfer retry budgets,
checksum checks, cancellation, execution evidence and terminal cleanup/recovery.
State schema changes reject old records instead of adopting or erasing them.
Protected installation binding and machine checks precede child startup;
configuration supplies canonical, separate roots. The launcher persists ownership
before child startup, checks nonce/installation/PID/containment before processing
authorization, and preserves ownership after an unverified stop. Successful
recovery stops prior containment before allowing a replacement child and leaves
assignment journals intact.

The sole separator now lives in the shared package. Worker one-shot, warm engine
and benchmark paths pass the explicit model cache. GPU imports remain outside
launcher/core import execution. The normal CLI deliberately fails closed until
native integration exists. Typed adapters are interfaces, not simulated claims
of native implementation.

The backend identity response queries the current worker ID and credential digest
together, accepts only enabled/draining registrations with a valid installation
UUID, and retains state and media-policy-2 semantics. Missing/revoked/invalid or
credential-mismatched registration cannot supply a successful binding. Existing
B01/B02/B04/B05 behavior was not independently re-reviewed outside this addition.

AST comparison confirmed the retired installer/configuration and legacy-adoption
checks described in the report. The protocol identity test is also renamed from
v2 to v3 while retaining its behavioral role. Meaningful shared recovery,
transfer, cancellation and execution checks survive; the nine removed installer
tests are not replaced by native boot evidence in W01.

## Validation independently performed

- `PYTHONPATH=worker python3 -m unittest discover -s worker/tests -q`: **167
  tests, OK, 14 skipped**, 38.167 seconds. Output:
  `/tmp/w01-independent-tests.log`.
- `PYTHONPATH=worker python3 -m unittest discover -s worker/tests/qualification
  -q`: **20 passed**.
- `python3 -m compileall -q worker/musicmute_worker`: passed.
- From `backend/`, `npm test -- --run src/worker/worker-identity.service.spec.ts
  src/worker/worker.controller.spec.ts src/worker/worker-registry.service.spec.ts`:
  **12 passed across three files**.
- Additional temporary synthetic checks injected failures in child `start`,
  `authorize_processing` and `wait`: each stopped containment before releasing
  ownership. Foreign installation, old schema and invalid containment ownership
  records each refused startup without changing the record or stopping arbitrary
  containment.
- Built/extracted a temporary source archive with `worker/package.py`; verified
  exactly one separator and byte equality with the shared source. From a different
  cwd, the extracted archive passed **21 launcher boundary tests and 20
  qualification tests**.

Backend compiled HTTP integration, typecheck and build were recorded by the
implementer; this reviewer did not rerun them or operate services. No real
credentials, journals, installed workers, migrations or backfills were accessed.

## Required downstream limits

Eight Windows-native and six NumPy/soundfile tests remain skipped on this host;
they do not establish native or numerical/GPU proof. POSIX process groups alone
are not crash-safe descendant ownership. I02–I04/W04 must supply real protected
stores, shared machine-lock/service containment and authorized child integration;
W02 must supply qualified provider/dependency recipes. F01 candidates remain
unavailable. Keep these gates explicit before enabling normal processing or
advertising install/boot readiness. B06 owns the broader protocol fixture rollout.

Only this review evidence file was changed by the reviewer. No commits, pushes,
deployment or unrelated Android/backend/root-document edits were made.
