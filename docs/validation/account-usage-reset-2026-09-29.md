# Account usage reset — 2026-09-29

## Behavior

User detail → UTC monthly account usage → **Reset usage** resets the current
UTC month's used/released processing seconds, upload grants/confirmed bytes,
download grants/estimated bytes, and today's upload grants. Limits, overrides,
files, actual retained storage, historical periods and service-wide bandwidth
remain unchanged. No real user's counters are reset as part of deployment.

The server requires `users.processing.manage`, authentication within 300 seconds,
a reason, UUID operation ID, and the displayed usage revision/month/day.
Active jobs/imports/reservations reject with `USAGE_RESET_ACTIVE_WORK` (409).
Stale confirmations reject with `REVISION_CONFLICT` (409). Close the dialog,
refresh usage, and reopen it. An ambiguous response uses the existing operation
receipt and read-back, without automatically repeating the reset. A successful
operation replay preserves usage accrued after its first commit.

Reset and before/after audit metadata commit in one MongoDB transaction. Account
and import admission fences plus usage document conflicts serialize concurrent
work. Existing files, object metadata and transfer receipts remain intact.

## Local verification

- `backend/`: `pnpm run verify` passed: formatting, lint, typecheck, secret scan,
  transfer benchmarks, 965 unit tests, 150 HTTP tests and compiled build.
- `backend/`: `pnpm exec node --test test/admin-usage-reset.integration.mjs test/processing-usage.integration.mjs`
  passed all three suites against isolated local MongoDB replica sets. Coverage
  includes zeroing all resettable counters, audit before/after, stale revisions
  and UTC boundaries, active reservations/jobs/imports, replay after new usage,
  concurrent reset confirmations, absent periods, storage/history/service/other
  account preservation, and existing reservation and queue admission behavior.
- `dashboard/`: `npm run format:check`, `npm run lint`, `npm run typecheck`,
  `npm test` (86 tests), `npm run test:deployment` (build plus 11 tests),
  and `npm run test:e2e` (34 desktop Chrome tests) passed.
- Reset UI tests cover reason/fresh-auth gating, permission visibility, revision
  and period submission, refreshed display, and lost-response receipt recovery.
- `git diff --check` passed. No native device tests were run.

## Release artifacts

Allowlisted archives were compared byte-for-byte against their source inputs.
No dotenv, credentials, dependencies, generated output or unrelated untracked
files are included. Working changes are not committed or pushed.

| Component | Files | Archive SHA-256                                                    |
| --------- | ----: | ------------------------------------------------------------------ |
| API       |   322 | `dcdab88532567c85080161b19e133a4a7f620a764b493cd45aa894a0b474ca7f` |
| Dashboard |   136 | `137982e5e3a3444c0f540db7b86a93e692d4c0ef1b4a334518c58a846af58d68` |

## Live verification

CapRover CLI deployments completed successfully. Active definitions read back:

- API: `img-captain-api:87` (previously 86).
- Dashboard: `img-captain-dashboard:15` (previously 14).
- API `/health/live` and `/health/ready`, and dashboard `/healthz`: HTTP 200.
- Unauthenticated reset POST, administrator/client realtime ticket POSTs and
  WebSocket upgrade: HTTP 401.
- Existing authenticated browser session restored successfully. The deployed user
  detail page showed **Reset usage**; its dialog displayed the correct reset scope,
  required reason and disabled reauthentication button while the reason was empty.
  The dialog was cancelled. No production reset was submitted.

The API initially returned 502 during container replacement, then recovered to 200. A Python urllib probe was rejected with 403 by the edge; curl and the actual
browser verified the healthy application. Local fixture tests prove reset writes;
production evidence covers deployed images, health, authentication and the live
UI, not a real-account reset. Changes remain uncommitted and unpushed.

## API guideline preflight

[Official Zalando RESTful API guidelines](https://opensource.zalando.com/restful-api-guidelines/)
read 2026-09-29. Rules 101 (OpenAPI), 104 (authorization), 106 (compatibility),
118 (snake_case), 149 (HTTP semantics), 151 (responses), and 176 (problem JSON)
shaped the additive route and contract. Existing API error middleware and
administrator permissions are reused.
