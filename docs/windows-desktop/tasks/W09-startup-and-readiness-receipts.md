# W09 — Implement fast startup and trustworthy readiness caching

- Status: code-complete / Windows timing, NTFS and GPU acceptance pending.
- Code dependencies: [W08](W08-automatic-prepare-and-repair.md).
- Accepted scope points: P07, P25, P27.
- Execution phase: A — implement now once authorized; native checks later.
- Evidence: [readiness core](../evidence/W09-readiness-core.md); [Advanced status/execution operation-count return](../evidence/W09-advanced-status-verification-2026-10-10.md).

Checked source rows refer to the current requirement matrix. Windows machine
checks remain separate; a status receipt or fixture cannot authorize inference,
a release, or machine acceptance.

## Current source audit — 2026-10-10

[Requirement → production entry → portable proof → native acceptance](../evidence/W06-W09-runtime-prepare-readiness-closure-2026-10-10.md)
records every boundary below. `[x]` in implementation/code sections means source
and portable proof, never Windows execution. Historical completion commands below
remain dated slices; use the current matrix for subsequent changes.

## Existing behavior and design consequence

The Mac implementation avoids repeated full inventory hashing by using a private verified receipt. Windows needs the same bounded startup behavior with Windows identity/ACL checks, not indefinite trust in paths or timestamps.

## Read before editing

- [chrome-extension/macos/ProcessBridge.swift](../../../chrome-extension/macos/ProcessBridge.swift)
- [chrome-extension/src/companion/installation-check.ts](../../../chrome-extension/src/companion/installation-check.ts)
- [chrome-extension/src/companion/worker-preflight.ts](../../../chrome-extension/src/companion/worker-preflight.ts)
- [chrome-extension/src/companion/app-journal.ts](../../../chrome-extension/src/companion/app-journal.ts)

Also read [architecture](../ARCHITECTURE.md), [AI handoff](../AI-HANDOFF.md),
[validation](../VALIDATION.md), and the affected component instructions/manifests.

## Implementation checklist

- [x] Create a versioned readiness receipt after full successful verification/qualification, bound to installation/profile, active release inventory, model identity and GPU/runtime requirements.
- [x] Implement cheap ordinary-start checks and explicit invalidation for update/repair, missing or replaced files, changed identities, damaged receipts and changed GPU/driver conditions. Define which checks require full revalidation and why.
- [x] Share readiness safely across app/native host/agent without each process independently hashing the model or racing setup. Bound wait time and report Preparing/Repair needed instead of blocking the UI indefinitely.
- [x] Perform full verification on first install, activation, explicit integrity check and repair. Keep runtime execution subject to its own integrity and provider rules; a cached UI state must not bypass engine safety.
- [x] Instrument startup stages with bounded local timings suitable for later measurement. Separate cold app launch, warm app launch, first model load and first inference.
- [x] Handle offline launch using an already verified installation without demanding update/auth services. Do not launch fleet claims merely to answer readiness.

## Code validation checklist

- [x] Test receipt tampering, stale profile/model/runtime/GPU, interrupted activation, concurrent readers and bounded wait recovery.
- [x] Assert normal-start fixtures avoid full model/inventory reads, while invalidation fixtures trigger the required verification.
- [x] Run source-level startup timing/operation-count regressions with deterministic fakes, not advertised Windows latency thresholds.
- [x] Reject missing/legacy and changed current-boot witness even when LUID/device/driver repeat; retain same-boot ordinal remapping and cheap checks. Capture cannot publish a marker across witness change. See [v2 migration/checkpoint](../evidence/W07-W09-boot-witness-and-session-serialization-2026-10-09.md).

## Windows acceptance — deferred until W34

- [ ] Measure real cold/warm startup and first inference separately; confirm receipt/ACL behavior and invalidation under real file replacement.
- [ ] Verify offline local startup and recovery without repeated large downloads or full hashing on every window open.

## Agent execution contract — planning review 2026-10-09

Readiness has two authorities: a full activation/qualification proof authorizes
execution, while the cheap startup capsule supports UI status only. A fast Ready
badge must never bypass model/release/provider verification at engine launch.

| Record/check   | Binding and invalidation rule                                                                                                                                                                   |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ReadyReceipt   | Version 2; current native volatile witness, SID, target/release, sequence, inventory digest, model/fixture, qualification, activation time and exact model fingerprint.                         |
| Startup marker | DPAPI-protected binding hash plus capsule path/SHA/byte length; reject unknown fields, oversized or damaged data.                                                                               |
| Capsule        | Small version 2 or chunked version 3; current native volatile witness, installation/SID/profile policy, release/model/fixture, selected physical GPU/driver and each verified file fingerprint. |
| Fingerprint    | Device, file ID, bytes, written/changed time as bounded strings; same path and size alone do not establish unchanged identity. Native ACL/reparse/hardlink checks remain required.              |
| GPU            | Re-enumerate without model loading. A reorder may resolve the same qualified device; physical/driver change invalidates readiness.                                                              |
| Final read     | Re-read activation marker after checking files; a concurrent activation/repair cannot publish stale Ready.                                                                                      |

The native witness is app-owned volatile-registry authority, not an OS boot GUID
or clock/logon estimate. Ordinary helper/app exits retain it; reboot or earlier
hive unload invalidates it conservatively. A changed witness requires actual
qualification. Past-boot receipt fields can identify exact already installed
bytes for network-disabled offline requalification, never Ready or inference.
Fleet current-runtime/capacity overlays are separately revalidated under W25/W29;
immutable original approval is not relabelled as current-boot qualification.

### Implementation order and integration boundaries

1. [x] Review `readiness-cache.ts`, `operations.ts` and private file helpers
       against current native APIs. Large inventories use 2 MiB chunks, a 64 KiB
       authenticated index, two fixed slots of at most 64 MiB each, and all
       100,000 signed entries plus manifest/model/fixture. Four concurrent
       fingerprint checks and an 8-second default wait are safety limits, not
       promised startup performance; no 8,192-file product restriction remains.
2. [x] Establish the full-verification producer after W08 successful activation.
       Persist the capsule before its DPAPI marker. Delete/invalidate marker first
       when repair/update changes the target; half-written records cannot authorize
       readiness. Preserve installation keys on account sign-out.
3. [x] Finish the app/session/native-host shared status path. Readers may use
       the same verified capsule; only the installation owner runs expensive repair.
       Bound waits and return missing/changed/timeout/cancelled truthfully. Do not
       launch fleet claims, Firebase or network update probes just to answer status.
4. [x] Audit every invalidation edge: package/profile policy, key rotation,
       target/sequence, file identity/ACL, model, GPU/driver, helper and recipe. Distinguish
       full revalidation from already-verified exact offline activation reuse.
5. [x] Ensure cheap status and full execution verification cannot be confused
       in IPC/types. A consumer attempting inference still needs its current W11
       permit/guard and provider proof; cached UI Ready is never an admission grant.
6. [x] Add bounded local startup measurements: app bootstrap, status check,
       controller attach, first model load and first inference are separate phases.
       Avoid repeated model hashing per window while retaining execution checks.

### Required code-only fixtures and races

- [x] Marker/capsule byte/hash/path tampering; wrong SID/installation/profile,
      expired/new release identity, unknown fields, duplicate paths, excessive files,
      malformed decimal fingerprints and corrupt DPAPI record: no Ready.
- [x] Same-size replacement with restored write time but changed file ID/change
      time; ACL/reparse/hardlink change; missing file; modified model: invalidation.
- [x] GPU ordinal reorder vs changed LUID/driver; missing GPU; discovery throws;
      software-only inventory: only unchanged qualified physical proof can pass.
- [x] Concurrent repair between initial/final marker reads, capsule rename while
      readers work, timeout during native I/O and caller cancellation: a late result
      cannot overwrite newer missing/Preparing state.
- [x] Assert ordinary fixtures read fingerprints/capsule only, never full model
      contents or inference. Assert explicit integrity/repair paths perform full
      verification. Count operations instead of advertising Mac-fixture milliseconds.
- [x] Signed-out/offline relaunch, account A→B and fleet stopped/running: local
      readiness stays independent while account/worker authorities remain fenced.

Use `readiness-cache.test.ts`, Prepare records/controller tests and injected
native/file clocks. Simulated fingerprint matching does not prove NTFS behavior.

### Deferred Windows checks and reviewable deliverables

- [ ] Native current-user protection, real identity-preserving/replacing writes,
      ACL/junction/hardlink manipulation, simultaneous processes and update/repair.
- [ ] Measure cold/warm app launch, cheap-status phase, first model load and
      first inference independently on the named machine; capture release/GPU/driver
      and whether runtime/model/page cache was warm.
- [ ] Verify offline launch, repeated windows and Chrome attachment share status
      without repeated full model reads or implicit worker startup.
- [ ] Deliver receipt schemas/examples, invalidation/revalidation matrix,
      operation-count regressions and measured W34 timings with explicit limitations.

[CryptProtectData](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata)
supports current-user protection and tamper detection; machine-wide protection
would widen access to other users and is unsuitable here. This does not isolate
the app from another program already running as the same Windows user. The
fingerprint/ACL/execution policy above is MusicMute's additional validation.

## Receipt rebinding and authority availability

- [x] Reject reuse of a same-boot execution permit after reboot, changed/reused
      LUID or ambiguous physical-device mapping. Trustworthy cheap current-device
      rebinding and inference qualification are separate decisions under W07.
- [x] Keep local model/Prepare readiness separate from browser/account connection
      readiness. Manual Cloud and valid retained playback do not require a GPU
      inference receipt; fresh local inference always does.
- [x] Test restart/reused-LUID receipts, missing model with valid cloud authority,
      and existing agent controls while Ready is missing, without false Ready.
- [x] Name the shared status producer/readers used by desktop, session and browser
      host; test sign-out preserving account-independent installation/receipt/
      Prepare transfer records. Return after W10/W26 composition.

## Current status APIs and bounded retention

- [x] Keep default `snapshotReady()` / `snapshotMediaTools()` full verification
      for actual execution, qualification, benchmark, update and explicit full
      integrity checks. New `snapshotReadyStatus()` / `snapshotMediaToolsStatus()`
      serve ordinary status only; no silent full fallback exists.
- [x] Route Main's ordinary fallback attachment and Advanced versions/quick Doctor/
      history/capacity-report reads to status. Actual activation/roles/tools still
      verify signed bytes independently; CPU status has no GPU/boot/model prerequisite.
- [x] Test real signed-ZIP Operations with 8,300 additional files and a separate
      9,000-file cache: complete coverage, zero warm full-inventory verification,
      two slots, marker-last publication and no shared-caller cancellation.
- [x] Bound startup and runtime-only receipts independently: 128 MiB each across
      two slots plus bounded index/marker, counted by W22 and ineligible for generic
      cache deletion. Generic metadata limits remain unchanged.
- [x] Record actual monotonic bootstrap/status/controller/model/first-inference
      phases in at most 32 local samples, seven-day/16 KiB retention; failures and
      cancellations remain distinct. No remote telemetry or fixture-derived timing
      promise is made. Schemas/invalidation/operation-count deliverables are S01–S08.
- [ ] Measure genuine Windows cold/warm/model/first-Run latency and multi-process
      NTFS/ACL/boot-witness behavior with the named release/GPU/driver.

## Completion record

- Implementation files and review: `windows-desktop/src/main/prepare/readiness-cache.ts`, bundle/operations/controller and private fingerprints.
- Commands/results and evidence: 49 focused tests; scoped lint and desktop TypeScript passed; see evidence.
- Unrun native/toolchain checks: Windows native build, NTFS/ACL/GPU checks and real startup timings.
- Current source return: S01–S08 cover scalable complete-file status, independent reader cancellation, shared app/session/browser paths, actual caller operation counts and bounded local measurement. Actual latency, NTFS/ACL/process and boot/GPU behavior remain unrun W34 checks.

Check completed items individually and update [TASKS](../TASKS.md) and
[PROGRESS](../PROGRESS.md). Use `code-complete / Windows pending` only when
the required source work and executable code checks are complete; unavailable
native compilation remains explicitly recorded. Do not claim a release from
fixture or source-only proof.
