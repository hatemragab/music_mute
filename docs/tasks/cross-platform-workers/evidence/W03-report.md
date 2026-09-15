# W03 implementation report

Date: 2026-09-14. Status: implemented and focused local validation complete;
source held for independent review. This report does not mark native platform,
bootstrap publication or activation gates complete.

## Implementation and interfaces

- `worker/musicmute_worker/update/trust.py`: maintained TUF 7.0.1 `Updater` with
  explicit embedded `bootstrap` bytes on every construction, native machine-lock
  serialization, bounded refresh/metadata fetches and strict HTTPS distribution
  transport. Current metadata must bind the complete `custom.musicmuteRelease`
  descriptor, including UUID release ID, policy target hash and length.
  `resolve(decision)` returns the authenticated target; `verify_artifact(target,
  path)` requires that resolution and validates local length/SHA-256. Failed
  refresh clears earlier resolution. `extract_artifact` authenticates the ZIP,
  validates its bounded internal inventory and every member before staging.
- `worker/musicmute_worker/update/download.py`: HTTPS origin/path confinement,
  no redirects/proxy inheritance, identity encoding, bounded streaming/deadline,
  durable partial file plus ETag identity, Range/If-Range resume and whole-response
  restart when the origin replaces content. Invalid range identity is refused and
  discarded; HTTP 416 on a partial restarts once without Range. SHA-256 and exact
  length gate publication of the content-addressed cached file. ZIP central
  directory is bounded before `ZipFile` allocation, including ZIP64 bounds.
  Extraction rejects traversal, links, unsupported modes, duplicate/case-colliding
  names, ancestor conflicts, unexpected/missing members, encrypted/split archives
  and decompression overflows; it checks disk headroom and creates a new stage.
- `worker/musicmute_worker/update/policy.py`: processing-independent
  `ControlClient` for existing scoped setup/permanent bearers, bounded API JSON,
  server UTC, safe structured errors and Retry-After. `parse_decision` validates
  current wire policy, artifact/profile/approval identities and compatibility.
  `ArtifactCache` persists active/prepared/permitted-rollback asset references
  independently of event retention; missing reference state disables pruning.
- `worker/musicmute_worker/events.py`: installation-scoped SQLite durable spool,
  FULL synchronous transactions before transmission, no assignment-journal access,
  exact B03 allowlist and redaction before persistence. Queued events use fresh
  server UTC correction; accepted/uncertain payloads are immutable. Explicit
  atomic rejection alone permits initially unpersisted events to be corrected.
  Exact 30-day admission/age boundary is counted explicitly, rejected records
  remain inspectable until bounded retention, and uncertain delivery survives
  restart. First/latest unchanged progress is coalesced, batches avoid repeated
  progress identities, successful server receipts impose five-second spacing,
  mixed atomic throttle failures split terminal delivery after Retry-After.
  Terminal storage is reserved; bounded eviction/loss/coalescing counters and
  safe last error/retry deadline are exposed by `inspect()`. Database growth is
  capped at 20 MiB; SQLite rollback journaling may temporarily require additional
  filesystem space. Disk-full transactions fail without erasing prior events or
  assignment state; callers receive that storage failure for local handling.
- `worker/musicmute_worker/launcher.py`: bounded `maintenance` factory verifies
  protected installation/API binding and returns the independent services. It
  imports no numerical/GPU dependencies. Native W04 callers hold the machine lock
  for downloader/cache/upload scheduling; the verifier obtains it internally.
- `worker/musicmute_worker/runtime_types.py` and `platforms/base.py`: current
  `serverTime` response field and event client scope/clock interface. No-delivery
  local upload results may omit serverTime; actual backend success includes it.
- `worker/launcher-locks/`: exact JSON asset locks and hash-required URL
  requirements for Python 3.12/macOS arm64, Windows x64 and Linux x64, plus README.
  Each platform selects exactly six wheels, not all possible resolver hashes.
- `worker/package.py`, `worker/README.md`: explicit source-package allowlist for
  all seven lock/documentation files and maintenance integration guidance.
- `docs/tasks/cross-platform-workers/contracts.md`: authenticated native ZIP
  inventory convention, approved by root for H01 consumption.
- Focused tests: `worker/tests/test_update_trust.py`, `test_update_download.py`,
  `test_update_policy.py`, `test_event_spool.py`.

No worker.py, supervisor.py, W02 recipe/runtime inventory, backend service or real
configuration/identity/credential changes belong to this W03 implementation.
Other authors' changes were preserved. Root's separate clock response and backend
spool integration work are referenced below, not attributed to this implementer.

## Dependency evidence

Official API checked: https://theupdateframework.readthedocs.io/en/latest/api/tuf.ngclient.updater.html
Registry release inputs: https://pypi.org/pypi/tuf/7.0.1/json and each locked
package's versioned PyPI JSON metadata. Every selected platform wheel was actually
downloaded into temporary process memory and its published size/SHA-256 verified.
Exact identities/URLs are recorded in the checked-in JSON locks.

Versions: tuf 7.0.1, securesystemslib[crypto] 1.5.1, cryptography 50.0.1,
cffi 2.1.1, pycparser 3.0, urllib3 2.7.0. A fresh private macOS environment was
created with CPython 3.12.13 and installed from the exact checked-in macOS lock:

```sh
uv venv --python /tmp/musicmute-launcher-tuf-preflight/bin/python /tmp/musicmute-w03-launcher-lock-check
uv pip install --python /tmp/musicmute-w03-launcher-lock-check/bin/python --require-hashes --only-binary :all: -r worker/launcher-locks/macos-arm64-py312.txt
```

Both commands succeeded; exactly six packages installed. No system or GPU
environment was changed. Windows/Linux wheels were downloaded/hash-verified;
prior platform dependency solves are described in W03-execution-brief.md. They
are not Windows/Linux execution evidence.

## Tests and validation actually run

Initial downloader and spool tests failed on the missing modules before their
implementations existed. Later test corrections replaced blind exception checks
with explicit TUF exception families and canonicalized temporary paths; the
mixed-metadata overflow fixture correctly raises TUF DownloadLengthMismatchError.

With `PYTHONPATH=worker` and
`/tmp/musicmute-w03-launcher-lock-check/bin/python`:

- `-m unittest discover -s worker/tests -p 'test_update_*.py' -q`: **25 tests pass**.
  Covers valid resolution/artifact verification, corruption/expiry/mix-and-match,
  replay, valid/invalid key rotation, oversized metadata, forged cached trust root,
  authenticated ZIP inventory, failed-refresh invalidation, untrusted path and
  redirect handling, interrupted ETag/range resume, replacement restart,
  digest/length/encoding/overflow rejection, safe extraction/headroom, independent
  control/reporting with deliberately broken ONNX/NumPy/Torch imports, policy
  validation, protected cache references and launcher maintenance binding.
- `-m unittest discover -s worker/tests -p 'test_event_spool.py' -q`:
  **12 tests pass**. Fast/slow clocks, persisted redaction, uncertain restart,
  stable installation scope, exact 30-day boundary, first/latest progress spacing,
  atomic mixed rejection/Retry-After restart, correctable future rejection versus
  immutable uncertain retries, terminal reserved capacity, backend vocabulary
  parity, actual SQLite SQLITE_FULL transaction failure and invalid receipts.
- `-m unittest discover -s worker/tests -p 'test_launcher.py' -q`:
  **21 existing tests pass**.
- `-m unittest discover -s worker/tests -p 'test_package.py' -q`:
  **1 existing test passes**.
- `-m compileall -q worker/musicmute_worker`: pass.
- `uvx ruff check worker/musicmute_worker/update worker/musicmute_worker/events.py worker/tests/test_update_download.py worker/tests/test_update_trust.py worker/tests/test_event_spool.py worker/tests/test_update_policy.py worker/package.py`: pass.
- `uvx ruff format --check worker/musicmute_worker/update worker/musicmute_worker/events.py worker/musicmute_worker/launcher.py worker/musicmute_worker/runtime_types.py worker/musicmute_worker/platforms/base.py worker/tests/test_update_download.py worker/tests/test_update_trust.py worker/tests/test_event_spool.py worker/tests/test_update_policy.py worker/package.py`: pass, 13 files formatted.
- `git diff --check -- worker docs/tasks/cross-platform-workers/contracts.md`: pass.
- `python worker/package.py --output /tmp/MusicMuteWorker-W03-source.zip`: pass,
  source-only archive SHA-256
  `a1d71b0d6a2b39d93cc5bc3954d799ac90b3739f9ecec547f5e4acec566f7b96`.

The deliberate duplicate-ZIP fixture emits Python's expected duplicate-member
warning. A full default Ruff check including existing W01 launcher/runtime_types
also identifies their pre-existing TRY004 choices at launcher.py:76 and
runtime_types.py:172; those unrelated exception semantics were not changed.
No broad GPU/FFmpeg suite was claimed or required for these independent services.

## Root integration evidence (executed by root)

Root reported a passing actual Python spool → isolated B03 backend test using the
same exact private launcher environment. Its files are
`backend/test/worker-spool.integration.mjs` and
`backend/test/helpers/worker-spool-client.py`. Real controllers, authentication,
Mongo transactions and Redis were exercised with processing disabled: setup
failure event under +24h clock skew; dropped reply after backend acceptance;
new Python process under -24h skew, expired setup capability and current permanent
authentication; exact payload SHA retry, duplicate-only receipt and one unchanged
retained record with original receipt/expiry/redaction. A test-only injected
HTTPS-named origin routed to isolated loopback HTTP; this proves wire integration,
not TLS. Root owns its exact final command/report and backend clock changes in
`W03-clock-response.md`.

## Remaining boundaries

- H01/I01 must supply the genuine initial trusted root through the approved
  bootstrap delivery and include the exact launcher lock. No fabricated product
  root, signing key, trust bypass or raw-key enrollment flow was introduced.
- H01 emits the authenticated ZIP inventory; W04 owns idle-safe staging/activation,
  journal coordination, permitted rollback and native exclusion around mutations.
  These modules deliberately never execute downloaded worker bytes.
- Native Windows/Linux/macOS installer, GPU, boot and platform TLS/store behavior
  remain I01–I04/V01 gates. TUF/synthetic fixture success is not GPU qualification.
- There was no real daemon launch, production request, deployment, publication,
  credential operation, migration/backfill, commit or push.
- Independent review is pending; source is held for review rather than marked
  reviewed or production-ready.

## Fix round 1 — clock-jump correction and clock-request backoff

Date: 2026-09-14. The two P2 findings in W03-review.md are addressed in
`worker/musicmute_worker/events.py` and `worker/tests/test_event_spool.py` only;
this report is the sole documentation edit. Other authors' files stayed held.
Source is held again for independent re-review.

### Conservative timestamp and elapsed-age policy

The spool now persists per-event elapsed-clock observations, accumulated known
age and the first authoritative server occurrence separately from the original
wall-clock timestamp. Before first delivery, the candidate may only move
**backward** to authoritative server UTC minus available elapsed-age evidence.
After explicit atomic rejection proving the initially queued event was not
persisted, a future occurrence may move backward again to the response's server
UTC. That authoritative anchor is retained: subsequent local clock changes do not
apply the same offset correction a second time. Accepted/uncertain payload bytes
remain immutable, including across restarts and later atomic clock rejections.

Available age at append plus nonnegative elapsed-clock intervals is persisted.
Known age at or beyond exactly 30 days drops the record with EVENT_TOO_OLD before
any timestamp correction, even if its original wall timestamp is still far in
the future. Existing old wall timestamps are never advanced into eligibility.
This prevents a future-dated event held for 30/31 days from being rejuvenated.
The current spool schema is version 2 with an event_clock table; nonempty older
spools fail closed with an explicit preserve-for-recovery message. There is no
migration, backfill, compatibility adapter or automatic deletion of old state.

True historical age cannot always be recovered from an incorrect wall clock and
missing boot identity. The implementation does not claim that it can. Monotonic
readings are usable across process restart within the same OS boot; a backward
reading is treated as reset and contributes no invented negative elapsed time.
Already accumulated age is preserved. A reboot whose new monotonic reading
exceeds the old reading is not independently identified. Native boot evidence
remains a downstream gate; the available elapsed evidence is conservative and
is not advertised as exact elapsed age across every reboot.

### Durable prerequisite-request scheduling

Clock acquisition now shares the event-delivery retry policy. Both typed clock
errors (including RATE_LIMITED and Retry-After) and network/invalid clock failures
persist the safe error, exponential jitter, UTC inspection deadline and monotonic
start/delay. The monotonic schedule is checked **before** any clock request.
Forward/backward wall-clock changes cannot authorize an early request; a process
restart in the same boot observes the persisted schedule. A detectable backward
monotonic reset re-arms the full stored delay. UTC retryAt remains inspectable;
it is not used as local wall-clock authority for making requests. This reboot
handling is deliberately conservative and does not claim a stable boot identity.

### Executed red/green evidence

Before the production fix, the new regressions reproduced all three assertions:
+24h append then OS correction still sent the future timestamp; three immediate
429 clock attempts made three requests; three network failures likewise made
three clock requests. The suite exited 1 with those failures.

After the fix, with `PYTHONPATH=worker` and
`/tmp/musicmute-w03-launcher-lock-check/bin/python`:

- `-m unittest discover -s worker/tests -p 'test_event_spool.py' -q`:
  **18 tests pass**. The six new tests cover clock synchronization before first
  send and atomic future retry; clock-endpoint 429/network suppression; exact
  retry-after deadline across restart and wall jumps; detectable monotonic reset;
  persisted network jitter deadline; future timestamps with known 30/31-day age;
  and suppression of clock fetch during uncertain-event backoff. Existing
  redaction, scope, immutable retry, exact occurrence boundary, atomic mixed
  rejection, terminal capacity and actual SQLITE_FULL checks remain green.
- From `backend/`:
  `MUSICMUTE_TEST_PYTHON=/tmp/musicmute-w03-launcher-lock-check/bin/python node --test test/worker-spool.integration.mjs`:
  **1 integration test passes**, zero failures/skips. Real isolated Mongo/Redis
  and authenticated controllers accepted setup delivery, simulated a lost reply,
  then acknowledged the identical retained payload from a restarted process with
  opposite clock skew and permanent authentication. No backend source or helper
  changes were needed.
- `uvx ruff check worker/musicmute_worker/events.py worker/tests/test_event_spool.py`:
  pass.
- `uvx ruff format --check worker/musicmute_worker/events.py worker/tests/test_event_spool.py`:
  pass, both files formatted.
- `git diff --check -- worker/musicmute_worker/events.py worker/tests/test_event_spool.py docs/tasks/cross-platform-workers/evidence/W03-report.md`:
  pass.

The earlier source ZIP hash describes the pre-review snapshot; it is not claimed
as the final fix-round artifact. Native platform/boot/TLS/production limitations
remain unchanged. No production service, deployment, commit, push, migration,
credential or destructive state operation occurred.
