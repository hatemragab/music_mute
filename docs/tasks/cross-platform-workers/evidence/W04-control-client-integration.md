# W04 control-client integration

Date: 2026-09-15. Current-state build and isolated integration passed after resume.
W04 coordinator implementation and independent review remain in progress.

Root owns `backend/test/worker-update-client.integration.mjs` and
`backend/test/helpers/worker-update-client.py`. The test starts isolated native
MongoDB/Redis, uses real Nest controllers/authentication and transactions, and
launches the actual Python ControlClient in separate child processes.

Covered assertions:

- A status response lost after backend acceptance can be retried from a new Python
  process with identical payload bytes and event ID. The receipt is accepted and
  the stored receipt timestamp stays unchanged.
- Reusing that event ID with a different payload returns HTTP 409 without advancing
  the stored stage.
- Consecutive preparation stages are acknowledged. A paused policy blocks
  activation, and a changed revision rejects the old activation request.
- The current revision can authorize activation. Reporting the downloaded build
  as running before the runtime report actually observes it returns HTTP 400 and
  leaves the stage at activating.
- Control traffic remains available with audio processing disabled.

On resume, the previous temporary interpreter was absent. A fresh private
CPython 3.12.13 environment was created and exactly six launcher dependencies
installed from the checked-in hash-required wheel lock:

```sh
uv venv --python 3.12 /tmp/musicmute-w04-resume-python
uv pip install --python /tmp/musicmute-w04-resume-python/bin/python --require-hashes --only-binary :all: -r worker/launcher-locks/macos-arm64-py312.txt
```

Executed from `backend` against the rebuilt current source:

```sh
npm run build
MUSICMUTE_TEST_PYTHON=/tmp/musicmute-w04-resume-python/bin/python node --test test/worker-update-client.integration.mjs
```

Both exited 0. Integration: one passed, zero failures/skips. The original test
before the pause failed specifically on the missing `post_update_status` method,
then passed after that method was added. The resumed run confirms the current
checkout still passes; it does not rely on the previous temporary environment.

Limits: release/profile and service qualifications are explicitly synthetic test
fixtures. The test injects a transport restricted to one synthetic HTTPS origin
and two paths, mapped to isolated loopback HTTP. It does not prove production TLS,
signing, native GPU/boot operation or actual coordinator journal durability. The
parent fixture supplies the same request to restarted clients; W04's own tests
must separately prove that its journal preserves and replays that request. Policy
pause/revision changes are isolated database fixture mutations, not dashboard UI
or administrator API evidence. No live service, credential or deployment was used.

## Real quota response repair

The resumed test was extended to exhaust the actual shared update read/write
budget and inspect the delay received by ControlClient. It failed: HTTP 429 was
correct, but `retry_after` was zero. WorkerUpdateController threw a plain
HttpException containing a body delay, while the client consumes Retry-After and
the global filter emits that header for the existing AuthRateLimitException.

The controller now throws AuthRateLimitException with the computed delay. This
reuses the existing error/filter mechanism and changes no quota, credential or
schema. The test now asserts the real client receives a positive delay no greater
than the 60-second window. Root also owns this bounded controller edit.

After the fix, backend build and typecheck passed. This command passed both
complete isolated integration scenarios, zero failures/skips:

```sh
MUSICMUTE_TEST_PYTHON=/tmp/musicmute-w04-resume-python/bin/python node --test --test-concurrency=1 test/worker-update-client.integration.mjs test/worker-rollouts.integration.mjs
```

Scoped oxlint passed for the controller and JavaScript fixture; Ruff F/E9 passed
for the Python helper. Prettier/Ruff formatting completed. The report remains
local integration evidence, pending W04 independent review.
