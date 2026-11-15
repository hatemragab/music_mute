# Evidence: W13 — Explicit cloud processing core

Historical foundation checkpoint. Its earlier integration-pending notes are not
the current source status: see the dated [production journey audit](W13-W16-W18-source-journey-audit-2026-10-09.md)
for actual desktop/Chrome bindings, 226 portable tests and remaining composed/
Windows acceptance boundaries. The original command counts below are preserved.

- Date: 2026-10-09.
- Host: macOS arm64; Node 24.18.0, TypeScript 6.0.2, Vitest 4.1.11.
- Status: core implemented and fixture-checked; main/renderer/shared-extension integration pending.
- Scope: `windows-desktop/src/main/cloud/`, `src/shared/cloud-contracts.ts`, cloud tests, the fixed CPU media branch in `src/agent/prepare.ts`, leased access to the existing account socket and explicit-mode presentation. Shared cloud provider adds a trusted current-job identifier accessor only.

## Source behavior

`CloudController` persists explicit Local/Cloud preference through `VaultCloudModeStore`. Signed-out Cloud remains selected and displays sign-in required. Cloud intake requires the current account generation, account/build/email gates, live processing policy and remaining usage; checks run again after asynchronous token access immediately before the intake POST. Library snapshot readiness is independent. Rights confirmation freezes source, owner, request UUID and a one-use five-minute capability before any request. No silent Local/Cloud fallback, automatic cloud request, intake POST retry or status polling is added. UI-only link visibility does not restrict submissions or cancel accepted work. Mode changes retain already accepted cloud work.

HTTP commands reuse the existing shared cloud provider and backend routes. Job/import updates use full raw socket snapshots. A leased account transport releases only its own watches; close/cancel cannot close the account socket or unrelated Library/usage subscriptions. Current-generation fences reject late authorization, snapshots, transfers and results. A known-job cancellation ACK is presented as requested, not completed. Before a job exists the backend has no import cancellation endpoint; stopping local waiting presents `CLOUD_IMPORT_CANCELLATION_UNAVAILABLE` without inventing one.

`WindowsCloudMedia` consumes trusted file capabilities and copies a pinned local source into private storage. The verified FFmpeg/ffprobe runtime executes in the existing owned Prepare Job Object with the Prepare mutex; CPU decoding/encoding has no model/GPU dependency. Qualification retains mandatory GPU validation. AAC-LC preparation strips metadata, validates audio/video source and full duration, and hashes bounded output. Decoder protocol/container restrictions accept local files only. Fresh execution UUIDs prevent a previous result being mistaken for current success. Cancellation awaits exact owned-tree shutdown, closes the guardian and releases the Prepare lease; a failed shutdown cannot return Ready.

Private R2 upload/download grants use existing validators, create-only PUT headers, exact byte/checksum verification and bounded abort handling. Firebase bearer tokens are used only for authenticated backend commands. Browser settings, renderer views and result capabilities contain no tokens, source paths or grant URLs. Current-owner result consumption prevents an old account's capability being reused after account switching.

## Executed code checks

| Command / directory                                                                                                                    | Result                      | Proof boundary                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `npm test` / `windows-desktop`                                                                                                         | 349 tests / 42 files passed | Current source and synthetic/headless fixtures, including cloud controller, transfer and owned-runner lifecycle tests. |
| `npm run build` / `windows-desktop`                                                                                                    | Passed                      | Source bundles; no Windows native binary or installation.                                                              |
| Scoped `oxlint --deny-warnings` and `prettier --check` / `windows-desktop`                                                             | Passed, no lint findings    | Owned cloud/usage/realtime source and test formatting.                                                                 |
| `npx vitest run tests/cloud-provider.test.ts tests/browser-cloud-provider.test.ts tests/account-realtime.test.ts` / `chrome-extension` | 102 tests / 3 files passed  | Existing shared provider and raw socket regressions.                                                                   |
| `npm run typecheck` and `npm run build` / `chrome-extension`                                                                           | Passed                      | Shared source types and bundle checks.                                                                                 |

Final `npm run typecheck` from `windows-desktop` passed after the concurrent native SDK addition landed. No unrelated source/test was repaired.

## Remaining integration and Windows acceptance

Root owns the main command/snapshot binding, renderer confirmation/progress/mode controls, shared-extension mode connection and Library/result persistence composition. Those integration checkboxes remain open. Browser automatic admission is Local-only and at most 1200 seconds in the core API; the real extension connection must still be verified after composition. Cloud result capabilities are ephemeral until the Library/storage task consumes them; they do not claim crash-safe Library persistence or an upload outbox.

Windows FFmpeg execution, native Job cleanup under decoder faults, actual private ACL/DPAPI behavior, extension mode read-back, real Firebase/backend policy/reconnect, and real authorized R2 grants remain W34 acceptance. No UI/device/native execution, real account, enrollment, production permission, release catalog, deployment or secret read occurred.
