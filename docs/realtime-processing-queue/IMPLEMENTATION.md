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
