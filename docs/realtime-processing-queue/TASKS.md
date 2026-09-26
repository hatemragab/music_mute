# Realtime processing queue implementation backlog

Implementation is authorized and in progress. This backlog accompanies [PLAN.md](PLAN.md).
See [IMPLEMENTATION.md](IMPLEMENTATION.md) for the expanded all-web scope, task
status and evidence. Dependencies indicate execution order; release is not authorized.

## RQ-01 — Freeze semantics and protocol fixtures

- Depends on: study review.
- Scope: confirm recipe-relative job rank; web scope is resolved as `web-client/`
  with separate dashboard job integration retained. Reconcile
  stage-timing work in the primary checkout with the current remote base.
- Deliver: protocol document, strict message schemas, close/error catalog, safe
  queue reason precedence, connection/subscription limits, synthetic golden JSON
  shared by TypeScript/Kotlin/Swift tests. Keep versioning separate from admin CAS.
- Include schema for pagination, imports, usage/availability, atomic snapshot chunks,
  stale states and incompatible protocol behavior.
- Before implementing endpoints/wire contracts, apply the repository-required
  `zalando-api-guidelines` skill and review the current official guidelines.
- Done when: all three clients can represent every fixture, including null/unknown
  queue state and backwards-compatible HTTP responses; no private fields leak.

## RQ-02 — Share scheduler eligibility and compute rank

- Depends on: RQ-01.
- Main files: `backend/src/worker-fleet/claims/worker-claim.service.ts`,
  `backend/src/admin-settings/processing-admission.service.ts`,
  `backend/src/jobs/job-lifecycle-policy.ts`, `backend/src/jobs/job.schema.ts`;
  proposed queue projection service under `backend/src/jobs/`.
- Extract pure eligibility predicates; keep claim transactions/fences intact.
  Implement read-only batch admission/ranking with snapshot consistency and bounded
  queries. Handle effective account policy, allowance reservation and capacity.
- Add invalidation dependency mapping and deadline scheduling for time-only changes.
  Profile existing indexes before adding a targeted schema-declared index.
- Done when: property/fixture tests match claim eligibility; blocked owners do not
  inflate ranks; equal timestamps are stable; retries move according to existing
  `queuedAt` rules; simultaneous claims cannot produce double ownership; rank reads
  cause no writes or quota changes. Explain/query budget evidence recorded.

## RQ-03 — Secure raw WebSocket entry point

- Depends on: RQ-01.
- Main files: `backend/src/main.ts`, `backend/src/worker-hints/worker-hint.service.ts`,
  existing auth/admin/rate-limit/config modules; proposed `backend/src/realtime/`.
- Introduce one upgrade dispatcher; preserve worker hint protocol behavior.
  Add authenticated owner/admin ticket routes, digest storage, atomic consume,
  Origin/audience binding, permission checks, distributed connection leases,
  bounded frame/subscription handling, heartbeat and shutdown cleanup.
- Update safe configuration examples centrally; never copy ignored environment files.
- Done when: expired/replayed/cross-audience tickets fail, foreign origins fail,
  unauthorized subscriptions reveal no existence information, logout/revocation
  closes streams, worker sockets still pass, and tokens never enter logs.

## RQ-04 — Committed change feed and snapshot delivery

- Depends on: RQ-02, RQ-03.
- Main files: proposed realtime feed/subscription/projection services; existing job,
  import, policy, usage, user/session and worker schema modules as read dependencies.
- Register one shared feed per replica. Invalidate only relevant projections;
  serialize snapshot generation and coalesce dirty work. Send owner/admin-specific
  payloads, including queue updates caused by other jobs. Support filtered/paged
  snapshots and tombstone/missing-resource handling without exposing raw records.
- Add resume/rebuild, feed-health status, dependency outage handling, chunk bounds,
  socket backpressure, deadline recovery and generation fencing.
- Done when: a writer crash after commit does not lose the visible update; two API
  replicas receive changes; lost resume token produces full recovery; no “Live”
  status while feed is unhealthy; older async reads cannot overwrite newer state.

## RQ-05 — Complete lifecycle and import coverage

- Depends on: RQ-04.
- Audit writers: `jobs.service.ts`, `job-actions.service.ts`, metadata/deletion
  services, `worker-attempt.service.ts`, `worker-recovery.service.ts`, admin actions,
  account deletion/restriction paths, `url-imports/` and processing usage settlement.
- Ensure subscriptions observe create/upload confirmation/claim/progress/result
  upload/ready/failure/cancel/retry/rename/delete and import-to-job handoff.
- Explicitly test progress writes that do not increment job revision and queue
  updates that do not change the subscribed job. Avoid gratuitous writer refactors
  when the feed already observes the required committed state.
- Done when: a lifecycle matrix covers every producer and no valid transition
  depends on a periodic client read; usage and availability projections converge.

## RQ-06 — Android session transport and state integration

- Depends on: RQ-01, RQ-04, RQ-05.
- Main files: Android `processing/JobHistoryController.kt`, `UrlImports.kt`,
  `JobModels.kt`, `PushRegistrationCoordinator.kt`, processing view-model wiring,
  Gradle version catalog/build file; new small session transport/reducer.
- Verify/pin a compatible OkHttp dependency for raw WS; reuse token/session sources.
  Implement foreground ownership, reconnect/backoff, snapshot timeout, offline
  state, sequence/generation validation and account cache fencing.
- Replace job polling and import detail polling; preserve durable idempotent command
  recovery and existing local preparation/upload progress. Add usage subscription.
- Done when: JVM transport/reducer/controller tests prove reconnect, token refresh,
  account switch, deletion, page reset and import handoff; zero repeated status GETs.

## RQ-07 — iOS session transport and state integration

- Depends on: RQ-01, RQ-04, RQ-05.
- Main files: `ios/Vocal/State/ProcessingHistoryModel.swift`, `ProcessingModel.swift`,
  `ios/Vocal/Processing/JobModels.swift`, push registration and usage repository;
  proposed URLSession WS coordinator and reducer.
- Implement native receive loop, heartbeat handling, session/scene lifetime,
  reconnect and MainActor updates. Replace polling while preserving durable command
  and background transfer recovery. Regenerate Xcode project only if required by
  source additions, using `ios/project.yml` as authority.
- Done when: fixture tests prove cancellation and stale-account callbacks are fenced;
  the authorized simulator recovers through foreground/background and server loss.

## RQ-08 — Web dashboard subscriptions

- Depends on: RQ-01, RQ-04, RQ-05.
- Main files: `dashboard/src/features/jobs/jobs-page.tsx`, `job-detail-page.tsx`,
  `jobs-api.ts`, auth session, API contracts, query
  integration, `dashboard/server.mjs`; new browser WS provider.
- Replace detail/list timers and processing-specific focus/mount/reconnect refetch.
  Update caches directly from authorized snapshots; replace mutation invalidations
  with WS convergence, preserving CAS and operation receipt reconciliation.
- Support filter changes and pagination; update CSP to the exact configured WSS
  origin and add packaging/runtime-config tests. Never expose admin scopes to owners.
- Done when: browser network tests show no hidden job refresh requests; filters,
  roles, multiple tabs, dropped connections and production CSP behavior are covered.

## RQ-08A — End-user web client subscriptions

- Depends on: RQ-01, RQ-04, RQ-05. Required for the requested three-platform feature.
- Main files: `web-client/src/jobs/JobsUI.tsx`, `home/HomePage.tsx`,
  `home/AudioUpload.tsx`, `library/LibraryPage.tsx`, `settings/SettingsPage.tsx`,
  `auth/AuthProvider.tsx`, `App.tsx`, `api/types.ts`, `api/wire.ts`, and
  `web-client/server.mjs`; add a small owner-session WS provider/reducer.
- Replace 5-second history, 4-second detail and 4-second import polling. Use owner
  ticket scope only. Preserve installation-scoped requests and auth generation
  cleanup; dispose sockets and subscriptions during logout/account switch and
  React StrictMode remount. Do not copy admin permissions/contracts into this app.
- Share snapshots across Home/Jobs/Library and detail; preserve infinite pages,
  favorites/hidden preferences and current playback. Handle restored import IDs,
  submitted-import navigation and upload completion before subscription attachment.
- Disable processing query default focus/reconnect/mount HTTP refetch and broad
  owner invalidations that would restart polling-like reads. Retain explicit HTTP
  commands, media grants and transfers; include usage and policy subscriptions.
- Add exact WSS API origin to runtime CSP and server tests. Keep Firebase/media
  permissions intact, no credentials in config, no new environment secret required.
- Done when: Vitest reducer/component and desktop Chrome tests prove queue changes,
  terminal transitions, import-to-job handoff, multiple tabs, reconnect, hidden-tab
  resume and account switch. Network assertions prove zero periodic processing
  reads and no event-triggered GET loop. Check EN/AR at 360/390/768/1024/1440 widths;
  record fixture evidence separately from authenticated live testing.

## RQ-09 — Consistent queue UI and accessibility

- Depends on: RQ-06, RQ-07, RQ-08, RQ-08A.
- Main files: Android processing detail/history/card/presentation and EN/AR strings;
  iOS corresponding views/presentation and localized strings; end-user web
  `JobsUI.tsx`, Home/Library, `i18n.tsx`, `styles.css`; dashboard job views.
- Add compact rank block and connection state. Remove Refresh/pull-to-refresh;
  distinguish waiting, unknown, blocked and not-queued. Preserve local transfer
  progress and playable cached results during connection loss.
- Done when: initial/live/stale/offline/blocked/retry/terminal fixtures pass; RTL,
  Arabic plurals, large text and accessibility are reviewed; scroll/playback remain
  stable and progress announcements are not noisy. No ETA or auto-download added.

## RQ-10 — Fault, security and performance verification

- Depends on: RQ-05 through RQ-09, including RQ-08A.
- Add isolated Mongo replica-set/Redis integration scenarios with two compiled API
  instances, synthetic auth, controlled workers, slow clients and network failure.
- Test simultaneous claims, duplicate/out-of-order callbacks, watcher recovery,
  ticket storms, oversized frames, subscription amplification, role/access changes,
  deleted resources, deadline-only eligibility changes and reconnect storms.
- Define and record load: concurrent sockets, active queue size, update frequency,
  replica count and hardware. Measure p95 propagation/snapshot latency, query cost,
  memory, timers and open sockets after teardown. Tune the proposed limits from data.
- Done when: no isolation leaks, loss of terminal state, unbounded buffering or
  periodic client reads; latency meets PLAN targets under the documented workload.

## RQ-11 — Documentation and release readiness

- Depends on: RQ-10.
- Update `backend/openapi.yaml` for ticket HTTP routes, `docs/api/client-contract.md`,
  versioned WS protocol, backend/client READMEs and proxy/CSP runbook. Correct stale
  processing/queue wording within the changed scope.
- Document additive rollout, monitoring, compatibility, stream-disabled behavior,
  rollback and migration/index implications. Verify change-stream privileges and
  proxy settings only in an authorized environment; do not mutate production here.
- Done when: completed tasks link actual evidence and distinguish unit/build,
  simulator/browser, staging and live results. Commit/push/deploy require a later
  explicit request. Mark this feature implemented only after all mandatory gates.

## Validation commands for the implementation phase

These commands are planned, **not executed by the study**. Run focused suites first;
broaden once implementation is complete, without repeatedly running costly suites.

```sh
# backend/ — locked Node 24 / pnpm 10; isolated services only
pnpm install --frozen-lockfile
pnpm run verify
pnpm run test:processing:integration
pnpm run test:imports:integration
pnpm run test:worker:integration
pnpm run test:realtime:integration
# Worker integration also requires the worker's locked dependencies/build.

# dashboard/
npm ci
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:deployment
npm run test:e2e
npm run build

# web-client/ — end-user app; separate from admin dashboard
npm ci --ignore-scripts
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:server
npm run test:e2e
npm run build

# android/ — compile/JVM checks; no unauthorized device target
ANDROID_HOME=/Users/hatemragap/Library/Android/sdk \
ANDROID_SDK_ROOT=/Users/hatemragap/Library/Android/sdk \
./gradlew :app:testDirectDebugUnitTest :app:testPlayDebugUnitTest \
  :app:lintDirectDebug :app:lintPlayDebug \
  :app:assembleDirectDebug :app:assemblePlayDebug

# ios/ — only existing authorized simulator; do not create clones
xcrun swift-format lint --recursive Vocal VocalTests VocalUITests scripts
xcodebuild -project MusicMute.xcodeproj -scheme MusicMute \
  -destination 'platform=iOS Simulator,id=3CC14436-EC3C-4419-A079-C84951E5FA07' \
  -derivedDataPath DerivedData -parallel-testing-enabled NO \
  test CODE_SIGNING_ALLOWED=NO

# repository root
git diff --check
```

Use the existing project formatters for touched files; inspect package scripts
again before execution. Fresh-worktree ignored Firebase configuration and SDK
availability may block native builds: report that rather than committing config.
If the authorized simulator is unavailable, report the blocker. Android device/UI
proof remains explicitly outstanding under the user's current device restriction.

## Study verification record

- Remote `main` fetched; feature branch HEAD equals recorded `origin/main` SHA.
- Main fetched and fast-forward merged again at `29a98542`; new `web-client/`
  inspected and incorporated into the plan. No merge conflicts or new merge commit.
- Existing main-checkout changes preserved; new managed worktree created.
- Runtime source, manifests, configuration and platform README files inspected.
- No application implementation, test run, build, deployment or production proof.
- Documentation whitespace/link and branch checks are recorded in the final report.

## Implementation follow-through

The initial study record above is historical. Implementation and actual local
results are recorded in [IMPLEMENTATION.md](IMPLEMENTATION.md); the implemented
wire contract and limits are in [PROTOCOL.md](PROTOCOL.md). RQ-01 through RQ-09
and documentation are implemented locally. RQ-10 local correctness checks have
run; production-scale performance, staging proxy/privilege checks and unauthorized
device targets remain explicitly unverified release gates.
