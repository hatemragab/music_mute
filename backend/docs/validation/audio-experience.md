# Backend audio experience validation — 2026-09-10

Backend tasks B01–B05 are implemented locally. This report does not claim deployment,
live AWS cleanup, or the new mobile UX is available in installed apps.

## Implemented

- Optional source title/kind/client intake time, stable request references, safe renamed
  display names, retry name inheritance, and compatible old create payloads.
- Retained processing intervals for existing jobs; approximate client total elapsed
  time and explicit missing timing for legacy jobs.
- Authenticated bounded mobile diagnostic reports, including pre-job operation references,
  owner/event idempotency and Redis-backed rate limiting.
- Terminal-only account deletion, persistent tombstones, blocked new artifact grants,
  exact-key version cleanup with retry/backoff, and protection for shared retry inputs.
- Native-client contract documentation and fixtures.

## Commands actually run

- Focused metadata/presentation tests first demonstrated missing behavior; focused
  S3 deletion and pagination cases also failed before implementation/fix.
- Focused regression: five suites, 32 tests passed before the final pagination case.
- `npm run verify`: passed Prettier, oxlint (zero warnings/errors), TypeScript,
  378 unit tests in 44 files, 35 HTTP tests in 6 files, and Nest production build.
  Existing validateSync-based tests emitted Mongoose deprecation notices, not failures.
- `node --test test/audio-experience.integration.mjs`: passed one consolidated scenario
  using real isolated MongoDB replica set, Redis, Firebase Auth Emulator, and HTTP
  guards, with fake S3/messaging. It covers metadata/rename/replay, stage replay,
  diagnostics ownership/correlation, terminal deletion, shared input retention/removal,
  durable cleanup retry, deletion/cleanup during a paused retry transaction, competing cleanup claims, expired
  cleanup lease recovery, and 11-attempt pagination across two sweeps. The expanded
  scenario passed in approximately 6.7 seconds; no broad suite was repeated.
- `npm run package:caprover`: created the archive below. Archive inspection verified all
  133 regular members match the current source/build inputs byte-for-byte and contain
  the root captain definition plus backend sources. No dotenv/service-account files,
  credentials in npm configuration, dependencies, mobile projects, or tests are packed.

Testing was consolidated to follow the user's request for focused, efficient validation.
The three separate new integration files proposed in the plan are represented by the
single `test/audio-experience.integration.mjs` fixture scenario and existing unit suites.

## Review

Independent review found and verified fixes for Unicode code-point length consistency
and a cleanup pagination stall on longer sibling object keys. Final source review
reported no remaining important findings. Existing unrelated checkout edits were kept.

## CapRover artifact

- Path: `/var/folders/jh/kqzv5jvj1qgfq85qwnwclz4w0000gn/T/musicmute-caprover-BQYwH2/api.tar`
- Size: 1,054,208 bytes; 133 members.
- SHA-256: `4da5ea3a215d9e4e96538b78f5eb7da1219056ff9ff3c8bc62a63a2721ba46cc`
- Captain Definition Path: `./captain-definition`
- Container HTTP Port: `80`

Before live deletion can remove S3 versions, the API identity needs the documented
`s3:ListBucketVersions` and `s3:DeleteObjectVersion` permissions. No IAM changes,
deployment, live object deletion, commit, or push was performed. A Docker image build
was not run; the Nest build and archive context were validated locally.
