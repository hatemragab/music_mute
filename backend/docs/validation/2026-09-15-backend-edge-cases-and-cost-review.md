# Backend edge cases and cost review

## claude --resume 558d3506-cdce-4193-a434-021378b423dc

**Date:** 2026-09-15
**Scope:** NestJS API at `backend/src/` — edge cases, failure modes, correctness, and
cost amplification.
**Explicitly deferred at the author's request:** the external audio worker
(`worker/`, `windows-worker/`, `backend/dist-worker/`). Backend API surface that
happens to be worker-facing is recorded separately in
[Appendix B](#appendix-b--deferred-worker-domain-findings) rather than mixed into
the main priorities.

**Constraint driving this review:** the deployment runs on free tiers — Firebase
(free), AWS S3 (free/trial, 100 GB egress for 12 months), MongoDB Atlas (free M0,
**512 MB**), external Redis. There is no budget to purchase capacity.

**Reading this document:** every finding cites `path:line`. Findings marked
**CONFIRMED** were verified by direct reading of the cited code. **DORMANT** means
the code path is real but currently disabled by an environment flag. **DEFERRED**
means it belongs to the worker domain.

---

## 1. Executive summary

Six things will cost real money, take the service down, or permanently trap a
user. Everything else is secondary.

1. **Failed jobs are fully refunded and can be retried forever.** Any `failed`
   job gets a 100 % allowance refund regardless of how much work the worker did,
   and retry is uncapped for every failure code except three input-integrity
   ones. A client that declares `durationSeconds: 1` for a long file makes
   failure deterministic, so it can loop worker runs at zero allowance cost
   indefinitely, on the _same uploaded input_. See **C-5**.

2. **Cancelling an upload orphans the S3 object permanently.** A concrete bug, not
   a policy gap: the sweeper matches on a state the row can never re-enter after
   cancellation, and no other path schedules input cleanup. See **C-1**.

3. **There is no global spending ceiling, and the caps that exist are bypassable.**
   Every limit is per-user or per-IP. Firebase gives unlimited free accounts, each
   with a fresh 3600 audio-second allowance. Separately, the backend sends mail
   through Google's _client-facing_ endpoint using the same public API key that
   ships in the mobile binaries, so its own mail caps can be bypassed entirely.
   See **C-2** and **C-4**.

4. **Eight collections grow forever with no retention path, on a 512 MB database.**
   When 512 MB is reached Atlas stops accepting writes and the entire API fails —
   including login. A hard outage, not a slow degradation. See **C-3**. C-5 is the
   engine that drives this growth.

5. **An interrupted job has no exit, and it consumes a global slot forever.** Not
   just "no automatic cleanup" — there is _no_ remediation path at all. Retry
   refuses it, cancel renames it to another active status, delete refuses it, and
   admin retry explicitly errors. Roughly 34 stuck jobs brick the queue for every
   user. See **H-8**.

6. **The per-IP limits, which are the backstop for everything else, do not bind —
   and exhausting Redis takes the whole API down.** A client with an IPv6 /64 has
   2⁶⁴ trackers. Worse, each tracker allocates Redis memory in a `noeviction`
   instance, so the abuse path converts directly into a total outage. See **H-6**
   and **H-7**. Separately, a Redis that is merely _slow_ blocks every request on a
   5 s leash while the unset `enableOfflineQueue` accumulates commands in process
   memory unbounded (**H-13**). Failing closed is the right call; leaving the
   resources unbounded is not.

Items 1–5 compound: the code deliberately retains everything, on tiers sized for a
demo, while the one mechanism that could have caught the leaks is refused at
startup (H-1).

---

## 2. Free-tier limits mapped to this codebase

| Provider           | Free-tier limit                                      | What breaks here                                                                   |
| ------------------ | ---------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Atlas M0           | **512 MB storage**, shared vCPU/IOPS                 | **C-3**, **C-5**. Hard write failure at the cap.                                   |
| Atlas M0           | No automated backup                                  | Account deletion is irreversible with no restore path.                             |
| Atlas M0           | Connection limit ~500                                | H-4's uncancelled Firebase calls and M-4's polling both consume connections.       |
| S3                 | 5 GB storage, 20 k GET, 2 k PUT/month, 100 GB egress | **C-1**, **H-5**, **H-9**, **H-12**. Versioning multiplies storage with no expiry. |
| Firebase Auth      | Email/password free; Identity Toolkit quota applies  | **H-3**. `checkRevoked` adds a Google call per authenticated request.              |
| Firebase Auth mail | Shared **daily** quota (verification + reset)        | **C-4**, **M-6**. Per-project caps are the only real protection.                   |
| FCM                | Free, quota'd                                        | **M-1**. Uncapped registrations multiply sends per job.                            |
| Redis              | **Provider-dependent** — see open question O-1       | **H-7**. Throttler fails **closed**, so exhausting Redis = full API outage.        |

**Open question O-1 (needs your answer):** which Redis provider? If it is
Upstash's free tier the limit is 10,000 commands/day, and the limiter spends
roughly one `EVAL` per request. If it is self-hosted, the binding constraint is
memory instead — see H-7. Both change which risk dominates.

---

## 3. Findings

### CRITICAL

#### C-1 — Cancelling an upload orphans the S3 object permanently

**CONFIRMED — this is a bug, not a policy gap.** I traced every code path that
schedules input cleanup. There are exactly two, and neither can reach this case:

1. `ProcessingStorageCleanupService.scheduleExpiredInput`
   (`src/processing/processing-storage-cleanup.service.ts:40-48`) matches
   `status: 'awaiting_upload'` **and** `inputObject: null`.
2. `JobDeletionService` (`src/jobs/job-deletion.service.ts:119`) — reached only by
   an explicit `DELETE /jobs/:id` or account deletion.

`JobActionsService.cancelInTransaction` (`src/jobs/job-actions.service.ts:127-148`)
sets `status: 'cancelled'` for a job in `awaiting_upload` via
`nextCancellationState` (`src/jobs/job-state.ts:66-68`) and calls only
`usage.settleJob`. It schedules **no** storage cleanup. Once the status is
`cancelled`, the row can never satisfy the sweeper's `status: 'awaiting_upload'`
predicate again.

**Trigger (deterministic, any authenticated user):**

```
POST /jobs                       create
POST /jobs/:id/upload-url        get signed PUT
PUT <signed url>                 upload up to 30 MB (or 100 MB on policy v2)
POST /jobs/:id/cancel            status -> cancelled, no cleanup scheduled
```

**The asymmetry is what makes this a bug rather than a design choice:**
`scheduleOrphanedOutput` (`:100-145`) explicitly handles `cancelled` and
`interrupted` attempts and reclaims orphaned **outputs**. The same safety net was
never built for **inputs**.

**Impact:** `maxActiveJobsPerUser: 1` serialises the loop but caps nothing in
aggregate. 50 cycles ≈ 1.5 GB (policy v1) or ≈ 5 GB (policy v2) of permanently
unreclaimable storage — the entire S3 free tier. H-1 blocks the lifecycle
backstop, so nothing can reclaim it short of manual console access.

**Recommended direction:** in `cancelInTransaction`, when cancelling from
`awaiting_upload`, schedule cleanup for `inputReservation.key` exactly as
`scheduleExpiredInput` does. `StorageCleanupService.schedule` and the
`reservationCleanupScheduledAt` marker already exist — this is a missing call, not
new machinery.

---

#### C-2 — No global budget ceiling anywhere

**CONFIRMED.** Every guardrail is per-identity:

- Per user: `allowanceAudioSeconds: 3600` per `allowanceWindowSeconds: 86400`
  (`src/admin-settings/queue-policy.schema.ts:5-14`).
- Per user concurrency: `maxActiveJobsPerUser: 1` (fixed, validated at `:44`).
- Global: `maxOutstandingJobs: 100`, `maxOutstandingAudioSeconds: 60_000` (`:12-13`).

The global limits bound _concurrent outstanding_ work only
(`QueueCapacityService.assertCapacity`, `src/processing-queue/queue-capacity.service.ts:130`).
Jobs that finish leave that set, so throughput over time is unbounded. Nothing
counts total audio processed per day, total bytes accepted, or total jobs created
across all users. Note also that the allowance accounts only in **audio-seconds**
— retained bytes are entirely unaccounted (see H-5).

**Trigger:** create _N_ free Firebase accounts (unlimited — see C-4). Each is
entitled to 3600 audio-seconds per 24 h and up to 30 MB input + 30 MB output.
Submit one job per account, wait, repeat. Cost scales linearly with _N_ and the
API never refuses on aggregate grounds.

**Recommended direction:** add a single global daily budget counter (bytes
accepted, audio-seconds accepted, jobs created) checked inside the existing
admission transaction, mirroring how `ProcessingAdmissionFence` already
serialises admission. **Per C-4 it must not assume account count is a trustworthy
proxy for distinct humans.**

---

#### C-3 — Eight collections with no TTL on a 512 MB database

**CONFIRMED.** Repo-wide there are exactly **five** TTL indexes:

```
src/processing-queue/queue-scheduling.schema.ts:25    processing_execution_usage
src/processing-usage/processing-usage.schema.ts:34    processing_usage_ledger  (BROKEN — see M-8)
src/storage/storage-cleanup-task.schema.ts:65         storage_cleanup_tasks    (BROKEN — see M-7)
src/users/user-identity-fence.schema.ts:26            user_identity_fences     (BROKEN — see H-10)
src/worker-events/worker-event.schema.ts:34           worker_events
```

Every one of these grows without bound, with **no** TTL and **no** sweeper:

| Collection                      | Written per                                                                                | Schema                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| `audio_jobs`                    | every job (+1 per retry cycle)                                                             | `src/jobs/job.schema.ts:135`                           |
| `audio_job_attempts`            | every worker claim                                                                         | `src/jobs/job-attempt.schema.ts:12`                    |
| `audio_job_receipts`            | every worker operation                                                                     | `src/jobs/job-receipt.schema.ts:5`                     |
| `audio_job_errors`              | every failure **and every lease expiry** (`src/worker/worker-recovery.service.ts:234-250`) | `src/job-errors/job-error.schema.ts:5`                 |
| `audio_notification_outbox`     | every job outcome                                                                          | `src/notifications/notification-outbox.schema.ts:13`   |
| `audio_notification_deliveries` | every job × every device                                                                   | `src/notifications/notification-delivery.schema.ts:23` |
| `client_errors`                 | every client error report                                                                  | `src/client-errors/client-error.schema.ts:11`          |
| `admin_audit_events`            | every admin mutation                                                                       | `src/admin/admin-audit.schema.ts:32`                   |

I verified the maintenance services purge none of these.
`NotificationMaintenanceService.tick()` only _dispatches_ pending notifications
(`src/notifications/notification-maintenance.service.ts:38-43`).
`JobDeletionService` only marks outbox rows `completed`
(`src/jobs/job-deletion.service.ts:64-76`). There is no reconcile or repair job for
any collection.

**Trigger:** ordinary use — but **C-5 is the accelerator.** That loop writes ~3
immortal rows per iteration at up to 30 iterations/min/account.

**Impact:** at 512 MB, Atlas M0 stops accepting writes. Because `AuthGuard` reads
`users` on every authenticated request (`src/auth/auth.guard.ts:154`), a full
database presents as a complete outage — no logins, no reads.

**Also note:** `docs/tasks/audio-processing.md:101` records "No automatic
deletion/expiration of retained business data or S3 objects" as deliberate. That
is defensible for a production service with a paid database. It is not survivable
on 512 MB.

**Recommended direction:** TTL or scheduled purge for every row above. Suggested
retention: receipts/attempts/errors 30 days, outbox/deliveries 30 days,
`client_errors` 30 days, `admin_audit_events` 180 days. `audio_jobs` should
follow user records rather than being TTL'd.

---

#### C-4 — Mail and account creation are callable directly, bypassing every backend cap

**CONFIRMED (structure verified; framing corrected from the agent report).**

This is _not_ a leaked-secret problem. Firebase web API keys are **public by
design** — they ship inside every Firebase client app and are not credentials.
The problem is architectural: the backend sends password-reset and verification
mail by calling Google's client-facing endpoint with that public key.

`FirebaseMailService` builds
`https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=FIREBASE_WEB_API_KEY`
(`src/auth/firebase-mail.service.ts:35`). I verified the key the backend reads is
the same key family embedded in the shipped clients:

```
android/app/google-services.json          real AIza… key, project "music-mute"
ios/Vocal/GoogleService-Info.plist        real AIza… key
backend/.env.production:10                FIREBASE_WEB_API_KEY=<set>
backend/src/auth/firebase-mail.service.ts:35   uses that same variable
```

**Trigger:** anyone with the app installed reads the API key out of the bundle and
calls Google's `accounts:sendOobCode` and `accounts:signUp` directly.

**Impact:** every backend-side cap in this document becomes advisory. The
project-day budgets (`verify-project-day` 200, `reset-project-day` 50 — M-6), the
per-IP and per-UID buckets, and the pause breaker are all skipped, because the
request never reaches this API. Consequences:

- Unlimited password-reset mail against the shared Firebase daily quota — the
  _same_ pool the backend depends on. Real users lose password reset.
- Unlimited free account creation, which feeds **C-2** directly: each new account
  is a fresh 3600 audio-second allowance _and_ a fresh set of per-UID budgets.
- Sender-reputation damage on a domain you cannot yet afford to repair.

**Recommended direction:** this cannot be fixed inside the backend — the
capability lives in the Google project. Options, in order of effort: (a) move
transactional mail off Firebase's built-in sender to a provider whose send
credential is a server-only secret; (b) enable Firebase App Check so unattested
clients are rejected; (c) restrict the web API key in Google Cloud console to the
specific APIs and referrer/IP ranges you use. Until one is in place, treat the
caps in C-2, M-6 and every per-UID budget as best-effort, not enforced.

---

#### C-5 — Failed jobs are fully refunded and retry is unlimited

**CONFIRMED — this is the most exploitable finding in the document.**

Two facts combine:

1. **A failed job is refunded in full.** `ProcessingUsageService.settleJob` maps
   any `failed` job to `entry.state = 'released'` with no debit
   (`src/processing-usage/processing-usage.service.ts:178-183`), regardless of how
   much worker work already happened. (Cancellation, by contrast, _is_ debited via
   `cancellationDebit` — so the incentive is inverted: a user wants **failure**,
   not cancellation.)
2. **Retry is uncapped.** `requiresNewInputForRetry` restricts retry-with-same-input
   to only three input-integrity codes — `INVALID_AUDIO`, `INPUT_TOO_LONG`,
   `INPUT_CHECKSUM_MISMATCH` (`src/jobs/job-actions.service.ts:31-35`).
   `assertRetryable` (`:386-402`) checks only that the job is `failed` and that the
   pinned input still matches. There is **no retry count, no window, and no
   per-day cap**. `SEPARATOR_FAILED`, `OUTPUT_UPLOAD_FAILED` and `DOWNLOAD_FAILED`
   (`src/jobs/job.types.ts:104-112`) are all retryable.

The client controls the declared duration, which closes the loop. `reserveForJob`
checks the allowance against the **client-declared** `durationSeconds`
(`:118-134`); the worker's real measurement arrives later at `reconcileMeasured`
(`:137-159`), which throws `PROCESSING_ALLOWANCE_EXHAUSTED` when the true duration
exceeds remaining allowance.

**Trigger:**

```
POST /jobs  { durationSeconds: 1, ... }      for a 1799 s file — accepted
POST /jobs/:id/upload-url  → PUT             ≤100 MB, paid once
worker claims → downloads input → probes
POST stage  → reconcileMeasured throws       PROCESSING_ALLOWANCE_EXHAUSTED
job ends failed → settleJob → 'released'     full refund
POST /jobs/:id/retry                          allowed; same pinned input
repeat                                        no re-upload needed
```

**Scoping the cost precisely:** `reconcileMeasured` is called inside `stage()` at
`src/worker/worker-coordinator.service.ts:345` with `stage: 'processing'`
(`:285, :294`) — that is, **before** the separation step. So each cycle costs a
worker claim, a **full re-download of the input** (≤30 MB v1 / ≤100 MB v2 of S3
egress) and a media probe — not necessarily a completed separation. I am stating
this narrower than the agent's phrasing because the ordering matters: the billed
resource burned per cycle is **egress**, the scarcest free-tier item, rather than
CPU. If the stage call throws without failing the job, the job instead lands in
`interrupted` and joins the immortal set in H-8 — either outcome is bad.

**Ceiling:** `PROCESSING_CREATE_UID_PER_MINUTE = 30`
(`src/auth/auth.guard.ts:132-136`), times unlimited accounts (C-4). At the limit
that is up to ~3 GB/min of input egress per account, and ~43,200 cycles/day.

**Recommended direction:** three changes, all small. (a) Debit the allowance on
any job that reached `processing`, refunding only failures that occurred before
the worker downloaded the input. (b) Cap retries per job and per user per day,
independent of failure code. (c) Reconcile measured duration against declared
duration at admission and reject a declaration that is grossly wrong before the
worker is ever asked to claim it — a 1-second declaration for a 30-minute file
should never reach a worker.

---

### HIGH

#### H-1 — S3 versioning is mandatory and lifecycle expiry is forbidden

**CONFIRMED.** `src/storage/storage-preflight.service.ts` fails startup unless
versioning is `Enabled` (`:129`) and no lifecycle rule contains an `Expiration`
beyond `ExpiredObjectDeleteMarker: true` (`safeLifecycleRule`, `:33-48`).
`startup-error.ts:49-50` carries `lifecycle expiration rules are not allowed` and
`unsafe lifecycle actions are not allowed`; `docs/operations/audio-processing.md:81-82`
confirms the intent.

Critically, the app **never enumerates the bucket** — there is no
`ListObjectsV2Command` anywhere in `src/`, and every cleanup task is created from
a database row (`src/storage/storage-cleanup.service.ts:33-55`). So an object no
row points at is invisible to every sweeper, forever, and the operator's only
backstop is refused at startup.

**Impact:** this single guard is what makes C-1, H-5, H-9 and H-11 _permanent_
rather than merely expensive. It removes the recovery option for all of them at
once.

**Recommended direction:** keep the versioning requirement (it makes the pinned
version download model safe) but allow one narrowly-scoped operator-owned rule
expiring **noncurrent** versions. `LIFECYCLE_RULE_KEYS`
(`src/storage/storage-preflight.service.ts:22-29`) currently would classify
`NoncurrentVersionExpiration` as unsafe and block startup, so the allowlist needs
that key added and validated.

---

#### H-2 — Incomplete multipart uploads are permitted but not required

**CONFIRMED.** `safeLifecycleRule` accepts `AbortIncompleteMultipartUpload`
(`:40-47`) but nothing requires it. A bucket with **no** lifecycle configuration
at all passes preflight — `lifecycleConfiguration()` returns `undefined` on
`NoSuchLifecycleConfiguration` (`:161-163`) and `lifecycleVerified` is then `true`.

**Trigger:** any interrupted upload — a mobile client on a flaky network killing a
30 MB PUT, which is the normal case for this app. Parts are billed while they
exist and are invisible to `ListObjects`, so the app's own cleanup never sees them.

**Recommended direction:** make `AbortIncompleteMultipartUpload` with
`DaysAfterInitiation: 1` a required precondition, not merely tolerated. (Note: the
app itself never uses multipart, so this is purely about client-driven failures.)

---

#### H-3 — Every authenticated request makes a Google network call

**CONFIRMED.** `AuthGuard.canActivate` verifies the bearer twice:

1. `verifySignature` → `verifyIdToken(token, false)` (`src/auth/firebase-identity.service.ts:36`)
2. `verifySession` → `verifyIdToken(token, true)` (`:41`)

The second argument is `checkRevoked`, which resolves to `getUser(uid)` →
`POST /accounts:lookup` — an **un-cached network call to Google on every
authenticated request** (`node_modules/firebase-admin/lib/auth/base-auth.js:962-964`).
At `AUTH_UID_PER_MINUTE = 120`, one account generates 120 Google calls/min =
**172,800/day**, and `/auth/verification-email` and `/auth/bootstrap` add a second
lookup (M-9). This is fully redundant with the Mongo revocation check the code
already performs at `src/auth/auth.guard.ts:173`
(`identity.authTimeSec <= user.sessionsRevokedAfterSec`).

**Impact:** latency (a Google round trip per request), quota (Identity Toolkit
volume scales with request volume — this is the Firebase pressure point, not
account count), and wasted work (the same token cryptographically verified twice).

**Recommended direction:** verify once, and drop `checkRevoked` to `false`. The
existing `sessionsRevokedAfterSec` check provides revocation enforcement from
Mongo with no Google call. Then collapse the two verifications into one.

**Ordering here is already correct — worth preserving.** The cheap CPU-only RS256
signature check (`verifySignature`) runs _before_ the identity budgets are
reserved, and the expensive network revocation lookup runs _after_
(`src/auth/auth.guard.ts:83` vs `:160`). So both the IP throttle and the per-UID
budget gate the Google call rather than trailing it. Two caveats: the
`processing-read` operation deliberately drops the generic UID bucket
(`:91-93`) and relies on its own 60/min budget, and per H-6 neither IP nor per-UID
bounds meaningfully constrain an attacker with unlimited free accounts (C-4).

---

#### H-4 — The Firebase timeout does not cancel, and the SDK retries 5×

**CONFIRMED.** `callFirebase` races the operation against a `setTimeout`
(`src/auth/firebase-identity.service.ts:69-88`). `Promise.race` resolves on the
timeout, but the losing promise — the real SDK call — keeps running; nothing
aborts it.

**Amplified by an SDK default:** `firebase-admin` applies its own retry policy —
`maxRetries: 4`, `statusCodes: [503]`, `ioErrorCodes: [ECONNRESET, ETIMEDOUT]`,
`maxDelay: 60s` (`node_modules/firebase-admin/lib/utils/api-request.js:109-116`).
Nothing here overrides it. So one client request during a Google 503 produces up
to **five** Google calls: the API returns 503 at 5 s while the SDK keeps retrying
for roughly 15 s more. With H-3's two verifications, one user request can generate
up to ten Google calls. There is no circuit breaker.

**Impact:** in-flight operations and sockets accumulate while Google stays slow,
on the smallest available box — memory and connection growth, recovered only by
restart. And quota keeps burning _after_ the API has already given up.

**Recommended direction:** stop making the call at all (H-3); set an explicit
retry policy bounded inside the 5 s deadline; add a circuit breaker that sheds
Firebase-dependent requests once the error rate crosses a threshold.

---

#### H-5 — Uploaded input bytes are retained for the life of the job row

**CONFIRMED.** Independent of C-1 and C-3, the happy path never reclaims input
storage. A completed `ready` job retains its input (≤30 MB v1, ≤100 MB v2) _and_
its output (≤30 MB default) indefinitely: no TTL on `audio_jobs`, no retention
window, no sweeper clearing `inputObject`. The only reclamation is an explicit
`DELETE /jobs/:id` or account deletion
(`src/jobs/job-deletion.service.ts:29-78`).

**Trigger:** ordinary use, no adversary. ~40 finished jobs at ~130 MB ≈ 5 GB — the
entire S3 free tier. Note the allowance system accounts only in audio-seconds, so
this cost is invisible to every quota in the application.

**Recommended direction:** a product decision, not a bug — see open question O-4.
Inputs are the larger object and are never needed again once processing succeeds,
so reclaiming inputs after a retention window is the cheapest option.

---

#### H-6 — IP-based limits have no effective bound against IPv6 clients

**CONFIRMED.** Every IP-keyed limit — the `overall` 600/min and `default` 60/min
throttlers plus the per-IP mail buckets — keys on `req.ip`, resolved through one
trusted proxy hop (`src/http/configure-http.ts:15`; the one-hop trust itself is
correct).

A client with an IPv6 allocation is typically delegated a **/64** — 2⁶⁴ addresses
it may source from, each a distinct tracker. The per-IP ceilings become
per-address ceilings that a single host resets at will.

**Impact:** the per-IP layer is the _only_ backstop for routes that never call
`RateBudgetService`, including every anonymous route in Appendix A. Every finding
that leans on an IP limit (M-1, M-6, and the anonymous-surface limits) is weaker
than it appears. In C-2 and C-4 the IP limits are supposed to bound cost, and here
they do not. H-7 is the concrete consequence.

**Recommended direction:** key limits on a /64 prefix for IPv6 rather than the full
address, as most production limiters do, and add per-account and per-day dimensions
so the IP layer is not load-bearing.

---

#### H-7 — Redis memory exhaustion converts abuse directly into a total outage

**CONFIRMED.** The throttler keys on `(throttler name, IP)`
(`src/rate-limits/api-throttler.guard.ts:25-31`). Each distinct IP creates a
`:hits` ZSET (≤61 members, ~7 KB) plus a `:block` key, expiring at `ttl+1000`
(`src/rate-limits/redis-throttler.storage.ts:24-26`). **There is no global counter
and no cap on the key space.**

**Trigger:** an IPv6 /64 (H-6) supplies unlimited distinct `req.ip`. At 100 k
IPs/min that is roughly **700 MB of Redis** in a single minute.

**Impact:** `docs/vps.md:14` and `docs/caprover.md:135` both mandate
`maxmemory-policy noeviction` — correctly, so that eviction cannot silently reset
security counters. But under `noeviction`, once memory is full Redis **rejects
writes**, every limiter throws `ServiceUnavailableException`
(`redis-throttler.storage.ts:104`), and because the throttler fails **closed** the
result is **503 for the entire API** — `/health/live` excepted. So the abuse path
is not "extra cost", it is a one-minute denial of service.

**Secondary bug in the same guard:** the counter is shared across routes while the
limits are per-route. `app-updates` sets 10/min on the same `api-default-ip` key
that other routes use at 60/min, so 11 calls to the strict route block every other
default-throttled route for 60 s. (Confirmed against
`test/security.e2e-spec.ts:104-125`.)

**Recommended direction:** add a coarse global counter with its own ceiling so the
key space cannot grow without bound, and separate the throttle key per route, not
just per throttler name.

---

#### H-8 — An interrupted job has no exit and permanently consumes a global slot

**CONFIRMED. This is worse than "no automatic cleanup" — there is no remediation
path at all.** I verified every candidate exit for `interrupted`:

| Attempted exit     | Code                                                                                          | Result                                             |
| ------------------ | --------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| User retry         | `assertRetryable` requires `status === 'failed'` (`src/jobs/job-actions.service.ts:386-389`)  | `JOB_STATE_CONFLICT`                               |
| Admin retry        | explicit guard (`:239-240`)                                                                   | `WORKER_RECOVERY_REQUIRED`                         |
| User/admin cancel  | `nextCancellationState('interrupted')` → `'cancel_requested'` (`src/jobs/job-state.ts:70-78`) | renamed, but `cancel_requested` is **also** active |
| `DELETE /jobs/:id` | requires `ready`/`failed`/`cancelled` (`src/jobs/job-deletion.service.ts:38-39`)              | `JOB_ACTIVE`                                       |

`interrupted` and `cancel_requested` are both members of
`ACTIVE_ADMISSION_STATUSES` (`src/jobs/job-state.ts:9-17`) and are counted by
`QueueCapacityService.assertCapacity` (`src/processing-queue/queue-capacity.service.ts:185-202`).
**Worker recovery is the only exit**, and `processing-maintenance.service.ts:29`
only expires worker leases — it does not age out jobs, and there is no alert.

**Trigger:** a worker crash, or a device uninstalled mid-job — no adversary needed.
Per user, one stuck job means permanent `PROCESSING_LIMIT_REACHED` and permanent
`busy` availability. Globally, `maxOutstandingAudioSeconds` defaults to 60 000, so
**~34 stuck 30-minute jobs brick the queue for every user**, permanently.

**Impact:** monotonic, non-self-healing consumption of the global admission
budget, requiring manual database surgery to clear. No metric, no alert.

**Recommended direction:** age out any job that has not progressed in a bounded
window (e.g. 7 days) into a terminal failed state, refunding allowance and
scheduling storage cleanup. This is the same fix C-1 and M-8 need, so implement it
once.

---

#### H-9 — One leaked download URL can consume the entire egress allowance

**CONFIRMED (dormant — `APP_UPDATES_ENABLED` defaults `false`,
`src/config/environment.ts:103`). Highest request-to-dollars ratio in the codebase.**

`POST /api/v1/app-updates/releases/:id/open` and `.../download` are `@Public()` and
return a presigned S3 GET URL (`src/releases/app-updates.controller.ts:35-43, 52-64`)
with a 300 s lifetime and `ResponseCacheControl: 'no-store'`
(`src/releases/release-artifact-storage.service.ts:129-148`). APK objects may be up
to `APK_MAX_BYTES = 268_435_456` (256 MB)
(`src/releases/apk-verifier.service.ts:11`). The route's `@Throttle` of 10/min is
per-IP and counts **grants, not bytes**.

**Trigger:** obtain one signed URL (post it publicly, or read the release id from
the public `GET /app-updates/policy`, which exposes `target.id` at
`src/releases/release-policy.service.ts:69-84`), then fetch it at line rate for
5 minutes, re-granting once per 5 minutes from a handful of IPs. **400 downloads
of a 256 MB APK = 100 GB — the entire free egress allowance — from essentially one
request.** The URL is the bearer token, so per-IP throttling is irrelevant once it
leaks. There is no CDN and `no-store` means nothing absorbs the fan-out.

**Recommended direction:** before enabling `APP_UPDATES_ENABLED`: shorten the
download grant to well under 60 s, put the artifacts behind a CDN or a caching
proxy, and add a per-object and per-day byte budget. This is the one finding where
a single leaked URL has an unbounded ceiling.

---

#### H-10 — A stuck account deletion loops forever and permanently locks the user out

**CONFIRMED.** `AccountDeletionCleanupService` retries a failing deletion at a
fixed 60 s interval with **no attempt cap, no backoff growth, no dead-letter, and
no log** (`src/users/account-deletion-cleanup.service.ts:131, 223-234`). It holds
a `blocked: true, expiresAt: null` identity fence — and the TTL index is on
`expiresAt` (`src/users/user-identity-fence.schema.ts:22-26`), which MongoDB's TTL
monitor ignores when `null`. So the fence is immortal.

`withProvision` filters `blocked: false` (`src/users/user-identity-fence.service.ts:38-50`
via `src/users/users.service.ts:34`), so the Firebase uid **can never re-register** —
it fails as a duplicate key and surfaces as `ACCOUNT_DISABLED`.

**Trigger:** any persistent failure — S3 cleanup never draining for that owner, or
any non-`user-not-found` Firebase error (`:217`).

**Impact:** permanent per-account CPU/Mongo retry loop at 4/min, _and_ the user is
permanently locked out of their own identity with no support path. `ALERT_TYPES`
(`src/admin-observability/admin-alert.schema.ts:5-10`) has four kinds and **none is
deletion-related**, so this is silent. Related: `account-deletion-maintenance`
processes exactly one account per 15 s tick (`:35-64`), so 1 000 queued deletions
take ≥4.2 hours.

**Recommended direction:** cap attempts, escalate backoff, surface a stuck deletion
as an admin alert type, and make the identity fence expire so a failed deletion
does not become permanent identity loss.

---

#### H-11 — Startup crash-loops permanently on an index-name conflict

**CONFIRMED.** `autoIndex: true` / `autoCreate: true` run in production
(`src/infrastructure/database.module.ts:7-8, 12-13`), and
`src/operations/auth-indexes.startup.ts:71-83` deliberately converts a MongoDB
code-86 conflict into a thrown `StartupDependencyError`, which `main.ts:24-27`
turns into `process.exit(1)`.

**Trigger:** a deploy that changes an index's _key_ while keeping its _name_.

**Impact:** the container boots, throws, exits, CapRover restarts, throws
identically — a deterministic, self-perpetuating crash loop. If the old container
was already replaced this is a **total outage with no self-recovery**. The
`indexConflictProvider` helper (`:38-69`) exists because this has already happened
once. A secondary version: index _builds_ run at every boot for every model
(`src/processing/processing-startup.service.ts:37-46`), and a new index on a large
`audio_jobs` can exceed the health-check window → restart → rebuild.

**Recommended direction:** this exit is deliberate and correct for correctness, so
the fix is operational — make index changes a separate, explicitly-run migration
step (`npm run ops:auth` already exists) rather than an implicit boot action, and
add a startup-failure alert so a crash loop is visible rather than silent.

---

#### H-12 — `confirmUpload` burns the monthly GET allowance in a day

**CONFIRMED.** `JobService.confirmUpload` (`src/jobs/jobs.service.ts:155-160`) calls
`storage-transfers.inspect`, which issues **two** billable `HeadObject` GETs
(`src/storage/storage-transfers.service.ts:251-295`), and `findOwned` only
short-circuits once `inputObject` is set — so every call while the job sits in
`awaiting_upload` pays both.

**Trigger:** one account polling `POST /jobs/:id/upload-complete` at the
`processing-grant` limit of 60/min → **172,800 GETs/day**, against a free-tier
allowance of **20,000 GETs per month**. `maxAttempts: 3` on the S3 client
(`src/infrastructure/storage.module.ts:8`) multiplies it further on transient
errors.

**Recommended direction:** short-circuit when `inputObject` is already set (make
the operation idempotent before touching S3), and collapse the two `HeadObject`
calls into one — the second re-read of the same version cannot return different
data.

---

#### H-13 — A slow (not down) Redis starves the whole process

**CONFIRMED.** H-7 covers Redis running _out of memory_. This is the quieter
variant: Redis is up but slow, and the client configuration turns that into
process-wide resource exhaustion.

- `commandTimeout: 5000` (`src/rate-limits/security-redis.provider.ts:16-21`) and
  the throttler runs **first** in the guard chain, so **every** request — public
  pages, `/health/ready`, everything — blocks on Redis before any other work. An
  authenticated request costs 3 sequential `EVAL`s → up to ~15 s of a held socket,
  bounded only by `server.requestTimeout = 30 s`.
- **`enableOfflineQueue` is never set**, so it stays at the ioredis default of
  `true`: while Redis is degraded, commands queue **in process memory** with no
  bound. A slow Redis therefore converts into unbounded heap growth.
- **No concurrency ceiling exists.** `server.maxConnections` is unset and there is
  no in-flight request cap (`src/http/configure-http.ts:87-89` sets only
  `requestTimeout`, `headersTimeout`, `keepAliveTimeout`).
- **The Mongo pool is 10** (`src/infrastructure/database.module.ts:15`,
  `maxPoolSize: 10`, `serverSelectionTimeoutMS: 5000`). A few hundred concurrent
  requests pin hundreds of sockets waiting on Redis and then contend for 10 Mongo
  connections, starving legitimate traffic.

**Trigger:** Redis under memory pressure, a network hiccup, or a provider-side
slowdown — not an attack, just degradation.

**Impact:** availability. Every other fail-closed behaviour in this system assumes
Redis answers _quickly_; none of them bound what happens when it answers _slowly_.
Note this is the deliberate cost of failing closed, and failing closed is the right
call — the fix is to bound the resources, not to fail open.

**Recommended direction:** set `enableOfflineQueue: false` so a degraded Redis
rejects immediately instead of accumulating; set `server.maxConnections`; add an
in-flight request cap or a small circuit breaker that sheds load after consecutive
Redis timeouts. `retryAttempts: 1` is already set on Mongo — the Redis side needs
the equivalent.

---

### MEDIUM

#### M-1 — Uncapped push registrations multiply notification rows and sends

**CONFIRMED by search.** No per-user cap on push registrations:
`PushRegistrationsService` has only `MAX_WRITE_ATTEMPTS = 3` and `PAGE_LIMIT = 50`
(`src/notifications/push-registration.service.ts:20-21`), and
`push-installation.schema.ts` defines three indexes with no count constraint. Each
job outcome fans out to every eligible registration (`TARGET_PAGE_SIZE = 50`,
`SENDS_PER_LEASE = 4`, `notification-dispatcher.service.ts:23-25`). Retries are
properly bounded (`MAX_ATTEMPTS = 8`, capped backoff `:27-29`) — that part is sound.

**Trigger:** one account registers many installation IDs, then runs jobs. Each job
writes one `audio_notification_deliveries` row **per registration**, into a
TTL-less collection (C-3), and sends one FCM message per row.

**Recommended direction:** cap registrations per user (e.g. 10), and TTL the
delivery collection. Combined with C-3 this is the fastest-growing collection.

---

#### M-2 — Download grants are replayable for their whole lifetime

**CONFIRMED.** `createDownloadGrant` signs a plain presigned `GetObject` valid for
`PROCESSING_URL_SECONDS` — default **900 s**
(`src/storage/storage-transfers.service.ts:154-156, 191-218`). The URL is a bearer
credential: anyone holding it can fetch repeatedly for 15 minutes, with
`ResponseCacheControl: 'no-store'` so every repeat is fresh billable egress. No
single-use enforcement, no revocation. Admin media grants are tighter (300 s,
version-pinned, `:185`).

**Trigger:** a leaked or deliberately shared URL. `PROCESSING_GRANT_UID_PER_MINUTE=60`
means one account can hold up to 900 concurrent valid URLs for its own objects.

**Recommended direction:** shorten download-grant lifetime; H-9 plus a CDN is the
structural fix for the egress ceiling.

---

#### M-3 — `admin_alerts` accumulates rows on flapping conditions

**CONFIRMED.** `admin_alert_active_condition_unique` is a partial unique index on
`{type, resourceId}` with `partialFilterExpression: { state: 'active' }`
(`src/admin-observability/admin-alert.schema.ts:56-62`) — it constrains _active_
rows only, and the collection has no TTL.

**Trigger:** a worker flapping offline/online; each resolve-then-re-fire cycle
creates a **new** row because the previous one is no longer `active`.

**Impact:** unbounded growth driven by infrastructure flapping rather than user
activity — accelerating exactly when the system is already unhealthy.

**Note:** `admin_alert_observations` is **not** a problem — it is keyed
`_id: AlertType`, so it holds exactly 4 documents, ever
(`admin-alert-observation.schema.ts:10-11`). Do not add a TTL there.

**Recommended direction:** TTL on resolved alerts, or bounded history per condition.

---

#### M-4 — Maintenance polls multiply with replica count

**CONFIRMED.** There is **no scheduler framework** — no `@nestjs/schedule`, no
`@Cron`. Five services each run a raw `setInterval`, all `unref()`ed, with **no
leader election**:

```
src/releases/release-upload-cleanup-maintenance.service.ts:23   15 s
src/processing/processing-maintenance.service.ts:29             15 s
src/storage/storage-cleanup-maintenance.service.ts:29           15 s
src/users/account-deletion-maintenance.service.ts:23            15 s
src/notifications/notification-maintenance.service.ts:35         5 s
```

Two gate on `AUDIO_PROCESSING_ENABLED` and are off by default. **Correctness is
safe**: every loop has a re-entrancy guard (`if (this.running) return`) and the
work is lease-claimed (`cleanupToken`/`cleanupLeaseUntil`, `cleanupNextAt`,
`cleanupScheduledAt`).

**Impact is cost, not correctness:** each extra API container multiplies polling
load — 5,760 cycles/container/day of indexed queries — against the same 512 MB and
shared-vCPU budget.

**Recommended direction:** fine at one container, which the CapRover guide assumes.
Document that assumption explicitly; add a distributed lease before scaling out.

---

#### M-5 — Every maintenance loop swallows every failure silently

**CONFIRMED.** `processing-maintenance.service.ts:35-37`,
`storage-cleanup-maintenance.service.ts:25`,
`release-upload-cleanup-maintenance.service.ts:32`,
`notification-maintenance.service.ts:29`, `account-deletion-maintenance.service.ts:28`
each catch everything and emit at most a `logger.warn`.

**Impact:** cleanup stopping is indistinguishable from cleanup having nothing to
do. Given H-8, H-9 and H-12, silent cleanup failure is the failure mode that turns
every other leak from "bounded" into "unbounded". No metric, no alert.

**Recommended direction:** count and alert on consecutive failures per loop, and
expose last-success time. This is cheap and it is the detection layer for
everything else in this document.

---

#### M-6 — A single drained bucket locks every real user out of password reset

**CONFIRMED.** `reset-project-day` is one project-wide bucket (limit 50, 24 h
window) with no per-user carve-out (`src/auth/auth-mail.service.ts:117-122, 132-135`),
gated only by 5/hr per IP. Unregistered addresses burn the same budget because
`EMAIL_NOT_FOUND` is swallowed _after_ reservation
(`src/auth/firebase-mail.service.ts:82-83`).

**Trigger:** ~50 requests across 10 IPs — or one IPv6 /64 (H-6), or instantly via
C-4. Same shape applies to `VERIFY_PROJECT_PER_DAY = 200`: ~67 throwaway accounts
exhaust email verification for everyone, which blocks processing if
`requireVerifiedEmail` is on. A `FirebaseMailQuotaError` also sets a 15-minute
project-wide `mail-pause` (`:140-147`).

**Impact:** availability, not cost. Every legitimate user loses password reset for
the remainder of the 24-hour window, and the breaker then 503s everyone for 15
minutes at a time. On an app whose only credential recovery is password reset,
this is a 24-hour account-lockout attack, free to run.

**Recommended direction:** the shared bucket is only fatal because its capacity is
consumable out-of-band — fixing C-4 reduces this to a per-IP problem. Independently,
reserve headroom (cap attacker-reachable consumption at ~60 % of the daily
allowance) so one source cannot exhaust the window for everyone.

---

#### M-7 — A cleanup task that can never succeed is retried hourly forever

**CONFIRMED.** On any exception, `StorageCleanupService`
(`src/storage/storage-cleanup.service.ts:109-129`) caps `attempts` at 20 and sets
`nextAt = now + min(3_600_000, 30_000·2^(failures-1))`, leaving `completedAt: null`.
The only TTL is on `completedAt` (`storage-cleanup-task.schema.ts:63-66`), which
MongoDB's TTL monitor ignores when `null`. **The row is immortal and re-queried
every hour.** The 20-attempt cap stops the counter, not the retries — there is no
dead-letter state and no alert.

**Trigger:** any persistent S3 failure — a revoked IAM permission makes
`sweepVersionsForKey` throw `'Artifact cleanup unavailable'`
(`src/storage/storage-transfers.service.ts:105-110`) for _every_ key. 5,000 jobs
processed before S3 access broke → 5,000 immortal rows, each claimed hourly →
+120 k queries/day plus 5,000×2 lease updates/day.

**Related (LOW):** `schedule()` uses `$setOnInsert` without unsetting
`completedAt` (`:38-54`), so an object created at a key whose cleanup task already
completed is never claimed again. Not reachable through normal keys (attempt IDs
are globally unique, input keys carry a fresh `randomUUID`) **except** after
account deletion purges `audio_job_attempts`, which frees an old attemptId for
reuse. Contrived, but the failure is permanent.

**Recommended direction:** dead-letter after N failures with an alert, and clear
`completedAt` on re-schedule.

---

#### M-8 — `reserved` ledger rows are TTL-less and counted forever

**CONFIRMED.** The TTL on `processing_usage_ledger` is on `purgeAt`
(`src/processing-usage/processing-usage.schema.ts:26-27, 34`), which only
`settleJob` ever sets. `reserveForJob` (`:122-134`) leaves it `null`, so **unsettled
`reserved` rows never expire**, and `readUsage` matches `{state: 'reserved'}` with
**no time bound** (`:30-36`).

**Three ways to get a permanent `reserved` row:**
(a) H-8's stuck jobs — never settled;
(b) `settleJob`'s early return at `:171`: a `ready` job with null
`processingStartedAt`/`measuredDurationSeconds` returns _without releasing_
(reachable via recovery finalizing `ready` at `worker-recovery.service.ts:457` for
a job interrupted while `validating`);
(c) `complete` accepts an optional `executionEvidence`
(`worker-terminal.service.ts:136-145`).

**Impact:** unbounded ledger growth **plus silent permanent allowance loss the
user cannot repair** — the reservation counts against their 3600 s forever. No
reconcile or repair job exists anywhere.

**Recommended direction:** set `purgeAt` on reservation as a backstop, bound
`readUsage` by age, and add a reconcile job that releases orphaned reservations.

---

#### M-9 — `/auth/verification-email` is a pure Google-quota amplifier

**CONFIRMED.** The route carries no `@LimitOperation`
(`src/auth/auth.controller.ts:39-45`), so only the generic 120/min private-UID
bucket applies, and it performs an uncached `getProfile` **before** any mail budget
is reserved (`src/auth/auth-mail.service.ts:29`).

**Trigger:** an already-verified user loops the endpoint. Each call performs two
uncached Google lookups, sends no mail, and returns `already_verified` with a 200.
At 120/min that is **240 Google calls/min/account** for zero useful work.

**Recommended direction:** early-return `already_verified` from a local check
before any Google lookup, and give the route its own operation budget.

---

#### M-10 — The fair-queue aggregate can't use its index and rewards fresh accounts

**CONFIRMED.** The usage `$lookup` in `FairQueueService` matches via `$expr`
(`src/processing-queue/fair-queue.service.ts:120-145, 180-190`), which is opaque to
the query planner, so the `{userId: 1, expiresAt: 1}` index is unusable — and this
sub-pipeline runs for **every eligible queued job on every selection**, i.e. on
every worker claim (`src/worker/worker-coordinator.service.ts:182`).

The sort key `recentWorkerSeconds` is a raw ascending recent-usage sum, so a
user with **zero history always outranks everyone** with any. The `agingThresholdSeconds`
(900 s) tier only rescues established users after 15 minutes of waiting.

**Impact:** the most likely throughput ceiling on free-tier Mongo (hundreds of
thousands of index fetches per claim at 100 queued jobs, `maxTimeMS 5000`), plus
misallocation: a free-account farm (C-2, C-4) queue-jumps every repeat user
indefinitely.

**Recommended direction:** replace `$expr` with a plain equality match so the index
applies, and change the fairness key so that zero history is neutral rather than
optimal.

---

#### M-11 — Admission serialises on one document, and bursts surface as 500s

**CONFIRMED.** Every create/retry/confirmUpload/stage takes `$inc` on the single
`settings` fence doc and the single queue-counter doc
(`src/processing-queue/queue-capacity.service.ts:149-161`,
`src/admin-settings/processing-admission.service.ts:42-48`,
`src/jobs/job-actions.service.ts:273`, `src/jobs/jobs.service.ts:161`). So **all
admissions globally serialize**, and each fenced transaction runs the full
`readSummary` aggregation under `maxCommitTimeMS 5000` / `timeoutMS 10000`.

**Impact:** no miscount (verified — see §4), but a burst produces all-but-one
`WriteConflict` → `withTransaction` re-runs the whole callback → the 10 s budget
can be exhausted, surfacing an unhandled 500 instead of a clean 503. It also
multiplies M-10's cost inside the mutex.

**Recommended direction:** return `503` with `Retry-After` when the transaction
budget is exhausted rather than letting the error escape, and consider a
sharded/segmented counter if admission throughput ever matters.

---

#### M-12 — Uncached anonymous Mongo reads, and half-finished TTL coverage

**CONFIRMED.** `AppPolicyService.current()` has no cache
(`src/app-policy/app-policy.service.ts:22-31`). It is read by the public
`GET /api/v1/app-policy` and twice by `GET /api/v1/processing-policy`, so an
anonymous loop costs **120 uncached Mongo reads/min/IP** (~173 k/day/IP) against
M0's shared IOPS, with no global or per-day bound — and per H-6 the IP bound is
defeatable.

Also, `client_errors` accumulates one row **per client-supplied `eventId`**
(`src/client-errors/client-error.schema.ts:83-86`), deduped on that value alone, so
generating fresh UUIDv4s bypasses dedup: ~43,200 rows/day (~17 MB/day) per account,
each behind a full Mongo transaction plus 2 reads and 1 Redis `EVAL`. The payload
is structurally bounded (all fields enum or `@MaxLength`) — it is a volume problem,
not a size problem. Only purge is user-initiated account deletion
(`src/users/account-deletion-cleanup.service.ts:209`).

**Recommended direction:** cache the two policy documents (they change only on
admin action — effectively free to cache), and add a per-user daily cap plus
retention for `client_errors`.

---

#### M-13 — Smaller items, grouped

- **`POST /users/me/account-recovery` has no `@LimitOperation`**
  (`src/users/users.controller.ts:46-54`) so only the generic 120/min uid bucket
  applies, versus 5/min for `DELETE /users/me` which does carry
  `@LimitOperation('profile')`. Each call runs `startSession` + `withTransaction`
  - 2–4 Mongo ops (`src/users/account-recovery.service.ts:78-136`). Requires a
    valid token for an account already `deleting`. **Fix:** add the decorator.
- **`/health/ready` pings Mongo and Redis on every anonymous call**
  (`src/http/health.controller.ts:28-48`); `@SkipThrottle` is applied only to
  `live` (`:22`). 60/min/IP × 2 round trips, usable to keep a free-tier instance
  warm. **Fix:** cache readiness for a few seconds.
- **APK verification has a rate cap but no concurrency or disk cap**
  (`src/releases/apk-verifier.service.ts:11-12, 299`): 250 MB max, 90 s timeout, a
  full-size `mkdtemp` and 3 subprocesses per run, at
  `ADMIN_SENSITIVE_OPERATIONS_PER_MINUTE = 5` — a rate, not a semaphore, so ~7 runs
  overlap at steady state ≈ 1.75 GB temp and ~21 process-group children. Admin-only
  and otherwise well-hardened (no shell, process-group SIGKILL, central-directory-only
  zip validation). **Fix:** a semaphore of 1–2.
- **Association of SSE-KMS:** the preflight verifies five bucket properties but
  never calls `GetBucketEncryption` (`src/storage/storage-preflight.service.ts:90-167`),
  and the app sets no `ServerSideEncryption`. If the bucket default is SSE-KMS,
  every PUT/GET adds KMS request charges and KMS throttling silently degrades
  uploads — in a path the app never inspects. **Fix:** add the check to preflight.
- **Snapshot-stale queue limits** (`src/processing-queue/queue-capacity.service.ts:179-184`):
  `assertCapacity` prefers the frozen `admissionSnapshot.queueLimits` over the
  freshly-read policy, so a "shrink the queue now" admin action does not apply to
  already-admitted jobs — the emergency lever fails exactly when needed.
- **One malformed ledger row can brick a user permanently**
  (`src/processing-usage/usage-accounting.ts:15-16`): `summarizeUsage` throws a bare
  `Error` on any non-safe-integer `audioSeconds`, and that propagates out of
  `readUsage` → out of `reserveForJob` inside the admission transaction → the user
  can never create a job again, and `GET /processing-usage` 500s forever. The schema
  currently prevents it, but there is no repair tooling or admin path. **Fix:** skip
  and quarantine bad rows rather than throwing.
- **`@LimitAdmin` sets no `ADMIN_ROUTE`** (`src/admin/admin.decorators.ts:10-17`).
  Today export throttling works only because every handler _also_ carries
  `@RequireAdminPermission`; `admin.guard.ts:44-48` returns `true` before any check
  when only `ADMIN_ROUTE` is absent. Currently dead — every existing route is
  decorated correctly — but a future `@LimitAdmin`-only route would get **no auth
  and no rate class**. **Fix:** have `@LimitAdmin` imply `ADMIN_ROUTE`. The 5/hour
  export cap itself is real and enforced _before_ the query
  (`admin.guard.ts:64-75`), with output bounded by `MAX_EXPORT_ROWS = 10000`.

---

#### M-14 — Every IP limit rests on one nginx directive this repo does not own or check

**CONFIRMED as an unvalidated dependency, not as a live bug.**

`app.set('trust proxy', 1)` (`src/http/configure-http.ts:15`) makes `req.ip` the
last `X-Forwarded-For` entry, trusting exactly one hop. That is the correct setting
for CapRover's single nginx — _provided nginx **appends** to XFF_ (CapRover's
default `$proxy_add_x_forwarded_for` behaviour appends, which is why H-6's analysis
of "unspoofable" holds).

The failure mode: if nginx is ever configured to forward the client's XFF
unchanged, or the container becomes reachable by a second path (a published port, a
sidecar, a debug route), then `req.ip` becomes **attacker-chosen** and every
IP-based limit in this document — the throttlers, the mail buckets, H-6, H-7 — is
defeated by a single header. The code enforces none of this: no trusted-CIDR list,
no hop assertion, no startup check. `docs/caprover.md:55` and the README document
the assumption; nothing verifies it.

**Recommended direction:** treat this as an operational invariant and verify it
externally (confirm the nginx template appends rather than passes through, and
confirm the container port is not separately reachable). If you want it enforced in
code, `trust proxy` accepts a trusted-CIDR list — using the proxy's actual subnet
instead of a hop count makes the assumption explicit and testable.

---

## 4. Verified sound — do not "fix" these

These came up as candidates and are actually correct. Changing them would weaken
the system.

**Concurrency and accounting (the strongest area of the codebase)**

- **`M-6`-class TOCTOU double-spend does not exist.** This was my own SUSPECTED
  finding; it is now **closed as safe**. `ProcessingAdmissionService.assertNewWork`
  runs with the session from `transactions.run`
  (`src/jobs/jobs.service.ts:55-68`, `src/jobs/job-actions.service.ts:168-182`),
  bumps the per-user fence `user:<id>` and the global fence `_id:'settings'` with
  `$inc` **before** reading allowance
  (`src/admin-settings/processing-admission.service.ts:42-48`), then does the
  per-user active count, then `assertCapacity`, then `usage.reserveForJob` — which
  hard-requires `session.inTransaction()` (`processing-usage.service.ts:99-100`).
  Two concurrent creates for one user both write the same fence doc → `WriteConflict`
  on the second → `withTransaction` re-runs against a fresh snapshot → the loser
  sees the winner's committed job and ledger row. Orphaned transactions cannot
  happen: the ledger `_id` **is** the job `_id`, created in the same transaction,
  and `EnqueueService.next` is session-scoped so the FIFO counter rolls back on
  abort. **The concurrency test is not needed.**
- **Counters are derived by counting documents, not incremented** — so they cannot
  drift. `queueOrder` is `$inc`'d inside the transaction and rolls back with it.
- **`settleJob` is idempotent**, and refunds cannot cross users.
- **`cancellationDebit` clamps to `[1, duration]`**, and numeric inputs are
  validated — no NaN, negative, or overflow path.
- **No timezone bug**: the allowance window is a rolling 24 h anchored to
  `processingStartedAt`, not a local-time daily reset.

**Storage**

- **Upload grants are genuinely immutable.** `createImmutableUploadGrant` pins
  `ContentLength`, `ChecksumSHA256` and `If-None-Match: *`, and signs the content
  headers (`signableHeaders` + `unhoistableHeaders`). The generated URL carries
  `X-Amz-SignedHeaders=content-length;content-type;host;if-none-match;x-amz-checksum-sha256`,
  so S3 itself rejects an oversized or wrong-content body and there is no
  unlimited-PUT replay. Strongest part of the storage design.
- **Actual size is re-verified after upload** via `HeadObject` with
  `ChecksumMode: 'ENABLED'` on all three paths
  (`storage-transfers.service.ts:280-287`, `release-artifact-storage.service.ts:73-81`).
- **Version deletion removes real versions**, not just delete markers
  (`storage-transfers.service.ts:87-99`), with correct exact-key pagination and
  fail-closed behaviour on truncation (`:114-119`).
- **No multipart anywhere in the app**, so no orphaned parts are billable from our
  own writes (H-2 is purely about client-side interruptions).
- **Job deletion waits `PROCESSING_URL_SECONDS + 300 s`**
  (`job-deletion.service.ts:42-44`) — strictly longer than any outstanding grant, so
  there is no data-loss race.
- **No avatar or Firebase Storage objects exist**, so account deletion has no fourth
  bucket to reconcile.
- **APK temp files are cleaned in a `finally`** (`apk-verifier.service.ts:353`).

**Request handling**

- **The rate limiter fails closed** (`redis-throttler.storage.ts:104`) — any Redis
  error becomes `ServiceUnavailableException`. Expensive (see H-7) but correct: no
  unbounded traffic during a Redis outage. Every rate-limit layer behaves this way
  (`rate-budget.service.ts:54-56`, `auth-mail.service.ts:140-149`).
- **Rate-limit keys always get a TTL** — `PEXPIRE KEYS[1] ttl+1000` on every hit
  (`redis-throttler.storage.ts:32`). No unbounded key growth _per key_; H-7 is
  about the number of distinct keys.
- **The Redis client is bounded**: `commandTimeout: 5000`, `maxRetriesPerRequest: 1`,
  retry capped at 1 s (`security-redis.provider.ts:16-21`).
- **Throttling runs before authentication** — both `ApiThrottlerGuard` and
  `AuthGuard` are `APP_GUARD`s and `SecurityModule` precedes `AuthModule`
  (`src/app.module.ts:26-27`). Firebase verification volume is bounded by the IP
  ceiling. _(Latent risk: nothing asserts or tests this ordering. Consider a test.)_
- **IP derivation is not spoofable by a single client** _given a correct proxy
  configuration_: `trust proxy` is exactly one hop (`configure-http.ts:15`),
  matching CapRover's Nginx, which appends to XFF by default. `docs/caprover.md:53`
  warns that adding a proxy layer invalidates this — keep that warning. **This is
  an unvalidated external assumption, not a code-enforced invariant — see M-14.**
  (H-6 is a separate problem: unspoofable ≠ bounded.)
- **Body limit is uniform** and Joi-bounded 1 KB–1 MB
  (`environment.ts:219-223`); the sole override uses `EVENT_BODY_BYTES = 64 KB`,
  path-anchored to the two worker event routes. No route is larger or unlimited.
- **Auth rejects duplicate `Authorization` headers** and caps header length
  (`auth.guard.ts:76-81`).
- **`POST /client-errors` is authenticated.** A premise I started with was wrong and
  the code disproves it: no `@Public()`, `AuthGuard` is an `APP_GUARD`, and the
  handler reads `req.user!._id` (`client-errors.controller.ts:12`). It grows because
  nothing prunes it (C-3, M-12), not because outsiders can inflate it.
- **No cross-user leakage found.** All device/user queries are owner-scoped with
  revision CAS (`devices.service.ts:175, 186-190, 201-207`;
  `device-installation-owners.service.ts:66-83`); fence keys are `sha256(uid)`.
- **No admin route escapes its decorator.** `RequireAdminPermission` sets
  `ADMIN_ROUTE` via `applyDecorators` (`admin.decorators.ts:10-14`); every admin
  path was checked.

**Auth and mail**

- **Account recovery sends no mail and has no token.** `AccountRecoveryService.request`
  requires a valid Firebase token for an account already in `deleting` state and
  writes an idempotent, admin-reviewed row — no code, no entropy, no expiry, no
  compare. Enumeration, mail-bomb and brute-force are absent by construction. (An
  earlier working assumption that this was a pre-auth mail flow was wrong.)
- **Password reset has no enumeration oracle.** Buckets are reserved _before_
  `send()` (`auth-mail.service.ts:136`), `EMAIL_NOT_FOUND` is swallowed and returns
  the same response, the same Google round trip happens on hit and miss, and
  `getUserByEmail` is never called on this path. The bound holds against _this
  backend_ — C-4 is what breaks it, and that break is outside this code.
- **A failed `pause()` opens no window** — the same request falls through to
  `SERVICE_UNAVAILABLE` and `reserve()` fails identically while Redis is down
  (`auth-mail.service.ts:144-146`).
- **Startup secrets are not tracked in git.** `git ls-files` shows only the two
  example files; `.gitignore` excludes `.env.*`, `firebase-admin.json`,
  `*service-account*.json`. Credentials load from
  `FIREBASE_SERVICE_ACCOUNT_BASE64` with a project-ID cross-check
  (`firebase-service-account.ts:22-27`). The one tracked client config
  (`android/app/src/authE2e/google-services.json`) is a `demo-musicmute` placeholder.
- **`FirebaseMailService` is otherwise careful**: 5 s timeout, `redirect: 'error'`,
  and quota errors mapped to a distinct path.

**Background work**

- **The health sampler is pull-only, not scheduled.** `sample()` is called only from
  `AdminHealthService.read()` behind `@RequireAdminPermission('health.read')`, and is
  cached 30 s with in-flight dedup and 2 s probe bounds
  (`health-sampler.service.ts:49, 84, 305-317`). It cannot fill disk.
- **Every maintenance loop has a re-entrancy guard** and lease-based work claiming
  (M-4 — the loops are safe, only multiplied).

---

## 5. Recommended order of work

Ranked by (cost avoided) ÷ (effort). Independent of the worker.

**Do first — small changes, large effect**

1. **Cap retries and debit failures that reached the worker** (C-5). Highest
   exploitability in the document; three small edits. Also reject a declared
   duration that is grossly wrong for the uploaded object _before_ a worker claims
   it.
2. **Fix the cancel-orphan** (C-1) — schedule input cleanup in
   `cancelInTransaction`. A missing call, not new machinery.
3. **Age out non-progressing jobs** (H-8) into a terminal state, refunding and
   scheduling cleanup. This also fixes most of M-8's orphaned reservations.
4. **Add TTL indexes to the eight unbounded collections** (C-3), and set `purgeAt`
   on reservation as a backstop (M-8).
5. **Cache the two policy documents** (M-12) — near-free, removes the cheapest
   anonymous Mongo load.

**Then — requires a decision or console work**

6. **Restrict the Firebase web API key, and/or move mail off Firebase's client
   endpoint** (C-4, M-6, M-9). Console-side, no code change, and the prerequisite
   for C-2's caps meaning anything.
7. **Add a global daily budget counter** (C-2) inside the existing admission
   transaction — which, per C-4, must not treat account count as trustworthy.
8. **Cache policy reads and add a coarse global throttle counter** (H-7, M-12) so
   the key space cannot grow without bound and the per-route counter is separate.
9. **Bound the Redis client** (H-13): `enableOfflineQueue: false`,
   `server.maxConnections`, and an in-flight cap or breaker. Small config changes
   that stop degradation from becoming process-wide exhaustion.
10. **Key IPv6 limits on a /64** (H-6).
11. **Verify the proxy assumption externally** (M-14): confirm the nginx template
    appends to XFF and that the container port is not separately reachable. No code
    change required unless you want `trust proxy` to take a trusted-CIDR list.

**Then — correctness and durability**

12. **Give stuck deletions an attempt cap, an alert type, and an expiring fence**
    (H-10).
13. **Dead-letter failing cleanup tasks and clear `completedAt` on re-schedule**
    (M-7).
14. **Surface maintenance-loop failures as metrics/alerts** (M-5) — the detection
    layer for everything else.
15. **Drop `checkRevoked` and collapse the double verification** (H-3), then bound
    the SDK retry policy (H-4).
16. **Make `AbortIncompleteMultipartUpload` required** (H-2) and permit a narrow
    noncurrent-version expiry rule (H-1).
17. **Fix `confirmUpload`** to short-circuit before S3 and collapse its two
    `HeadObject` calls (H-12).
18. **Make index changes an explicit migration, not a boot action** (H-11).
19. **Make the inflated-duration throw debit rather than free** (C-5), and add
    retry caps per job and per day.
20. **Cap push registrations, TTL resolved alerts, fix the fair-queue `$expr`,
    return 503 on admission budget exhaustion, add the APK verifier semaphore,
    make `@LimitAdmin` imply `ADMIN_ROUTE`** (M-1, M-3, M-10, M-11, M-13).

**Before enabling `APP_UPDATES_ENABLED`**

21. **H-9 is a hard gate.** Shorten release download grants, put artifacts behind a
    cache/CDN, and add per-object and per-day byte budgets. Until then leave the
    flag off.

---

## 6. Open questions for you

- **O-1:** Which Redis provider and tier? Decides whether H-7 is a memory problem
  (self-hosted) or a commands/day problem (Upstash free = 10 k/day). Also please
  confirm the instance actually runs `maxmemory-policy noeviction` as
  `docs/caprover.md:135` instructs — the docs require it, nothing checks it.
- **O-2:** Which S3 tier, and is there an account-level billing alarm? Nothing in
  the code can stop S3 spend; only a budget or CloudWatch alarm can.
- **O-3:** Is Atlas M0 (512 MB) the actual target or a paid tier? C-3, C-5 and H-1
  are survivable on a paid tier and fatal on M0.
- **O-4:** What is the intended retention for user audio? The code retains
  everything forever by design. If users expect indefinite persistence, that is a
  product decision requiring a paid storage tier, not a code fix.
- **O-5:** How many API replicas? M-4 is a non-issue at one and a real cost at three.
- **O-6:** Is `APP_UPDATES_ENABLED` intended to ship? H-9 must close first.
- **O-7:** Do you want the worker-domain findings in Appendix B addressed now or
  after the worker work finishes? **A1 is live today and is the largest storage
  risk in the repository.**

---

## 7. Method and limitations

Findings marked CONFIRMED were established by reading the cited source directly,
cross-checked against schemas, preflight, maintenance services and deployment
docs. Six parallel read-only audits covered storage/S3, Firebase and mail, rate
limiting, usage accounting, background loops, and the anonymous surface. Every
load-bearing agent claim was re-verified against the source before inclusion.

**Four claims were corrected in that process, and they are worth recording because
each changed a conclusion:**

1. **C-4 framing** — a public-by-design API key, not a leaked secret. The
   vulnerability is architectural (a client-callable endpoint), and the fix is
   console-side.
2. **`POST /client-errors` is authenticated**, not anonymous. It grows because
   nothing prunes it.
3. **C-5's per-cycle cost** — the agent said "up to `processingTimeoutSeconds` of
   CPU"; the code shows `reconcileMeasured` throws _before_ separation, so the
   billed resource burned per cycle is egress, not CPU. Stated narrower.
4. **H-8 had no exit path at all** — my draft said an interrupted job could be
   cleared by user retry, cancel, or admin action. It cannot: all four candidate
   exits were checked and all four refuse.

My own SUSPECTED finding (the allowance/capacity TOCTOU, previously M-6) is now
**closed as safe** — see §4. No concurrency test is needed for it.

**Limitations:** this is static analysis. No live-load measurement, no runtime
profiling, and no reconciliation against actual provider billing. Quota figures in
§2 are from published free-tier terms and should be confirmed against your own
console, since they change. No code was modified and no credentials, buckets, or
services were touched. Secret values were never printed — client API keys were
verified by prefix only.

---

## Appendix A — Anonymous route surface

Every route reachable without an `Authorization` header, verified against the
guards actually applied rather than filenames. `ApiThrottlerGuard`
(`src/http/security.module.ts:31`) and `AuthGuard` (`src/auth/auth.module.ts:38`)
are both `APP_GUARD`s; `AuthGuard` returns early for `@Public()`
(`src/auth/auth.guard.ts:55`). IP limits are `default` 60/60 s and `overall`
600/60 s.

| Method + path                                         | Writes Mongo | Reads Mongo             | S3      | Extra rate limit                   |
| ----------------------------------------------------- | ------------ | ----------------------- | ------- | ---------------------------------- |
| `GET /api/v1/app-policy`                              | —            | 1 uncached              | —       | —                                  |
| `GET /api/v1/processing-policy`                       | —            | 2 uncached              | —       | —                                  |
| `GET /api/v1/app-updates/policy`                      | —            | 0 (flag off)            | —       | —                                  |
| `GET /api/v1/app-updates/releases/:id`                | —            | static                  | —       | —                                  |
| `POST /api/v1/app-updates/releases/:id/download`      | —            | 4                       | presign | 10/min per IP — **H-9**            |
| `POST /api/v1/app-updates/releases/:id/open`          | —            | 4                       | presign | 10/min per IP — **H-9**            |
| `GET /api/v1/health/live`                             | —            | —                       | —       | **none** (`@SkipThrottle`)         |
| `GET /api/v1/health/ready`                            | —            | Mongo ping + Redis PING | —       | — (M-13)                           |
| `GET /delete-account`                                 | —            | config only             | —       | —                                  |
| `GET /privacy`                                        | —            | config only             | —       | —                                  |
| `POST /api/v1/auth/password-reset`                    | —            | —                       | —       | 4 buckets (C-4, M-6)               |
| `POST /api/v1/worker-installations`                   | 3 docs       | 3                       | —       | 5/hr/IP + 1000/hr global — **B1**  |
| `GET /api/v1/worker-installations/:id`                | —            | 1                       | —       | —                                  |
| `POST /api/v1/worker-installations/:id/renew`         | 1            | 1                       | —       | 60/min                             |
| `POST /api/v1/worker-installations/:id/qualification` | 1            | 1                       | —       | 60/min                             |
| `POST /api/v1/worker-installations/:id/pairing`       | 1            | 1                       | —       | 60/min                             |
| `POST /api/v1/worker-installations/:id/events`        | ≤50 docs     | 2                       | —       | 2 MB/day per installation — **B1** |
| `GET /api/v1/worker-bootstrap/stable`                 | —            | 1                       | —       | —                                  |

Three notes:

- **`app-policy` and `processing-policy` are uncached** and are the cheapest
  anonymous Mongo load in the system — cache them (M-12).
- **`health/live` is deliberately unthrottled** and does no database work. Do not
  add database checks to it, and do not use `health/ready` for load-balancer probes.
- **Per H-6, none of the per-IP columns above is a real bound** against an attacker
  with an IPv6 /64.

Not anonymous but verified complete: `POST /api/v1/worker/*` is `@WorkerOnly`
(installation-credential auth, `src/worker/worker-auth.guard.ts:33`), and every
`admin/*` route requires `ADMIN_ROUTE`.

---

## Appendix B — Deferred worker-domain findings

**Recorded for later, not included in the main priorities, per your instruction to
leave the worker until it is finished.** These are backend API endpoints, not
worker internals — but they are worker-facing, so they are parked here.

### B1 — Self-service enrollment plus event ingest is a storage bomb — **DEFERRED, but live today**

**The largest storage risk in the repository.** `POST /api/v1/worker-installations`
is `@Public()` (`src/worker-installations/worker-installations.controller.ts:54-68`):
the client picks its own `installationId` and `tokenSha256`, and `tokenSha256` is a
plain SHA-256 with no server secret (`installation-secrets.ts:3`). `authenticate`
never checks `pairingState` (`installation-pairing.service.ts:127-150`), so **no
approval is needed**. Each installation then receives a fresh
`WORKER_EVENTS_SETUP_BYTES_PER_DAY = 2 097 152` budget, and
`POST /worker-installations/:id/events` is `@Public()` and accepts 50 events per
64 KB batch, each an indexed `findOne` + insert inside a `w:majority` transaction.

With the 1 000/hour global enrollment cap: 24 000 sinks/day → **~48 GB/day
accepted**, ~12 M events/day, **50–70 M Mongo ops/day**, and with
`EVENT_RETENTION_MS = 30 days` a **~1.4 TB steady state** — against a 512 MB M0,
full in roughly 15 minutes.

Two distinct problems, and the second is independent of the first:

- **Volume**: no global byte or op ceiling across installations; exhausting one sink
  does not stop the next.
- **Enrollment denial**: the 1 000/hr global bucket is the sole fleet-enrollment
  allowance, and it is attacker-consumable in seconds — denying legitimate worker
  enrollment (and therefore all audio processing) for an hour.

**Recommended direction (when you return to the worker):** require a
server-generated secret or a pairing approval before an installation authenticates;
add a global byte/op ceiling shared across installations; and add retention plus a
cleanup path for `worker_events`.

### B2 — `GET /worker-bootstrap/stable` is public with uncached reads — **DEFERRED**

`@Public()` with no `@Throttle` override, so only the 60/min/IP default applies
(`src/worker-releases/worker-releases.controller.ts:185-191`). Each request costs
**2 uncached Mongo reads** (`worker-rollouts.service.ts:990-1004` — `policy.findById`
then `releases.findOne`), served with `Cache-Control: no-store` so nothing absorbs
repeats. Per-IP only, no global cap → an IP-diverse flood (H-6) is unbounded Mongo
reads at 2 ops/request. **Fix:** cache the stable-release pointer; it changes only
on publication.

### B3 — Batch-rate buckets weigh 1 per batch, not per event — **DEFERRED**

`WORKER_EVENTS_BATCHES_PER_MINUTE = 60` charges **1** for a batch whether it holds
1 event or 50 (`src/rate-limits/weighted-quota-script.ts:22`,
`src/worker-events/worker-events.service.ts:98-119`) — a 50× underweighting of the
actual work. The real bound is therefore the per-day byte budget, not the rate
limit. **Fix:** weight the batch bucket by event count, the way the other weighted
quotas already do.
