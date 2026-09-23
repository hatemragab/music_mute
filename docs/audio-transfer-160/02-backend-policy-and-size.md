# 02 — Update backend policy and upload protection

**Status: implemented locally; deployment pending.** Depends on task 01. Own backend
policy, admission, upload confirmation and associated contract tests.

## Source entry points

- `backend/src/admin-settings/account-policy.service.ts`
- `backend/src/jobs/dto/create-job.dto.ts`, `job-state.ts` and `job.schema.ts`
- `backend/src/jobs/jobs.service.ts` and `job-actions.service.ts`
- `backend/src/storage/storage-transfers.service.ts` and `immutable-upload-grant.ts`
- `backend/src/jobs/worker-recipes.ts` and the canonical worker protocol

## Planned work

1. Publish the reviewed 160 kbps preparation policy instead of the current
   256 kbps fallback target. Coordinate strict mobile parsers in tasks 04–05.
   Distinguish input upload preparation from final output encoding policy.
2. Keep the 50,000,000-byte maximum in API validation and storage upload grants.
   Trace the actual storage mechanism: constrain upload bytes at storage where
   supported and always verify actual object size during upload confirmation.
   Do not trust a small client-declared size to accept a larger uploaded object.
3. Preserve object ownership, immutable upload identity, content-type checks,
   checksums and idempotent confirmation. An oversized or mismatched object must
   not become claimable by a worker. Reuse existing safe cleanup/error behavior.
4. Accept the reviewed compressed formats without backend transcoding, FFmpeg
   execution, or a new backend media-probing service. Worker remains responsible
   for actual audio validation during its existing intake. An extension/MIME claim
   does not prove that a file contains valid audio.
5. If task 01 requires metadata, validate its units/range and provenance. Update
   DTOs, presenters, schemas, recipes and tests together without migrations.
   Regenerate worker protocol copies using the existing `protocol:sync` script
   when the canonical protocol changes; never hand-edit generated copies.

## Acceptance and validation

- Mobile receives a coherent 160 kbps policy; all relevant consumers are covered
  by the implementation sequence before integrated use.
- Test declared sizes below, exactly at and above 50,000,000 bytes, missing or
  invalid sizes, and actual objects larger than declared. Keep duration and other
  existing protections intact.
- Test forged MIME/rate hints, wrong object identity, duplicate confirmation,
  cancellation and failure cleanup through existing focused suites.
- Run affected backend tests and required backend verification with isolated
  local services; inspect package scripts before use. The current full gate is
  `pnpm run verify` from `backend/`. Use `test:processing:integration` or focused
  relevant local integration commands for changed storage/job behavior.
- Handoff: policy/API examples, byte-boundary evidence, contract changes and
  unresolved integration gaps. No backend conversion stage should exist.
