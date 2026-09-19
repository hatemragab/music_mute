# Branch 1 checkpoint report: account quotas and administrator controls

## Identity

- Assigned branch: `hatem/account-quotas-admin-controls`
- Collection branch: `codex/backend-security-cost-hardening`
- Accepted predecessor commit: `0f8fb0572a309029dc6ada24d9da1c0fbfb8e0eb`
- Starting collection commit: `0f8fb0572a309029dc6ada24d9da1c0fbfb8e0eb`
- Actual tested source: working tree based on the starting commit; final commit pending
- Pull request URL/base: not opened / `codex/backend-security-cost-hardening`
- Date/time with timezone: 2026-09-19 22:31:49 EEST
- Agent/operator: Codex / Hatem Ragap
- Environment class: local macOS worktree; no live provider or real-data access

## Progress

- Branch status: `READY_FOR_REVIEW`
- Current checkpoint: complete; waiting for maintainer review
- Completed checkpoints: A1, A2, A3, A4, A5, A6
- Next unchecked item: maintainer review and merge decision
- Blocking input, if any: none
- Successor branch: not authorized until this branch is accepted and merged

## Scope and replacement inventory

| Area                                               | Before                                           | Action  | After                                                   |
| -------------------------------------------------- | ------------------------------------------------ | ------- | ------------------------------------------------------- |
| `processing-allowance.ts` and tests                | 3,600-second base plus temporary bonus           | Delete  | No allowance helper or additive bonus remains           |
| Processing settings service, DTO, and routes       | Separate processing settings authority           | Replace | One revisioned `standard` account policy                |
| User allowance fields                              | Bonus seconds and expiry stored on the user      | Delete  | One separate, audited replacement override              |
| Processing usage ledger                            | Rolling/legacy totals                            | Replace | UTC account-period counters and job reservations        |
| Admission and terminal job paths                   | Quota checks and settlement split across callers | Extend  | One transactional reservation/settlement service        |
| Admin user routes                                  | Temporary allowance update/clear                 | Replace | Usage read plus override PUT/DELETE                     |
| Dashboard settings and user controls               | Processing settings and allowance dialog         | Replace | Global policy form and account override editor          |
| Android and iOS usage models                       | Flat legacy usage response                       | Extend  | Versioned period, counters, policy source, availability |
| Auth, ownership, admin guards, audit, transactions | Existing security foundations                    | Reuse   | Same foundations protect the new policy                 |
| Installation/device history                        | Display and diagnostics                          | Reuse   | Remains separate from account quota ownership           |

Obsolete local fields `processingAllowanceAudioSeconds` and
`processingAllowanceExpiresAt` were removed from the user schema. Existing database
documents are not bulk-mutated; strict schemas simply stop reading or writing those
properties. The legacy route names remain only in negative compatibility tests, and
the 3,600-second wording remains only in historical replacement documentation.

## Final contracts

- `GET /processing-usage` returns schema version 2 with UTC period, processing
  counters, effective source, reset, and availability.
- `GET /processing-policy` is public, client-focused, no-store, and supports the
  compatibility schema selector.
- `GET /admin/settings/account-policy` and
  `PUT /admin/settings/account-policy` manage the global revisioned policy.
- `GET /admin/users/:id/account-usage` returns the same resolved account usage.
- `PUT /admin/users/:id/account-policy-override` creates or replaces the one
  optional override.
- `DELETE /admin/users/:id/account-policy-override` clears that override.
- Old `/admin/settings/processing` and processing-allowance mutations are absent.

## Checkpoint results

| ID  | Status | Evidence                                                     | Actual observation                                                       |
| --- | ------ | ------------------------------------------------------------ | ------------------------------------------------------------------------ |
| A1  | `PASS` | Source inventory, deleted legacy files, negative route tests | Every caller was classified and no dual quota engine remains             |
| A2  | `PASS` | Policy unit tests and admin policy integration               | Validated defaults, revision conflicts, audit, and exact expiry pass     |
| A3  | `PASS` | Usage unit and Mongo transaction integration                 | UTC renewal, reserve, consume, release, replay, race, and retention pass |
| A4  | `PASS` | Admin policy integration and controller E2E                  | One replacement override is protected, revisioned, expiring, and audited |
| A5  | `PASS` | Backend, dashboard, Android, and iOS contract tests          | Account usage is consistent across API, admin UI, and clients            |
| A6  | `PASS` | Repository scan and final non-device gates                   | Legacy controls are removed and required local gates pass                |

## Commands actually executed

| Directory       | Command                                                                                                                                                                 | Exit | Sanitized result                                                                  |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---: | --------------------------------------------------------------------------------- |
| `backend`       | `pnpm run verify`                                                                                                                                                       |    0 | Format, lint, types, secret scan, 724 unit tests, 137 E2E tests, and build passed |
| `backend`       | `pnpm run test:processing:integration`                                                                                                                                  |    0 | 12 isolated processing/Mongo tests passed                                         |
| `backend`       | `pnpm run test:dashboard:integration`                                                                                                                                   |    0 | 23 isolated admin/dashboard contract tests passed                                 |
| `dashboard`     | `npm run format:check && npm run lint && npm run typecheck && npm test -- --run && npm run build && npm run test:deployment`                                            |    0 | 50 unit tests, build, and 11 deployment tests passed                              |
| `dashboard`     | `DASHBOARD_E2E_API_PORT=3101 npx playwright test`                                                                                                                       |    0 | 31 browser E2E tests passed; alternate port avoided another task                  |
| `android`       | `./gradlew :app:assembleDirectDebug :app:assemblePlayDebug :app:lintDirectDebug :app:lintPlayDebug :app:testDirectDebugUnitTest :app:testPlayDebugUnitTest --no-daemon` |    0 | Both flavors built, linted, and passed unit tests                                 |
| `ios`           | Focused `ProcessingUsageRepositoryTests` on authorized simulator                                                                                                        |    0 | 2 changed-contract tests passed                                                   |
| `ios`           | `xcrun swift-format lint --recursive Vocal VocalTests VocalUITests scripts`                                                                                             |    0 | Swift format check passed                                                         |
| repository root | JSON, Markdown-link, legacy-reference, and `git diff --check` checks                                                                                                    |    0 | Recorded after final documentation update                                         |

## Behavioral evidence

- The standard account receives 7,200 successful processing seconds for each UTC
  calendar month, with no carryover or device ownership.
- Reservation is atomic with job admission. Duplicate reserve and settlement calls
  are idempotent.
- Success moves measured seconds to used; failure or cancellation releases the full
  reservation without charging the account.
- Two simultaneous last-capacity reservations cannot exceed the accepted limit.
- A second account receives its own full period.
- A lower administrator limit never produces negative remaining capacity.
- The accepted global and override revisions are stored with each reservation.
- Later-branch media, transfer, queue, and deletion values are defined centrally but
  are not newly enforced by this branch.

## Data and concurrency evidence

- Isolated test databases were created by the repository integration harness; no
  Atlas or production Redis connection was used.
- `account_usage_periods` has one unique account/period key and a TTL index for
  closed periods.
- `processing_reservations` uses the job identifier as its immutable reservation
  identity and has account/state/period plus TTL indexes.
- Open periods and periods with active reservations have `purgeAt = null`.
- Closed periods are retained until the first day thirteen months after their
  period start; settled reservations use bounded retention.
- Mongo transactions cover admission, reservation, settlement, policy mutation,
  audit failure rollback, and concurrent revision conflicts.

## Client and dashboard evidence

- The dashboard global policy page edits all centrally defined launch values and
  handles revision conflicts.
- The account detail page shows limit, used, reserved, released, remaining, reset,
  effective source, and optional override expiry.
- Android Direct and Play variants compile and their repository tests validate the
  versioned monthly response.
- iOS repository tests validate the same response, and Swift formatting passes.
- Device quota enforcement was not added; installations remain history only.

## Security and privacy review

- [x] Owner/account authorization verified.
- [x] Admin permission, recent authentication, revision, reason, and audit verified.
- [x] Safe public errors contain no provider, internal, or abuse details.
- [x] No secrets, dotenv values, signed URLs, private audio, or personal data were
      added to tracked files or evidence.
- [x] Device history is excluded from quota ownership and restriction.
- [x] MongoDB growth is bounded for closed usage periods and settled reservations.
- [x] No live provider, deployment, or real-data mutation was performed.

## Compatibility and rollback/removal

Public policy schema version 1 remains available for existing clients while version
2 exposes the new monthly contract. The mobile clients in this branch consume
version 2. Legacy administrator settings and temporary allowance routes intentionally
return not found and are covered by compatibility tests.

Rollback is the normal branch revert before merge. No destructive migration or live
data rewrite was performed. Old user properties may remain inert in existing
documents until a separately approved cleanup migration.

## Pending tests and limitations

- At the maintainer's request, no further device/UI E2E run is part of this handoff.
- Before that instruction, the full authorized-simulator run reported 171 passed,
  3 skipped, and 1 unrelated Files-picker UI failure. The changed iOS repository
  tests passed 2/2, and the UI test experiment was fully reverted.
- Real Atlas, S3, Firebase, VPS, deployed-system, physical-device, and production
  checks remain `NOT_RUN`.
- Provider-console changes belong to later branches and were not performed.

## Handoff

- Ready for review or draft: ready for review
- Required maintainer decision: review and merge or request changes
- Provider checklist items still unchecked: all; no provider action belongs here
- Next branch, still unauthorized: `hatem/media-s3-cost-protection`
- Progress files synchronized: manifest, start page, roadmap, task, changelog, and
  this evidence report
