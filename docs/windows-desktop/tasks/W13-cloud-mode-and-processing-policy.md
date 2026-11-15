# W13 — Port explicit cloud mode and processing policy

- Status: code-complete — every required source/code action is mapped and portably verified; Windows/native/live acceptance remains pending in W34.
- Code dependencies: [W05](W05-backend-platform-and-contract-support.md), [W12](W12-local-files-and-youtube-processing.md).
- Accepted scope points: P09, P11, P23.
- Execution phase: A — implement now once authorized; native checks later.
- Evidence: [cloud core source and fixture checks](../evidence/W13-cloud-core.md), [current source journey audit](../evidence/W13-W16-W18-source-journey-audit-2026-10-09.md), [composed Cloud I/O](../evidence/W13-composed-cloud-io-2026-10-09.md).

A dependency's pending Windows checks do not block this task's code work. Implement real native source now, test portable behavior on the Mac, and retain native checks for W34.

Checklist reconciliation: every source/code row below maps to W13 C01–C14 in the [exhaustive requirement matrix](../evidence/W13-W16-W18-requirement-closure-2026-10-09.md). Native/live observations are separate unchecked W34 cases. Historical subset counts remain dated evidence.

## Existing behavior and design consequence

The desktop is the authority for local/cloud preference and browser handoff. Mode, account readiness, server policy and quota are distinct decisions; an unavailable mode must not cause an automatic fallback.

## Read before editing

- [chrome-extension/src/companion/cloud-provider.ts](../../../chrome-extension/src/companion/cloud-provider.ts)
- [chrome-extension/src/companion/browser-cloud-provider.ts](../../../chrome-extension/src/companion/browser-cloud-provider.ts)
- [chrome-extension/src/companion/browser-processing-bridge.ts](../../../chrome-extension/src/companion/browser-processing-bridge.ts)
- [chrome-extension/macos/DesktopCloudHandoff.swift](../../../chrome-extension/macos/DesktopCloudHandoff.swift)
- [docs/realtime-processing-queue/AI-HANDOFF.md](../../../docs/realtime-processing-queue/AI-HANDOFF.md)

Also read [architecture](../ARCHITECTURE.md), [AI handoff](../AI-HANDOFF.md),
[validation](../VALIDATION.md), and the affected component instructions/manifests.

## Implementation checklist

- [x] Persist local/cloud preference in the trusted desktop authority and expose safe status to the shared extension. Keep local as the account-free path and cloud as an explicit authenticated action.
- [x] Validate account readiness, current desktop policy and remaining usage before cloud submission. Preserve server-denied/unavailable/error distinctions and recheck at command time.
- [x] Implement the existing cloud import/job/transfer flow using HTTP commands and raw WebSocket snapshots. Fence every request/snapshot/result by account owner/generation and installation identity.
- [x] Preserve global/user/country link-import visibility precedence and the existing UI-only hiding scope. Do not turn hiding into cancellation or new server enforcement, and do not block unrelated local files.
- [x] Permit automatic Chrome processing only in local mode and within its established duration rule. Cloud requires a deliberate action; preserve the native-authorized manual browser provider and keep tokens out of Chrome. A separate native review handoff is an additional journey, not a mandatory replacement for manual browser START.
- [x] Handle cancellation, reconnect, expired grants, failed policy reads and mode changes during active work without duplicated jobs or accidental account charges. A backend 503 remains unavailable, not a made-up fallback policy.

- [x] Implement trusted persisted mode and token-free browser settings/admission APIs in the core; signed-out Cloud remains selected and unavailable.
- [x] Implement owned CPU media preparation/probing, authenticated grant transfers and owner-bound result capabilities.
- [x] Bind core commands/views to main/renderer, connect the shared extension mode authority, and verify the listed controller/headless/provider confirmation/cancellation/result flows. The composed I/O harness below supplies the distinct end-to-end code composition proof.
- [x] After verified file-job Ready/upload confirmation, positively close the prepared workspace and recheck original account/cancellation authority before admitting the same-request output workspace. Retain activity/pins and refuse output byte transfer on uncertain close.

## Code validation checklist

- [x] Test mode/account/policy/quota combinations, unavailable policy, account switching, stale snapshots and explicit versus automatic browser initiation.
- [x] Assert no polling/automatic HTTP refetch is added to migrated live views and no request occurs before required cloud guards.
- [x] Verify link-import hiding does not terminate existing jobs or affect unrelated processing actions.
- [x] Compose actual account/raw realtime/usage/cloud/media/Library/cache/storage classes with bounded synthetic I/O for URL and file success, A→B during transfer or result handoff, cancellation/account change during prepared close, and retained cleanup refusal. See the seven-case composition evidence.

## Windows acceptance — deferred until W34

- [ ] Verify explicit cloud submission, account/policy failures and reconnect against an authorized real backend.
- [ ] Confirm the same extension observes app mode without receiving account credentials and never auto-starts cloud work.

## Detailed agent execution handoff

### Dependency cycle and closure order

W05 and W12 permit a cloud **foundation** with typed account/usage/realtime ports. They do not close authenticated cloud behavior. Implement/verify W14 account authority, then W15 owner-scoped usage/policy/realtime, then return here to bind production account authorization, current policy and real socket snapshots. W15 may reference this task's source/protocol interfaces without requiring its completed main/extension UI. Final closure order is W14 → W15 foundation/composition → W13 authenticated composition → W27 shared extension journeys. A fixture transport is a code test, not production wiring.

Existing source: [CloudController](../../../windows-desktop/src/main/cloud/controller.ts), [strict account API adapter](../../../windows-desktop/src/main/cloud/api.ts), [media](../../../windows-desktop/src/main/cloud/media.ts), [signed transfers](../../../windows-desktop/src/main/cloud/transfers.ts), [shared provider](../../../chrome-extension/src/companion/cloud-provider.ts), [realtime protocol](../../realtime-processing-queue/PROTOCOL.md).

### Concrete remaining sequence

- [x] Bind the trusted persisted LOCAL/ONLINE mode, account safe view, W15 current access and min-build gate in main. Signed-out ONLINE remains selected and unavailable; it must not silently select LOCAL or enqueue paid work.
- [x] Bind explicit file/YouTube source confirmation to a one-use bounded capability containing original UID/generation, source identity and request UUID. Recheck owner, account/policy/quota and cancellation after every asynchronous authorization step immediately before intake. Disabled/unknown policy is an actionable blocker.
- [x] Connect raw full-snapshot job/import resources through a scoped lease of the shared account socket. Closing a cloud operation releases only its subscriptions; Library/usage watches remain active. No recurring job GET or automatic refetch may be introduced.
- [x] Use read-only selected file descriptors and fixed private work directories. CPU decode/encode/probe runs in the signed owned Prepare role with all-child stop proof; model inference remains GPU-only. Validate exact grant host/expiry/headers, stream length/hash and final audio duration before issuing a result capability.
- [x] Capture file-picker owner dynamically on window reopen without reassigning the owner of an already running job. Bind trusted completed metadata and one-use result handles into W16 Library, then release scratch only after immutable adoption/pins permit it.
- [x] Bind browser mode/status without exposing tokens. Automatic Chrome work is allowed only by the existing LOCAL/duration rules; Manual saved ONLINE_MUSICMUTE browser Start uses the trusted native account/mode/owner/policy authority and synchronized vocal delivery; it must not be reduced to a handoff-only flow. A separate explicit desktop review handoff remains available. Cloud autostart stays forbidden and tokens never enter Chrome. Link-import hiding follows global/user/country precedence and remains UI-only: do not cancel accepted jobs or restrict unrelated files.
- [x] Present source/confirmation, preparing/uploading/queue/processing/downloading, cancellation, recovery and completed Library state in English/Arabic. Mode changes affect new work while accepted operations remain scoped to their original mode/owner.

### Manual browser parity return

- [x] Trace the existing [BrowserCloudProvider](../../../chrome-extension/src/companion/browser-cloud-provider.ts) and shared native START protocol. Preserve manual ONLINE_MUSICMUTE submission, authenticated native reuse/import/job/grant flow and synchronized browser vocals, including reconnect/cancel and tab/video/generation fencing.
- [x] Keep saved LOCAL automatic behavior and saved ONLINE manual behavior separate. Signed-out ONLINE stays selected/unavailable. Native confirmation/rights authority applies through the existing manual protocol; opening a desktop review handoff must not be imposed on every manual START unless an accepted requirement explicitly changes parity.
- [x] Test manual browser cloud success, missing account, policy/quota/min-build denial, owner change, wrong tab/video/generation, late result and synchronized playback; separately test native review handoff. Assert neither path enables cloud autostart or shares credentials with browser scripts.

### Race and validation matrix

Test LOCAL/ONLINE × guest/email/Google × policy allowed/disabled/unavailable × quota/reset/min-build, source confirmation expiry/replay, token refresh completing after A→B, reconnect before initial snapshot, stale sequence/rank, lost intake response, malformed/corrupt/expired grant, cancellation during media tooling/PUT/download and window close/reopen. Prove zero intake before current guards and no duplicate non-idempotent intake retry. Owner switch must clear old presentation immediately; received A bytes cannot publish into B's Library. Do not use a fabricated zero quota or permissive cached policy to hide an outage.

Run focused `tests/cloud*.test.ts`, account/realtime/usage and signed-transfer fixtures, strict typecheck/build and scoped lint/format from `windows-desktop`; run shared provider/socket regressions from `chrome-extension`. The UI fixtures are headless code proof only. Deliver a production composition test that exercises the actual account adapter, socket lease, media/result capability and Library adoption, with synthetic HTTP/R2.

W34 later requires authorized real Windows cloud submission, actual whole-tree tool cancellation, reconnect/auth expiry, installed Chrome explicit-versus-automatic mode behavior and real private R2 output integrity. No real source import, account charge or R2 upload is authorized by this plan.

## Cold browser cloud and policy-scope closure

- [x] Bind manual Chrome Cloud to the sole account authority when local runtime/
      model/GPU Prepare is absent. Validate downloaded trusted bytes/hash/timeline
      without starting local FFmpeg or inference.
- [x] Confine native link-import hiding to native source pickers; Chrome controls/
      handoff/bridge remain unchanged. Keep actual cloud account/quota admission.
- [x] Test saved Cloud with missing config, cold headless startup, current usage,
      A→B during transfer and UI Quit during playback. No automatic billed request,
      token exposure or silent local fallback.

### Current source continuation

The dated [journey table](../evidence/W13-W16-W18-source-journey-audit-2026-10-09.md)
reviews actual main/preload/renderer and browser authority/media bindings and
records 226 portable tests across 23 relevant suites. Native file Cloud needs its
owned signed CPU media tools; cold manual Chrome Cloud delivers trusted cached/
downloaded bytes without local runtime/model/FFmpeg. Normal GUI automatic Prepare
is a separate P05 journey; the headless account entry skips it. Keep this distinction
explicit rather than advertising all cloud input types as tool-free.

The same evidence records the coordinating agent's **22:19:16** stable full
Desktop checkpoint: **1,424 tests / 174 files**, whole TypeScript/lint/format/build
and two package-boundary tests passed. The subsequent composed return passed
**142 tests / 11 files** at **22:38:45** and corrected the same-request prepared/
result workspace collision. Both checkpoints are source evidence; actual Windows/
live acceptance remains open.

- [x] Deliver the single synthetic composed account/socket/media/Library test
      requested above, using actual domain classes and controlled HTTP/R2/socket/
      native I/O ports; record the exact native codec/process boundary.
- [ ] Retain Windows/live service and installed extension evidence in W34.

## Completion record

- Implementation files and review: `src/main/cloud/`, safe shared cloud contracts, fixed CPU Prepare branch and leased existing raw socket transport; source reviewed against existing shared provider and private R2 guide.
- Commands/results and evidence: 349 desktop fixture tests and 102 shared provider/socket tests passed; source builds and scoped lint/format passed; see evidence for typecheck checkpoint.
- Unrun native/toolchain checks: Windows CPU decoder/Job/ACL behavior and real backend/Firebase/R2/extension acceptance are deferred.
- Remaining limitations and next task: production bindings and the distinct composed synthetic I/O harness are now present and code-checked. Actual installed/live W27/W34 cloud/account/R2/codec/whole-tree journeys remain open; do not infer them from the historical foundation or current composed counts.

Check completed items individually and update [TASKS](../TASKS.md) and
[PROGRESS](../PROGRESS.md). Use `code-complete / Windows pending` only when
the required source work and executable code checks are complete; unavailable
native compilation remains explicitly recorded. Do not claim a release from
fixture or source-only proof.
