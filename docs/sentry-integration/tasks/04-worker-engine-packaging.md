# SEN-04 — Python engine and native worker packages

Status: TODO. Priority: P0. Dependencies: SEN-01 and SEN-03 reporting/config contract.

## Owned implementation scope

`worker/engine/musicmute_engine/child.py`, `pipeline.py`, a proposed engine
telemetry module, Python tests; `worker/src/agent/child-process.ts`; macOS/Windows
release builders/manifests; existing isolated runtime dependency locks/builders.
Coordinate shared child-process edits with SEN-03.

## Work

1. Install a pinned Python SDK into the qualified private runtimes for MPS and
   DirectML. Preserve numerical/ONNX dependencies, interpreter constraints,
   immutable manifests, and existing model source rules.
2. Initialize in the child, disable locals and broad logging/default integrations,
   and capture unexpected ProcessingFailure causes before stack context is lost.
   Classify media validation and cancellation correctly. Use one scope per
   protocol request, cleared even when processing fails.
3. Pass only validated telemetry routing/settings through a narrow extension of
   the child environment allowlist. Never inherit arbitrary process variables or
   pass backend credentials. Keep stdout reserved for framed protocol traffic.
4. Decide correlation without widening the strict protocol unnecessarily. Reuse
   existing request IDs. If an event receipt is required, explicitly version and
   test its protocol representation; synchronize from the backend canonical file.
   Do not forward full traceback strings through the control pipe.
5. Python owns reported engine exceptions; Node captures abnormal exit/signal
   when no typed result is available. Document that SIGKILL, OOM termination and
   native library crashes may have no Python event or symbolicated native stack.
6. Fix both release builders to include the locked production Node dependency
   closure. Materialize it inside staging with no links back to a developer's
   checkout/store. Exclude dev dependencies and include required licenses.
7. Verify Python SDK imports using each packaged interpreter. Account for its
   transitive dependencies and package filters. Create hashes/manifests/signatures
   only after artifact preparation; retain update and rollback validation.

## Acceptance and tests

- [ ] Python fake-transport tests cover original cause stack, safe context, no locals,
      no stdout contamination, expected-error filtering, and bounded shutdown.
- [ ] Existing protocol and processing tests still pass; optional telemetry disabled
      preserves startup for old installations.
- [ ] An extracted package outside the repository resolves every SDK import with
      developer `NODE_PATH`, package stores and virtual environments unavailable.
- [ ] Packaged Node/Python versions report the expected shared build revision.
- [ ] Malformed telemetry settings do not corrupt runtime config or break rollback.
- [ ] Native macOS and Windows proof are recorded separately. A mocked Windows
      package test on macOS is not a Windows service or DirectML runtime validation.

Run focused child, release-builder, release-manifest, and update/rollback tests;
then `pnpm run test:engine`, `pnpm run protocol:check`, and the remaining worker
verification gate. Native service installation/update and live events belong to
the authorized SEN-09 rollout, not an incidental unit-test step.
