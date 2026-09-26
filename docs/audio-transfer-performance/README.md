# Audio transfer performance

## Scope and baseline

Worktree branch: `hatem/audio-transfer-performance`, based on remote `main`
`29a98542f96faded2d1903460d6979a02b297d62` (2026-09-26). Existing uncommitted
job-stage timing work in the original checkout was not copied or modified.
No CloudFront distribution is created or enabled.

Twenty retained successful worker attempts from 2026-09-25/26 showed median
input download 2.176 s, output publication 8.848 s, and completion acknowledgement
2.413 s. The samples have different file sizes and incomplete retained history;
these are not matched network benchmarks or phone transfer measurements.

The live `music-remover` bucket was reviewed on 2026-09-26: Ohio (`us-east-2`),
versioning enabled, SSE-S3 default encryption, all public access blocked,
bucket-owner-enforced ownership, acceleration disabled, no lifecycle rules and
no Intelligent-Tiering archive configurations. These settings do not establish
that S3 service latency is the bottleneck.

## Implemented changes

- Bucket preflight performs its six independent reads concurrently, with one
  30-second deadline and one shared in-flight check. It waits for all reads to
  settle, preserves operation-specific sanitized errors, fails closed, and keeps
  the existing 60-second successful-cache lifetime. No check is removed or made
  stale-on-error. An expired-cache request now waits for the slowest read rather
  than the sum of all six reads.
- Worker diagnostics preserve the existing `download`, `upload`, and
  `completionAck` measurements and add `inputGrant`, `outputGrant`, `outputPut`.
  The grant timings include control-plane retry/backoff; output PUT timing sums
  actual transfer calls, including failed PUTs before successful recovery.
  `upload` includes `outputGrant` and `outputPut`: do not add parent and child
  measurements together. `download` includes checksum and disk persistence, but
  excludes `inputGrant`. Timings are monotonic worker measurements, not client
  clocks or S3-internal latency. A recovered existing object has zero PUT time
  unless a PUT was attempted during this execution. Terminal failures do not
  currently produce the success timing summary; use failure diagnostics too.
- Backend debug logs emit `worker_transfer_timing` with a fixed operation name,
  validated attempt ID, monotonic `duration_ms`, and `success`. Operations split
  output grant total/signing (including preflight)/database transaction and
  completion total/S3 verification/database transaction. Transactions and
  authority checks are unchanged. Logging includes no URL, object key, checksum,
  credentials, input filename, or provider exception. Transaction timings include
  driver retries and commit. Total spans overlap their component spans.
- Audio presigning can opt into S3 Transfer Acceleration using
  `S3_TRANSFER_ACCELERATION_ENABLED=true`. Default is false; bucket management,
  HEAD verification, cleanup and release artifact signing stay regional.
  Opt-in preflight additionally verifies that bucket acceleration is enabled
  (requires `s3:GetAccelerateConfiguration`).
  Checksums, conditional creation, pinned versions, expiry and headers are
  unchanged. Dotted bucket names are rejected for acceleration.
- Web CSP can opt into `PUBLIC_MEDIA_ACCELERATION_ENABLED=true`. It adds only the
  same bucket's accelerated origin and retains the regional origin for existing
  grants/rollback. Default remains false. No wildcard S3/CDN origins are added.

`mw perf --last 20 --json` includes the new timing fields in `stageMs` after the
worker update; older samples continue to omit them. Server and worker diagnostic
changes do not require new public response fields or mobile releases.

## Live monitoring

Created and read back one S3 request-metrics filter on 2026-09-26:
`audio-transfers`, prefix `users/`, bucket `music-remover`. It covers audio input
and output requests, not release/model artifacts. The exact configuration is
[request-metrics.json](request-metrics.json). Standard CloudWatch metric charges
apply. This does not grant permissions, publish objects or change encryption.

Use S3 Request metrics with this filter and compare `FirstByteLatency`,
`TotalRequestLatency`, `GetRequests`, `PutRequests`, `4xxErrors`, `5xxErrors`,
`BytesUploaded` and `BytesDownloaded`. Metrics are prospective, minute-resolution
aggregates; lack of historical data immediately after creation is expected.
Do not interpret one aggregate as a per-job timing. Existing server-access
logging remains disabled.

## Preliminary live comparison

AWS's official browser speed comparison completed its Ohio test on 2026-09-26
and displayed **34% faster** for acceleration from this machine. This is a
single vendor multipart test, not a MusicMute-sized whole-object PUT comparison.
Other-region tests were stopped after recording Ohio. The bucket and application
acceleration settings remain disabled. A separate attempt to run the bounded
regional benchmark below failed before producing samples: the local AWS standard
credential chain is unavailable (`aws sts get-caller-identity` confirmed no
credentials). Browser Console login does not supply CLI credentials. No synthetic
object versions or cleanup-pending entries were reported by that attempt.

## Controlled benchmark

From `backend/`, with a scoped AWS profile via the standard credential chain:

```sh
node scripts/benchmark-audio-transfers.mjs --help
node scripts/benchmark-audio-transfers.mjs \
  --bucket music-remover --region us-east-2 --allow-writes \
  --runs 3 --sizes-mib 4,16
```

The tool generates synthetic bytes, uses signed whole-object PUT and pinned GET,
verifies checksums, and deletes only the exact versions it creates under a new
random `transfer-benchmarks/<uuid>/` prefix. It never loads application dotenv
files or reads user media, changes bucket settings, or prints signed URLs/errors.
Normal transfer/request charges apply. Maximum accepted configuration is five
runs and two sizes chosen from 1/4/16 MiB. Default regional run transfers 60 MiB
in each direction; comparison doubles this. Timings exclude URL signing but
include the HTTP transfer and response. Payloads are not compressed.

For comparison, the bucket must already have acceleration enabled; add
`--compare-acceleration`. The tool checks this before writing and alternates
endpoint order between rounds. Run from the actual worker network and the API
host separately; a CloudShell test in Ohio is not evidence about this Mac or
mobile users. Compare medians for the same size and network, repeat when load
changes, and inspect retries/errors before attributing a result to S3.

Scope benchmark credentials to bucket versioning/acceleration reads and
PutObject/GetObject/GetObjectVersion/DeleteObjectVersion for
`transfer-benchmarks/*`. Never use root credentials or expand the application's
production role just for a benchmark. A failure report's `cleanup_pending`
identifies only generated objects requiring reconciliation. If the process is
killed before it can report, the random prefix may need operator cleanup.
A missing object after a timed-out PUT is not proof no object will appear later.

## Rollout and rollback

1. Deploy the backend changes with acceleration false; inspect safe timing logs.
2. Update the worker and compare like-for-like runs. This branch has not deployed
   either component and makes no claim of a measured production speedup.
3. If acceleration is worth testing, enable the bucket feature for a controlled
   comparison first; it does not require a distribution. No such enablement was
   performed by this work. Do not change the application endpoint without a
   measured benefit that justifies the additional transfer cost.
4. For a successful acceleration trial, deploy web CSP support and enable its
   public flag first, then enable the backend flag. Native clients already use
   the supplied HTTPS grant. Keep both origins available during rollout.
5. Roll back backend flag to false first. Previously issued accelerated grants
   need time to expire before disabling the bucket feature/CSP allowance.
   The input/output grants have at most a 600-second lifetime.

Do not change region, bitrate/quality, private access, checksums, versioning,
retention, or worker concurrency as a speculative transfer optimization.

## API guidance

Reviewed the current [Zalando guidelines](https://opensource.zalando.com/restful-api-guidelines/)
on 2026-09-26. Applicable rules: 104/105 (authorization), 106/107 (compatibility),
178 (Content headers), and 118 (snake_case diagnostics). Existing grant schema,
HTTP methods and auth scopes remain unchanged; diagnostic additions remain
internal. No claim of production API compliance follows from this review.

## Validation

Completed locally:

- Backend `pnpm run verify`: formatter, lint, typecheck, secret scan, offline
  benchmark tests (7), unit tests (876), HTTP tests (147) and build. A subsequent
  `pnpm run build` also passed.
- Backend isolated `pnpm run test:integration` and
  `pnpm run test:worker:integration` passed. Fixtures do not prove real S3 speed.
- Worker protocol check, lint, typecheck, tests and build passed (391 passed,
  2 skipped); no Python engine changes or GPU benchmark were made.
  Formatting of changed files passed. Full `pnpm run format:check` flags only
  the unchanged `worker/pnpm-lock.yaml`; that unrelated file was preserved.
- Web formatting, lint, typecheck, unit tests (11), build and server tests (6)
  passed.
- Final `git diff --check` passed. No native device tests were run.
- Live `/health/live` and `/health/ready` both returned `{"status":"ok"}`
  after the metrics configuration change.

Focused tests cover
concurrent and failed preflight, endpoint/conditional-header integrity, environment
validation, backend timing redaction, retry-aware worker timing, CSP rollout,
and benchmark cleanup/error handling. No real media is required by these tests.
