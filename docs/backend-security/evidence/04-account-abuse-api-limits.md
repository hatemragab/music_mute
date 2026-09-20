# Branch 4 checkpoint report: account abuse and API limits

## Identity

- Assigned branch: `hatem/account-abuse-api-limits`
- Collection branch: `codex/backend-security-cost-hardening`
- Merged predecessor PR: <https://github.com/hatemragab/music_mute/pull/12>
- Starting collection commit: `5151426a87d2712e9064bd222de498cf6b054f5f`
- Tested implementation commit: `33f5a640ba126b3e4f863e1a0aa946995c9dde99`
- Pull request URL/base: <https://github.com/hatemragab/music_mute/pull/13> /
  `codex/backend-security-cost-hardening`
- Date/time with timezone: 2026-09-20 EEST
- Environment: local macOS isolated worktree with synthetic isolated MongoDB and
  Redis; Firebase, S3, APK verification, and provider configuration used test
  doubles or stayed outside the branch

## Progress

- Branch status: `MERGED` in PR #13
- Completed checkpoints: D1, D2, D3, D4, D5, D6
- Next item: none; Branch 5 later completed and merged as PR #14
- Blocking input: none

## Delivered behavior

| Checkpoint | Result                                                                                                                                                                                                                                                                                                                                                                 |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1         | Typed account abuse events aggregate atomically into hourly buckets, preserve true first/last times, expire after 90 days, and feed compact monthly summaries retained for twelve closed months. Admin queries use bounded projections, indexed filters, 100-row maximum pages, scoped cursors, and no arbitrary metadata.                                             |
| D2         | Processing create/upload/confirm/download/retry/cancel, deletion/recovery, and administrator operations use atomic layered account or UID, IP, endpoint, and service budgets. Keys reuse the existing keyed-hash builder and TTL-based Redis Lua reservation; durable MongoDB quota checks remain authoritative.                                                       |
| D3         | One revisioned restriction record per account supports active, expired, and removed states with safe reason type/note, optional expiry, audit, fresh auth, and separate permission. Apply cancels at most 100 unfinished jobs transactionally, settles usage, and fences attempts/slots. Authentication, reads, cancellation, deletion, and recovery remain available. |
| D4         | The dashboard has account/type/severity/date filters, count, first/last time, current restriction state, and separate apply/remove controls. Quota override and abuse restriction remain separate. Loading, empty, error, permission, fresh-auth, and revision contracts are covered.                                                                                  |
| D5         | Event and summary TTLs, bounded counters/documents, narrow query indexes, Redis `maxmemory`/policy/pressure signals, and MongoDB data-plus-index pressure signals provide local cost ceilings. The operator runbook records the external Atlas/Redis work without marking it complete.                                                                                 |
| D6         | Backend, HTTP, MongoDB/Redis integration, dashboard, privacy, JSON, link, whitespace, and secret gates passed. Device identity remains history only and event counts never create an automatic restriction.                                                                                                                                                            |

## Removed and replaced behavior

| Legacy behavior                                                        | Replacement                                                                         |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Embedded `processingSuspended` user state and suspension expiry fields | Separate `account_restrictions` record with optimistic revision and optional expiry |
| `POST /admin/users/:id/suspend-processing` and `resume-processing`     | Audited `PUT`/`DELETE /admin/users/:id/restriction`                                 |
| Suspension filter/column/dialog in the users UI                        | Separate abuse event page and restriction card/dialog on user detail                |
| UID-only administrator budget                                          | Atomic UID, IP, endpoint, and service administrator budgets                         |
| Unclassified datastore health                                          | Sanitized MongoDB/Redis capacity warning codes and alert episodes                   |

The historical migration integration explicitly proves embedded suspension fields
and query parameters are gone. No compatibility route keeps the old mutation
contract active.

## Verification evidence

| Directory       | Command                                                                                                     | Exit | Result                                                                                                                                           |
| --------------- | ----------------------------------------------------------------------------------------------------------- | ---: | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `backend`       | `pnpm run verify`                                                                                           |    0 | Format, lint, typecheck, tracked-secret scan, 110 files / 769 unit tests, 23 files / 140 HTTP E2E tests, and build passed                        |
| `backend`       | `pnpm run test:integration`                                                                                 |    0 | 1 isolated authenticated Redis outage/recovery integration passed                                                                                |
| `backend`       | `pnpm run test:auth:integration`                                                                            |    0 | 18 isolated Firebase/MongoDB/Redis/auth/rate-limit integrations passed                                                                           |
| `backend`       | `pnpm run test:processing:integration`                                                                      |    0 | 15 integrations passed, including concurrent abuse aggregation, restriction expiry/no-auto-create, jobs, usage, notifications, and push bindings |
| `backend`       | `pnpm run test:dashboard:integration`                                                                       |    0 | 23 compiled administrator/dashboard workflow integrations passed; runtime reported 27 requests and 10 audited events                             |
| `backend`       | `pnpm run test:deletion:integration`                                                                        |    0 | 3 deletion/recovery compatibility integrations passed                                                                                            |
| `dashboard`     | `npm run format:check && npm run lint && npm run typecheck && npm test && npm run build`                    |    0 | 16 files / 51 component tests and production build passed                                                                                        |
| repository root | JSON parse, relative Markdown link audit, stale-symbol scan, sensitive-pattern scan, and `git diff --check` |    0 | Documentation and replacement boundary checks passed                                                                                             |

An initial full backend run timed out after five seconds in the existing APK
verifier installer test. The same two-test file passed in isolation, and the full
backend verify rerun passed all 769 tests. No deployment code was changed for that
timing-only failure.

## Security and privacy review

- Abuse documents contain only account ObjectId, fixed enums, timestamps, bounded
  counts, policy revision, and optional restriction ObjectId.
- No request body, token, raw IP, email, Firebase UID, device identifier, S3 key,
  presigned URL, audio name, stack trace, or open-ended metadata is accepted.
- Redis key material continues through `RateLimitKeys`; every added counter has a
  bounded window and the atomic reservation fails closed on dependency failure.
- Restriction operations validate account existence and revision, require separate
  permissions/fresh authentication, and run restriction, cancellation, usage
  settlement, operation receipt, and audit in one transaction.
- Event counts have no path to create a restriction. Device records have no quota,
  download, restriction, or ban authority.

## Provider boundary and remaining limitations

- No AWS, Atlas, Redis/VPS, Firebase, CapRover, deployment, production database,
  bucket, real account, or real media setting/data was read or changed.
- Every item in `../runbooks/PROVIDER-CONSOLE-CHANGES.md` remains unchecked.
- The new health codes are local application signals, not proof of actual Atlas or
  VPS configuration/capacity.
- Device and browser UI E2E were not launched by maintainer instruction. Backend
  HTTP E2E, compiled dashboard integration, component tests, and builds passed.
- Branch 5 must purge or irreversibly de-identify abuse events, summaries, and the
  restriction record during permanent account cleanup.

## Handoff

- Ready for review: merged
- PR base: `codex/backend-security-cost-hardening`
- Next branch: `hatem/account-deletion-cleanup`, later merged as PR #14 after
  starting from merge commit `daad109f646400440714c12c175e3e12ac3442de`
