# Library pagination and URL job reuse — 2026-10-17

Validated on 17 October 2026, Cairo time. The owner authorized checking Library
pagination, deploying the backend, and verifying URL job reuse in production.

## Library pagination

The web client already requests ready jobs using the server cursor and appends
older songs correctly. No production client source change was needed. Added
regression coverage in `web-client/src/realtime/RealtimeProvider.test.tsx` and
`web-client/tests/library-pagination.spec.ts`.

- Local fixtures loaded 245 songs across 13 pages, with no gaps or duplicate IDs.
- Coverage includes account switching, failed next-page retry with the same
  cursor, reconnect/boundary changes, and retaining all loaded songs while
  bounding live subscriptions to ten pages. Status reads use WebSockets.
- The saved signed-in account's live API history returned 278 ready songs across
  14 cursor pages: thirteen pages of 20, then 18. IDs were unique and the final
  cursor was null. This read occurred before the new-cache test below.

Checks passed from `web-client/`: `npm run format:check`, `npm run typecheck`,
`npm run lint`, `npm test` (279 tests), `npm run build`, and installed-Chrome
pagination/history/realtime coverage (3 tests). Fixture browser tests and the
authenticated API read are separate evidence; no native device/UI test ran.

## Backend deployment

CapRover CLI deployed API version **139**, based on the active version **138**.
The deployment archive SHA-256 was
`4b7016aca6dd97fe4e496bc00b6ad21f3d242e95914d7f3344b8a4d5a9167eb9`.

The four changed modules are `jobs/jobs.service`, `jobs/job.schema`,
`url-imports/imports.service`, and `url-imports/import-processor`. An isolated
pre-change compilation matched all four running JavaScript modules. The build
guard checked all eight old/new JavaScript and source-map hashes before replacing
them. Readback confirmed all eight candidate hashes and 1,081 other runtime,
package and catalog file hashes unchanged. Dependency versions and the entire
application configuration were unchanged. The worker installation catalog and
existing worker-report repair were preserved through the version-138 base image.

CapRover reported one instance and no build in progress. Public liveness and
readiness, plus container-local readiness, returned HTTP 200. Unauthenticated
`GET /jobs` returned HTTP 401. The declared owner/output lookup index was present
in the live database. No web, dashboard, provider or worker release was deployed.

The exact backend modules had passed `pnpm run verify` (1,741 unit tests,
233 API tests, formatting/lint/type checks and build),
`pnpm run test:imports:integration` (43),
`pnpm run test:processing:integration` (19), and `pnpm audit --prod` (no known
vulnerabilities). An earlier unrelated public-page test failure passed in isolation
and on the final complete verification run.

## Authenticated live reuse

For a ready YouTube rendition already in the signed-in account's history:

- Six fresh request UUIDs across three canonical-equivalent YouTube URL forms
  used three normal imports and three cache-only deliveries.
- All returned `submitted` immediately with the same existing job ID.
- Database readback confirmed unchanged history counts, original job metadata,
  input/output identities, shared catalog/artifact rows, usage, processing
  reservations and upload receipts. No notification was created during these
  repeated submissions.

For a ready shared source absent from that account's current history:

- One cache-only delivery created one owned ready job. Normal and cache-only
  submissions with fresh UUIDs returned that job; replaying the first UUID also
  returned the original import receipt.
- The stored original and vocal identities exactly matched the existing shared
  catalog. Both keys remained under the private shared namespace. The artifact
  ledger was unchanged: no new media object or copy was published.
- Acquisition and worker attempts were zero. No processing reservation or upload
  receipt was added. Exactly one ready notification was created.
- Logical retained storage increased once by 3,553,019 bytes, equal to the shared
  original plus vocal sizes. Repeated submissions added no further charge.

One cached test entry remains in that account's Library; its ready-song count
increased from 278 to 279. No existing history or media was deleted. Previously
duplicated history rows remain unchanged. Full and trimmed output renditions
continue to be separate entries. These checks prove the exercised live cache
delivery paths, not fresh provider acquisition or general production capacity.

Private verification material remains outside the repository. This record omits
account identifiers, titles, source URLs, object keys and credentials. No commit
or push was made.
