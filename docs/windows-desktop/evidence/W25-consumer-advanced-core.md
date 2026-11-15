# W25 — Consumer Worker Advanced core

- Date: 2026-10-09; current source check at 11:21 UTC.
- Git base: `c0218633c43559c8ad1988e5037273970a91f99b`; unrelated dirty work preserved.
- Source/test checkpoint: SHA-256 `a061df3626413896aa142a41edf4df0d836e5fa229b613c539d3834f0ad88827` across the 20 scoped Advanced files/tests, fleet store/runtime/Prepare dispatch, shared contracts and portable investigation/status adapters. Later integration edits require renewed checks.
- Host: Darwin arm64, Node v24.18.0. No Windows/native/GPU/live operations ran.
- Status: consumer core and richer benchmark/retirement/purge source checked; final composition and Windows acceptance pending. The 11:21 checkpoint below remains historical; the latest source checkpoint is recorded separately.

## Implemented source

`windows-desktop/src/main/fleet/advanced/` contains the real factory/controller, private descriptor inspection, fixed guarded benchmark child/runner, bound capacity state, exact removal marker, bounded file maintenance and actual ZIP encoder. `shared/fleet-advanced-contracts.ts` closes all input shapes; `agent/prepare.ts` dispatches only the fixed benchmark branch after existing owned SID/role/Node/release/helper verification. `agent/fleet.ts` selects real stable slot identities from current receipt evidence and respects the local Remove marker.

The factory binds existing current-user DPAPI and native mutexes, Session maintenance, verified Ready, read-only file capabilities, the existing worker unpair/config routes, real Storage pins/writer/native workspace ownership and the existing optional updater. It does not call service/elevated helpers, enroll a machine, invent endpoints or provide a successful authority fallback.

Confirmations expire after five minutes and bind exact Windows SID, machine credential/worker/revision/release authority and action parameters. `VaultFleetStore.writeIfCurrent` compares that authority under the native cache mutex before changing the record. Backend unpair confirmation is durably retained before local credential effects; recovery uses that exact receipt without repeating the request. A lost response retains uncertainty and credentials. Remove stops/disables only the consumer fleet role; purge requires separate confirmed revoke/remove and affects only fixed fleet scratch/history/state namespaces. Personal/account/shared runtime/model/Chrome data is preserved.

Benchmarks hold the Session maintenance fence and current-SID Prepare mutex. The real native physical GPU guard is acquired before `launchOwned`; the independent keeper covers all nested inference/media descendants. Node-only scratch copying uses Storage writer authority, stops/fsyncs and calls `handoff()` before launch; the acknowledged native owner supplies workspace retention. Physical/workspace leases are released only after exact native whole-tree cleanup. CPU fallback, LocalService context, wrong ordinal/model/fixture/manifest/GPU/driver and fabricated producer PASS measurements are rejected. Approved fleet fixture capacity remains separate from user-selected file benchmarking and personal preparation.

Capacity evidence includes the measurements and current SID/host/hardware/driver/release/model/fixture bindings. Selection of two workers also requires current backend recipe permission; the real WorkerRuntime continues to apply backend policy on claims. Changed/expired evidence reduces to the original qualified single slot. The second worker identity remains stable in DPAPI state.

Readonly reports reuse shared investigation/performance semantics through validated descriptors, mark retained/stale history and cached policy honestly, and never poll backend status. Doctor/version views show missing Ready as failed/unavailable rather than blocking history. Live inference is explicitly not-run in Doctor. Diagnostics ZIP contains only sanitized allowlisted JSON and reads successfully as a ZIP. Updates are unavailable when not configured and otherwise delegate to W29's own transaction/fence.

## Executed code checks

| Command / directory                                                                                                            | Result                                                | Scope                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npx tsc --noEmit` / windows-desktop                                                                                           | Passed, exit 0                                        | Current strict TypeScript source/contracts/fixtures; not native compilation.                                                                                       |
| `npm run build` / windows-desktop                                                                                              | Passed, exit 0                                        | Main/agents/renderer source bundle, including guarded Prepare dispatch; no Electron/UI execution.                                                                  |
| `npx vitest run` explicit Advanced, fleet controller/runtime, session/admission and Prepare regression files / windows-desktop | 162 passed / 13 files, exit 0                         | 41 new Advanced tests; parser/fence/recovery/guard/storage ordering, real fixture HTTP dispatch, ZIP readback, retained history and existing role/intent behavior. |
| Scoped `oxlint --deny-warnings` / windows-desktop                                                                              | 0 warnings/errors, exit 0                             | Advanced source/tests, store, fleet/Prepare entry and contracts.                                                                                                   |
| Scoped Prettier write/check / windows-desktop                                                                                  | Formatting applied; check follows final evidence edit | Only owned source/test/task/evidence files.                                                                                                                        |
| `npx tsc --noEmit` and `npm run build` / worker                                                                                | Passed, exit 0                                        | Shared status parser and investigation optional descriptor source remain compatible.                                                                               |
| Explicit consumer capacity/report/receipt/status/Mac investigation/performance/log Vitest files / worker                       | 30 passed / 7 files, exit 0                           | Legacy operator defaults plus explicit Windows consumer context; portable fixtures only.                                                                           |
| Scoped worker oxlint                                                                                                           | 0 warnings/errors, exit 0                             | Investigation/status changes.                                                                                                                                      |

Earlier transient TypeScript failures in concurrently edited browser account authority were resolved by their owning agent before this current successful check. The older fleet fixture missing-method/string-lease errors were repaired in its owned fixture and current fleet regressions passed; production mutex behavior was preserved.

## Remaining closure and native proof

- Root Main/renderer/export dialog/local-notification composition, localization/accessibility and all Mac control parity must be checked as actual source integration.
- W29's active-fleet overlay is consumed by the shared launch/Doctor/capacity/benchmark resolver; actual Windows update/rollback qualification remains deferred.
- Optional file-benchmark baseline/candidate/saved-audio production core is now implemented and tested as described below; Main/native destination and complete UI integration have separate evidence and Windows acceptance.
- A launch with a lost ACK and no exact native owner receipt remains recovery-blocked. The independent keeper safely owns teardown, but no PID-only certificate or successful recovery is fabricated.
- Windows C++ compilation, current-SID DPAPI/ACL/Job/mutex behavior, actual DirectML execution/quality/throughput, signed installation/update/native browser and authorized live backend/grant/revoke/purge scenarios remain unrun. Test them later on the connected supported Windows x64 target; destructive acceptance requires explicit disposable-installation authorization.

Official preflight was refreshed from [Zalando API/Event Guidelines](https://opensource.zalando.com/restful-api-guidelines/) and [Microsoft Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects) on 2026-10-09. Portable security, bounded validated data, secret-free errors/events, immutable identity and compatibility rules apply; REST URL/OpenAPI rules do not define this local IPC. Existing backend routes/contracts remain unchanged.

## Rich benchmark and retirement checkpoint — 18:03 UTC

- Closed optional benchmark parameters preserve simple defaults: DirectML group size exactly 1, an installed signed candidate release identity, read-only baseline capability, saved audio and separately claimed audio/report destinations. Arbitrary engine paths, unsupported groups and unclaimed renderer destinations are rejected. Candidate Python hashes use the actual Windows backslash/NUL framing and full verified installed inventory/proof; the child repeats verification before import.
- `benchmarkExports.claim(capability, "audio" | "report", signal)` returns a trusted `write(readonly AdvancedExportEntry[], signal)`/`release()` lease. Each entry lends a readonly `FileHandle` from offset zero with fixed filename/size/SHA. Destinations are claimed before long maintenance/benchmark work and held through actual streaming teardown. Audio is bounded to 26 files, 256 MiB each, 1 GiB total; report JSON to 2 MiB. No audio Buffer or raw path enters the renderer.
- Factory composition tests execute real source-copy/hash/fsync, baseline parsing, protected journal/CAS, descriptor exports and teardown in temporary files; only native/hardware benchmark execution is injected. Pins remain held until output streaming ends, borrowed handles close and selected source/baseline remain unchanged. Controller tests cover cancel during claim, expiry/stale-machine release and dispose waiting actual sink completion.
- Confirmed backend unpair is persisted before `retireIfCurrent` drops **all three** credential strings to null under exact machine/cache CAS. Active records cannot contain nullable credentials. Cleanup failure remains retryable from the confirmed receipt without another unpair. A retired record cannot start WorkerRuntime or authorize capacity.
- Local Remove preserves the original machine approval/credential. Explicit Restore verifies current Ready/active runtime/GPU and actual `GET /worker/status` active identity, clears only its exact marker, saves Stop and requires explicit Start. Paused/revoked approval refuses restoration without new enrollment or automatic start.
- Purge requires separate confirmed Revoke and Remove, actual session maintenance plus Prepare/cache authority, and an exact qualification/output/approved-fixture receipt. It removes only fixed fleet config/work/log/state/report/enrollment files and matching fleet qualification artifacts. Shared Ready fixture, runtime/model, account, personal Library/outbox, source files, Chrome and legacy service data remain outside scope.
- A minimal noncredential `purged_tombstone` commits before enrollment/confirmation cleanup. Lost deletion ACK recovers without repeating filesystem deletion. New enrollment clears the old marker only after its write commits; the old journal cannot delete replacement credentials. Secret-like or unexpected tombstone fields are rejected.

Executed from `windows-desktop/`:

```sh
npx vitest run tests/fleet-*.test.ts tests/session-admission.test.ts tests/session-supervisor.test.ts tests/prepare-records.test.ts tests/prepare-controller.test.ts tests/admission-broker.test.ts
npx tsc --noEmit
npm run lint
npm run build
```

Results: **22 files / 210 tests passed**, full TypeScript passed, full lint **370 files / 0 warnings/errors**, source build passed. The earlier 162/13 and worker 30/7 results remain historical. The key-aware fixture now models separate `purged_tombstone`/enrollment DPAPI keys rather than returning enrollment bytes for every read. Latest tests include actual fixture filesystem purge, retirement/CAS faults, Restore backend status, candidate hash framing, factory exports and controller destination lifetime. Scoped formatting was applied and checked; native ACL/DPAPI/DirectML/installer/destructive live proof remains unrun.

Root's rich Main/preload/UI and streaming destination source now exists; its separate binding evidence must prove command/selection/cancel/retention integration before overall W25 closure. There is no new remote personal telemetry or backend endpoint.

## Consumer teardown proof checkpoint — 2026-10-09

Shared supervisor stop alone no longer proves consumer fleet idle. The tracker
starts unconfirmed and requires actual bound-role native `inferenceIdle()` at
initialization and after all-slot stop. False/query failure retains
`FLEET_STOP_UNCONFIRMED`, unavailable state and guarded resources. Uncertain
terminated-attempt cleanup preserves exact scratch and blocks engine replacement;
remaining slots still stop. Legacy profiles omit this hook. Active-runtime GPU
identity now drives physical guard acquisition after legitimate updates.

Fleet/update **23 files / 206 tests**, full TypeScript/lint/build (387 files) passed
before subsequent account/live-policy changes. The final combined source slice
passed **27 files / 269 tests**, full TypeScript/lint/build (392 files; zero
warnings/errors). Worker runtime **52 tests**, TypeScript/build and scoped
format/lint passed. Real Job census, simultaneous engines, orphaned decoder/query
faults and genuine destructive/DirectML acceptance remain deferred to Windows.
