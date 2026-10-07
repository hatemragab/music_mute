# Realtime implementation ledger

Implementation authorized on 2026-09-26. Worktree branch:
`hatem/realtime-processing-queue`, base `29a98542`.
No commits, pushes, deployment or live data changes authorized.

## Expanded scope

All browser polling must be replaced, including these previously excluded areas:

| App / scope                         | Existing interval                 | Replacement                                            |
| ----------------------------------- | --------------------------------- | ------------------------------------------------------ |
| Public jobs / Home / Library        | 5 seconds                         | Shared owner job-page subscription                     |
| Public job detail                   | 4 seconds                         | Owner detail subscription                              |
| Public URL import                   | 4 seconds                         | Owner import subscription and job handoff              |
| Admin jobs / detail                 | 30 / 20 seconds                   | Authorized page/detail subscriptions                   |
| Admin fleet / machine / diagnostics | 30 seconds                        | Permission-filtered worker subscriptions               |
| Admin invitations                   | 60 seconds                        | Enrollment subscription                                |
| Admin overview                      | 60 seconds                        | Aggregate snapshot on relevant changes / time boundary |
| Admin health / alerts               | 60 seconds                        | Shared server monitor and pushed snapshots             |
| Admin recovery list / badge         | 60 seconds                        | Recovery page/summary subscriptions                    |
| Admin APK verification              | 2 seconds, bounded at 120 seconds | Upload-verification subscription                       |

Explicit commands, sign-in, token refresh, security revalidation, signed transfers
and media grants remain HTTP. UI animation, input debounce and operation deadline
timers are not data polling. Eliminate data-refresh controls on migrated screens;
provide one quiet connection indicator and automatic recovery. Reconnect retries
the transport. Never silently switch new clients back to HTTP polling.

## Simplicity decisions

- Reuse `ws`; do not add Socket.IO or a second socket framework.
- One upgrade dispatcher, one session connection, bounded resource subscriptions.
- Reuse existing domain read services and permissions; no arbitrary path/RPC proxy.
- Complete snapshots first; no general patch language or durable client replay log.
- Database changes trigger snapshots. Health probes and time-dependent aggregates
  run in one bounded server monitor, not once per browser or per subscription.
- Keep TanStack Query as the view cache; disable automatic refetch for live scopes.
- Preserve native local preparation/transfers and session-generation fences.

## Added tasks

- RQ-08B: dashboard worker fleet/machine/diagnostic/invitation subscriptions;
  preserve permission checks and reviewed administrative commands.
- RQ-08C: overview, health/alerts and account-recovery list/badge subscriptions;
  shared monitoring must detect non-database failures and time-window changes.
- RQ-08D: APK verification subscription, including reconnect while verification is
  active; retain upload cancellation semantics. Verification remains subscribed
  until terminal state or user cancellation, so slow verification is not reported
  as failure simply because the former polling deadline elapsed.
- RQ-10A: scan both browser apps for recurring status reads, plus network assertions
  on every migrated screen. Test queries on focus, mount, reconnect and mutations.

These supplement all tasks in TASKS.md; Android/iOS are still required.

## Research and contract preflight

Read current official sources on 2026-09-26:

- [ws](https://github.com/websockets/ws#multiple-servers-sharing-a-single-https-server):
  one HTTP upgrade dispatcher routes to separate `noServer` WS handlers.
- [TanStack Query defaults](https://tanstack.com/query/latest/docs/framework/react/guides/important-defaults):
  stale queries can refetch on mount/focus/reconnect independently of intervals.
- [MongoDB change streams](https://www.mongodb.com/docs/manual/changestreams/):
  shared committed-change feed with resumption and explicit snapshot recovery.
- [Zalando API guidelines](https://opensource.zalando.com/restful-api-guidelines/):
  104/105 authentication and permissions; 118 snake_case; 106 compatibility;
  101 OpenAPI and 151 documented responses; bounded pagination and explicit
  event ordering/idempotent consumption. HTTP methods/status rules apply to
  ticket endpoints, not to WS frames. Keep this repository's Firebase security,
  error envelopes and enum conventions; do not import Zalando-specific IAM or
  event registration infrastructure.

## Implementation status

| Work                                    | Local result                                                                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| RQ-01/02 queue semantics and projection | Shared scheduler eligibility/capacity predicates; consistent read-only rank, blocked reasons, retry/liveness deadlines, bounded work |
| RQ-03/04 transport and auth             | Shared upgrade dispatcher, owner/admin tickets, current authorization, distributed connection leases and protocol bounds             |
| RQ-05 feed and recovery                 | One committed Mongo feed per API process, resume handling, closed sockets on feed loss, full snapshots after recovery                |
| RQ-06 Android                           | Raw OkHttp transport, foreground session fencing, live history/detail/imports, queue/progress UI, removed Refresh controls           |
| RQ-07 iOS                               | Native URLSession WebSocket, live history/detail/usage, foreground/session fencing, queue/progress UI, removed Refresh controls      |
| RQ-08/08A public web and dashboard      | Shared native browser connection, live query caches, full migrated polling inventory, exact WSS CSP                                  |
| RQ-08B/08C/08D admin auxiliary scopes   | Fleet/diagnostics/invitations, overview/health/alerts, recovery, APK verification snapshots                                          |
| RQ-09 UX                                | EN/AR queue and connection states, hide stale ranks, existing playback/transfer behavior preserved                                   |
| RQ-10 local correctness                 | Unit, integration, browser, native build/lint and simulator suites; see evidence and limitations below                               |
| RQ-11 docs                              | HTTP OpenAPI tickets, versioned PROTOCOL.md, client contract, component README links and rollout prerequisites                       |

## Validation evidence — 2026-09-26

All results are local, using synthetic identities/data and isolated loopback
services. No deployed feature, production proxy or real Firebase/S3 flow is claimed.

- Backend `pnpm run verify`: formatting, lint, types, secret scanner, **900 unit
  tests / 125 files**, **148 API tests / 25 files**, and build passed. Afterwards,
  `pnpm exec vitest run src/realtime` passed **43 tests / 5 files**, including
  additional permission-registry tests; lint and typecheck passed again. Final
  targeted transport/worker-hint run passed 48 tests / 7 files after the explicit
  per-process connection cap was added.
- `node --test test/dashboard-contract.integration.mjs test/realtime.integration.mjs`:
  compiled Nest application/HTTP workflow and main readiness passed; real Mongo
  replica-set/Redis test passed with two independent API transport/feed instances.
  The realtime test was extended and passed again: committed queue movement reaches
  both sockets, rollback is invisible, owner isolation/admin denial, ticket replay
  rejection, actual change-cursor loss closes the client, recovery returns a fresh
  snapshot, and account suspension closes both sessions.
- Public web: format, lint, typecheck, **15 unit tests**, production build,
  **4 server tests** and **3 existing Chrome tests** passed. New native-WebSocket
  browser test passed: pushed queue #3 -> #1, no status GETs through 31 seconds,
  no Refresh button; offline hides old ranks and reconnect restores a fresh rank. Production bundle has an existing >500 KiB chunk warning.
- Dashboard: lint/typecheck, **74 unit tests / 22 files**, production build and
  **11 deployment tests** passed after removing unused polling/Refresh utilities.
  **32 Chrome tests** passed; new raw-WebSocket browser test also passed, proving
  pushed detail changes and no status GETs through 61 seconds. Whole-tree format
  check flags unchanged `src/observability/sentry.test.ts`; touched files formatted.
- Android: `:app:testDirectAuthE2eUnitTest --tests 'com.hatem.musicmute.processing.*'`,
  `:app:assembleDirectAuthE2e`, `:app:lintDirectAuthE2e`: **157 processing tests / 24
  classes**, build and lint passed. Includes real transport orchestration with
  injected socket, no periodic status reads, duplicate suppression and owner fencing.
- iOS: fixture `build-for-testing` succeeded on the specified existing simulator.
  **140 unit tests, one intentionally skipped live test, zero failures** when the
  missing-Firebase-configuration test is explicitly excluded. Raw socket tests cover
  snapshot decoding, duplicates, background cancellation and logout during ticket
  issuance and forbidden-ticket retry suppression. Initial full run's four assertions all came from the absent plist test.
- iOS UI: six of eight original fixture tests passed initially. The two failures
  were repaired: stable job accessibility identifiers restore the native Files
  import scenario, and full-height timeline text without status ellipses passes
  the Arabic dark/large-text clipping audit. Both failing scenarios passed on
  targeted reruns on the same specified simulator. These are synthetic UI tests,
  not a live mobile-to-backend run.
- Touched Swift files: `xcrun swift-format lint` passed after formatting.
- `git diff --check`: passed. Main checkout and unrelated stage-timing work preserved.

## Bounded local propagation baseline

`node --test test/realtime.integration.mjs` also passed with six authenticated
sockets across two independent transport/feed instances, 202 queued jobs and eight
sequential committed updates on Apple M4 Pro / 24 GiB RAM. Maximum (nearest-rank
p95 for eight samples) commit-to-all-six-snapshots latency was **1,079 ms**, including
the one-second coalescing window. A seventh account connection was rejected with 429. Extra sockets closed cleanly before feed-loss/revocation checks. This small
single-host fixture is not evidence for the 3,000-connection production limit.

## Environment and release limits

- The iOS worktree does not contain GoogleService-Info.plist. Builds used the
  generated fixture project without that missing resource and a test-owned
  xctestrun launch argument; repository project references are preserved for real
  configuration. No credentials/configuration were copied into source.
- Android normal debug Google Services configuration is absent. The auth-E2E
  variant is self-contained. An earlier broad auth-E2E run also exposed the
  installer's hardcoded production package assertion against the `.authtest`
  package; the focused processing suite above is the verified feature result.
- No Android device/UI testing, physical iOS, production Firebase/S3, staging proxy,
  database privileges or production rollout testing was performed. Device/UI work
  used only iPhone 17 Pro iOS 26.0, UDID
  `3CC14436-EC3C-4419-A079-C84951E5FA07`.
- The protocol's fleet-scale connection/queue limits are defensive starting values,
  not a measured production capacity claim. Large-scale load/reconnect-storm and
  staging failure exercises remain release gates. The isolated integration uses two
  transport/feed instances in one process, not two deployed API processes.
- APK verification stays subscribed until terminal state or cancellation. Commands,
  media grants, explicit security revalidation and file transfers remain HTTP.
- Nothing committed, pushed, published or deployed.

## Browser connection lifetime correction — 2026-09-27

Branch `hatem/keep-live-socket` is based on `origin/main` at `c1891ddb`. The
public web client and administrator dashboard no longer close their shared
session socket when the document becomes hidden. Route changes and browser-tab
switches now retain the existing connection; offline/network loss, server or
watchdog closure, session expiry, logout and app unmount retain their existing
recovery behavior. Browser watchdog and initial-snapshot deadlines are suspended
while hidden, then rearmed with a grace window when visible. View/cache listener
failures are isolated from protocol handling so they cannot restart the transport.
Regression tests assert that hidden-tab and repeated start or online signals still
issue one ticket and construct one socket per app session.

Backend heartbeat refresh now targets only resources whose representation changes
from elapsed time or live probes. Active job and job-list subscriptions retain the
refresh needed for server timing and progress-staleness fields; once a job or every
item in a page is terminal, refresh becomes change-driven. Policy subscriptions
use committed-change invalidation, and the queue projection retains exact retry
and worker-liveness deadlines. One-minute aggregate socket telemetry records
active/accepted/rejected/closed counts, bounded read latency, snapshots, bytes and
maximum buffered output. It contains no identity, resource name, subscription
parameters or payload data.

Backend `pnpm run verify` passed formatting, lint, types, secret and transfer
checks, 935 unit tests / 131 files, 148 HTTP tests / 25 files and the production
build. Both browser clients passed targeted realtime tests (7 each), typecheck,
lint, full unit suites (web 93; dashboard 82), production builds, web server tests
(7), dashboard deployment tests (11), web Chrome tests (5), and dashboard Chrome
tests (34). The Chrome realtime fixtures keep the document hidden for two minutes
past the former watchdog deadline and verify that ticket and physical connection
counts remain one. The dashboard-wide format check remains blocked by pre-existing
formatting in `src/observability/sentry.test.ts`; all files changed by this
correction pass Prettier. These are local and fixture checks, not deployment or
production connection proof.

### CLI worker hint socket follow-up

The same branch also corrects the CLI worker hint transport. The client now
cancels its ten-second handshake deadline once the socket opens, keeps a single
connection loop, closes erroring transports, isolates local wake-listener
failures and applies jittered exponential backoff that resets only after a stable
connection. A Redis compare-and-renew lease permits one active hint connection
per machine identity across API instances; clean closure releases it, heartbeat
renewal fails closed, and dead connections remain bounded by lease expiry. Hint
broadcasts also enforce bounded output buffering and isolate send failures.

The worker hint tests now cover two simulated minutes on one opened socket,
duplicate starts, increasing retry delays and listener isolation. A real local
12.5-second WebSocket run reproduced two tickets/connections before the fix and
one ticket/connection with no closure afterward. Backend tests cover duplicate
machine rejection (`429` plus `Retry-After`) and reconnect after lease release.
Worker protocol sync, changed-file format, lint, typecheck, 398 TypeScript tests,
73 Python engine tests passed (one skipped) and the worker build passed. The worker-wide format gate
remains blocked by unchanged `worker/pnpm-lock.yaml`; its Git object is identical
to `HEAD`. Backend `pnpm run verify` remains green with 935 unit tests, 148 HTTP
tests and its production build. No worker binary, API image or production service
was published or deployed.

### Socket review corrections — 2026-09-27

Review identified malformed worker hints that could throw outside the parse
guard, close codes rejected by Node's native WebSocket, and a browser tab-return
deadline being restarted after a definitive subscription error. Both browser
clients now preserve that completed error response. The worker validates hint
objects and string types without coercion and uses the supported private close
code 4000 for invalid hints and transport errors. Retry delays release abort
listeners, shutdown fences pending ticket responses, and reconnect waits for the
previous socket's close event even after a handshake timeout.

Regression coverage includes malformed JSON shapes, delayed socket closure,
shutdown during ticket acquisition, a real local native WebSocket malformed-hint
exchange, and two API instances sharing a fake Redis machine lease. The latter
is a local service test, not live Redis failover or multi-host deployment proof.
Backend `pnpm run verify` passed with 936 unit and 148 HTTP tests. Web and
dashboard full unit suites passed (94 and 83), as did their realtime Chrome
fixtures (one and two), typecheck, lint and builds. Worker `pnpm test` passed
409 tests (two skipped); typecheck, lint and build also passed. The unchanged
worker lockfile and dashboard Sentry test formatting limitations noted above
remain. No production deployment or production soak test was performed.

## Direct-main integration — 2026-09-26

Integrated realtime work with remote main `796ce894`, preserving original-audio
comparison, optional trimming, transfer diagnostics/acceleration, startup UI and
build-version monitoring. Build-version checks remain distinct from the migrated
job/status data subscriptions. Regenerated the iOS project from project.yml to
include both source sets. Production images from the earlier deployment do not
prove this later combined source revision has been deployed.

Validation of the combined source:

- Backend `pnpm run verify`: 933 unit and 148 HTTP tests passed, along with
  format, lint, typecheck, secrets checks, transfer benchmark and build.
- Compiled worker-flow, imports and realtime integrations: seven passed using
  isolated local services. Six-socket propagation maximum was 1,153 ms.
- Dashboard: typecheck, lint, 79 unit tests, build and two realtime Chrome tests
  passed. Public web: typecheck, lint, 90 unit tests, build, seven server tests and
  the realtime Chrome test passed. Initial web server test used stale dist; after
  rebuilding it passed. Browser suites were run sequentially due to shared port.
- Worker: typecheck, lint, 394 tests passed (two skipped), and build passed.
- Android: focused processing JVM tests, assembleDirectAuthE2e and
  lintDirectAuthE2e passed. No device test was run.
- iOS: fixture build-for-testing passed for the mandated iPhone 17 Pro simulator.
  The fixture omits the absent local Firebase plist; production configuration
  remains required. Checked repository configuration was preserved.
- iOS focused fixture tests: 37 passed, zero failures on the specified simulator.
  The first test invocation lacked the fixture launch argument and failed on the
  absent Firebase plist; rerunning with the test-owned argument passed.
- Android focused processing suite: 161 tests. Swift conflict files passed strict
  swift-format lint; merged source passed git diff --check.

## Mac worker registration approval — 2026-10-06

Added the owner-scoped `worker_registration` snapshot and default-false account
registration permission. Administrator approval reaches the open Mac app through
its existing account socket and can start first registration from any screen.
New user-originated enrollment is fenced against permission/account changes;
activated machines use their own credentials and retain existing fleet claim and
lifecycle rules. Disabling registration permission or deleting the registering
account does not revoke a machine. Provenance is informational only. The dashboard
uses an audited reason/revision/reauthentication mutation and no longer exposes
enrollment codes.

Review added coverage for interrupted registration after relaunch, same-account
credential replacement, operation ownership while inspecting local state, and
explicit removal surviving app/account events and relaunch. The Mac persists only
non-secret pending registration identity/removal intent; worker controller and
runtime source are unchanged. Dashboard post-commit read failures retain the
operation ID and block another write until its saved outcome is read.

Local validation:

- Backend format, lint, typecheck, `pnpm test` (1,652 unit tests),
  `pnpm run test:e2e` (216 HTTP tests), and eight transfer-benchmark tests passed.
- `node --test test/worker-registration.integration.mjs`: seven tests passed with
  an owned Mongo replica set, including deterministic concurrent permission
  removal during activation, multiple Macs, legacy registration, and machine
  authentication/replay after the registering account was deleted.
- `pnpm run build` plus `node --test test/realtime.integration.mjs` passed with
  owned Mongo/Redis and two API feeds. Missing permission defaulted false,
  approval/removal propagated to both feeds, another account remained false,
  caller-supplied account parameters were rejected, and reconnect restored current
  permission. The six-socket/202-job fixture's measured maximum propagation was
  1,048 ms; this is not a production latency target.
- `pnpm run test:worker:integration` passed the compiled backend/worker
  authoritative job flow using isolated fixture identity, storage, and processing.
- Dashboard format, lint, typecheck, 164 unit tests, and production build passed.
  The selected Chrome suite passed 31 tests; after the final read-back fix the
  seven affected registration browser tests also passed. Coverage includes roles,
  lost/failed reads without write replay, machine controls, 360/768/1440 widths,
  accessibility, and keyboard scrolling.
- Companion `npm run verify` passed 2,096 tests (four skipped), typecheck, lint,
  build, and formatting. Final Swift native checks passed all six suites with
  Swift 6 warnings-as-errors, and the actual ARM64/macOS 14 app entry point
  compiled. English/Arabic registration states were rendered offscreen; these are
  synthetic layout checks, not an installed-app session.
- OpenAPI parsed with 142 paths and 1,535 resolved local references. Diff checks
  passed, and worker source/tests/package/protocol, dependency manifests/locks,
  and environment files have no changes from this task.

The complete backend `pnpm run verify` stops at the repository-wide tracked
secret scan: it flags unchanged `video_providers/ytdlp/.env.example` and
`video_providers/ytdlp/test_diagnostics.py` as credential assignments. No values
were displayed or changed. The scan's five unit tests passed; the remaining
backend checks above ran separately. `pnpm audit --prod` also reports one existing
moderate Joi advisory (`GHSA-wr44-6hxh-3jwq`); dependencies were not changed.

No real account, provider, R2, installed LaunchAgent, or macOS login lifecycle was
used for this validation. No DMG, commit, publication, installation, or deployment
was performed. Matching backend/dashboard/Mac releases and separately authorized
installed-Mac registration/login verification remain delivery gates.

### Authorized deployment and installed acceptance — 2026-10-06

The later deployment request completed through CapRover CLI. The active images
are `img-captain-api:117` and `img-captain-dashboard:31`, each with one instance
and no build in progress. Independent read-back confirmed both environment
inventories are unchanged. The deployed allowlisted archives have SHA-256:

- API: `1d3ad021dd8668f5aa41f4089d1e7f72f3111f651cd991bcdb0151643f7a00f2`.
- Dashboard: `52f5b11d08227a7894c8d2fc909d604eeb731325c4600a46cec05a39f3f4bd99`.

API liveness/readiness return 200. Owner/admin registration and realtime-ticket
routes reject requests without authentication with the expected 401 problem
responses; websocket handshakes without a ticket also return 401. Dashboard
health, authenticated-route SPA entry points and runtime configuration return 200. Its 51 served JavaScript/CSS assets and seven other static files match the
archive-shaped build byte-for-byte. Hidden paths and missing assets return 404;
security headers and registration/provenance markers pass. These public checks
do not establish authenticated administrator actions.

The earlier verification blockers were resolved: Joi is pinned to 18.2.9, and
empty provider example values/synthetic diagnostics no longer trigger the secret
scanner. Complete backend verification now passes 1,652 unit and 216 HTTP tests,
plus formatting, lint, types, secrets, benchmarks and build. Eleven compiled
integrations pass. The device integration separately confirms metadata revision
and account-switch fences. Production dependency audits pass for both services.
Dashboard validation passes 164 unit, 19 deployment and 50 Chrome fixture tests;
the final container mitigation changes no browser build bytes. Six upstream
development-only dependency findings remain in the optional shadcn CLI chain.

Repeated dashboard builds failed inside BuildKit after dependency installation.
The app Dockerfile now resolves its optional file secret before one combined
install/build step, disables npm lifecycle scripts and enforces release presence
when a source-map token is supplied. The resulting archive deployed successfully.
This matches the Dockerode session-health defect described in
[issue 845](https://github.com/apocas/dockerode/issues/845); the deployed Dockerode
version and exact failed vertex were not independently established. No global
builder or application configuration was changed. The unchanged repository-wide
secret scan also passes after replacing the computed token assignment with a
shell read that handles token files both with and without a trailing newline.

Mac build `1791296418` is installed with matching inventory and strict signature
verification. The earlier live Google bootstrap exposed fixed revision-1
metadata; the client now persists metadata revisions and performs one bounded,
owned-device reconciliation. The repaired installed app published a connected
account scope and revision 2 for build `1791295340`. No account token was read or
logged.
The registered worker's identity/credential remain unchanged, and it stays ready
while the GUI is closed and the personal account is signed out.

Real local-file inference exposed a separate GPU handover failure before an
admission grant: the worker could not confirm its processing child had stopped.
The service subsequently recovered to healthy/ready with zero active attempts.
Internal worker diagnostics now preserve only fixed stop-stage codes and
allowlisted OS error codes; shutdown deadlines and GPU fences are unchanged.
Twenty-one focused and 726 full worker tests pass. Installed Mac build
`1791296418` contains these diagnostics and passes all 16 offline package checks.
Its app-managed worker update committed
`0.1.3-app.e748a9b48b8ede830625a6cb` without changing the original machine or
credential. A later real local-file retest reached Voice ready and completed
three-second playback. The old worker processing group exited cleanly, with no
new fatal/stop-stage error, and the same supervisor returned to healthy, ready
and claim-eligible fleet operation. No stop deadline or GPU guard was weakened.
The original YouTube/cloud processing selections were restored after testing.

The real administrator approval, fresh-machine registration and completed-job
cycle remain unverified. The tested Google account is not a dashboard
administrator, and the existing Mac is already registered. No administrator
permission, existing machine credential, real account deletion or R2 job was
changed to force that test. Desktop controls recovered after the owner closed
the earlier app. Account restoration on the latest build is waiting inside
macOS Keychain, before HTTP; the intended administrator account and the macOS
access response remain required for visible acceptance. Automatic safety review
blocks Computer Use access to SecurityAgent, so the owner must handle any system
prompt. The Mac packages are
ad-hoc local updates for the prepared runtime, not notarized or fresh-network
releases. No commit, push or public Mac artifact publication was performed.

### Dashboard machine deletion source and deployment — 2026-10-06

`POST /admin/workers/machines/:id/deletions` adds an owner-only, freshly
reauthenticated, revision-fenced operation. One MongoDB transaction disables the
registering account's worker approval, records both audit events and retires the
machine's installation/session/leases. Registered provenance cannot be reassigned;
legacy machines require an explicitly selected existing account. A tombstone
preserves internal audit/job references while fleet lists and detail/diagnostic
views hide the machine. Authenticated old credentials receive
`410 WORKER_MACHINE_DELETED`; the existing unpair route alone remains available
for bounded cleanup. Ordinary revocation keeps its existing authentication error.
Stable operation receipts prevent repeated deletion or permission changes after
an ambiguous result and later reapproval.

The dashboard adds **Delete machine** with explicit account/reason/revision review,
fresh Google reauthentication and read-only operation reconciliation. The mounted
control survives the machine's live disappearance so a committed deletion can be
confirmed without replaying the write. Its confirmation button changes colors
atomically, preserving focus contrast under normal browser motion.

Source validation passed complete backend verification: 1,659 unit tests, 220
HTTP tests, eight transfer benchmarks, five secret-scan tests plus the tracked
scan, formatting, lint, types and build. Seven compiled deletion integrations
passed, including actual transaction rollback when audit insertion fails. The
combined compiled users/realtime/registration/deletion run passed 16 tests.
Dashboard checks passed 182 unit, 19 deployment and 56 installed-Chrome fixture
tests, plus formatting, lint, types and production build. Worker verification
passed 768 tests (21 skipped), including 178 focused tests, protocol, formatting,
lint, types and build. Synthetic/isolated tests do not establish a real deletion.

CapRover CLI deployed `img-captain-api:121` and `img-captain-dashboard:32`, each
with one instance and no build in progress. Independent environment inventory
digests are unchanged. API liveness/readiness return 200, and the new deletion
route returns its expected 401 problem without authentication. Dashboard health,
SPA entry and uncached runtime configuration return 200; hidden paths/missing
assets return 404. All 51 declared served JavaScript/CSS assets match the exact
archive-shaped build, including registration/deletion markers across their
respective feature chunks.

The API archive SHA-256 is
`b3a9f9b4f0830d680bd40fe349040458f1f93b87f55978d1bd4665b215d43684`;
the dashboard archive is
`506cb1334f289294b497aa1e46f51ca3c9fb687da6d3af06fdf810fc8a8aedea`.
After three failed API builds, its Dockerfile now resolves an optional file secret
before one combined install/build step; all source inputs precede that step.
Twelve executable shell-fixture tests validate absence/empty/newline handling,
token isolation from installation/build, release requirements, source-map upload
and failure propagation. The failure matches the upstream
[Dockerode session-health issue](https://github.com/apocas/dockerode/issues/845);
the installed upstream versions remain unverified.

The successful API archive reused the already running version-117 production
runtime. Package/lock/npmrc/catalog inputs were independently byte-identical;
build-time comparisons plus exact Node/APK-tool checks enforce that assumption.
All current TypeScript source was compiled in the pinned Node 24.21.0 build stage
and replaced the generated API output. Only the archive's Dockerfile uses this
runtime reuse; the tracked production/APK stages remain unchanged. No global
builder, application environment or service permissions were changed. Matching
backend/dashboard production dependency audits report no vulnerabilities.

Prepared-Mac installation and the real deletion/reapproval/registration cycle are
separate acceptance boundaries recorded in
[the Mac integration ledger](../../chrome-extension/docs/macos-worker-integration.md).
