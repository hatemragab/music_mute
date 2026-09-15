# W03 independent review

Date: 2026-09-14. Decision: changes requested for two reproduced P2 reporting
issues. This is a source review of current working files, including untracked
implementation, not a HEAD-only diff. No product source was changed by reviewer.

## Findings

### P2: A local clock correction before first upload leaves queued diagnostics in the future

`worker/musicmute_worker/events.py:477-478` derives each queued event timestamp
from its original wall-clock occurrence plus the offset measured at upload time.
The atomic rejection handler restores queued state but never corrects that
original occurrence. If setup records a failure while the local clock is +24h,
then the OS synchronizes its clock before first upload (including across restart),
the current offset is zero. The failure is sent 24h in the future. A proven atomic
`EVENT_CLOCK_AHEAD` rejection followed by another fresh server-clock fetch sends
the same future occurrence again. This prevents useful setup diagnostics from
reaching the backend until the original future timestamp is reached. More severe
clock errors last correspondingly longer.

Independent reproduction used actual temporary SQLite files and the existing
`test_event_spool` fixture: append `event(NOW + 86400)` with local clock
`NOW + 86400`, reopen with local clock `NOW`, reject atomically with server UTC
`NOW`, advance local/server clocks by 20 seconds, and retry another atomic future
rejection. Both submitted timestamps remained `NOW + 86400`; pending remained 1.
The checked-in fast/slow tests keep the same skew before and after restart, so
those passing tests do not cover this case.

Correct never-transmitted/proven-unpersisted future timestamps using authoritative
server time, with an explicit policy for wall-clock jumps. Preserve uncertain
payload immutability and the exact 30-day age boundary: do not refresh genuinely
aged records into eligibility through an unconditional timestamp reset/clamp.
Add a regression with clock synchronization between append
and first submission, plus atomic future rejection/retry.

### P2: Clock acquisition bypasses retry backoff and Retry-After

`worker/musicmute_worker/events.py:447-459` calls `client.server_time()` before
checking the persisted retry deadline. Any clock-request `EventRequestError`,
including HTTP 429 with Retry-After, is collapsed to REPORTING_UNAVAILABLE without
calling `_retry` or saving the supplied delay. Thus an unavailable or rate-limited
status/update-policy endpoint is requested on every scheduler invocation; even an
existing event retry deadline does not prevent the extra clock request.

Independent reproduction: a client whose `server_time()` raises
`EventRequestError('RATE_LIMITED', 429, server_time=stamp(NOW), retry_after=60)` was
passed to `upload_pending()` three times without advancing time. It made three
requests, persisted `retryAt: 0`, and replaced the meaningful rate-limit code with
REPORTING_UNAVAILABLE. W03 step 5 requires network jitter and Retry-After handling;
the prerequisite clock request is part of that reporting path.

Persist/back off clock-request failures and check the applicable retry schedule
before issuing another request, while handling local clock changes/restarts
conservatively. Add a clock-endpoint 429/network failure regression proving no
request before the deadline and a request after it.

## Independent validation

Executed from the repository root with `PYTHONPATH=worker` and
`/tmp/musicmute-w03-launcher-lock-check/bin/python`:

- `-m unittest discover -s worker/tests -p 'test_update_*.py' -q`: 25 passed.
- `-m unittest discover -s worker/tests -p 'test_event_spool.py' -q`: 12 passed.
- `-m unittest discover -s worker/tests -p 'test_launcher.py' -q`: 21 passed.
- `-m unittest discover -s worker/tests -p 'test_package.py' -q`: 1 passed.
- The two additional temporary-file reproductions described above confirmed both
  findings. They were run inline without changing checked-in tests.

The intentional duplicate ZIP fixture emitted its expected duplicate-member
warning. Read the actual trust/downloader/policy/spool code, launcher maintenance,
response types/protocol integration, package allowlist and dependency locks,
backend clock additions and focused fixtures, plus the isolated cross-language
spool integration and helper. No additional important issue was confirmed in
those reviewed paths. In particular, exact signed ReleaseTarget binding includes
releaseId, and signed bundle.json is the approved packaging convention.

Root's isolated Mongo/Redis cross-language execution is recorded separately in
W03-spool-backend-integration.md; this reviewer inspected that test but did not
operate services or independently rerun it. Root build/lint/format evidence remains
root-owned. These local fixture results do not establish native boot, GPU,
installer, real TLS/origin, production trust publication or W04 activation proof.
Those downstream boundaries are not review findings against this W03 scope.

## Fix round 1 independent re-review

Date: 2026-09-14. Decision: **both P2 findings addressed; approved for W03's
reviewed local scope**. This verdict supersedes the initial changes-requested
verdict above. Review was bounded to the held events.py correction, focused test
changes and fix-round report; no additional product source was changed.

Read the actual persisted event_clock/server_occurrence handling and the pre-GET
monotonic retry gate. The first future timestamp can now move backward to the
server clock, and an explicit atomic future rejection adjusts only previously
queued payloads. Known elapsed age is checked before correction. Uncertain
payloads do not enter that correction branch. Clock-request errors preserve typed
safe reasons and Retry-After; their schedule is persisted and checked before the
next request. No new important regression was confirmed in this bounded fix.

Independent execution with `PYTHONPATH=worker` and
`/tmp/musicmute-w03-launcher-lock-check/bin/python`:

- `-m unittest discover -s worker/tests -p 'test_event_spool.py' -q`: **18 passed**.
- Inline temporary SQLite reproduction using EventSpool directly (not the test's
  spool factory): +24h append then synchronized-clock restart sent server NOW;
  atomic future rejection at NOW-1 retried at that corrected occurrence.
- Original clock-429 reproduction made one request for three immediate calls,
  preserved RATE_LIMITED, suppressed a request after restart at 59.999 seconds
  despite a +24h wall jump, and allowed one at the exact 60-second deadline.
- Additional direct reproduction preserved the entire uncertain request across
  restart from +24h to -24h wall skew.
- Direct known-age checks dropped future-dated events at exactly 30 days and
  31 days without any transmission; they were not rejuvenated by correction.

The explicit schema-2 fail-closed handling for nonempty incompatible state keeps
old diagnostics for recovery; it introduces no compatibility migration. Reported
limits remain real: missing boot identity prevents exact historical-age/retry
inference for every reboot, and no native boot/TLS/GPU/production result follows
from these fixtures. The separately reported isolated backend rerun was not
re-executed by this reviewer. No service operation, commit or deployment occurred.
