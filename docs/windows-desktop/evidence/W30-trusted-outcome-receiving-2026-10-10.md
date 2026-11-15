# W30 — Trusted outcome receiving and report identity

Date: 2026-10-10, Africa/Cairo. Portable source, owned temporary files,
crypto/projection, jsdom and built IPC fixtures only. No Windows/native helper,
GPU/model inference, Electron/browser/device session, account, enrollment,
production API, signing, installer or deployment operation ran.

## Requirement → production receiver → executable proof

| Required behavior                                                       | Actual production entry and resource                                                                                                                                                                                                                                                                                                                                                                                          | Meaningful current proof                                                                                                                                                                                                                                                                                                                                                                                                  | Deferred acceptance                                                                                                                              |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Record account/realtime, Library/sync and basic Fleet/Advanced outcomes | Main's existing Account/Usage/Library/Outbox/Fleet/Advanced/Session subscriptions publish their actual views; `recordSnapshotDiagnostics` invokes `DesktopDiagnosticRecorder.receive`. Initial journal setup seeds the actual current snapshot. The receiver selects scalar states, fixed reasons and counts; it never reads user names, account IDs, worker credentials, Library queries, source paths or Advanced raw data. | Actual account/live → reconnect, Library error, Outbox failure, Fleet/Advanced/Session failure snapshots pass through the receiver and real temporary-file journal into the report and Chrome projection. Duplicates produce no additional records; uppercase secret-shaped reasons use fixed domain fallbacks.                                                                                                           | Real account/fleet/backend, OS failures and long-run records remain W34.                                                                         |
| Recognize six fixed codes emitted by Main                               | The existing `diagnosticCode` allowlist now accepts `DESKTOP_STARTED`, `PREPARATION_STATE`, `UPDATE_STATE`, `PERSONAL_STATE`, `ACCOUNT_SCOPE_TRANSITION_FAILED`, `ACCOUNT_AUTHORITY_RETIREMENT_FAILED`. Additional receiving state/failure reasons are fixed literals; arbitrary codes remain generic.                                                                                                                        | All six pass the real projector with zero rejected fields; unknown secret-shaped codes remain `UNKNOWN_ERROR`. Actual Setup/update failure → success preserves the earlier errors and correctly named successful state events.                                                                                                                                                                                            | Inspect representative Windows failure exports.                                                                                                  |
| Preserve true personal cancellation                                     | Preparing → Cancelled emits the existing `cancelled` event with `CANCELLED`; completed remains separate. Report aggregation receives that event.                                                                                                                                                                                                                                                                              | Real receiver → journal → report → bounded Chrome summary yields a cancelled job, one cancellation and no completion.                                                                                                                                                                                                                                                                                                     | Real cancellation/whole Job cleanup belongs to W12/W34.                                                                                          |
| Bind actual sealed package inventory identity                           | `configurePackagedResourceTrust` retains SHA-256 of the validated actual ASAR index bytes. Readonly `packagedResourceInventorySha256` returns that digest; `desktopDiagnosticIdentity` is called by the actual Main constructor. Packaged diagnostics fails closed without full package trust; development and the smaller independent-worker capsule invent no full inventory digest.                                        | Actual temporary ASAR/resource files are hashed/validated, then the production identity builder feeds the real journal and Chrome summary. Tests distinguish the index-byte digest from the payload digest and reject corrupted resources.                                                                                                                                                                                | Genuine signed/fused ASAR, actual installed PE and native publisher enforcement remain W31/W34.                                                  |
| Measure observed personal stage durations with current-owner fences     | At most 16 job observations retain monotonic `performance.now()` timestamps. Controller reference/owner UUID, window owner and account generation fence this private map. Leaving an observed stage appends a scalar `duration_ms` resource observation for the prior stage. No timer/poll/network read is introduced.                                                                                                        | Separation 900 ms + encoding 600 ms → cancellation retains exact observed sums; duplicate progress is ignored. Independent controller/window/account replacements discard the old interval; stale old-owner jobs cannot append. Recovered terminal, clock reset/NaN, day-long gap and eviction produce no fabricated duration. Accepted writes are awaited; sink failure and reentrant owner replacement remain isolated. | Real engine/CPU/GPU timings and long-run resource behavior remain W34. These are observed Main intervals, not claims of complete engine timings. |

Production source:

- [Main binding](../../../windows-desktop/src/main/main.ts).
- [Bounded receiving recorder](../../../windows-desktop/src/main/diagnostics/desktop-recorder.ts).
- [Sealed identity builder](../../../windows-desktop/src/main/diagnostics/desktop-identity.ts) and [package trust](../../../windows-desktop/src/main/browser/package-trust.ts).
- [Existing projection/report aggregation](../../../windows-desktop/src/main/diagnostics/projection.ts).
- [Actual receiver fixtures](../../../windows-desktop/tests/diagnostics-desktop-recorder.test.ts), [identity fixtures](../../../windows-desktop/tests/diagnostics-desktop-identity.test.ts) and [package trust fixtures](../../../windows-desktop/tests/package-trust.test.ts).

## Current commands and actual results

From `windows-desktop/`:

```sh
npx vitest run tests/diagnostics*.test.ts tests/diagnostics-view.test.tsx tests/package-trust.test.ts tests/browser-diagnostics.test.ts tests/storage-diagnostic-partials.test.ts tests/browser-account.test.ts tests/browser-account-bridge.test.ts tests/browser-toolkit.test.ts tests/security.test.ts tests/contracts.test.ts tests/desktop-ipc-transport.test.tsx
npm run typecheck
npm run lint
npm run build
npm run test:package-fixtures
npx prettier --check src/main/main.ts src/main/browser/package-trust.ts src/main/diagnostics/desktop-recorder.ts src/main/diagnostics/desktop-identity.ts src/main/diagnostics/projection.ts tests/package-trust.test.ts tests/diagnostics-desktop-recorder.test.ts tests/diagnostics-desktop-identity.test.ts
```

**137 passed / 17 files**, 03:40:34, 3.15s, zero failures/skips. The same
sequential command then passed full TypeScript, full lint (**532 files**, zero
warnings/errors), source build, **2 bundle-boundary tests**, and scoped formatting.
The earlier 135-case checkpoint precedes two additional invalid/long-interval
fixtures; it is superseded by this run. An intermediate formatting check found
only concurrently edited Root Library export/share lines; their owner formatted
them before the successful final check. No unrelated source was rewritten.

From `chrome-extension/`:

```sh
npx vitest run tests/app-diagnostic-reply.test.ts tests/diagnostic-identity.test.ts tests/diagnostics.test.ts tests/extension-diagnostics.test.ts tests/privacy-disclosure.test.ts
```

**114 passed / 5 files**, 03:39:08, 2.55s, zero failures/skips. Focused counts
overlap whole-suite counts and must not be added to historical whole totals.
The previous 2,052-case full Desktop checkpoint is historical after these edits;
Root owns the final combined regression return.

## Boundary and remaining-proof reconciliation

The narrow production ports remain actual clipboard Copy, consent-owned
`saveDestinations.writeReceipt`, fixed owned log-folder Reveal and receipt-first
Show. Chrome `owns(receipt)` prevents fallback after report verification fails.
`DIAGNOSTICS_CLEAR` requires its closed confirmation; generic renderer diagnostics
cannot supply Export, Clear, paths, event append or fleet commands. Journal Clear
serializes with writers and replaces only its four fixed journal segments.
Main's diagnostics and reporter initialization/activity/shutdown are included in
the existing update/headless/quit fences. These bindings were read against the
[prior threat/proof ledger](W30-local-diagnostics-core.md#boundary-review-and-code-evidence)
and re-exercised in the focused receiver/UI/IPC/browser corpus above.

No telemetry SDK, upload route, dependency, polling, arbitrary native operation,
account/worker permission or model-qualification behavior changed. Unknown errors
still discard raw content. Expected model identity is not successful inference;
Main memory samples are observations rather than leak/quality certification.

- [x] Close the five concrete W30 trusted receiving gaps with actual Main calls and portable fixtures.
- [x] Preserve bounded public/private report separation and local-only diagnostics.
- [x] Receive the independently owned final Native report/repair/guard source review and final whole regression; see the [exact receiver ledger](W22-final-native-library-cleanup-2026-10-10.md) and [final2135/232 source checks](W33-final-source-regression-2026-10-10.md).
- [ ] Execute real ACL/DPAPI/peer/Job/Explorer/clipboard/disk/full installed-package failure acceptance on supported Windows.
- [ ] Resolve approved release/config/signing inputs and W01's separate eight moderate development-builder review before release approval.

The [official Zalando RESTful API and Event Guidelines](https://opensource.zalando.com/restful-api-guidelines/)
were retrieved on 2026-10-10 before editing: sensitive event data, duplicate-safe
consumption, compatible event changes and omission of stack traces guided this
additive, scalar-only local event return. REST routes, HTTP methods/statuses and
OpenAPI registries are unchanged and do not define this private journal schema.

Evidence formatting and local links are checked separately; this document is not
Windows compilation, a native security test, signed release or live-service proof.
