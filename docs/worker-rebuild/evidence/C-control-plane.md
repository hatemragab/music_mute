# C control-plane evidence

Observed 2026-09-17 in Africa/Cairo on `codex/worker-control-plane`, created from
accepted feasibility commit `ae1e954eff9d77e83b0b1d90446ac51c985af1bc`.
The local environment was Darwin 25.6 ARM64 with Node.js 24.18.0 and pnpm
10.14.0.

## Checkpoint status

| Checkpoint | Status | Evidence |
| --- | --- | --- |
| C1 persistence, protocol and authorization | PASS | Worker-fleet schemas, explicit indexes, existing-job execution fields, protocol-v1 validation, fail-closed worker guard, startup initialization and focused/full test coverage. |
| C2 enrollment lifecycle | PASS | One-use invitation exchange, restricted installation report, qualified activation, scoped authentication and audited machine pause/resume/revoke with ownership fencing. |
| C3 admission and claims | PASS | Feature-gated public admission, immutable verified-input recipes, exact-version upload verification, durable sessions/slots and policy/capability-matched transactional claims with same-request replay. |
| C4 leases and recovery | PASS | Backend-time batch renewal, exact ownership fences, fixed deadlines, cancellation/session/revocation fences and race-safe bounded recovery with focused/full test coverage. |
| C5 storage and finalization | PASS | Attempt-scoped input/output grants, exact-version verification, idempotent completion/failure, coherent usage/notification/slot updates and orphan cleanup. |
| C6 machine/status/policy APIs | PASS | Durable machine/invitation/policy reads and controls, policy acknowledgement, typed commands, runtime diagnostics and independent route-authorization coverage. |

## Implemented boundary

- Added dedicated collections for one-use enrollment invitations, bounded
  installation sessions, durable machine identity, execution slots, attempts,
  policy and diagnostics. Credential fields store hashes or key identifiers,
  never bearer secrets.
- Extended the existing `audio_jobs` schema for recipe snapshot, retry
  eligibility, attempt numbering and fenced current ownership. Public job
  serialization remains unchanged.
- Added protocol version 1 with explicit operation, platform, provider and
  recipe allowlists plus payload size, nesting, array and string bounds.
- Added a distinct worker-route authorization marker and guard. It deliberately
  rejects every worker request at C1; C2 must implement credential verification
  before any worker endpoint can become usable.
- Registered all worker collections for startup index initialization. A model or
  index failure stops startup with the fixed redacted message
  `Worker fleet schema initialization failed`.

At C1 no HTTP worker controller or usable credential existed. C2 below adds
only the enrollment lifecycle; job claims, S3 grants, runtime processes,
dashboard UI and deployment remain absent.

## C2 enrollment and revocation

- Added `POST /worker/v1/installations` for atomic one-use invitation exchange.
  A replay with the same request ID derives the same restricted installation
  credential without storing recoverable plaintext; a different replay is a
  conflict.
- Added authenticated installation report and activation routes. Reports are
  revision-fenced, bounded and replay-safe. Activation accepts only protocol v1,
  the exact qualified Kim Vocal 2 digest and the verified MVP pairs:
  Darwin ARM64/CoreML or Windows AMD64/DirectML.
- Added bounded installation log batches with contiguous sequence validation,
  idempotent acknowledgements, TTL retention and server-side redaction of
  bearer values, secret assignments, credential-bearing URLs and home paths.
- Added admin invitation creation and machine pause/resume/revoke routes with
  explicit permissions, recent-auth requirements, sensitive rate limits,
  operation receipts and audit records.
- Revocation rejects the machine credential, clears its durable session,
  revokes its installation session and expires current audio-job ownership.
  Restricted, failed, expired and revoked installations cannot authenticate as
  machines or claim work.

Invitation, installation and machine secrets are 256-bit opaque values. The
database contains only SHA-256 digests. Installation and machine credentials
are domain-separated HMAC derivations of an already high-entropy parent secret,
which permits same-request response recovery without storing plaintext.

## C3 admission and atomic claims

- Restored public create, upload-renewal, upload-confirmation and retry flows
  behind `AUDIO_PROCESSING_ENABLED` and the durable processing settings fence.
  Account state, per-user active limits, rolling usage reservation and request
  idempotency execute in the existing MongoDB transaction boundary.
- Each new job freezes the verified MVP Kim recipe, exact model digest and byte
  size, trim/denoise choices, protocol revision and MP3 output settings before
  an upload grant is issued. Admission and recipe snapshots are immutable.
- Input grants bind the exact key, size, media type, checksum and create-only
  condition. Upload confirmation verifies and pins the S3 version before the
  job can enter `queued`; historical jobs without a recipe snapshot remain
  ineligible for claims.
- Added machine session opening and logical slot registration. New sessions
  increment the supervisor generation and free stale slots are taken offline.
- Added one-at-a-time transactional claims. Eligibility is the intersection of
  active machine/session state, applied policy revision, enabled fleet recipe,
  slot capacity/capability, retry limits and the job's frozen recipe.
- Claim creation conditionally fences the machine, slot and job before writing
  one attempt. A lost response replayed with the same machine/request/session/
  slot identity returns the same active claim, including while new work is
  paused; a different identity is rejected.
- A default revision-zero fleet policy is inserted only when processing is
  explicitly enabled and only when no policy exists. Later policy APIs may
  revise it without overwriting stored policy.

## C4 leases, cancellation and recovery

- Added machine-authenticated `POST /worker/v1/leases/renew` with bounded
  batches and per-item `accepted`, `expired`, `cancelled` or `revoked`
  dispositions. Renewals use backend time, require the exact job/attempt/
  machine/worker/session/incarnation tuple, and never revive an expired lease.
- Every accepted renewal conditionally advances the attempt, job ownership and
  slot in one MongoDB transaction. The renewed expiry is capped at the fixed
  attempt deadline rather than extending total processing time indefinitely.
- Added a single-flight recovery scanner that runs every ten seconds while
  processing is enabled. It compares the observed attempt revision and exact
  lease timestamp, so a racing successful renewal wins instead of being reset.
- Lost attempts release their slot and either requeue after bounded exponential
  backoff or fail finally. Eligibility is capped by the durable fleet policy's
  maximum attempts and the job's remaining-attempt snapshot.
- Owner/admin/account-deletion cancellation, terminal-job deletion, supervisor
  session replacement and machine revocation now fence active attempts and
  leases. Late renewal is rejected; C5 will apply the same ownership tuple to
  output grants and finalization.
- Focused tests cover accepted/deadline-capped renewal, refusal to revive,
  cancellation/revocation dispositions, renewal/recovery races, retry backoff,
  final failure, session replacement, machine revocation and deletion fencing.

## C5 exact-version transfers and finalization

- Added current-attempt input grants that expose only the already pinned S3 key
  and immutable version. The grant is signed before a second ownership/account
  check, so a concurrent fence prevents the URL from being returned.
- Added output declaration and grant refresh with a backend-derived
  user/job/attempt key, exact MP3 media type, byte/checksum/duration bounds,
  create-only signed headers and expiry capped at the attempt deadline.
- The declaration is frozen on the attempt. Conflicting refreshes fail closed;
  abandoned attempt keys receive durable exact-key cleanup scheduled after the
  deadline and grant-settlement window.
- Completion HEADs the worker-declared immutable S3 version outside the MongoDB
  transaction, verifies key/version/bytes/checksum/media type, then rechecks
  ownership, lease, deadline, account state and the frozen recipe inside it.
- One successful transaction publishes `ready`, records the attempt output,
  disables retry, releases the slot, settles usage, inserts the durable ready
  notification and cancels orphan cleanup. Identical completion replays return
  the same terminal result; conflicting or stale completion cannot publish.
- Categorized worker failure is also idempotent. Transient failures use the
  same bounded policy/backoff rules as lease recovery; terminal failure settles
  usage, releases the slot and inserts one failed notification.
- Focused tests cover attempt-key derivation, immutable output declarations,
  exact-version S3 HEAD, mismatch rejection, successful replay, expired-owner
  rejection, terminal failure replay and orphan-cleanup cancellation.

## C6 machine, status and policy APIs

- Added machine list/detail APIs with bounded slot, current/recent attempt,
  installation, command and diagnostic metadata. Credential digests and raw log
  lines are excluded from ordinary machine reads; sanitized diagnostic content
  requires the separate `workers.logs.read` permission.
- Added invitation lifecycle listing and an audited, expected-revision revoke
  action. Expired active invitations are presented as expired without causing
  an unaudited write during a GET request.
- Added audited drain alongside pause/resume/revoke. Drain stops new claims and
  preserves active work; machine revocation continues to fence current leases
  and credentials.
- Added versioned recipe/capacity policy reads and optimistic updates. Policy
  changes advance each non-revoked machine's desired revision, and claims stay
  closed until the current session acknowledges the exact policy revision.
- Added current-session configuration reconciliation and a durable
  `worker_commands` collection for typed doctor/benchmark requests. Results are
  bounded, sanitized, session-authenticated and replay safe; arbitrary remote
  shell commands and remote update commands do not exist.
- Added ordered machine runtime-log batches with exact-sequence replay,
  credential/path redaction, 14-day retention and current-session/incarnation
  fencing. The machine stores the highest acknowledged diagnostic sequence.
- Extended the independent dashboard-route inventory with all C6 permissions,
  role boundaries, fresh-auth requirements, rate classes and DTO validation.
- No WebSocket/Redis delivery path was made authoritative. The runtime branch
  can add bounded presence/progress/cancellation hints when it has a real
  consumer; configuration, commands, claims, leases and results already
  reconcile durably over HTTPS and MongoDB.

## Verification

The backend verification command was run with only repository rate-limit
variables removed from that child process. The developer shell defines local
rate-limit overrides, while several existing tests intentionally instantiate
`ConfigService` directly and assert repository defaults. No `.env` file or
runtime value was modified.

```bash
env -u AUTH_UID_PER_MINUTE \
  -u PROFILE_UID_PER_MINUTE \
  -u PROFILE_IP_PER_MINUTE \
  -u DEVICE_UID_PER_MINUTE \
  -u LOGOUT_UID_PER_HOUR \
  -u PROCESSING_CREATE_UID_PER_MINUTE \
  -u PROCESSING_READ_UID_PER_MINUTE \
  -u PROCESSING_GRANT_UID_PER_MINUTE \
  -u PROCESSING_MUTATION_UID_PER_MINUTE \
  -u VERIFY_COOLDOWN_SECONDS \
  -u VERIFY_UID_PER_DAY \
  -u VERIFY_EMAIL_PER_DAY \
  -u VERIFY_IP_PER_HOUR \
  -u VERIFY_PROJECT_PER_DAY \
  -u RESET_COOLDOWN_SECONDS \
  -u RESET_EMAIL_PER_DAY \
  -u RESET_IP_PER_HOUR \
  -u RESET_PROJECT_PER_DAY \
  -u ADMIN_READS_PER_MINUTE \
  -u ADMIN_WRITES_PER_MINUTE \
  -u ADMIN_MEDIA_GRANTS_PER_MINUTE \
  -u ADMIN_SENSITIVE_OPERATIONS_PER_MINUTE \
  -u ADMIN_EXPORTS_PER_HOUR \
  -u ADMIN_REAUTH_MAX_AGE_SECONDS \
  pnpm run verify
```

Result: PASS.

- formatting: PASS
- lint: PASS, zero warnings and errors
- TypeScript typecheck: PASS
- tracked-secret scan: PASS, 4/4 tests
- unit tests: PASS, 107 files and 727 tests
- E2E tests: PASS, 22 files and 135 tests
- processing integration tests: PASS, 12 tests against isolated local services
- NestJS production build: PASS

This is local implementation evidence only. It is not proof of production
deployment, live MongoDB migration, live S3 transfer, real machine claim,
worker execution or hardware processing.
