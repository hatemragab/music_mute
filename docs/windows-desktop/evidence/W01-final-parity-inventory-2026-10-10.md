# W01 — Final current-source parity inventory refresh

Reviewed 2026-10-10 on macOS arm64. This return edits only the component parity
inventory, W01 task and this evidence. It executes no app, native helper, model,
account, browser, installer or live release operation.

## Audit method and result

The refreshed [inventory](../../../windows-desktop/docs/parity-inventory.md)
traces current Mac screen/action/state source into actual Windows
renderer→preload→Main→domain/session/browser receiving entries. It maps every
P01–P30 from [COVERAGE](../COVERAGE.md) and
[FEATURE-ACCEPTANCE](../FEATURE-ACCEPTANCE.md), retaining the owner's Windows
10 22H2/build 19045/native-x64 minimum, Windows 11 x64, physical GPU, shared
extension, no-admin logged-in-session worker and explicit LOCAL/ONLINE choice.

Read current `MusicMuteLocal.swift`, `DesktopMediaViews.swift`,
`DesktopWorkspace.swift`, `DesktopAccountView.swift`, `DesktopAuth.swift`,
`DesktopListening.swift`, `DesktopPreferences.swift`, `DesktopWorkerView.swift`,
`DesktopWorker.swift`, `UIJournal.swift` and the linked portable companion APIs.
The older SOURCE-MAP is an initial porting map, not a current implementation
status: its ordinal-zero/LocalService/disabled-Windows findings were checked
against today's consumer profile, actual DXGI selection, current-witness proof
and dynamic browser HELLO. No unreferenced static flag was called an execution
blocker merely because its old value remained false.

The inventory now includes previously under-recorded late behavior: real manual
Chrome cloud Start separate from desktop handoff; true cold cloud/app-only update;
account destructive consent bound to UID and generation; same-account explicit
invitation renewal and purge auto-enrollment fence; reviewed Force and distinct
signed catalog updates; current approved secondary-GPU/personal alignment;
cheap Advanced status versus full mutation; exact sample maps/direct originals;
durable first-play/publication and independent waiter cancellation; owner-specific
awaited export cleanup; bounded/redacted personal Chrome diagnostic reports;
safe initial/return modal focus and actual named keyboard shortcuts.

## Concrete gaps reported, not hidden by historical tests

| ID  | Actual source boundary at review                                                                                                                                                                                                                                                    | Required next source return                                                                                                                                                                                                                                                                                                       |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G01 | Mac Setup exposes extension install/development guidance/open/reveal/copy, while Windows PreparePanel exposes start/cancel/repair/check. `packaging/build-release.mjs` copies only the shared extension manifest into resources; HKCU host registration is not a runnable extension | Full freshly source-built shared extension payload with complete sealed inventory/notices, plus closed Setup assistance for Chrome management, exact verified folder reveal/copy and actual model-error folder. Root confirmed accepted parity and assigned receiving ownership; no Store URL or installation success is inferred |
| G02 | TrustedSaveDestinations removed Node unlink and now requires a native created-file proof/receipt ACK callback; actual Native receiver/Main binding is still being implemented                                                                                                       | Native retained-handle deletion/certificate, immutable request ID/birth/full fingerprint, idempotent lost ACK and bounded receipt retirement; missing/pending proof stays retained. Never delete a replacement based on lstat/path absence                                                                                        |
| G03 | Fixed runtime-bank cleanup/WAL/receipt, physical guard/whole-role cleanup and W12 hostile-error/coercion audits are active peer returns                                                                                                                                             | Validate pre-effect WAL refusal, exact approved signed-stage delete inventory, unknown extra-file conflict and truthful retained uncertainty. Their owners record final source/portable checks; earlier passing snapshots do not close moving code                                                                                |

Additional G04: actual shared error guidance still names the Mac/Prepare my Mac/
Apple Silicon on Windows failures; popup/content already have PC loading branches
and were not missing those alternatives. Root assigned a narrow negotiated-HELLO
EN/AR guidance return. The [G01 tested producer/core return](W01-G01-shared-extension-setup-source-2026-10-10.md)
now exists; final receiving/Native action and other owners' returns remain open.

No other missing behavior was asserted from unchecked historical wording alone.
Source-present labels require the actual receiving entries in the inventory and
the adjacent task matrices; this is not a fresh claim that all tasks are complete.

### Later source returns — 2026-10-10

The discovery table above is historical within this audit. G01's complete freshly
source-built shared extension, sealed inventory/notices and Setup assistance are
now implemented: [producer/core proof](W01-G01-shared-extension-setup-source-2026-10-10.md)
and [actual Main/preload/App/native receiving return](W04-W26-setup-export-receiving-2026-10-10.md).
G02 exact native preflight/discard/certificate/ACK receiving source is in that same
checkpoint; no C++ execution or filesystem race proof is inferred.
G04 [received-HELLO guidance/discovery/privacy return](W27-platform-guidance-and-privacy-2026-10-10.md)
is source-tested. Mac language/destination is retained for actual Mac; Windows/
unknown uses the reviewed Downloads destination without an installer claim;
shared disclosures name both secure guest stores and preserve existing data flows.
Its earlier whole Chrome backoff timing failure was investigated/corrected at the
final **2329 passed / 4 skipped / 83 files** shared checkpoint; the linked evidence
retains the intermediate failures. G03 and the W11 Session admission/broker return
remain owner work until their concrete checkpoints; the
[FleetRoleControl current-overlay return](W11-fleet-current-gpu-control-2026-10-10.md)
is implemented and portably checked without changing original approval.

## Build/dependency and official-source boundary

Read root/component/companion READMEs and manifests, build script, package approval
and the [current build/license review](../../../windows-desktop/docs/build-inputs-and-licenses.md).
Root's separately recorded refresh remains **zero runtime findings / eight
moderate development findings**, latest sprintf-js 1.1.3, twelve actual metafiles
without builder-chain modules. This return did not rerun npm audit or approve
its unresolved development exposure.

Official sources reopened during this audit:

- [Electron v44.7.0 support](https://github.com/electron/electron/blob/v44.7.0/README.md#platform-support)
  lists Windows 10+. The app's native x64/build-19045 gate is stricter; this table
  does not prove a packaged runtime on Windows.
- [Node v24.18 build support](https://github.com/nodejs/node/blob/v24.18.0/BUILDING.md#platform-list)
  lists Windows x64; engine Node remains independent of Electron's embedded Node.
  Builder prerequisites are not end-user dependencies.
- [Reviewed sprintf-js advisory](https://github.com/advisories/GHSA-hp3w-g68c-fv3c)
  still lists no patched version. Development release review remains open; builder
  isolation and absence from runtime graphs are containment, not a clean full audit.

## Document validation

Scoped Prettier write/check passed for all three owned documents. A bounded
Python reference/coverage validator confirmed **142 local references**, exactly
**30 unique ordered P01–P30 rows**, and the development dependency-review box
still unchecked. Three initially guessed module paths were replaced with their
actual source files before validation. No new application tests were run for this
documentation-only refresh; earlier executable evidence is linked with its actual
date/scope, not claimed as rerun here. W01's historical foundation
source/type/build/architecture and clean-checkout evidence remains preserved.

## Separate unchecked acceptance and release review

- [ ] Actual Win10/Win11 x64 compile/link/install/launch and clean standard-user
      runtime dependency/ABI compatibility.
- [ ] Real NTFS/ACL/DPAPI/reparse/pipe/signer/Job/keeper, GPU node placement,
      output/listening/device-loss and repeated-window/Chrome lifetime.
- [ ] Real account/backend/R2/provider, signed installer/feed/publisher/rollback,
      screen-reader/focus/contrast/scaling and startup/inference measurements.
- [ ] Resolution or explicit final review of the eight moderate development
      builder-chain findings before release, without a fabricated patched version.
- [ ] Approved artifacts/signing/publication/deployment/Store delivery, each
      separately authorized and currently unproved by this inventory.

Completing the W01 inventory refresh can coexist with the explicitly named
source returns in other tasks. It never checks their Native/live rows or reduces
the accepted Mac parity to a smaller first release.
