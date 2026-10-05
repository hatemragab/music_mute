# Permanent shared URL media

Implemented on `hatem/youtube-result-cache`, starting from remote main. This is
source and isolated-fixture behavior, without production or live provider/R2 proof.

## Ownership and storage

All supported public URL imports use permanent shared artifacts. Personal audio or
video files uploaded from a device/browser stay private to that account. YouTube
URLs acquired by Chrome/Mac use the separate
[guest community publication flow](youtube-community.md), including when logged out.
The R2 bucket remains private: shared storage does not grant public access.

```text
shared/url/<source hash>/<unique transfer UUID>/input/source.<extension>
shared/url/<result hash>/<unique transfer UUID>/output/vocals.mp3
users/<user ID>/jobs/<job ID>/...  (local uploads and temporary worker outputs)
```

Each account retains its own job row, title, history, notifications and ownership
checks. URL jobs reference the same confirmed input/output identities; no media
copy is made for each user. Playback/download grants require the existing account
and owned-job checks. Internal cache keys and provider URLs are not exposed.

The first original uploads directly to a unique shared input key. The existing
worker uploads to its private attempt reservation. Backend completion verifies
that output and publishes it once to a fresh shared output key, then records
shared readiness and the producer's completed job in one transaction. The private
attempt file uses normal delayed cleanup. Later users reuse the output without
another copy, acquisition or worker attempt.

## Identity and single flight

The source key is SHA-256 of a versioned provider plus the existing canonical URL.
YouTube watch, short, embed and youtu.be forms resolve to the same case-sensitive
video ID; tracking/timestamp parameters do not create separate audio. Other
supported sites use the existing parser's canonicalization, without paid metadata
lookup or vendor-specific backend code.

The result key includes the source key, source generation and frozen worker
recipe digest. Trim choice, recipe/model revision and output settings produce
separate vocals while reusing the original. Completed artifacts have no expiry
or automatic refresh. Failed acquisition can acquire a new generation only
after an explicit new request. Queued imports retain their frozen recipe across
backend updates; validated older recipe snapshots remain usable for replay.

The existing global admission fence creates one durable source producer and one
result producer. Duplicates remain durable queued imports while the producer
works. Existing backend import maintenance wakes followers after readiness;
clients retain owner-scoped WebSocket snapshots. No new worker scheduler or
client polling loop is introduced.

`shared_media_sources`, `shared_media_results` and `shared_media_artifacts` have
no TTL. The artifact catalog records every destination before transfer and retains
confirmed or uncertain identities even after a failed generation/publication is
replaced. Recovery performs bounded HEAD verification of a recorded PUT/copy before
any further action. New imports may retry transient acquisition failures at most
three times before an upload intent or job reservation exists, retaining the
same source/result producer, generation and single usage hold. A recorded PUT or
accepted job is recovered without another paid acquisition. Historical failed
imports are not replayed. See [the retry policy](retries-2026-10-01.md).
Confirmed-source submission failures also use [durable database handoff recovery](database-handoff-recovery.md), with a separate queue generation and no additional provider download.
Recovery scans rotate by cursor
and fence the observed producer/generation so an old scan cannot fail a newer retry.
Queued import recovery also rotates bounded pages and delivers ready results
before acquisition queue dependencies. A full cold backlog, Redis queue failure
or one interrupted ready delivery cannot starve later ready deliveries.

## Limits and deletion

Completed matching results consume no processing reservation or upload grant.
They are submitted directly without entering BullMQ, and bypass the outstanding
acquisition queue limit and URL acquisition enablement flag. Authenticated
`POST /media-imports/cache-deliveries` provides the same delivery without admitting
work on a miss: HTTP 404 `IMPORT_CACHE_MISS` creates no source/result producer,
import or usage hold. Mac Local and extension clients consult this route after
their own ready history, so a result produced by another account can be reused
without another acquisition or inference. Generic local sync pairs remain private.
The dedicated YouTube contribution path publishes full original/vocal pairs with
explicit community provenance and guest capabilities; it does not attest the
uploaded video's identity or model execution. Trusted results retain priority.
They remain subject to active account, restrictions, processing policy, media
limits, logical retained-storage and normal download allowances. Monthly compute
or waiting-job exhaustion can still permit a completed hit. Source-only hits
use normal processing admission/compute accounting but no acquisition or upload
grant. Fresh acquisition preserves the pre-provider duration hold and confirmed
upload accounting.

Storage allowance remains logical per saved user job: original plus result counts
against that user's Library limit although physical storage exists once. Request
replay never charges twice. Job/account deletion releases its logical allowance
and removes owned records/access. Shared files and catalog rows are never deleted.
No reference-count garbage collection, age expiry or shared cleanup is enabled.
Local uploads and temporary worker outputs retain existing cleanup behavior.

New YouTube cloud producers retain a full-timeline master even when the submitting
user requests silence trimming. Worker completion commits the full shared master,
releases its slot and settles model usage, while a durable backend finalizer derives
the requested trim and commits the user's ready rendition. Slow DSP or restart
cannot requeue the accepted full separation. Later
full or trimmed requests reuse these artifacts without another model run. The
derived recipe records its additional MP3 encode; existing exact trimmed worker
results remain usable. Older trimmed-only entries cannot recover removed vocals.

## Rollout and limits

No bucket change, data migration, existing-job rewrite or cache backfill runs.
Existing jobs remain compatible. New URL imports populate shared storage after
backend deployment; native/web requests and grants need no new fields. Automatic
Mongo initialization only creates registered collections/indexes. The release
preserves the exact active worker installation catalog (R2 release 0.1.2,
macOS sequence 4 and Windows sequence 3); no worker package is republished.

The producer remains an account-owned job under the existing scheduler. If it is
cancelled, deleted or fails permanently, waiting imports fail safely; a new import
or eligible retry can reuse a confirmed source. There is no independent service
job that continues after its producer account is removed.

Permanent storage grows with distinct sources/recipes and uncertain transfers.
These objects are intentionally retained and catalogued. Cached sources are the
first confirmed snapshot of a canonical URL; changes at that URL are not detected
automatically. Legacy jobs are not deduplicated. Deployment must keep the bucket
private, avoid external lifecycle deletion of `shared/`, and publish the updated
retention notice, including any configured override. Application guards cannot
prevent manual bucket deletion or external lifecycle policies.

## Validation

Executed locally on 2026-10-01:

| Command (from backend unless stated)                              | Result                                                                                                           |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `pnpm run verify`                                                 | Format, lint, type checks, secret scan, transfer fixture tests, 1,197 unit tests, 158 API tests and build passed |
| `pnpm run test:imports:integration`                               | 24 tests passed, including 8 shared-media tests                                                                  |
| `pnpm run test:processing:integration`                            | 19 tests passed                                                                                                  |
| `pnpm run test:retention:integration`                             | 29 tests passed                                                                                                  |
| `pnpm run test:deletion:integration`                              | 3 tests passed                                                                                                   |
| `pnpm run test:integration`                                       | Compiled API startup, restart and dependency recovery passed                                                     |
| `node --test test/realtime.integration.mjs`                       | Two API feeds, realtime changes and authorization fences passed                                                  |
| `pnpm run test:worker:integration`                                | Compiled API and worker authoritative job flow passed                                                            |
| Android `:app:testDirectAuthE2eUnitTest` focused URL/usage suites | 17 JVM tests passed with synthetic fixtures                                                                      |
| iOS `swiftc -frontend -parse` for URL/usage source and tests      | Syntax checks passed                                                                                             |
| `pnpm audit --prod`                                               | Passed after pinning the compatible `@grpc/grpc-js` patch release 1.14.5 to resolve two pre-existing advisories  |

The shared integration uses owned loopback Mongo replica-set/Redis and synthetic
provider/R2 fixtures for concurrent deduplication, recipe separation, reference
reuse, lost-response recovery, idempotent quotas, private uploads and account purge.
The startup fixture's obsolete AWS region expectation was corrected to R2 `auto`.
These checks do not establish device/simulator/UI behavior or real provider/R2
and production behavior. Deployment validation is recorded separately.

API preflight: [Zalando RESTful API guidelines](https://opensource.zalando.com/restful-api-guidelines/)
read on 2026-10-01. Applied security/ownership, compatibility, idempotent requests,
asynchronous POST semantics and OpenAPI/error documentation. Routes, bearer
authentication, snake_case responses and non-cacheable HTTP behavior remain
compatible; storage reuse is not HTTP response caching.
