# Import reliability fixes — 2026-09-28

Deployed as backend 83, adapter 3 and web 11. See the separate
[release evidence](DIAGNOSTICS-PLATFORMS.md#verified-live-release).
The release-82 successful import does not prove universal provider reliability.

## Diagnosis

- A production acquisition failed after about seven seconds, before S3 or
  processing. Subsequent format responses were usable. Another item returned
  inconsistent/empty lists. Historical logs cannot identify the exact upstream
  HTTP/task failure.
- Another acquisition succeeded immediately before API exit code 1. BullMQ
  marked its execution stalled/failed, but Mongo stayed in progress until the
  approximately sixteen-minute recovery deadline. The deleted container's fatal
  stack is unavailable; the exact crash cause remains unknown.
- Web retained its spinner after failure and lacked several error translations.

## Implemented safeguards

- Format selection never requires ID `140`: eligible Opus/WebM, MP3 or other
  returned AAC IDs continue the same import. Missing/null bitrate or channel
  metadata no longer discards an otherwise audio-only candidate. Prefer candidates
  with complete metadata, then AAC/non-DRC/bitrate; known invalid or out-of-policy
  values still exclude a candidate. No synthetic format ID or guessed metadata.
  Actual file validation remains mandatory. Selection fallback happens before
  the single paid POST, not by resubmitting failed provider tasks.

- Every pending import checks its BullMQ state. Failed/completed executions are
  reconciled on the next maintenance pass (normally every 30s after BullMQ
  detects failure). Confirmed inputs remain submitted; unconfirmed reservations
  follow existing cancellation. Missing/unknown/active states retain the deadline
  fallback. Only unclaimed queued outbox records may be enqueued. No acquisition
  replay. Mongo changes still use the existing WebSocket snapshots, not polling.
- Failed web imports stop their spinner, explain the stable error in English and
  Arabic, and can be closed before a deliberate new submission. Ambiguous create
  responses retain their existing idempotent request identity.
- Provider GET retries have per-request and operation-wide limits documented in
  the README. No task-create retries, access bypass, video/DRM fallback, paid
  enrichment, automatic vendor failover or new dependencies.
- Backend stage events and adapter phases share an opaque execution UUID through
  `X-Import-Request-ID`. It is not an idempotency key. Numeric HTTP and allowlisted
  task status distinguish failed phases without raw bodies, signed URLs, media
  identifiers or credentials.
- `uncaughtExceptionMonitor` writes bounded code locations synchronously before
  Node's normal fatal exit. It also observes fatal unhandled rejections under the
  default Node policy. It does not swallow crashes, alter exit behavior or catch
  OOM/SIGKILL. Existing Node fatal stderr behavior remains. Infrastructure log
  retention is still required after container deletion; none is provisioned here.

## API preflight

Read the current [official Zalando guidelines](https://opensource.zalando.com/restful-api-guidelines/)
on 2026-09-28. Relevant rules: 101 (OpenAPI), 104 (security), 106 (compatibility),
149 (method properties), 176 (problem JSON), 177 (no public stack traces).
Public routes, schemas, auth, error codes and snapshots are unchanged. The
optional private correlation header is documented in the adapter OpenAPI.

## Verification and release boundary

Synthetic tests cover native-only selection, bounded GET retries, single paid
submission, access-refusal non-retry, cancellation/cleanup, stalled execution
recovery, confirmed-input preservation, fatal process exit and localized failure
UI without automatic resubmission. Local integration uses isolated Mongo/Redis.
Commands run successfully on this local checkout:

- Adapter: `python3 -m unittest -v test_service.py` — 22 tests.
- Backend: `pnpm run verify` — formatter, lint, types, secret scan, transfer
  benchmark, 962 unit tests, 148 HTTP tests and compiled build.
- Backend: `pnpm run test:imports:integration` — 8 tests, including actual
  BullMQ stalled locks and fatal subprocess exit; no acquisition replay.
- Backend: `pnpm run test:processing:integration` — 15 tests.
- Backend: `pnpm run test:integration` — Redis outage/recovery test.
- Backend: focused acquisition-client test rerun after adding the explicit
  correlation-header assertion — passed.
- Web: `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`
  (109 tests), and `npm run build` — passed. Build retains the large-chunk warning.
- Changed-file formatting and `git diff --check` — passed. No physical device,
  simulator, new live provider import, deployment, commit or push performed.

Format-fallback follow-up (same date): `python3 -B -m unittest -v test_service.py`
passed 28 tests, including absent `140`, ineligible preferred formats, missing/null
quality metadata, malformed metadata rejection and a complete synthetic Opus
acquisition with exactly one task POST. The adapter source/tests and provider docs
are the only files changed in this follow-up. This is not live-provider proof.

Release requires explicitly authorized deployment of adapter, backend and web,
then a bounded live import and correlated log collection on failure. This change
does not establish a fix for the historical exit cause or guaranteed provider
availability.
