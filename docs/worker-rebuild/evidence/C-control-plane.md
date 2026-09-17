# C1 control-plane evidence

Observed 2026-09-17 in Africa/Cairo on `codex/worker-control-plane`, created from
accepted feasibility commit `ae1e954eff9d77e83b0b1d90446ac51c985af1bc`.
The local environment was Darwin 25.6 ARM64 with Node.js 24.18.0 and pnpm
10.14.0.

## Checkpoint status

| Checkpoint | Status | Evidence |
| --- | --- | --- |
| C1 persistence, protocol and authorization | PASS | Worker-fleet schemas, explicit indexes, existing-job execution fields, protocol-v1 validation, fail-closed worker guard, startup initialization and focused/full test coverage. |
| C2 enrollment lifecycle | PASS | One-use invitation exchange, restricted installation report, qualified activation, scoped authentication and audited machine pause/resume/revoke with ownership fencing. |
| C3 admission and claims | NOT_RUN | Reserved for the later checkpoint. |
| C4 leases and recovery | NOT_RUN | Reserved for the later checkpoint. |
| C5 storage and finalization | NOT_RUN | Reserved for the later checkpoint. |
| C6 machine/status/policy APIs | NOT_RUN | Reserved for the later checkpoint. |

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
- unit tests: PASS, 99 files and 694 tests
- E2E tests: PASS, 22 files and 125 tests
- NestJS production build: PASS

This is local implementation evidence only. It is not proof of production
deployment, live MongoDB migration, real worker authentication, machine
enrollment, job execution or hardware processing.
