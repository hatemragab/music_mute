# Evidence: W15 — Account usage, policy and realtime core

- Date: 2026-10-09.
- Host: macOS arm64; Node v24.18.0; TypeScript 6.0.2; Vitest 4.1.11.
- Status: realtime and usage core complete; application wiring and presentation pending.
- Scope: `windows-desktop/src/main/realtime/`, `src/main/usage/`, `src/shared/usage-contracts.ts`, focused realtime/usage tests; compatible resource validation in the existing shared companion transport.

## Behavior and boundaries

`UserRealtimeController` reuses `AccountRealtimeClient` for the existing raw WebSocket ticket, full-snapshot, sequence recovery, watchdog and reconnect/backoff protocol. It injects trusted account authorization and fences every callback by Firebase owner and generation. Disconnects scrub queue ranks; ticket or subscription authorization failure clears the owner view immediately. Authentication and resource readiness remain distinct from Library readiness. There are no recurring GET reads, status polling or Refresh controls. App-open policy checkout is an explicit HTTP read; a delayed checkout cannot overwrite a newer live policy snapshot.

`AccountUsageController` exposes selected usage percentage, remaining allowance, reset date and safe availability/connection fields. Arithmetic validates safe integers and the server used/reserved/released equation with BigInt; invalid quotas are unavailable. Reset dates require valid calendar RFC3339 values. The local clock does not reset quota or override a current server availability decision. English/Arabic formatting fixtures cover the display helpers.

Processing policy follows the existing global/user/country visibility decision and excludes administrator identity lists. Owner-specific policy cache entries are bounded to 64 KiB and 24 hours, keyed with a 64-character SHA-256 vault-safe key, and cleared from presentation before switching owners. Cached policy and stale usage are informational: cloud submission requires current authoritative snapshots plus active account access. Local-ready processing remains independent of account/backend availability. `AccountController.receiveAppPolicy` updates Windows minimum-build/email gates from the same existing public policy contract.

The shared `AccountRealtimeClient` resource union/parameter validator now accepts the existing backend `worker_registration` and `local_media_sync` channels. Wire framing, full-snapshot behavior and macOS compatibility are unchanged.

## Executed checks

| Command                                                                                                                                        | Result                        | Scope                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx vitest run tests/account-controller.test.ts tests/account-oauth.test.ts tests/realtime-controller.test.ts tests/usage-controller.test.ts` | Passed: 52 tests / 4 files    | Account fences plus ticket expiry, delayed readiness, revoked permission, sequence gaps, stale/foreign snapshots, owner cache changes, live-policy checkout races, quota arithmetic and localized formatting. |
| `npm test` from `windows-desktop/`                                                                                                             | Passed: 134 tests / 16 files  | Current integrated source/headless fixtures; no app or Windows execution.                                                                                                                                     |
| `npm run typecheck` from both `windows-desktop/` and `chrome-extension/`                                                                       | Passed                        | Shared transport and desktop strict source types.                                                                                                                                                             |
| Scoped `oxlint --deny-warnings`                                                                                                                | Passed: 0 warnings / 0 errors | Owned account/realtime/usage source and shared transport regression paths.                                                                                                                                    |
| `npm run build` from both components                                                                                                           | Passed                        | Source bundles only; no native Windows binaries.                                                                                                                                                              |
| `npx vitest run tests/account-realtime.test.ts` from `chrome-extension/`                                                                       | Passed: 11 tests              | Existing shared socket regressions plus worker-registration/local-media-sync resources.                                                                                                                       |

The full companion suite was not rerun for this task; root tracks a separate existing app-setup timing failure. No unrelated fixture was changed.

## Remaining integration and native acceptance

Root owns account-scope wiring, app-open checkout, safe usage/status renderer and processing-mode command integration. W15 task implementation items that require those bindings remain unchecked until they are implemented and verified. Local model processing, real Windows reconnect/auth expiry, real quota presentation and backend outage acceptance remain W34 checks. No accounts, production permissions, enrollment, live claims, catalog or secrets changed.

## Presentation, guest policy and terminal account retirement

2026-10-09 continuation; earlier counts above remain historical.

- [UsagePanel](../../../windows-desktop/src/renderer/usage-view.tsx) now presents
  actual used/limit/remaining allowance, accessible percentage and reset date,
  current/stale/loading/unavailable/blocked/overdue states and separate connection/
  Library readiness. It uses the central English/Arabic catalog and RTL, and has
  no command/Refresh control. The [shared formatter](../../../windows-desktop/src/shared/usage-presentation.ts)
  keeps renderer bundles free of trusted services; the old main module reexports
  its existing API compatibly.
- [Guest policy](../../../windows-desktop/src/main/usage/guest-policy.ts) reads only
  the backend origin from the existing sealed `desktop-public-config.json`.
  `createGuestPolicy({origin, installationId, cache?, fetch?})` returns
  `realtime`, `usage`, explicit `onAppOpen()` and `dispose()`. It reuses the existing
  two public policy GET checkouts without Firebase, bearer, realtime tickets,
  socket creation or timers. Invalid/unknown/getter/credential/path config is
  refused. Main may use it only when validated full account configuration is
  absent; a runtime/session/account rejection is not permission to downgrade.
- Terminal realtime auth rejection now carries its original UID/generation to
  `AccountController.receiveAuthorizationRejection(code, scope)`. Stale A cannot
  retire B. Current revoked/deleted/disabled authority is cleared; pending
  deletion retains only its existing recovery credential. No remote logout,
  account mutation, guest/fleet credential change or automatic refresh is added.
- Account retirement publishes the trusted Host's null in-memory scope/listener
  fences before awaiting tombstone/vault/recovery writes. Durable tombstone and
  credential queues remain FIFO, so late A cleanup cannot clear B's scope or
  secret. All retirement paths retain real `activity().busy` and awaited shutdown
  through listener/persistence settlement, including failure. Consumer modules
  must start their own scope fences before waiting unrelated history or CPU
  teardown; final Main audit remains separately explicit.

Executed from `windows-desktop/`:

```sh
npx vitest run tests/account-controller.test.ts tests/account-oauth.test.ts tests/host-context.test.ts tests/realtime-controller.test.ts tests/usage-controller.test.ts tests/usage-view.test.tsx tests/usage-guest-policy.test.ts tests/localization.test.tsx tests/account-lifetime.test.ts
npm run typecheck
npm run lint
npm run build
npm run test:package-fixtures
```

Latest slice: **90 tests/9 files passed**. Full source typecheck, lint
(416 files, zero warnings/errors), JS build, both package-boundary fixtures and
scoped formatting passed. An intermediate exact-event assertion included initial
A login; the test reset was corrected and the complete slice rerun. Earlier
57/5, 61/6 and 67/7 checkpoints preceded immediate retirement and are not the
final result. New tests execute actual promises/state/queues and headless React;
native vault/Host/HTTP/socket boundaries are injected. No real account, HTTP,
Windows/native, GPU or UI/device action ran.

Main/Home/Account and guest fallback source bindings now exist and are separately
reviewed/validated by their owner. Remaining checks are final consumer-fence
composition and actual Windows/account/network/usage policy behavior in W34.
