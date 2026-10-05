# Shared YouTube contributions from Chrome and Mac

This is a source implementation. It requires the matching backend and companion
release; local fixtures do not establish production R2 or installed-client proof.

YouTube acquired by the companion is a URL source even though separation runs
locally. Personal audio/video file uploads continue through account-private local
media sync. The shared flow accepts only the canonical YouTube identity and the
qualified full-timeline Kim Vocal 2 profile. For example, both
`youtube.com/watch?v=bZxrIoCPsOc&list=RDbZxrIoCPsOc&start_radio=1` and
`youtu.be/bZxrIoCPsOc?si=RLbbOevlM4lBmXHi` identify `bZxrIoCPsOc`.

## Preparation and publication

1. The native companion obtains a backend guest capability without Firebase or
   creating an account. The bearer is kept in macOS Keychain and sent only in
   Authorization headers or the first native WebSocket authentication frame.
2. A cache lookup prefers a ready trusted adapter/worker artifact, then a ready
   community artifact. A hit grants the existing private R2 objects and does not
   request YouTube audio or run separation.
3. On a miss, an idempotent contribution reserves one expiring producer before
   acquisition. The existing cloud admission fence coordinates cloud imports and
   community preparation. Other requests receive complete live state snapshots
   and wait; they do not use recurring HTTP status reads.
4. The producer captures its existing original/vocals pair into a bounded durable
   outbox before scratch cleanup. Upload records contain local paths, hashes and
   contribution/request IDs, never bearer tokens or presigned URLs. Original
   cleanup follows a durable committed receipt. Interrupted uploads resume against
   the same immutable reservations without reacquiring or running inference.
5. The backend admits declarations once, issues create-only private quarantine
   grants and verifies actual R2 identities, byte hashes, types, complete audio
   decoding and equal full timelines. Publication reserves exact permanent
   destinations before copying and recovers uncertain copies by HEAD.
6. Accepted artifacts enter the existing `shared/url/<hash>/<uuid>/...` namespace.
   Authenticated mobile/web/Mac jobs reference them through the existing import
   contract. Guests receive scoped grants without a Library job or account quota.

Guest sessions last 30 days; producer leases are renewed during active work and
pending contributions expire after 24 hours. Explicit producer failure and expired
leases release waiting requests. Reconnect starts with a fresh complete snapshot.
An already prepared durable pair can reclaim its expired preparation lease through
the same upload-grant command during the original 24-hour reservation, if no other
producer for that source is active. Reclamation consumes publication capacity and
can proceed while another source is preparing in the same guest session. It waits
for a replacement source producer or reuses its ready result otherwise.
Explicitly failed and fully expired reservations cannot reclaim. A ready-owned
replay also closes a lost acknowledgement receipt, releasing the guest producer cap.
Feed loss closes the guest socket rather than reporting stale state as live.
Temporary quarantine cleanup is exact-key and waits for grants/transfers to settle;
accepted shared artifacts have no TTL and outlive account/guest deletion.

## Provenance and limits

Community artifacts record `community_contributed` and unverified source identity.
File/hash/codec checks prove intact audio, not that an untrusted machine uploaded
the declared song or correctly ran the model. Community records are separate from
trusted records, never overwrite them and never prevent later trusted publication.
Guest installation credentials provide scoped continuity and abuse budgets, not
remote processing attestation. Login would not establish that attestation either.

Admission bounds each artifact to 100 MB and 1,800 seconds, with one preparing
source per session and at most four live contributions across preparation, upload
and validation. Earlier uploads and validation do not block the next source's
preparation until that bounded backlog fills. The combined ten-per-IP and
100-global active limits are unchanged. Session/IP/global daily byte
budgets and a conservative 100 GB lifetime contribution reservation ceiling bound
permanent growth. Retries do not charge the same declaration twice; failed
reservations are conservatively retained in the lifetime budget. Commands, grant
renewals, validation and live connections have independent bounds. Signed R2 URLs
are bearer capabilities until expiry; grant budgets cannot meter every URL replay.
The bucket stays private and storage credentials remain backend-only.

Silence trimming is derived once from a cached full vocal MP3, without another
source download or model run. Its explicit derivation identity distinguishes the
additional lossy encode from the worker's PCM-first trimming recipe. Full audio is
required for synchronized YouTube playback. New cloud YouTube producers therefore
separate the full timeline first and derive the submitting user's requested trim
through a durable backend finalizer. Worker completion commits the full shared
master and acknowledges the succeeded attempt promptly; the user job remains
`uploading_result` with no delivered output until trimming and its retained-byte
accounting commit. The finalizer survives restart, rechecks owner access and
cancellation, and never enters the model queue. The immutable worker recipe remains
the full master and the delivered rendition has its own recipe snapshot. Existing
trimmed-only results cannot restore removed intervals; their retained original can
support full separation.

## HTTP and realtime contract

- `POST /youtube-guest-sessions {}` issues the guest capability.
- `POST /youtube-cache-deliveries {url}` returns approved ready original/vocals
  declarations and temporary grants, or 404 `IMPORT_CACHE_MISS` with no producer.
- `POST /youtube-contributions {request_id,url,profile_id}` reserves preparation.
  The fixed profile is `kim-vocal-2-full-timeline-v1`. `producer:false` waits or
  returns already ready artifacts.
- `GET /youtube-contributions/{id}` is explicit owned recovery.
- `POST /youtube-contributions/{id}/lease-renewals {}` renews active preparation.
- `POST /youtube-contributions/{id}/upload-grants` freezes paired `original` and
  `vocals` declarations plus `request_id`; renewal retains identical keys.
- `POST /youtube-contributions/{id}/completions {}` validates and publishes.
- `POST /youtube-contributions/{id}/failures {}` releases failed preparation.

All commands after issuance require the guest bearer and return `no-store`.
The raw native `/youtube-community-realtime` socket accepts one first frame
`{type:"authenticate",token,video_id}` within five seconds. Snapshots are complete
`{type:"snapshot",video_id,state,expires_at,sequence}` objects for that one public
source; no contributor identity, grants or credentials appear in snapshots.
Query credentials, browser Origin handshakes and additional commands are rejected.
Connections use the existing shared HTTP upgrade router and committed Mongo feed.

API preflight: [Zalando RESTful API Guidelines](https://opensource.zalando.com/restful-api-guidelines/)
read 2026-10-05 for the background-publication admission change. Applied endpoint security (104), backward compatibility (106),
snake_case JSON (118), problem responses (176), redacted errors (177), and
idempotent commands (229); product-specific guest capabilities preserve existing
Firebase account routes.

## Background publication validation, 2026-10-05

- Backend `pnpm run verify` passed formatting, lint, type checks, secret and
  transfer fixtures, 1,639 unit tests, 207 HTTP tests and compilation.
- `node --test test/youtube-community.integration.mjs` passed 13 isolated
  MongoDB/Redis fixtures. The added coverage proves next preparation during
  publication, one active preparation, the four-contribution backlog, exact
  replay without duplicate byte charges, prepared recovery alongside another
  preparation and transactional races for the last slot across two API instances.
- `pnpm run test:imports:integration` passed 40 fixtures and
  `pnpm run test:processing:integration` passed 19 fixtures. Compiled API startup,
  restart and dependency recovery also passed `test/infrastructure.integration.mjs`.
- Extension `npm run verify` passed type checks, zero-warning lint, 1,906 tests
  (four existing skips), build and formatting. Fixtures cover playback-only
  release, no media reload on save updates, cancellation followed by local-byte
  replay, guest/lease recovery, bounded metadata contention and independent
  publisher continuation after its launcher exits. `npm run test:native` passed
  the native macOS, desktop, updater and browser-bridge checks.

These checks use synthetic audio, isolated loopback infrastructure and fixture
storage. They do not establish deployed admission, installed Chrome playback
or real R2 performance.

## Local validation, 2026-10-04

- Backend `pnpm run verify`: formatting, lint, type checking, secret checks,
  transfer fixtures, 1,614 unit tests, 194 HTTP tests and compilation passed.
- `pnpm run test:imports:integration`: 40 real Mongo/Redis integration tests passed,
  including canonical URL aliases, guest/account reuse, no-write cache misses,
  immutable copy recovery, full worker acknowledgement and durable trim recovery.
- `node --test test/youtube-community.integration.mjs`: 10 real Mongo/Redis tests
  with synthetic audio and storage fixtures passed. They cover seven guest
  sessions, producer races, lease reclamation, lost receipts and exact quarantine
  cleanup, with no account jobs or quota rows.
- Compiled startup and two-replica realtime integration checks passed. The
  processing persistence, usage, job actions, storage cleanup, push registration,
  notification and abuse-protection integration set passed 19 tests.
- Extension type checking, lint, 1,553 tests, build and formatting passed. Native
  Swift fixtures and Swift 6 guest-helper compilation passed. Validate-only helper
  checks accepted supported dates and rejected malformed tokens without accessing
  Keychain.

These are local and synthetic-fixture results. No production R2 objects or paid
source acquisitions were created, and no backend or installed companion release
was deployed. Existing Android/iOS/web import contracts were preserved; these
checks do not establish live playback on those clients or actual Keychain access.

### Trusted original reuse (2026-10-05)

`POST /youtube-contributions/:id/source-deliveries` accepts an empty JSON body
with the existing guest bearer. Only the owned active producer can request it.
It returns `video_id`, `provenance: trusted`, `source_identity_verified: true`,
and `original: { declaration, grant }` with `Cache-Control: no-store`. The source
must be a validated, immutable backend-acquired shared source; a ready vocal
rendition is not required. Missing originals return `IMPORT_CACHE_MISS` (404);
authentication, ownership and lease errors retain existing 401/404/409/410 codes.
The delivery reserves original bytes against existing session/IP/global limits
and rechecks session/producer after signing. It never acquires media or admits
cloud work. Clients fall back to local acquisition only on that explicit cache
miss, never on authorization errors or an unrecognized 404.
