# I01 permanent qualification during maintenance

The compiled HTTP integration reproduced HTTP 503 when a permanently paired
worker submitted its qualification report while `AUDIO_PROCESSING_ENABLED=false`.
That prevented repair/update preparation even though qualification does not grant
fresh-job admission.

`PermanentWorkerQualificationController` now uses the existing `WorkerCleanup`
classification. Permanent worker authentication, installation binding, validation
and report quotas remain enforced. No route, schema, migration or legacy adapter
was introduced.

The existing isolated installation integration disables processing around a real
paired fixture and verifies permanent qualification succeeds, an expired setup
credential is rejected, a wrong installation is rejected, a fresh claim still
returns 503, and no WorkerRuntime/readiness record is created by qualification.
Processing is restored in a finally block before the remaining lifecycle checks.

Actual red: expected 201, received 503 before the controller correction. Actual
green: `node --test --test-concurrency=1 test/worker-installations.integration.mjs`
passed one compiled HTTP scenario with zero failures/skips (5.738 seconds). Backend
build/typecheck and scoped Oxlint passed; Prettier completed. Logs were retained
locally under `/tmp/musicmute-i01-qualification-{red,build,green}.log`.

This is isolated backend proof, not a deployed maintenance test.
