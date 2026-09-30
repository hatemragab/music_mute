# Realtime processing: AI handoff

Snapshot date: 2026-09-26. This documents implemented source, not a future proposal.
At documentation time the work is local and uncommitted on
`hatem/realtime-processing-queue`, based on merged remote main `29a98542`.
Recheck Git/worktree state before continuing; these are dated facts, not a reason
to reset, replace or recreate a checkout. The primary checkout's separate
stage-timing work was preserved and must not be overwritten.

## Read order and authority

1. Root and affected component `AGENTS.md`/README instructions.
2. [PROTOCOL.md](PROTOCOL.md): implemented transport, resources, permissions,
   queue semantics, limits and rollout requirements.
3. [IMPLEMENTATION.md](IMPLEMENTATION.md): dated changes, actual commands/results,
   fixture limitations and remaining release gates.
4. [PLAN.md](PLAN.md) and [TASKS.md](TASKS.md): original study and task rationale.
   Proposed acceptance targets are not measured results or deployment evidence.
5. Actual source and tests. If source and docs disagree, investigate and update
   the documents with verified behavior; do not invent missing implementation.

## What changed

All recurring public-web and administrator-dashboard status polling was replaced
with native browser WebSocket subscriptions. Native Kotlin/Compose Android and
Swift/SwiftUI iOS job history/detail also use raw WebSockets. This is not Flutter,
Socket.IO or SSE. Android URL-import tracking and iOS usage updates use the same
session-owned transport. The full browser scope inventory is in the ledger.

Data flow: authenticated HTTP ticket -> single-use Redis ticket -> raw WebSocket
upgrade -> bounded resource subscription -> authorized complete snapshot. Committed
Mongo changes invalidate subscriptions through one change-stream cursor per API
process. Timer-driven eligibility, progress freshness and health/window changes
also trigger server-side updates. Reconnect gets a fresh ticket and snapshots.

HTTP remains for authentication, commands, signed media/transfer grants, uploads,
downloads and explicit non-live reads. Preserve legacy REST routes for old clients.
Do not replace transfers or mutation idempotency/CAS with an arbitrary socket RPC.

## Source map

Paths below are relative to the repository root.

| Responsibility                                          | Main files                                                                                                                                                                                                              |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared upgrade routing, including existing worker hints | `backend/src/http/websocket-upgrades.ts`, `backend/src/main.ts`, `backend/src/worker-hints/worker-hint.service.ts`                                                                                                      |
| Tickets, principals and current access                  | `backend/src/realtime/realtime-ticket.controller.ts`, `realtime-auth.service.ts` in the same directory; `backend/openapi.yaml`                                                                                          |
| Frames, subscriptions, deadlines and limits             | `backend/src/realtime/realtime-protocol.ts`, `realtime-socket.service.ts` in the same directory                                                                                                                         |
| Domain resources, permissions and invalidations         | `backend/src/realtime/realtime-resources.service.ts`, `realtime-dependencies.ts`, `realtime-feed.service.ts`                                                                                                            |
| Read-only queue projection and scheduler parity         | `backend/src/realtime/queue-projection.service.ts`, `backend/src/jobs/dispatch-eligibility.ts`, `backend/src/admin-settings/processing-admission.service.ts`, `backend/src/worker-fleet/claims/worker-claim.service.ts` |
| Public browser connection and query cache               | `web-client/src/realtime/client.ts`, `RealtimeProvider.tsx` in the same directory; `web-client/src/jobs/QueuePosition.tsx`, `jobs/JobsUI.tsx`                                                                           |
| Administrator connection and query cache                | `dashboard/src/realtime/client.ts`, `provider.tsx`, `hooks.ts`; migrated pages under `dashboard/src/features/`                                                                                                          |
| Browser CSP                                             | `web-client/server.mjs`, `dashboard/server.mjs`                                                                                                                                                                         |
| Android transport and history                           | `android/app/src/main/java/com/hatem/musicmute/processing/RealtimeClient.kt`, `JobHistoryController.kt`, `JobsApiClient.kt`, `UrlImports.kt`, `JobModels.kt` in the same directory                                      |
| Android ownership, lifecycle and UI                     | `android/app/src/main/java/com/hatem/musicmute/VocalApplication.kt`, `ui/VocalApp.kt`, `ui/ProcessingQueueStatus.kt` under that package                                                                                 |
| iOS transport, history and usage                        | `ios/Vocal/Processing/ProcessingRealtime.swift`, `JobsAPIClient.swift`, `ProcessingUsageRepository.swift`, `JobModels.swift`; `ios/Vocal/State/ProcessingHistoryModel.swift`                                            |
| iOS UI and localization                                 | `ios/Vocal/UI/ProcessingQueueStatus.swift`, `ProcessingHistoryView.swift`, `ProcessingDetailView.swift`, `AudioStepTimeline.swift`, `AudioTaskCard.swift`; EN/AR resources on both native platforms                     |

## Invariants to preserve

- One raw socket per authenticated foreground session, shared by consumers. Preserve
  session/generation fences, background cancellation, logout cleanup and backoff.
  A forbidden ticket must not trigger an endless native reconnect loop.
- Queue position is a job's one-based rank among currently eligible waiting jobs
  in the same recipe, ordered by `(queuedAt, _id)`. Running jobs are excluded;
  blocked/unknown rank is null. Never invent an ETA, expose other users' records,
  or mutate scheduling while calculating position. Busy compatible workers still
  count as available capacity. Keep retry and liveness deadlines meaningful.
- Snapshots are complete and snake_case on the wire. Sequence belongs to a
  subscription within a connection's stream ID, not to the job revision. Ignore
  duplicates and old generations; resync gaps; restore fresh state after feed loss.
- Reuse live-query hooks. Do not restore `refetchInterval`, recurring status GETs,
  focus/reconnect HTTP refetches, manual Refresh controls, or HTTP polling fallback.
  Debounce, animation, heartbeat and reconnect timers are not status polling.
- Preserve ownership/admin permission checks and domain input validation. New
  resources need explicit registry entries and collection invalidation mappings.
  Never send bearer tokens/tickets in URLs or logs; keep exact browser origin/CSP
  restrictions and the existing separate worker-hint protocol.
- Hide queue numbers when stale/offline. Keep English/Arabic RTL and large text,
  existing cached native playback, and user-initiated media downloads. Ten live
  history pages form a moving window; pagination can continue beyond that window.

## Verification and remaining limits

Run checks from component directories; there is no root package install. From
`backend/`, run `pnpm run verify` and, for realtime infrastructure,
`pnpm run test:realtime:integration` with owned local Mongo/Redis fixtures.
The integration exercises two independent feed/transport instances in one process;
it does not establish multi-process or deployed-cluster behavior.

Regression entry points: backend realtime specs and `test/realtime.integration.mjs`;
both web `src/realtime/client.test.ts` files; public `tests/realtime.spec.ts` and
dashboard `e2e/realtime.spec.ts`; Android `RealtimeClientTest.kt` and
`JobHistoryControllerTest.kt`; iOS `ProcessingRealtimeTests.swift`, history/usage
tests and `VocalUITests/ProcessingUITests.swift`. Test snapshot recovery, permission
loss, no recurring GETs, stale ranks, queue changes, ownership and teardown.
The ledger has exact commands and historical results; rerun checks after changes.

Native device/UI testing is restricted to the existing iPhone 17 Pro iOS 26.0
simulator, UDID `3CC14436-EC3C-4419-A079-C84951E5FA07`. No other device or simulator
may be substituted without the user's instruction. Android JVM/build/lint checks
are allowed; Android device proof is not available from these runs.

Missing native Firebase configuration required fixture builds and an explicitly
excluded iOS Firebase configuration test. Do not copy secrets, remove production
resource references, or present those fixtures as a production-configured build.
The dashboard whole-tree formatter also flags an unchanged baseline test; touched
files were checked separately. Preserve these limitations in future reports.

The measured six-socket local baseline is not production capacity proof. Staging
proxy upgrades, Mongo change-stream privileges, real Firebase/R2, larger load and
reconnect storms remain release gates. Backend support must precede new clients;
realtime requires a replica set/sharded Mongo deployment and Redis. Do not commit,
push, deploy or change production permissions without explicit user authorization.

## Stage timing integration (2026-09-26)

Backend/worker/dashboard stage timing is now integrated from the separate timing
checkout. Read [the timing contract and rollout notes](../job-stage-timings.md).
Persist backend/worker durations; never derive them from client clocks or show
missing stages as zero. Keep per-attempt detail out of list snapshots. The deployed API is `img-captain-api:71` and dashboard is
`img-captain-dashboard:13`. The local worker is
`0.1.0-mvp.45-trim6-timing.local.20260926.1`, activated after the backend with
its newer engine fixes preserved. Do not downgrade it to the repository package
version. See the timing document for production evidence and remaining new-job
verification; other workers still need their own timing rollout.
