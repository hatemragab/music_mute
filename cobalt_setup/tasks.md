> Retired Cobalt design/evidence. Do not use these deployment instructions. The active replacement is [yt-dlp](../ytdlp_test/README.md), tracked in its [migration plan](../ytdlp_test/migration-plan.md).

# Cobalt URL-import implementation tasks

Created: 2026-09-25. Status: release 64 deployed and enabled for verified SoundCloud and Tumblr native audio; YouTube remains unavailable after actual transfers returned empty audio. See [all-provider review](provider-support.md).

Evidence and remaining blockers: [implementation-notes.md](implementation-notes.md).
Checked items record completed implementation or verification work. Local fault/concurrency tests
and live production checks are distinguished in the evidence report. The failed YouTube helper
consumption gate remains explicitly unchecked; no YouTube readiness is claimed.

Specification: [music-mute-cobalt-pilot-agent.md](music-mute-cobalt-pilot-agent.md).
This checklist supplements that specification with the owner's conversation
decisions and explicit disk-cleanup requirements. All specification safeguards,
verification gates, and exclusions still apply.

## Agreed behavior

- Available to all authenticated accounts under existing account limits. Users
  access it through an Android version that implements URL submission.
- This implementation covers backend and deployment; Android UI work is separate.
- Android submits the link and does not download or upload the source audio.
- Cobalt resolves/proxies a verified native audio-only source and returns a
  temporary link plus available details. Do not assume it first saves a complete
  file or supplies authoritative duration/size metadata.
- NestJS consumes that source once into a bounded temporary file, validates it,
  uploads it to existing S3 storage, and continues the existing job/worker flow.
- The worker continues reading S3 inputs. No provider URLs in worker jobs.
- Use a separate test account for live jobs and usage accounting.
- Delete temporary audio promptly; crashes and restarts must not leave an
  unbounded collection of downloaded files.

## 1. Confirm integration points and deployment baseline

- [x] Read applicable instructions, backend source/configuration, lockfile, and
  deployment guidance; preserve unrelated work.
- [x] Trace current job reservation, upload grants, S3 confirmation, quota
  accounting, worker dispatch, and completion from source.
- [x] Record actual accepted formats, byte/duration limits, account overrides,
  idempotency, cleanup, and notification mechanisms.
- [x] Reconcile the specification's ingestion assumptions with actual source:
  initial inspection found job reservation before upload and no backend
  FFprobe/FFmpeg ingestion facility. Plan minimal probing support and reuse
  existing reservation/finalization services without changing old clients.
- [x] Inspect deployed backend release, replicas, internal connectivity, Redis,
  deployment access, and rollback mechanism without exposing credentials.
- [x] Identify or provision the separate test account through supported flows.

Acceptance: documented integration points and pre-change release/configuration
baseline; no invented business rules or parallel accounting system.

## 2. Verify and deploy private Cobalt dependencies

Depends on task 1.

- [x] Inspect current official releases and exact image contents; select and
  record supported image versions, architecture, and tested digests.
- [x] Verify the Cobalt/session-generator endpoint and response contract against
  the selected images, including the documented `/get_pot` versus `/token` risk.
- [x] Create/reuse private CapRover apps with one instance each, no public routes
  or host port mappings, and verified internal DNS.
- [x] Configure one protected service API key and verify unauthenticated
  processing is rejected. Keep secrets and tunnel URLs out of logs/evidence.
- [ ] Verify actual generator consumption by Cobalt using the same VPS egress.
  **Unavailable:** exact official images were tested; `/get_pot` returns 404 and
  `/token` returns 503. YouTube is disabled; the helper is stopped. This follows
  the specification's permitted partial-provider outcome.
- [x] Inspect Cobalt's selected tunnel/storage behavior; avoid persistent media
  volumes and verify any transient resources expire or are cleaned up.

Acceptance: private authenticated services with recorded compatibility evidence.
If no compliant official pair works, leave YouTube unavailable; no adapter/fork.

## 3. Prove accepted audio-only provider paths

Depends on task 2; backend scaffolding can proceed independently.

- [x] Start with single-item YouTube and SoundCloud links as test targets.
- [x] Verify source/action paths for native audio with no upstream video fetch
  and no Cobalt conversion; document the supported subset and link limitations.
- [x] Define a small response acceptance check covering the actual selected
  release, including verified proxy responses.
- [x] Reject picker, merge/video, ambiguous, and unverified HLS/processing paths
  before fetching media bodies.
- [x] Reject unknown hosts, credential-bearing URLs, unsupported schemes,
  playlists, collections, and single-item URLs carrying playlist parameters.
- [x] Restrict returned tunnel origins/redirect behavior to the verified flow;
  never turn the integration into an arbitrary remote-file fetcher.

Acceptance: source-level and observed behavior evidence for each enabled path.
A final audio file alone is insufficient proof of no video download.

## 4. Add authenticated import admission and status

Depends on task 1; align final provider admission with task 3.

- [x] Follow existing API naming, snake_case wire format, guards, DTO validation,
  error envelope, and applicable API documentation requirements.
- [x] Add asynchronous URL submission and owner-scoped status; return promptly
  after admission, normally HTTP 202.
- [x] Keep import acquisition state separate from existing processing state;
  return the processing job reference when successfully submitted.
- [x] Reuse account eligibility, quota, idempotency, and deletion safeguards.
- [x] Add sanitized errors/progress and reuse existing notifications where
  appropriate; polling status is sufficient if no suitable event exists.
- [x] Keep feature admission disabled until deployment verification passes.

Acceptance: authenticated account isolation, deterministic replay behavior, and
clear admission/status errors without exposing internal URLs or credentials.

## 5. Add a bounded Redis import queue

Depends on tasks 1 and 4.

- [x] Recheck installed queue dependencies; use maintained NestJS/BullMQ
  integration if none exists. Reuse existing Redis with a distinct queue prefix.
- [x] Enforce global concurrency across actual backend replicas, initially 2.
- [x] Enforce a race-safe maximum of 20 active plus waiting imports unless
  equivalent existing limits apply; release capacity on terminal outcomes.
- [x] Resolve Cobalt tunnels only when work starts and consume them immediately.
- [x] Start eligible imports as soon as a slot opens, with no artificial delay.
- [x] Bound transient retries and prevent retry storms for upstream blocks,
  unsupported sources, authentication failures, and expired tunnels.
- [x] Ensure stalled/recovered executions cannot submit duplicate worker jobs.

Acceptance: simultaneous-admission and multi-processor tests prove limits;
restarts produce recoverable or terminal imports, never permanently stuck work.

## 6. Implement bounded acquisition, validation, and S3 handoff

Depends on tasks 3–5.

- [x] Stream accepted audio to a unique import-owned temporary directory without
  buffering the complete file in memory.
- [x] Count actual bytes and abort at the applicable limit, even without
  Content-Length; enforce finite request and stream deadlines.
- [x] Add minimal backend FFprobe support to measure duration and inspect
  container/codec/tracks; reject missing audio and any video track.
- [x] Apply actual account limits to measured data. Cobalt metadata and global
  duration ceilings are early hints/safeguards, not authoritative validation.
- [x] Preserve native extension/content type. Avoid conversion unless required
  for existing compatibility; do not silently broaden accepted formats.
- [x] Reuse server-generated S3 keys, account reservation/finalization, immutable
  input verification, and worker dispatch. Reserve at the existing accounting
  point and submit for processing only after successful validated S3 upload.
- [x] Handle failures between reservation, upload, and confirmation with existing
  idempotency, reservation release, and storage cleanup mechanisms.

Acceptance: exactly one valid S3-backed processing job per successful import,
with existing accounting and worker contracts preserved.

## 7. Guarantee disk and failed-upload cleanup

Design alongside task 6; required before enabling any provider.

- [x] Use a dedicated temporary root with generated import/attempt directories;
  never derive filesystem paths from source titles or URLs.
- [x] Close streams/processes and remove temporary files in `finally` on
  success, rejection, timeout, abort, upstream failure, S3 failure, and job
  finalization failure. Remove successful local files once no longer needed.
- [x] Enforce a disk budget/free-space threshold in addition to per-file byte
  and queue-concurrency limits. Refuse acquisition safely when disk is low.
- [x] Add bounded startup and periodic orphan cleanup restricted to this
  feature's temporary root. Check ownership/active attempts and a safe age
  threshold so recovery cannot delete a live import's files.
- [x] On shutdown, stop new acquisition and safely finish or abort active
  transfers; recover leftover attempts after crashes or forced termination.
- [x] Retry/report cleanup failures without logging secrets or blocking normal
  processing indefinitely. Integrate with existing operational logging.
- [x] Abort incomplete multipart uploads if used and schedule cleanup for this
  import's abandoned S3 objects through existing mechanisms. Preserve accepted
  job inputs, user results, shared Redis, and unrelated files.
- [x] Test cleanup after each terminal path, process interruption, orphan
  detection, low disk, and repeated imports; verify disk usage returns to a
  bounded baseline and active/unrelated files are preserved.

Acceptance: successful and failed imports leave no unnecessary local audio;
crash leftovers are reclaimed automatically without deleting valid live data.

## 8. Validate behavior and document the Android contract

Depends on tasks 4–7.

- [x] Cover every test case in specification section 13, using isolated mocks
  and services for concurrency, limits, faults, and recovery.
- [x] Verify old upload/finalization behavior and worker contract regressions.
- [x] Verify auth/ownership, actual byte/duration limits, account quotas,
  idempotency, queue saturation, and source rejection before body transfer.
- [x] Verify upstream 403/429, helper failure, expired tunnel, S3 failure,
  finalization failure, backend restart, and all cleanup guarantees.
- [x] Run required backend formatter, lint, type checks, unit/HTTP tests, build,
  isolated integration checks, and native startup checks appropriate to changes.
- [x] Update API/OpenAPI and deployment/configuration documentation with safe
  request/status examples, errors, verified providers, retention/cleanup rules,
  and actual rollback commands. No Android code changes in this task set.

Acceptance: commands and results recorded accurately; mocked/local checks are
clearly separate from live provider and production evidence.

## 9. Deploy, prove end-to-end behavior, and enable

Depends on tasks 2–8.

- [x] Deploy additive backend changes through the established workflow with
  public import admission initially disabled and a controlled verification path.
- [x] Use the separate test account and small permitted media to verify actual
  acquisition, measured validation, S3 upload, worker processing, and result.
- [x] Verify the old upload flow still works and temporary disk usage returns to
  baseline. Record source-path evidence, not just HTTP success or container health.
- [x] Enable only verified provider paths for all authenticated accounts under
  existing limits; report unavailable providers explicitly.
- [x] Record feature-disable, in-flight recovery, and previous-release rollback
  steps; preserve old uploads, shared infrastructure, and worker processing.
- [x] Report implemented/deployed/enabled/live-tested status separately, with
  image digests, backend revision, queue limits, checks, and remaining blockers.

Acceptance: live S3-to-worker completion and old-client regression evidence,
verified cleanup, and a reproducible rollback path. No commit/push is implied by
creating this checklist; follow explicit authorization for release actions.
