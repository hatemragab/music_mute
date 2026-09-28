# Transfer crash and status window — 2026-09-28

Backend **84** and adapter **5** deployed and verified below. Web remains 11.

## Evidence and cause

Live API 83 exited with code 1 on two transfers around 10:33 and 10:42 UTC.
The adapter 4 reported successful delivery of 3,597,607-byte WebM audio for
correlations `f3460129-0063-4be2-bc83-0d64f4e3edbc` and
`f46aa27b-5361-4dc3-b58d-7380562bd209`. Backend fatal diagnostics recorded
`AssertionError: assert(!this.paused)` in Undici `Parser.finish`, called on
socket end. This matches https://github.com/nodejs/undici/issues/5360.
A local Node 24.18.0 / bundled Undici 7.28.0 subprocess reproduced the exact
uncatchable assertion with synthetic 64 KiB and connection close. No provider
request was needed. It is not evidence of YouTube blocking.

A separate request `40a6f785-b841-43e0-9ddc-152ae9e73480` failed after the old
four unknown-state rechecks. The provider's exact state remains unrecorded;
do not claim it was pending or failed. It is inconclusive.

## Changes

- ImportFiles now uses Node native HTTP/HTTPS streams instead of fetch/Undici.
  Keeps cancellation/deadlines, SHA256, byte limits, exclusive scratch creation,
  sanitized metadata/error handling, TLS verification, and finally cleanup.
  Requires HTTP 200 and complete Content-Length when present. No redirect,
  credential redirect forwarding, pooling, or POST retry. Response/request
  streams are destroyed on every exit. No global exception swallowing.
- Unknown provider states have their own 60-second/30-recheck budget from the
  first unknown observation. HTTP-transient retries remain separately bounded
  to four per operation. Terminal failure still stops immediately; only explicit
  completed allows delivery. No new task is submitted during any status retry.
- No new dependency, endpoint, migration, metadata lookup or user-data rewrite.

API review: https://opensource.zalando.com/restful-api-guidelines/ read on
2026-09-28; existing problem JSON and no-sensitive-stack response behavior
(176/177) retained. Single paid submission remains mandatory.

## Focused validation

- 39 Python adapter tests passed: eight unknown states then completion, fixed
  read-count limit, elapsed-time limit, cancellation, terminal failures, no
  paid format fallback and no repeated download POST.
- 14 ImportFiles tests passed: twelve consecutive closing 3.6 MB transfers,
  exact bytes/hash, no fetch usage, truncated body, cancellation, limits,
  metadata and scratch cleanup. Initial large-buffer deep equality exceeded
  the test timeout; replaced with Buffer.equals, retaining full byte comparison.
- Upstream crash reproduced separately; never in the production API process.
- Full backend verify passed: formatting, lint, types, secret scan, build,
  965 unit tests and 148 HTTP tests. Import integration passed 8 tests;
  processing integration passed 15 tests. Commands ran sequentially for builds.
- `node video_providers/videoscale/verify-transfer.mjs backend` passed locally:
  twelve successful transfers and one deliberately truncated response, exactly
  thirteen requests, zero leftover scratch. No SaaS/S3/database request.

## Release archives

- `videoscale-status-window-2026-09-28.tar` SHA256
  `9ba2097b7ce34743eb02c6e754928d80a2a1987d42f12b4e55b4673ff18a20f8`
- `backend-transfer-crash-2026-09-28.tar` SHA256
  `ed65dba7b728dc727ddffd0975160728bc0916babccd99319c523665465099d8`
- Adapter service.py SHA256
  `081f108e09134ddc48e4913236424a2e7ad02cfeec1ce29a45028608f4b6a2b0`

CLI used explicit connection musicmute and explicit app names. Production
MongoDB read-only admission check found zero active imports before backend
deployment. No user records, credentials or provider metadata policy changed.

## Live verification

- API container `40b973837038`, image `img-captain-api:84`, running after
  deployment; previous API 83 shut down for this release. Public readiness 200.
- Adapter `7d5f0820ed5b`, image 5, healthy. Live service.py hash matches above;
  root filesystem remains read-only and published ports remain empty.
- Ran verify-transfer.mjs inside the deployed API with Node 24.21.0:
  12 successful 3,597,607-byte synthetic loopback transfers with exact SHA256,
  one truncated body rejected, 13 requests total, zero scratch entries.
  The script removed only its own mkdtemp directory. No new fatal assertion
  or import-failure appeared in the new container during this check.
- No paid acquisition, user import replay, or full mobile/S3/worker E2E was
  performed. These checks prove deployed transport behavior, not universal
  upstream availability or successful completion of every future import.
