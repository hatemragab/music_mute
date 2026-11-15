# W12 — Port account-free local imports and processing

- Status: code-complete / Windows pending; native compilation, approved release inputs and actual acceptance remain unrun.
- Code dependencies: [W02](W02-shared-core-and-contracts.md), [W08](W08-automatic-prepare-and-repair.md), [W11](W11-gpu-admission-and-handover.md).
- Accepted scope points: P04, P08, P09.
- Execution phase: A — implement now once authorized; native checks later.
- Evidence: [W12 source and code checks](../evidence/W12-personal-processing-foundation.md), [intake/reuse/recovery checkpoint](../evidence/W12-W21-W22-intake-reuse-recovery-2026-10-09.md), [pending playback and exact cancellation](../evidence/W12-pending-playback-and-cancellation-2026-10-09.md), [current requirement/entry/proof matrix](../evidence/W11-W12-current-admission-and-personal-closure-2026-10-10.md).

Handoff boundary: checked rows preserve earlier source evidence. Execute source
work only when implementation is explicitly authorized. Windows machine checks
remain separate and do not block code-only development on the Mac.

## Existing behavior and design consequence

The personal pipeline already separates acquisition from processing. Windows must use bundled executables and its own paths/process adapters while keeping local access independent of account configuration.

## Read before editing

- [chrome-extension/src/companion/file-provider.ts](../../../chrome-extension/src/companion/file-provider.ts)
- [chrome-extension/src/companion/local-provider.ts](../../../chrome-extension/src/companion/local-provider.ts)
- [chrome-extension/src/companion/local-engine.ts](../../../chrome-extension/src/companion/local-engine.ts)
- [chrome-extension/src/companion/youtube-runtime.ts](../../../chrome-extension/src/companion/youtube-runtime.ts)
- [chrome-extension/src/companion/downloader-bundle.ts](../../../chrome-extension/src/companion/downloader-bundle.ts)
- [worker/engine/musicmute_engine/pipeline.py](../../../worker/engine/musicmute_engine/pipeline.py)

Also read [architecture](../ARCHITECTURE.md), [AI handoff](../AI-HANDOFF.md),
[validation](../VALIDATION.md), and the affected component instructions/manifests.

## Implementation checklist

- [x] Implement file picker and drag/drop import for the current macOS-supported audio/video formats, with trusted file capabilities, rights confirmation where applicable, validation, metadata and meaningful errors.
- [x] Preserve the current inclusive 1,200-second processing ceiling and the source eligibility rules. Validate limits from bounded probing and trusted metadata; never increase the limit simply because another GPU is selected.
- [x] Implement local YouTube paste/acquisition using the current companion architecture and bounded helpers. Keep provider credentials and backend SaaS acquisition boundaries intact; do not add an extraction fallback to the backend URL-import flow.
- [x] Run the exact local recipe/model on the qualified DirectML GPU through the shared engine and reservation broker. Preserve original/result identity and trim=false where timeline synchronization requires it.
- [x] Expose acquisition/preparation/separation/encoding progress, cancel and retry. Open the preparing player immediately; no account/verification/quota request can block local execution.
- [x] Use safe argv and app-managed scratch directories for Unicode/space/long paths, bounded media probing, input-size/resource limits and cancellation cleanup. Never edit or delete user source files.
- [x] Keep network-dependent source acquisition distinct from already-cached/offline file processing. Return offline/source-unavailable errors truthfully; never switch a failed local request to cloud or CPU.
- [x] Make duplicate submissions, interrupted work and stale completion events idempotent and generation-bound; publish only fully verified completed outputs.

## Code validation checklist

- [x] Use small synthetic media and stubbed external executables to test import validation, stages, cancellation, cleanup, duplicate requests and stale results without real GPU/UI. See the current intake/reuse/native-handoff/restart checkpoint; actual codec/GPU acceptance stays in W34.
- [x] Test absent/expired account, missing backend config, offline cached input, invalid URLs, oversized probes, child hangs and unsupported GPU.
- [x] Run shared companion/engine code tests proving output identity and no silent cloud/CPU fallback.
- [x] Preserve originally captured null guest intake through login/logout, refuse stale account-A intake on A→B, and bind trusted submission authority through delayed session attachment before issuing completion receipts.
- [x] Resume the event-driven desktop owner watch after the current account scope is acknowledged; stale handshakes/delivery cannot restart or overwrite the newer subscription. Explicit detach/Quit still cancels owned intake.
- [x] Refuse fresh model execution against a missing/changed current native boot witness, even when GPU LUID/driver and model fingerprint repeat; valid cache reuse and CPU/cloud tools remain separate. See [current boot checkpoint](../evidence/W07-W09-boot-witness-and-session-serialization-2026-10-09.md).
- [x] Publish immediate bounded pending-playback descriptors before awaited intake, map only the exact owned job acknowledgement, and retire the presentation on cancellation/failure/manual playback intent without fabricating a media grant or history count.
- [x] Await actual copier and late owned-job cancellation cleanup; terminal state alone cannot certify idle. Failed/unknown cleanup acknowledgements retain busy activity and exact owned job identity through empty/scope-filtered snapshots, and failed cleanup occupies its existing 16-job intake slot.
- [x] Keep public successful/failed/cancelled outcomes preparing through owned teardown. Public Ready follows positive stop/cleanup/release; cancel-after-pair-commit preserves exact durable media, retires autoplay and awaits teardown rather than deleting the verified pair.

## Windows acceptance — deferred until W34

- [ ] Process actual supported audio/video files and fresh YouTube input on Windows with GPU placement evidence.
- [ ] Verify input/output quality, encoding compatibility, cancel cleanup, source preservation and offline signed-out file processing.

## Agent execution contract — planning review 2026-10-09

Implementation continuation: the personal child now performs verified pair and original-only reuse before acquisition/inference, with deferred publisher activity. Input staging has its 64-entry/512 MiB aggregate, creation-birth and native handoff/recovery checks. Canonical pairs survive lost catalog acknowledgement; strict owner/captured-scope recovery preserves trimmed source/map metadata. The [current checkpoint](../evidence/W12-W21-W22-intake-reuse-recovery-2026-10-09.md) records executed portable checks. The current L01–L14 matrix revalidates the later intake/presentation/Library source; native deliverables remain below. Checked source rows never attest an actual Windows import.

- [x] Provide a bounded transient fresh-completion playback gate using the existing
      completion receipt, exact desktop owner/request/current Ready output hashes
      and captured window/account/playback epoch. Stage/reuse/submit share one
      request UUID; failure/cancel/detach/dispose retire it. Intentional reuse and
      fresh completion consume the same intent once.
- [x] Bind the private lifecycle hooks and gate to actual application completion
      reconciliation and player intent epochs. A pair may arrive before submit
      acknowledgement, so acceptance triggers an explicit reconcile. Window close,
      manual Next/play/cancel and a stale owner must never yield late autoplay.
      Startup/backfill/Chrome/fleet results have no desktop-created intent.

The [pending-playback checkpoint](../evidence/W12-pending-playback-and-cancellation-2026-10-09.md)
records the current production lifecycle/snapshot/UI binding and a fixture composing
the actual intake controller, intent gate and React application. The private
`PersonalPlaybackPreparation` descriptor is only `{requestId, jobId:null|string}`.
It is visible during file staging/reuse before a job exists; it contains no path,
audio grant, Ready output or listen count. `CANCEL_REQUEST` accepts only that owned
current intake UUID. A valid job acknowledgement arriving after cancellation must
be cancelled by exact owner/job and genuinely cleaned before intake settles.
An unknown submission acknowledgement or failed stop retains protected activity;
retiring the visual intent never releases its native guard, pin or scratch.
Actual Windows picker/import/native cancellation acceptance remains in W34.

The current personal foundation includes an owned DirectML child, private storage,
broker admission, parallel control/admission/event lanes and durable Library hooks.
Actual intake/controller/intent/panel composition and capability/storage/recipe/Library tests now close the source rows mapped in L01–L14. An injected runner or headless DOM does not prove a packaged Windows import works.

| Boundary    | Input/output and invariant                                                                                                                                                       |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Intake      | Picker/drop descriptor or validated YouTube identity + rights/settings + request UUID. Renderer supplies opaque capabilities, never executable/filesystem paths.                 |
| Scope       | Trusted captured account `{firebaseUid,generation}` or null. Chrome/account-free jobs remain null even if the desktop is signed in; account A work cannot become account B work. |
| Acquisition | Exact app-owned input descriptor/SHA/bytes and actual acquisition source identity. Keep trusted YouTube video/format/audio-track metadata; never infer it from a filename.       |
| Admission   | W11 logical permit and pre-acquired role physical guard, matching job/GPU/nonce before model load. Abort retains ownership until exact teardown/cleanup acknowledgement.         |
| Child       | Verified release/module/model/fixture, isolated Python import, filtered environment and owned nested Job; no account/R2 secrets, CPU inference or cloud fallback.                |
| Publication | Verified original/voice descriptors, actual recipe/sample map, atomic private pair and completion receipt, then Library catalog, then Ready snapshot.                            |
| Events      | Bounded full recent-job views with instance/version and owner/captured-scope fence; `wait_changes` replaces status polling and must not block cancel/admission replies.          |

### Guest intake and trusted scope continuation

The 2026-10-09 source audit distinguished accepted guest jobs from desktop intake
still staging or trying reuse. The child already retained null-scope jobs across
account changes, but desktop intake previously aborted them or allowed dispatch
to recapture the newly signed-in account. The current trusted desktop adapter
passes its original captured scope to `SessionClient.personal`. New submit frames
always carry `submission_authority: {kind: "guest"}` or
`{kind: "account", scope: {firebaseUid, generation}}`; the dispatcher validates
that discriminant, keeps Chrome guest-only and rechecks an account generation
after awaited role attachment. Explicit guest cannot become account capture.
The older omitted field retains legacy private-wire behavior for compatibility;
current submit clients always emit the explicit authority. Renderer commands
cannot supply an account scope or that private envelope.

`scopeChanging(nextScope)` aborts only stale non-null intake and retires the old
event watcher. `scopeChanged(acknowledgedScope)` restarts an already registered
owner watch only when the acknowledged scope still equals the host's current
scope. The first watch uses a full snapshot; no status/HTTP polling is added.
Explicit owner detach and Quit still abort all owned intake and retire the watch.
Guest work may lose its stale autoplay intent on a window/account/playback intent
change; that does not cancel its local processing or grant account saving.

### Implementation order and boundaries

1. [x] Trace `agent/personal.ts`, main personal factory/config/client/server,
       controller/runner/storage and the DesktopPersonal/Chrome gateway. Preserve
       actual owner birth, helper/role nonce, original peer and captured scope across
       every private frame. Reject direct caller identity substitution.
2. [x] Finish/review picker + drop capability intake, Unicode/long-path/format
       probe and immediate preparing-player UI. Inclusive personal limit is 1,200
       seconds; Chrome automatic eligibility remains strictly below its saved
       1–20 minute limit and honors disabled automatic mode.
3. [x] Keep cached/offline file processing distinct from fresh YouTube network
       acquisition. Use the shared bootstrap and fixed private tools; no MusicMute
       login/quota/verification prerequisite for local work and no backend provider
       credentials in the child. Classify genuine acquisition failures truthfully.
4. [x] Review child launch/module paths in verified dynamic ESM imports, actual
       current GPU identity and model proof. Every child/tool descendant belongs to
       the owned Job. Clear role ownership environment fields before tools spawn.
5. [x] Close stage/progress/cancel/retry/state presentation and request-id dedup.
       On cancel, stop child tree, confirm exit, clean owned workspace, then release
       GPU permit/physical guard; late engine success cannot publish artifacts.
6. [x] Preserve both desktop recipes: `kim-vocals-v2` and
       `kim-vocals-v2-trim`, revision 6 with their fixed digests. Current source now
       runs trim and parses an exact retained 44,100-Hz sample map. Persist the map
       privately in `pair.json`/Library; do not force the selected desktop trim flag
       false or send the full map through bounded public job snapshots. Chrome stays
       untrimmed for synchronized playback.
7. [x] Reconcile completion receipts and captured scope with W16/W20. Guest
       completion is retained locally regardless of current Firebase state; account
       saving uses its original captured owner/generation only. Full-timeline reuse
       receipts currently exclude trimmed output. Keep that limitation visible and
       explain incompatible Save/reuse without silently substituting the
       full-timeline profile. A trimmed-private ingestion return to W20/W05 is
       conditional on a later explicitly accepted requirement, not new parity
       scope from this review. Export/share have different eligibility.
8. [x] Close W22 partial/pair recovery and processing pins before claiming
       crash-safe publication. Terminal error/cancel is not idle unless owned
       stop/cleanup/release all completed; W29 `idle_proof` must remain fail closed.

### Trim, account saving and export parity audit

Source review on 2026-10-09 found distinct paths; do not collapse them into one
"trim not supported" restriction:

| Path                        | Current Mac/backend source                                                                                                                                                                                 | Windows handoff requirement                                                                                                                                              |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| New local separation        | Mac `local_pipeline.py` requests untrimmed `kim-vocals-v2`; `LocalMacProvider` rejects `trimEnabled !== false`/removed samples and returns `trim_enabled: false`.                                          | Windows desktop now has an actual optional trim recipe/sample map. Its new local trim option needs complete Library/playback/export behavior; Chrome stays untrimmed.    |
| Local-path Export/Share     | Swift Library/player actions require a valid local voice path, with no trim check; this also applies to locally downloaded account voices.                                                                 | A valid verified trimmed voice must remain exportable/shareable. No full-timeline reuse receipt, login or account-ingest profile is required for local export/share.     |
| New/warm local account save | `desktop-service.ts` stages verified pairs; warm file capture explicitly requires `trim_enabled: false`. `local-sync-capture.ts`/`warm-local-sync.ts` recover YouTube originals for the untrimmed profile. | Preserve working untrimmed saving and captured-account authority. Do not relabel trimmed bytes as full timeline to get a receipt.                                        |
| Backend local ingest        | `/local-media-syncs` accepts only `kim-vocal-2-full-timeline-v1`; original/vocal duration agreement is required within 250 ms, created job is untrimmed and has no comparison map.                         | Explain incompatible trimmed Save/reuse under the same full-timeline contract; do not suppress valid local playback/export/share or add a new ingest profile implicitly. |

No successful current Mac **new locally separated trim=true account-save** path
was found: the local Mac engine produces full timeline, the sync wire has no trim
map, and backend validation rejects shortened timelines. This audit does not
claim an earlier installed Mac release never supported another path. It proves
the present source contract cannot accept trimmed local pairs. Existing Mac
Export/Share behavior must still be preserved, including trimmed account results
downloaded into a valid local cache.

- [x] Expose an honest save/reuse-specific unavailable explanation for a pair
      incompatible with the full-timeline profile, retaining valid local
      playback/export/share and successful artifacts. Do not falsely claim a save
      succeeded, change the recipe or reinterpret bytes to fit the profile.
- [x] Keep synchronized YouTube reuse/community publication full timeline,
      trim=false and non-denoised. A new private trimmed-ingest profile must never
      confer canonical shared-media eligibility or pretend to attest model quality.
- [x] Test a completed trimmed local pair and downloaded trimmed account voice:
      exact voice bytes play/export/share, full-timeline outbox refuses an
      incompatible new save, and local availability survives unsupported/failed
      saving. Current account authority remains required for account-owned bytes.

**Conditional extension, outside current parity acceptance:** only if a later
accepted product requirement explicitly asks to save newly locally separated
trimmed pairs, create a W20/W05 return task. Do not implement that extension now
or block current Mac parity on its absence. Such a task would need a compatible
versioned account-private profile with recipe/model/version/digest, bounded
retained 44,100-Hz ranges, decoded original/output durations and verified hashes;
preserve the existing full-timeline profile and duration validation. Its scope
would also include outbox replay/receipt, account Job trim/comparison metadata,
captured-owner fences, download/playback map round-trips and contract/OpenAPI
updates. It must not grant canonical YouTube reuse/publication eligibility.

Read [Mac desktop service](../../../chrome-extension/src/companion/desktop-service.ts),
[warm capture](../../../chrome-extension/src/companion/warm-local-sync.ts),
[sync outbox](../../../chrome-extension/src/companion/sync-outbox.ts),
[Swift Library/player](../../../chrome-extension/macos/DesktopWorkspace.swift),
[local sync contract](../../api/client-contract.md#desktop-local-media-sync) and
[backend validation](../../../backend/src/local-media-syncs/local-media-validation.service.ts).
If that new capability is later accepted, return its contract/outbox work to
[W20](W20-background-account-saving-and-outbox.md) and
[W05](W05-backend-platform-and-contract-support.md); do not infer that current
full-timeline ingestion can save trimmed audio merely because upload bytes verify.

### Code-only fixture matrix

- [x] Exact 1,200 seconds passes personal intake; above fails before GPU; Chrome
      saved shorter limit/disabled mode and strict boundary remain unchanged.
- [x] Audio/video format probes, changed source descriptor, oversized output,
      short writes, corrupt hashes, unsafe paths, malformed metadata, unavailable
      tools and offline input; source descriptor/file must remain unchanged.
- [x] Cancel during acquisition/permit/inference/encode/publication; helper loss;
      unknown owned shutdown; late response; duplicate request; process restart:
      no Ready, duplicate artifact or guard release while an engine can survive.
- [x] Simultaneous stop/scope/long-poll and guard status/release prove separate
      native lanes avoid deadlock. Initial empty jobs bind the authorized owner;
      changed peer birth or stale scope cannot read it. No silent response truncation.
- [x] Desktop account A→B/sign-out and Chrome null captures, including Ready
      completion delayed across the switch; no new account scope is inferred.
- [x] Full/trim recipes, contiguous output coordinates, ordered retained source
      ranges, removed-sample conservation, malformed/overlapping maps and duration
      tolerance. Player maps logical original time exactly, never proportionally.
- [x] Durable Library/completion failure between pair rename and Ready, pending
      outbox copies, cache cleanup contention and cleanup failure: preserve verified
      media and recovery authority; do not falsely acknowledge idle.

Extend the existing personal controller/control/events/runner/storage/timeline
fixtures and Python `test_consumer_personal`/`test_trimmer`. Synthetic PCM trimming
can test mapping on the Mac; injected DirectML sessions do not establish GPU
execution. The current broad Desktop257/34 run includes actual controller/router/role intake, reuse, timeline, Library and Share adapters with injected native/codec observations. Python personal/trimmer12 passed with real synthetic PCM. Historical50/9 evidence remains historical; current commands/typecheck boundaries are recorded in the matrix.

### Deferred Windows evidence and deliverables

- [ ] Actual picker/drop and supported audio/video files, fresh YouTube input,
      Unicode/long paths and offline signed-out use on the named x64 target.
- [ ] Real DirectML model placement, output original/voice hashes/durations,
      both desktop recipes, listening quality and synchronized untrimmed Chrome.
- [ ] Helper/Node/decoder crash, busy GPU, cancel, logout and low disk while
      another owner is active; prove complete tree teardown and source preservation.

### Reviewed source deliverables

- [x] Deliver the source intake/stage/ownership, format/error/captured-scope and
      timeline/cancellation contracts in L01–L14 and the private receipt parsers.
      Every actual Windows measurement/evidence row remains unrun below.

[Nested Windows Jobs](https://learn.microsoft.com/en-us/windows/win32/procthread/nested-jobs)
permit a role tree and a per-engine child hierarchy; assignment order and breakaway
settings must be audited. Native proof is deferred, not inferred from Mac child fixtures.

## Pre-acquisition reuse integration return

- [x] Route every desktop and Chrome YouTube entry through W21 before original
      acquisition, runtime activation or GPU admission. Shared/guest voice hits
      skip inference; original-only hits skip acquisition but still use strict GPU.
- [x] Keep signed-in desktop captured-save scope separate from null-scope Chrome
      guest processing/reuse. Reuse must not silently grant a guest an account save.
- [x] Test actual entry orchestration for voice hit, original-only hit, miss,
      corrupt/timeline/model mismatch and cancellation; assert downloader/engine
      call counts and exact held/released pins, not only controller output.
- [x] Stage eligible fresh YouTube publication with W21's playback deferral and
      original caller proof; private files and incompatible trimmed results stay
      outside browser/community reuse.
- [x] Preserve the current Mac staging bound of 64 entries/512 MiB aggregate in
      the Windows intake equivalent, in addition to per-file/free-space checks;
      recover only exact owned journaled inputs rather than Mac PID-only cleanup.
- [x] Test missing Windows-required writer hooks through actual producer entry;
      ordinary Mac fixtures that omit those hooks cannot close Windows integration.

## Completion record

- Implementation files and review: `windows-desktop/src/main/personal/**`, `src/agent/personal.ts`, `src/shared/personal-contracts.ts`; shared worker `consumer_personal.py`, isolated guardian import option and pure diagnostic redaction; consumer inventory now requires the personal engine source.
- Commands/results and evidence: current broad Desktop257 tests/34 files, worker scheduler/admission/DLL95/3 and Python personal/trimmer12 passed. Earlier16/44/59 counts remain historical. See the matrix for exact commands and the separately reported moving peer fixture typecheck errors; prior owned154/17 whole TSC/full lint518/build/2boundaries passed.
- Unrun native/toolchain checks: all real Windows build/runtime/GPU/YouTube/UI acceptance remains W34.
- Remaining limitations and next task: shared native partial/marker deletion receiving review is closed by the final W22 receiver ledger; Root aggregate reconciliation and actual Windows acceptance remain separate. Genuine picker/drop/codec/acquisition/GPU/listening/logon/NTFS acceptance remains W34. [W07's real frontend return](../evidence/W07-pinned-frontend-code-checks-2026-10-10.md) closes the three formerly absent frontend checks with actual declared dependencies in a disposable environment; this is not real inference. The separate W11 waiting-status receiving return does not mint execution permission. A newly separated trimmed account-ingest profile is outside current accepted parity, not silently required. Existing historical counts are not full current Windows acceptance.

Check completed items individually and update [TASKS](../TASKS.md) and
[PROGRESS](../PROGRESS.md). Use `code-complete / Windows pending` only when
the required source work and executable code checks are complete; unavailable
native compilation remains explicitly recorded. Do not claim a release from
fixture or source-only proof.

## Native receiving return — 2026-10-10

[Final W22 receiver/authority/proof matrix](../evidence/W22-final-native-library-cleanup-2026-10-10.md)
closes the shared partial/marker/pair/storage dependency. Live bound-role cleanup
requires actual inference/tool-free Job census; restarted owners require positive
whole-Job retirement. Exact born file, journal, nonce and immutable receipt fences
remain mandatory. Lost ACK/cancel/Scope/metadata errors retain pins/activity and
never authorize name-only deletion. Current affected receiving124/10 passed and
corrected Cloud adoption7/1 passed; Native compilation, real acquisition/picker,
codec, GPU and listening remain unrun W34 gates. Root owns W12 aggregate index.
