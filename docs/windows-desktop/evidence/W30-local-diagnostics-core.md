# W30 — Local diagnostics and owned offline Doctor core

Date: 2026-10-09. Host: macOS source workspace / installed Node 24.18 tooling. No Windows native code, GPU inference, Electron UI, installer, live account/backend/R2, enrollment, removal or telemetry operation ran.

## Implemented production core

- [Diagnostics contracts](../../../windows-desktop/src/shared/diagnostics-contracts.ts) accept only Inspect, Doctor/full, Copy, Export/opaque destination, Reveal logs, Show successful report, Clear and Cancel. Renderer-controlled paths, executables, arguments, GPU ordinals, event payloads or fleet commands are not accepted.
- [Journal](../../../windows-desktop/src/main/diagnostics/journal.ts) serializes at most 64 pending operations, owns only four fixed `diagnostics/events-N.jsonl` files, and bounds events to 4 KiB and segments to 256 KiB (1 MiB retained). Actual current-SID/logon cache authority, native private-path checks, nofollow readonly descriptors and repeated descriptor/name identity checks protect reads. Writes reuse W22's atomic metadata writer with actual consuming Node PID/birth and its separate metadata mutex; no POSIX permission fallback is substituted for Windows native authority.
- [Projection](../../../windows-desktop/src/main/diagnostics/projection.ts) allowlists subsystem/event/phase/code/scalar metrics. It never serializes nested Error/cause, cycles, Buffer/stderr, arbitrary strings, getters, URLs, filenames, paths, account identifiers, tokens, grants or credentials. Recorder software/runtime/inventory/expected-model identity stays with historical records; expected model is distinct from a trusted actual byte-verification observation.
- Readonly inspection and empty Clear create no journal directory/files. Rotated/partial/malformed history is labeled incomplete. Invalid complete lines/tails are excluded from subsequent publication, and sanitized recovery/write-failure warnings persist across later success and reopen. Counts, peaks, stages, local anonymous job summaries and newest warning/error per retained recorder identity remain separate from recent activity. UTF-8 summaries fit 28 KiB, leaving room for the existing 32 KiB Windows envelope; full local export is bounded to 2 MiB. If mandatory alert detail cannot fit, the projection fails rather than falsely claiming a complete report.
- [Controller](../../../windows-desktop/src/main/diagnostics/controller.ts) returns sanitized report/Doctor/busy/problem/opaque export receipt, delegates copy/export/reveal/show to narrow trusted OS ports and keeps failed export distinct from success. Cancel/dispose wait the real operation teardown. There is no new backend endpoint, analytics SDK or personal diagnostic upload.
- [Doctor](../../../windows-desktop/src/main/diagnostics/doctor.ts) repeats actual native identity and DXGI inventory. Missing runtime produces Setup required and explicit not-run checks without creating scratch, downloading or running a child/model. With a verified installed runtime, it uses the existing fixed Prepare Job and Cloud scratch reservation/Node creation birth/handoff/native workspace owner. CPU metadata/media-protocol inspection never constructs an inference session or acquires a model GPU fallback.
- The strictly closed [Doctor child](../../../windows-desktop/src/main/diagnostics/doctor-child.ts) is reached through the additive owned Prepare discriminator after existing actual SID/nonce/Node/release/helper/inventory checks. Fixed signed Python imports inspect accepted versions, engine protocol and DirectML provider availability; the existing worker media validator checks FFmpeg versions/encoders/filters/network-protocol exclusion. Only bounded booleans/counts/bindings leave the private child result; raw stdout/stderr/errors are omitted. Optional full Doctor hashes the existing expected model bytes but performs no inference, qualification or repair. A provider list, model checksum or observed resource growth is not audio quality or working GPU inference proof.
- Unknown CPU shutdown retains its scratch/reservation/native protection and nonidle activity. Recovery requires exact owned-tree exit; new Doctor work cannot bypass that uncertainty. `factory.activity()` includes actual journal, OS/controller and CPU work plus retained uncertain workspaces, so update/quit can retain the Host/helper.

## Concrete integration API

`createWindowsDiagnostics({host, identity, operations, storage, os})` returns `controller`, `journal`, `doctor`, `record(input, verifiedModelSha256?)`, `activity()`, `subscribeActivity(listener)` and awaited `close()`.

`identity` contains `softwareVersion`, `runtimeScope`, `expectedModelSha256` and optional sealed `packageInventorySha256`. Main must resolve these from its running package, never renderer input. `operations` supplies the real `snapshotMediaTools`; `storage` is the current `CloudScratchAdmission` used by actual CPU media tools.

The trusted OS port exposes `copy(text)`, `export(capability, "MusicMute-diagnostics.json", bytes, signal) -> {receipt: UUID}`, `revealLogs()` for the fixed owned logs directory, and `showReport(receipt)` for an already successful owned export. It must validate destination/receipt/window ownership, preserve chosen source files and wait actual publication; no raw destination returns to the renderer.

Main binds real event-driven setup/account-connectivity/Library/outbox/Chrome/personal/update/lifecycle outcomes through `record`; the renderer has no append/event command. Personal collection is independent of Firebase UID and never reads fleet/account credential vaults. Existing authorized fleet diagnostics remain under W25 and their own reporting contract. Chrome DIAGNOSTICS/REPORT needs its own bounded personal-only adapter and cannot dispatch Worker Advanced commands.

## Boundary review and code evidence

| Boundary                      | Required refusal/proof                                                             | Executed source coverage                                                                        |
| ----------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Renderer/preload/main         | Closed action shape; no path/tool/native scope; actual sender gate stays in Main   | New parser negatives plus current `security`/`contracts` tests                                  |
| Diagnostic persistence/export | Allowlisted scalar projection; no secrets, raw errors, getters or source media     | Actual temp-files journal, hostile/cyclic/accessor inputs, rotation/reopen/tail/clear tests     |
| Chosen OS destination         | Opaque claim and success receipt; cancel/failure not optimistic success            | Controller copy/export/reveal/show/disposal fixtures; genuine dialogs/Explorer remain pending   |
| CPU child                     | Fixed signed Prepare entry, whole Job, reservation/birth/handoff, exact owner exit | New cold/child/result/uncertain-shutdown fixtures plus existing Prepare/session regressions     |
| OAuth/Chrome/media            | Existing origin/state/PKCE/nonce/generation/range fences, no report bypass         | Existing account, browser/media, installer maintenance, session and archive code fixtures rerun |
| Windows helper/ASAR           | Native ACL/DPAPI/peer/signature/Job enforcement and sealed trusted package         | Source boundaries reused; real compilation/install/attacks remain W34                           |

Executed from `windows-desktop/`:

```sh
npx vitest run tests/diagnostics*.test.ts
npx vitest run tests/diagnostics*.test.ts tests/security.test.ts tests/contracts.test.ts tests/file-capabilities.test.ts tests/account-oauth.test.ts tests/account-controller.test.ts tests/browser-media.test.ts tests/browser-provider-service.test.ts tests/browser-account.test.ts tests/browser-account-bridge.test.ts tests/browser-installer-maintenance.test.ts tests/session-browser.test.ts tests/verified-archive.test.ts
npx tsc --noEmit
npm run lint
npm run build
npx prettier --check src/main/diagnostics src/shared/diagnostics-contracts.ts tests/diagnostics*.ts src/agent/prepare.ts
```

Latest diagnostics result: **3 files / 13 tests passed**. The latest combined boundary checkpoint (18:33 UTC) passed **15 files / 145 tests**; full TypeScript, source build and full lint (**387 files, zero warnings/errors**) passed. Scoped formatting passed. Earlier combined checkpoints of 140 tests and diagnostics/fleet/update/Prepare/session/cloud-workspace **35 files / 305 tests** remain historical. The intermediate Main bridge fixture errors at 18:30 were corrected by their owner before the latest successful typecheck. Windows path spelling and native/tool/OS boundaries are fixture adapters; actual descriptor/filesystem/projection/controller/journal/workspace behavior executes in temporary files.

Source review found no fetch/network/telemetry initializer or raw console/stderr logging in the new diagnostics modules. The generated source bundle builds the new fixed Prepare entry; it is not a signed Windows installer or a device run. No new dependency was added. The native-role owner reviewed reuse of the existing fixed Prepare/whole Job boundary; native execution remains deferred.

## Remaining closure

- [ ] Revalidate the new actual Main/preload/localized UI, trusted outcome recorders, fixed log reveal/report destination/receipt ports and aggregate updater/quit activity. Production bindings now exist; their separate composition evidence must cover all real publishers and consent/receipt lifetime rather than manufactured UI evidence.
- [ ] Bind bounded Chrome personal DIAGNOSTICS/REPORT separately from fleet health; verify source-level owner/origin/nonce/projection composition and 32 KiB frame encoding.
- [ ] Complete the final dependency/bundle surface and threat review after W31 sealed packaging and all production bindings settle; source checks do not establish a penetration test.
- [ ] Compile/run on supported Windows x64: current SID/ACL/path replacement/hardlink/metadata-lock faults, actual CPU tools/DXGI/version checks, owned Job/ACK loss/logout/crash/antivirus, disk-full and real chosen destination/Explorer/clipboard behavior.
- [ ] Inspect actual exported representative failure bundles and verify retention/isolation; actual GPU/quality qualification remains a separately explicit action.

Reviewed current primary sources on 2026-10-09: [Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security/), [Microsoft Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects), and [Zalando API/Event Guidelines](https://opensource.zalando.com/restful-api-guidelines/). Their relevant principles are narrow validated IPC, isolation, secret-free events and compatible contracts. REST routing/OpenAPI conventions do not define this private IPC/journal; no external API schema changed. Native protections are not represented as protection against every malicious process running as the same Windows user.

## Chrome personal DIAGNOSTICS/REPORT source checkpoint

2026-10-09, macOS/Node code checks. The preceding counts remain historical core
checkpoints. No real Windows, Chrome/UI, ACL/DPAPI, Explorer, GPU, OAuth/backend/R2,
installer, enrollment, removal or telemetry operation ran in this addition.

The actual macOS native host exports a private report for the shared extension's
empty `DIAGNOSTICS` command and returns `REPORT`; the extension treats the report
as opaque and asks the user to reveal the saved report from the desktop app.
Windows previously returned `OPEN_APP_REQUIRED`. The new Windows source preserves
that public command/reply and request UUID, using its existing Windows diagnostic
schema in `REPORT {report}`. Public replies omit private paths and report receipts.
Neither the diagnostics action nor its error path reads account tokens, cloud
policy, mode storage, realtime data, a model, worker credentials or Prepare/Doctor.

- [Browser projection](../../../windows-desktop/src/main/diagnostics/browser-report.ts)
  repeats the strict report allowlist, rejects getters/coercion/sparse arrays and
  unknown/private fields, and measures encoded UTF-8 bytes. Full report ceiling is
  2 MiB; the summary is at most 28 KiB and fits both the actual private 32 KiB reply
  and legacy 64 KiB native framing. Exact aggregates/peaks/coverage and the newest
  warning/error per historical identity survive truncation. Unrepresentable
  mandatory alerts produce a bounded failure rather than erased provenance.
- [Private report producer](../../../windows-desktop/src/main/diagnostics/chrome.ts)
  owns only fixed current-SID `diagnostics/reports/<UUID>.json` files. It retains
  at most four committed reports, four pending commands, bounded retired duplicate
  receipts and a 16 KiB protected registry. Actual nofollow descriptors, native
  private-path/cache authority, single-link checks and repeated birth/size/timestamp/
  SHA checks precede publication/reveal. Files are fsynced before the staged DPAPI
  journal; staged/ready/deleting receipts reconcile lost acknowledgments. Duplicate
  requests reuse stored bytes, not a new journal snapshot. Admission failure keeps
  earlier reports; changed files are neither revealed nor blindly deleted.
- [Shared registry](../../../windows-desktop/src/main/diagnostics/report-registry.ts)
  supplies one strict protected shape to report recovery and partial reclamation.
  An exact staged receipt/birth protects its `.tmp` after a settled/dead copier and
  lost publication acknowledgment; a corrupt registry fences cleanup. Unknown
  report files never become deletion authority from a prefix alone.
- W22's closed [partial policy](../../../windows-desktop/src/main/storage/partial-write-policy.ts)
  adds a separate diagnostic-report 2 MiB/four-slot budget. Existing thumbnail,
  Outbox and Share budgets/cleanup authority remain independent. Inventory counts
  the fixed report subtree once as metadata with no generic deletion eligibility.
- The browser private authority has a separate personal diagnostics lane, validates
  current packaged peer/owner before and after publication, rejects worker/path/
  Clear/Doctor payloads and respects maintenance admission. The client preserves
  the original request UUID, validates the dedicated bounded response and never
  retries after connecting. The gateway returns the existing public `REPORT`.
  Real private reply/producer activity remains owned until teardown settles.
- `WindowsDiagnosticsController.acceptLocalReport(receipt)` is a trusted callback
  only. It exposes an opaque successful report receipt without changing GUI
  destination consent or adding a renderer receipt-setting command.

Production API:

```ts
const reporter = await createWindowsChromeDiagnostics({
  host,
  journal,
  storage,
  reveal,
});
// reveal is the trusted Main OS sink, invoked only after repeated file proof.
reporter.exportReport(requestId, signal); // -> {report: bounded summary, receipt: UUID}
reporter.owns(receipt); // true for known current/retired receipts
await reporter.show(receipt); // verification failure must never fall back
reporter.latestReceipt();
reporter.subscribeSaved((receipt) => controller.acceptLocalReport(receipt));
reporter.activity();
reporter.subscribeActivity(listener);
await reporter.close(); // deduplicated; awaits actual writes/cleanup
```

Main binds `BrowserAccountAuthorityOptions.diagnostics = reporter`. Its Show report
OS port must route known reporter receipts through `reporter.show`; only a receipt
the reporter does not own may use the existing selected-GUI destination registry.
No report path enters Chrome or renderer. Receipt lifetime is the current Windows
SID, independent of old window ownership or a Firebase generation. Main production
composition and real OS behavior are separately validated by their owner.

Executed from `windows-desktop/`:

```sh
npx vitest run tests/diagnostics-chrome.test.ts tests/diagnostics-browser-report.test.ts tests/browser-diagnostics.test.ts tests/storage-diagnostic-partials.test.ts tests/diagnostics-controller.test.ts tests/diagnostics-journal.test.ts tests/diagnostics-doctor.test.ts tests/storage-partial-writes.test.ts tests/browser-account.test.ts tests/browser-account-bridge.test.ts tests/browser-provider-service.test.ts tests/browser-installer-maintenance.test.ts tests/security.test.ts tests/contracts.test.ts
npx vitest run tests/storage-write-journal.test.ts tests/storage-policy.test.ts tests/storage-controller.test.ts tests/storage-files.test.ts tests/storage-share-workspace.test.ts tests/storage-local-deletions.test.ts tests/browser-publication.test.ts tests/browser-account-gate.test.ts tests/session-browser.test.ts tests/browser-guest-account.test.ts tests/browser-media.test.ts
npx vitest run tests/diagnostics-chrome.test.ts tests/diagnostics-browser-report.test.ts
npm run typecheck
npm run lint
npm run build
```

Results: **108 tests/14 files**, **72 tests/11 additional files**, and final affected
report/framing recheck **8 tests/2 files** passed. The latter overlaps the first
slice and is not an additional count. Full TypeScript, source build and full lint
(409 files, zero warnings/errors) passed. Scoped formatting is recorded at final
handoff. Filesystem/descriptor/journal/duplicate/retention/recovery behavior runs in
actual temporary files, with Windows path spelling and native/vault/peer/OS
authority explicitly fixture-adapted. No dependency was added.

The current official [Zalando API/Event Guidelines](https://opensource.zalando.com/restful-api-guidelines/)
were reread before this private wire addition. Relevant requirements are compatible
closed schemas, authenticated authority, bounded validation, idempotent receipt
recovery and secret-free events. No public REST route or OpenAPI schema changed.
Portable tests do not prove native signing, DACLs, DPAPI or malicious same-user
process isolation.

- [x] Personal Chrome report source, safe private producer, transport/framing and
      meaningful code-only fault/race regression checks.
- [ ] Revalidate Root/Main production bindings, actual headless/GUI saved receipt
      routing and aggregate updater/quit activity; separate composition evidence.
- [ ] W34 actual Windows Chrome/logon/ACL/DPAPI/disk/Explorer/ACK-loss acceptance.
