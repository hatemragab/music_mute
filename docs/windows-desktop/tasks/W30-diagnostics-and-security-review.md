# W30 — Complete bounded diagnostics and security hardening

- Status: code-complete / Windows pending; final Native report/source threat review and frozen regression passed.
- Code dependencies: [W03](W03-windows-native-security-adapters.md), [W14](W14-complete-account-experience.md), [W20](W20-background-account-saving-and-outbox.md), [W25](W25-worker-advanced-maintenance.md), [W27](W27-shared-extension-feature-parity.md), [W29](W29-app-runtime-and-model-updates.md).
- Accepted scope points: P28, P30.
- Execution phase: A — implement now once authorized; native checks later.
- Evidence: [trusted outcome receiving closure](../evidence/W30-trusted-outcome-receiving-2026-10-10.md), [current requirement/proof ledger](../evidence/W22-W30-2026-10-10-source-closure.md) and [W30 local diagnostics core](../evidence/W30-local-diagnostics-core.md).

A dependency's pending Windows checks do not block authorized code work. Implementation still requires the user's authorization; this task file alone does not provide it. Test portable behavior on the Mac and retain actual native execution for W34.

## Implemented source checkpoint — 2026-10-09

- [x] Implement closed personal diagnostic command/view and allowlisted recorder identity/events/scalar metrics, bounded current-user journal, retained aggregate/alerts and typed failure/recovery states.
- [x] Implement readonly/no-logs inspection, consistent serialized append/export/clear, sanitized copy/export/reveal/show ports and actual operation/Host-lifetime activity. Actual Main/OS source receiving composition is revalidated in the current receiving ledger; genuine Windows UI enforcement remains deferred.
- [x] Implement the fixed signed CPU-only Doctor discriminator after existing Prepare ownership validation, real scratch reservation/creation birth/handoff/native workspace tracking and uncertain whole-tree cleanup. Cold missing-runtime/native/DXGI diagnosis performs no download, model inference or repair.
- [x] Test hostile/cyclic/accessor/private payloads, path/tool command rejection, UTF-8/alert bounds, rotation/reopen, malformed/tail/write recovery, source isolation, export/cancel/disposal and CPU authority uncertainty. Historical diagnostics checkpoint: 13 tests/3 files; current receiving/boundary run: 137 tests/17 files; boundary checkpoints and limitations are in evidence.
- [x] Implement compatible personal Chrome `DIAGNOSTICS -> REPORT` through the verified browser/account authority, independently of account login, Prepare/model and fleet permissions. Project to 28 KiB, omit private paths and receipts, preserve aggregate/coverage/historical alert identity, and test actual framing bounds.
- [x] Implement current-SID protected report receipts, at most four full private reports (2 MiB each), exact file birth/hash validation, duplicate-request recovery, staged/deleting publication journal, bounded partial-writer admission and staged-receipt cleanup protection. Portable filesystem/transport/storage regressions are recorded separately below; no Windows proof is implied.
- [x] Reject scalar enum/identity coercion and preserve active Doctor ownership against concurrent run/public recovery. Meaningful fixtures failed before the fixes; 37 diagnostics/browser code tests passed at 01:43 on 2026-10-10.
- [x] Receive the independently owned final Native exact handle-held diagnostic report retirement source/check return. Chrome already consumes the closed Native port; its generic cache namespace is not widened. Actual Win32 compilation/attacks remain W34.
- [x] Bind and revalidate actual trusted outcome recorders, Main/preload/localized UI, selected export/reveal/receipt ports, Chrome personal DIAGNOSTICS/REPORT and updater/quit activity. Close account/realtime, Library/sync and Fleet/Advanced receiving; preserve six actual Main codes, true cancellation, sealed inventory SHA and bounded current-owner monotonic observations. See the receiving closure evidence.
- [x] Complete final whole-product/package threat/dependency source review,
      including the [actual boundary review](../SECURITY-REVIEW.md) and independently
      owned Native cleanup returns. Actual ACL/DPAPI/Job/Explorer/disk/toolchain
      acceptance remains in the separate unchecked Windows section below.

## Existing behavior and design consequence

Personal diagnostics are explicitly local and redacted. Windows adds renderer/native/pipe/registry/vault boundaries, while the existing fleet has its own authorized diagnostic behavior.

## Read before editing

- [chrome-extension/src/companion/diagnostics.ts](../../../chrome-extension/src/companion/diagnostics.ts)
- [chrome-extension/src/companion/app-diagnostic-reply.ts](../../../chrome-extension/src/companion/app-diagnostic-reply.ts)
- [chrome-extension/src/companion/diagnostic-identity.ts](../../../chrome-extension/src/companion/diagnostic-identity.ts)
- [chrome-extension/macos/UIJournal.swift](../../../chrome-extension/macos/UIJournal.swift)
- [worker/src/platform/windows/diagnostic-bundle.ts](../../../worker/src/platform/windows/diagnostic-bundle.ts)
- [chrome-extension/AGENTS.md](../../../chrome-extension/AGENTS.md)

Also read [architecture](../ARCHITECTURE.md), [AI handoff](../AI-HANDOFF.md),
[validation](../VALIDATION.md), and the affected component instructions/manifests.

## Implementation checklist

- [x] Define a bounded diagnostic schema for setup, runtime/GPU, account connectivity, Library/sync, Chrome, worker, update and lifecycle failures. Keep personal collection local and user-exported only.
- [x] Redact tokens, grants, raw tool stderr, private media URLs/paths, account identifiers and content; bound per-event size, retention, rotations and export size. Use safe reason codes with actionable user text.
- [x] Review renderer/preload/main IPC, native commands, pipe peers, local media routes, OAuth callbacks, archives, update trust, file capabilities and browser-origin validation against the [documented source threat model](../SECURITY-REVIEW.md). Final moving W22/native-report cleanup proof and combined regression remain separate open closure rows; this is not native enforcement proof.
- [x] Test account/worker credential separation, current-user storage and crash/error paths. Avoid claiming DPAPI or code signing protects against every malicious same-user process.
- [x] Preserve the existing fleet reporting contract where authorized; do not initialize new remote telemetry through Electron, renderer libraries or shared diagnostics.
- [x] Implement diagnostics export/clear controls with app-owned path restrictions and active-write coordination. Never include media/model files or live credentials in bundles.
- [x] Record unresolved Native/security/release checks explicitly for W34 and identify independently owned pending source reviews. The five diagnosed Main receiving gaps are fixed; fixture adapters do not establish native protection.

## Code validation checklist

- [x] Run redaction/retention tests with adversarial secret-like payloads, nested errors, oversized strings and raw child stderr.
- [x] Run affected negative IPC/origin/report/path/owner/schema tests and source bundle-boundary checks: current Desktop receiving/boundary corpus 137/17 and shared diagnostic/privacy corpus 114/5. Whole-product archive/OAuth/native/dependency final review remains the separate open row above and W33/W34.
- [x] Verify production logging/export serializers omit private fields and no personal telemetry initialization enters built bundles.

## Windows acceptance — deferred until W34

- [ ] Verify real Windows ACL/vault/pipe/media-host enforcement and sanitized crash/installer/update diagnostics.
- [ ] Inspect an exported diagnostic bundle from representative Windows failures and confirm bounded retention on disk.

## Detailed execution plan

1. Model trust boundaries explicitly: web page -> extension -> native host ->
   session agent; renderer -> preload -> main; local media client -> capability
   server; updater -> signed metadata -> verified files; OAuth -> loopback callback.
   For each, record the authority required and a negative test at the receiver.
2. Prefer allowlisted diagnostic fields to generic object serialization. Collect
   subsystem, timestamp, stable reason code, operation phase and bounded counts.
   Reject private titles, filenames, user/SID identifiers, tokens, grants, URL
   queries, tool stderr and arbitrary error causes before persistence.
3. Use one local journal with bounded rotations and serialized writes. Proposed
   initial bounds: 4 KiB per event, four 256 KiB journal files, 2 MiB export ceiling.
   These are implementation defaults to review, not measured performance claims.
4. Export through a trusted chosen destination from a consistent journal snapshot.
   Clear only owned journal files while writers are coordinated; never recurse
   into runtime/model, Library, source media, account vault or fleet job state.
5. Keep personal diagnostics local. Existing fleet reports remain behind their
   existing authorization/contract; no analytics SDK or new upload endpoint.
6. Audit dependency/bundle and native command surfaces after final composition.
   Track unresolved native checks individually; safe fake-transport results do
   not prove DACL, WinVerifyTrust, Job Object or browser enforcement on Windows.

## Threat/recovery cases and required work

- [x] Deny renderer-controlled filesystem paths, executable arguments, native
      ordinals, worker scopes and external navigation outside reviewed destinations.
- [x] Reuse portable capability/nonce/generation/origin refusal receivers; the recorder additionally fences controller/window/account generations and never grants authority. Final Native process-birth/range/manifest enforcement review and real attacks remain W03/W26/W29/W31/W34.
- [x] Redact nested/cyclic/errors and hostile strings before bounded persistence;
      an unknown error becomes an allowlisted generic reason code.
- [x] Recover or quarantine partial journal files; disk-full/permission/export
      failure is visible without losing unrelated state or leaking raw errors.
- [x] Exercise portable journal/export isolation: Clear owns only four fixed segments, chosen export is receipt/owner-bound and diagnostics introduces no personal telemetry. Exact Native deletion and cross-user enforcement remain independently reviewed and W34-only proof.

## Specific code-only fixtures

| Input/fault                                                                      | Required result                                                             |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| JWT, bearer header, Firebase refresh token, signed URL query, Windows user path  | None appears in the persisted/exported bytes.                               |
| Nested Error/cause, cyclic object, oversized Unicode string, binary child output | Bounded safe event or rejection; no crash or raw fallback logging.          |
| Concurrent append/export/clear and interrupted rotation                          | Consistent bounded snapshot and recoverable journal; no unrelated deletion. |
| Disk full, denied destination or replaced path                                   | Typed failure; no optimistic export/clear success.                          |
| Unexpected diagnostics field from another subsystem                              | Omitted/rejected by the allowlisted schema.                                 |

## Deliverables to review

Local diagnostic schema/journal/export UI, redaction fixtures, a concise boundary
threat model, dependency/bundle findings and exact native checks retained for W34.
The boundaries follow the [Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security/);
policy design is not a native penetration-test result.

## Complete Diagnostics actions and report semantics

- [x] Bind Inspect local diagnostics, Export report, Reveal logs and Show report
      after successful export through narrow main/preload/owned OS destination
      ports. Support cancel/failure; no arbitrary renderer path or optimistic success.
- [x] Keep sanitized browser DIAGNOSTICS/REPORT distinct from W25 worker Doctor/
      logs/export. Chrome cannot forward privileged fleet inspection commands.
- [x] Preserve unavailable/failure reason, malformed/recovered/truncated/incomplete
      history coverage, counts/peaks/stage timings/job summaries and retained
      warning/error provenance even after later success.
- [x] Include safe UI/setup/personal evidence plus recorder/inventory/expected-model
      identity. Expected model is not verified inference; sampled memory growth
      alone is neither leak nor audio-quality proof.
- [x] Fit projections to actual Windows 32 KiB and legacy app 64 KiB envelopes,
      preserving newest warning/error per identity. A bounded full retained export
      is separate from transport summary; measure encoded UTF-8 bytes.
- [x] Allow readonly inspection during active writer; preserve truthful no-logs/
      unavailable/disk-write failure states and consistent aggregate/export.
      Inspection never triggers model inference, download or remote telemetry.
- [x] Test truncation/redaction/coverage/alert retention and append/export/clear
      races. Real Windows resource sampling, Explorer/dialogs and ACL/DPAPI/exported
      native failure bundle remain W34.

### Chrome report source closure — 2026-10-09

- [x] Keep the public native protocol unchanged: empty `DIAGNOSTICS` payload,
      correlated UUID and `REPORT {report}` reply. The private personal lane is
      closed to paths, Clear/Doctor/full/fleet commands, account state and tokens.
- [x] Recheck the actual approved browser peer/owner at receipt and after awaited
      publication; deny new report writers during maintenance. Track accepted
      work and private reply acknowledgment through actual shutdown.
- [x] Store `diagnostics/reports/<receipt UUID>.json` privately, with a protected
      SID/birth/hash registry. Retry a request from its exact durable publication;
      do not create another snapshot/file after lost acknowledgment. Verify the
      full file again before reveal and never fall back after verification fails.
- [x] Apply a separate four-slot/2 MiB temporary budget and preserve an exact staged
      protected report during generic partial cleanup. Corrupt registry or changed
      file birth remains fenced. Count report bytes once as ineligible metadata.
- [x] Expose trusted `acceptLocalReport(receipt)` to the GUI controller without
      adding a renderer receipt setter or changing chosen-export consent.
- [x] Revalidate the separately owned production Main binding: actual reporter
      port, saved events, activity/quit/update fences and receipt-first Show report
      routing across headless/GUI window replacement. Source modules/fixtures alone
      do not close this production-composition row.
- [ ] Execute real Chrome/native/Explorer/ACL/DPAPI/disk/ACK-loss/logon acceptance
      on supported Windows after W34 has the connected machine.

See the [Chrome source checkpoint](../evidence/W30-local-diagnostics-core.md#chrome-personal-diagnosticsreport-source-checkpoint)
for exact production APIs, executed commands and retained verification boundaries.

## Completion record

- Implementation files and review: actual Main receiver/identity/OS binding, bounded recorder, sealed identity, projection and existing journal/Chrome/controller/UI ports; see [receiving matrix](../evidence/W30-trusted-outcome-receiving-2026-10-10.md).
- Commands/results and evidence: current 137 Desktop tests/17 files, 114 shared Chrome tests/5 files, full TypeScript/lint532/source build, two bundle boundaries and scoped formatting passed. Final whole Desktop2135/232 and static/build/package checks passed; see W33 evidence. Earlier checkpoints remain historical.
- Unrun native/toolchain checks: supported Windows x64 compilation, actual ACL/DPAPI/signature/pipe/Job/path replacement/disk faults and Explorer/clipboard/selected export; every Windows acceptance row remains unchecked.
- Remaining limitations and next task: actual Windows cleanup/security/candidate acceptance; final source review and W33 regression are complete; W01 eight moderate development findings and operator/release exception remain separate gates.

Check completed items individually and update [TASKS](../TASKS.md) and
[PROGRESS](../PROGRESS.md). Use `code-complete / Windows pending` only when
the required source work and executable code checks are complete; unavailable
native compilation remains explicitly recorded. Do not claim a release from
fixture or source-only proof.

- [x] Bind personal Main outcome recording, localized Diagnostics UI, actual clipboard, native export dialog, content-bound saved-report receipt and owned log reveal; test headless clear confirmation, busy cancellation, unavailable and partial observations. Browser report source parity and trusted receiving are revalidated in the current ledger; Native/security source review is complete; actual Windows acceptance remains open. See [current integration evidence](../evidence/W16-W18-W29-final-integration.md).

## Final Root source closure — 2026-10-10

[Exact Native report retirement](../evidence/W22-final-native-library-cleanup-2026-10-10.md),
[the boundary review](../SECURITY-REVIEW.md) and
[the final2135/232 regression](../evidence/W33-final-source-regression-2026-10-10.md)
close the source returns. W01 development-builder findings, genuine signing/
configuration inputs and all native/installed/live proof remain release gates.
