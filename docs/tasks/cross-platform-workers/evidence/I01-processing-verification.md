# I01 actual update-client verification boundary

Extended `backend/test/worker-update-client.integration.mjs` to exercise the actual
Python ControlClient against the isolated compiled Nest HTTP controller and real
local MongoDB/Redis. Its existing confined HTTPS-to-loopback fixture remains in use;
this does not establish production TLS or native worker/GPU proof.

After the existing activation/runtime fence checks, the fixture observes candidate
build 101 and accepts running. It inserts isolated backend JobAttempt records for
one successful attempt before runningAt and another after runningAt. The actual
HTTP client receives 400 for the old attempt; backend state remains running. The
new attempt is accepted as verified, the first successful response is deliberately
lost, and a new Python process retries the same payload hash successfully. The
backend retains exactly the new verifiedAttemptId. Processing stays disabled
throughout; no real inference or new-job claim occurs.

Executed from backend:

```sh
npm run build
MUSICMUTE_TEST_PYTHON=/tmp/musicmute-w04-resume-python/bin/python node --test --test-concurrency=1 test/worker-update-client.integration.mjs
npx oxlint test/worker-update-client.integration.mjs
npx prettier --write test/worker-update-client.integration.mjs
```

Build, scoped lint and formatting passed. The compiled HTTP scenario passed with
zero failures/skips (5.913 seconds). Build/test output is retained under
`/tmp/musicmute-i01-verified-{build,http}.log`. This confirms backend rejection and
uncertain-retry semantics; the shared coordinator's automatic handling of those
results is separately covered by the I01 shared review/fix tests.
