# Worker fleet execution ledger

Plan: `docs/superpowers/plans/2026-09-13-cross-platform-worker-fleet.md`

Implementation authorized by the active goal, “Now start implement all tasks do your best take your time”. Work is local on `codex/cross-platform-worker-fleet`. No commit, publication, deployment, data reset, or live worker operation is authorized.

## Decisions

- **2026-09-15 — unattended-boot proof is sticky per boot, not recomputed per observation.** The first implementation derived the flag from "last observed boot identity differs from the current one", which made it true exactly once after a reboot and false on the next call — silently dropping readiness for a machine that really had rebooted unattended. It is now recorded as a per-boot proof that survives repeated observation and is cleared when the boot identity changes. **Stated limit:** this proves the service was live across a boot boundary that was actually observed; it does not prove nobody logged in before launchd started the job, and the platform exposes no process start time here to settle that.

- **2026-09-15 — I03 macOS host implemented; child raising deliberately refused.** `platforms/macos.py` supplies the whole `SetupAdapter` surface except `create_child`, which raises `STARTUP_INSTALL_FAILED`. It needs the authenticated launch channel plus a child entry point that performs the nonce handshake; neither exists. A half-built containment path would look like working containment while providing none, and `descendants_stopped` would answer on behalf of a process the adapter never supervised. **I03 is incomplete and the loop cannot complete on macOS.** See `I03-report.md`.

- **2026-09-15 — macOS credentials are files, not keychain items.** A LaunchDaemon starts before any login session, so the login keychain is locked; the system keychain needs an interactive unlock or a partition-list change. Chosen: 0600 records in the root-owned 0700 identity root, atomic replace, refusing a record that is linked or readable beyond its owner.

- **2026-09-15 — a linked secret raises rather than reporting "absent".** `load_secret` returning `FileNotFoundError` for a symlink would invite a caller to write a replacement over an attacker's link.

- **2026-09-15 — unreadable native state is never reported as a negative.** FileVault state that cannot be read maps to `PREBOOT_UNLOCK_REQUIRED` (the only preboot code in the allowlist) rather than to "no encryption"; the accelerator and boot identity follow the same rule. Conservative over-reporting, never under-reporting.

- **2026-09-15 — `KeepAlive` is `{SuccessfulExit: false}`.** Unconditional `KeepAlive` would restart the service immediately after a deliberate operator pause.

- **2026-09-15 — registry `load_hosts` is now self-healing.** It previously returned early for an already-imported module, so a cleared or lost registration was indistinguishable from "no adapter ships" and registration order decided test outcomes. It now re-executes an importable-but-unregistered module.

- **2026-09-15 — I01 closeout gates implemented on `deepseek/cross-platform-worker-fleet`.** User approved the install-source fork: **the entrypoint-verified bootstrap stage is the v1 release**. `installer.install` no longer calls `verifier.resolve`/`downloader.download`/`verify_artifact`/`extract_artifact`; `SharedActivationRuntime.prepare_from_stage` builds the environment from the stage instead. W03/W04 code untouched and still dormant in the tree. This was forced by the existing code, not chosen freely: `package.py` already ships `profiles/<id>.candidate.json` + `.lock.json`, and the signed path could never complete because `verifier.resolve` needs a published TUF release while every F01 profile is `unavailable`, so `approvedProfile` was always null.

- **2026-09-15 — I01 gate ordering ruling.** Stage integrity is verified **before** registration and the approved-profile check **after** it. A tampered stage must make no network call and execute nothing; an intact-but-unqualified stage must still be reportable, per the I01 acceptance scenario ("local and remote events identify the component and safe reason"). Verified by `test_a_tampered_stage_stops_install_before_any_network_step`.

- **2026-09-15 — bootstrap stage integrity is not a signature.** `verify_stage` detects corruption, truncation and partial writes. A writer inside the protected root can rewrite `.bootstrap-sha256` too, so authenticity rests on the recipe digest checked at download time plus the root-owned 0700 stage. The descriptor's release identity is **derived** from payload bytes, never read from the descriptor, so a rewritten descriptor cannot restate its own identity. Stated explicitly in `bootstrap_release.load_descriptor` and in the report; the backend never treats the stage as attestation.

- **2026-09-15 — spool diagnosis and enforcement are separate.** `EventSpool.inspect()` uses a non-strict native-byte count and must never raise, because a linked bootstrap entry is a rejection case the importer already preserves; `EventSpool.budget()` is strict so a link cannot hide retained bytes from the aggregate cap. A pre-existing `test_bootstrap_events` case proved the diagnostic read must not throw.

- **2026-09-15 — native retry codes.** `REPORTING_UNAVAILABLE` is safe to send as an event code (present in both the Python importer and `backend/src/worker-events/worker-event-policy.ts`); `UNSAFE_STATE_PATH` is in **neither** and stays local, mapping to `INSTALLATION_FAILED`. Sending the latter would have had the event rejected.

- **2026-09-15 — native `Retry-After` record is validated at top level.** `fail` inside a command substitution only ends the subshell, so a corrupt `state/setup/retry-after.json` discovered from inside `request()` would have let the run continue to a real request. Validation moved to top level; `retry_blocked` is now a pure predicate.

- I01 shared source approved after fix round 2: independent reviewer passed 87 focused tests and confirmed revision-bound processing hints, recovery after definitive verification rejection, and immutable uncertain retries. The implementer's combined suite passed 154 tests. `I01-shared-review.md` records both corrections and remaining native limits. Overall I01 stays in progress while the native bootstrap follow-up closes persisted throttling and aggregate spool accounting; this shared checkpoint does not establish a working installed service.

- I01 root actual ControlClient/compiled backend verification passed: an attempt before runningAt is rejected without advancing running, a new attempt is accepted, and a lost verified acknowledgement retries with identical payload hash in a new Python process. Backend build and scoped lint/format passed; see `I01-processing-verification.md`. This supports shared fix round 2 after review found stale rejected hints could poison pending status; automatic coordinator handling is separately under correction. Native bootstrap follow-up now owns persisted throttling and combined spool bounds. Windows implementation handoff is prepared in `I02-execution-brief.md` without starting or authorizing a native installation.

- I01 remains in progress. Shared implementation initially passed 141 focused tests; independent review found transient-hold recovery, repeated committed-update restart and stale-owner mailbox routing issues. Shared fix round 1 is active; see `I01-shared-review.md`. Root native bootstrap source and importer are separately reported in `I01-bootstrap-report.md`; initial four review findings are addressed in source, with a missing-identity guard regression being verified. Native Retry-After persistence, aggregate spool accounting and Windows/native proof remain explicit open gates. The permanent qualification maintenance route now passes an isolated compiled HTTP regression; see `I01-maintenance-qualification.md`. No task completion, publication or production readiness is claimed.

- W04 locally reviewed after fix round 1/5: original signed-target alias finding addressed and no new important issue in scoped re-review. Defensive copies also protect the stop/reconcile callback boundary. Reviewer independently passed 14 activation and 10 recovery tests; prior broader local/W03/lifecycle validation and root actual control integration remain separately recorded. I01 now starts with explicit concrete shared ActivationRuntime and native bootstrap wiring obligations; local W04 approval does not establish an installed/boot-qualified worker.

- W04 fix round 1/5 active after independent review: runtime.prepare could mutate the aliased signed target, causing a corrupted durable transaction and later policy rejection. Reviewer passed 77 scoped tests and separately reproduced the missing immutability guard. Fix must retain the original signed descriptor, isolate callback inputs and reject mismatched returned environments. See `W04-review.md`. The concrete ActivationRuntime wiring and processing-disabled permanent qualification route are recorded I01 integration obligations; W04 remains unaccepted pending scoped re-review.

- W04 root integration found and repaired missing Retry-After on the real update quota response: controller now reuses AuthRateLimitException, so the existing filter emits the delay consumed by ControlClient. Red wire regression reproduced zero delay; green update-client and rollout integrations passed (two scenarios), with backend build/typecheck and scoped lint. Include the controller/helper/test and `W04-control-client-integration.md` in W04 review.

- W04 resumed on 2026-09-15 after the user's explicit continue. The prior implementation agent was no longer present; a fresh agent continues the existing partial source without resetting it. Root recreated the missing private launcher test environment from the exact checked-in lock, rebuilt the backend, and reran the Python update-client integration: one passed, zero failures/skips. See `W04-control-client-integration.md`. W04 remains incomplete until lifecycle/fault tests and independent review pass.

- W03 locally reviewed after fix round 1/5: both P2 findings addressed, no open important finding in the bounded re-review. Reviewer independently passed 18 spool tests and direct SQLite clock/backoff/immutable-retry/known-age reproductions. Implementer also reran the real isolated backend integration successfully. Current schema fails closed on nonempty incompatible spools without migration or deletion. Exact historical age across every reboot remains unproven without native boot identity. W04 activation/rollback now starts from its prepared handoff; no native profile is promoted by these local results.

- W03 fix round 1/5 is active after independent review reproduced two P2 issues: queued timestamps remain future-dated after the machine clock corrects before first upload, and clock acquisition bypasses persisted backoff/Retry-After. The implementer owns bounded spool/test repairs; uncertain payload identity and genuine 30-day expiry remain required. Independent review passed 59 existing focused tests but requested changes; W03 is not accepted yet. See `W03-review.md`.

- W03 source is held for independent review. Implementer reports 25 update, 12 spool, 21 launcher and one packaging test passing in the exact launcher environment. Root's real isolated Python-spool/backend integration also passed lost-response, process-restart, clock-skew and setup-to-permanent credential retry with one immutable backend event and exact 30-day expiry. Scoped integration formatting/lint passed. See `W03-report.md` and `W03-spool-backend-integration.md`; native installation/boot and activation remain downstream gates.

- B06 worker polling follow-up independently approved: removed the old-server HTTP 400 retry and negotiated polling state. Nine focused tests passed independently; configured zero-wait polling remains bounded. See `B06-worker-polling-followup.md` and `B06-worker-polling-review.md`.
- Ruling from the remaining media-policy audit: versioned media admission is a separate existing job contract spanning creation DTOs, frozen job snapshots, queue limits, retries and worker output validation; it is not the removed legacy/z440 worker backend. Do not erase that product behavior merely because old-job comments use the word legacy. The user permits breaking changes but did not request replacement of the media-admission feature in this fleet task. No new old-client adapter is introduced. Preserve the single separator's numeric behavior as well. Cost: media versions remain explicitly supported until a separate product-contract change; the fleet still has no implicit z440 identity or old-server request negotiation.

- Ruling: W03 signed target custom metadata is `custom.musicmuteRelease = complete ReleaseTarget`, including releaseId. Existing B04 publication receipts already sign that UUID and constrain artifact paths by it; omitting it would weaken identity binding. H01 obtains the release ID before metadata signing. Cost: packaging must coordinate identity before publication rather than retrofitting a backend ID.
- W03 integration adds response-only `serverTime` to installation registration/status and every permanent update-policy decision. This supplies a clock source before first event transmission without a new endpoint, persistence, or migration. Worker clock correction must preserve uncertain/accepted payload identity; it is not authority to rewrite stored event history.

- W02 locally reviewed after fix round 1: both P1 findings resolved. Independent re-review passed 15 focused profile/native-media tests, checked the exact 9,435-entry runtime inventory and both native binary identities, and accepted the bounded W02 implementation. Agent full suite reported 195 tests with eight Windows skips; root real GPU worker-media diagnostic passed without PATH tools. These checks do not qualify any native profile. W03 implementation now starts from `W03-execution-brief.md`; signed-update trust and spool behavior remain unimplemented until its own evidence/review.

- Follow-up to B06 before final fleet validation: current `Worker._claim` still retries a rejected waitSeconds field for old servers, and media-limit defaults explicitly preserve old-job semantics. Audit these remaining client compatibility branches against the user's clean breaking-contract requirement after W02 source handback. Do not treat the earlier backend B06 review as proof that every worker compatibility path is gone. This is outside the two scoped W02 review findings, not a reason to omit it from the full goal.

- W02 independent full review requires fix round 1 for two P1 findings: bind interpreter links and detect extra executable/importable runtime files; remove system-PATH media probing from actual worker jobs. The original implementer is active on both. Root independently verified a Jellyfin macOS arm64 ffprobe candidate, including archive/member hashes and successful JSON probing with an empty PATH; see `W02-review.md` and `W02-ffprobe-asset.md`. W02 remains unreviewed until scoped re-review approves the fixes. No profile is promoted.

- Ruling: W02 uses a dedicated authenticated `/worker/claim/recovery` endpoint for uncertain ownership after a lost response when local runtime is invalid. It returns owned work or an immediate empty response before all fresh queue selection; normal claims remain gated. Cleanup availability while processing is disabled does not waive credential/installation fencing. Cost: a new protocol route and explicit client branch instead of an unsafe admission bypass. Backend build/lint/typecheck, five real-controller HTTP tests plus six auth-isolation tests, and an isolated coordinator integration passed, including missing-runtime rejection of fresh work and recovery of existing ownership. `W02-recovery-review.md` independently approves the scoped path; its additional run_once regression recommendation was sent to the W02 implementer. Full W02 review remains pending.

- Development is a clean breaking contract: no migrations, backfills, compatibility bridges, or implicit z440 ownership. Existing physical machines reinstall and re-pair. Obsolete migration entry points are deleted in B06.
- Preserve all unrelated Android edits, including changes arriving from other work. The current checkout is used as the user requested; a dedicated branch separates this work from main.
- Keep implementation changes uncommitted; review working files and focused diffs because automatic commits in execution skills conflict with user instructions.
- Native hardware evidence is a release gate, not a prerequisite to writing and testing the other components. Missing evidence must remain explicit and fail closed.
- B01 introduces runtime persistence and the readiness boundary. B02 supplies pairing bindings; B05 supplies approved recipe and claim gates. Runtime self-reports alone must never grant admission.
- Execute B04/B05 claim policy before completing B02 pairing exposure. B01's runtime/readiness receipt remains fail closed pending qualification; the existing coordinator does not consume that new state until B05. Do not deploy this intermediate checkout or add a second temporary gate.
- Ruling: the installation qualification request includes runtime, qualificationReport and serviceBindingSha256. The report-only route sketch omitted identities required by B05; making them explicit prevents guessed service binding. This changes the planned I01 request body before implementation and requires matching fixture updates.
- Ruling: add permanent-auth `POST /worker/qualification` in B02 for later updates and repairs after the seven-day setup capability expires. The original route list could not create another report for the stable installation after expiry. The new route reuses scoped immutable storage and readiness authority; it never renews setup credentials or rebinds identity. This adds one authenticated endpoint and its quota/ownership tests, avoiding an unusable update lifecycle.
- Ruling: reserve new setup and permanent credential digests in one unique namespace. Checking only a setup session's own digest leaves deliberate cross-session reuse able to violate token-scope separation. Atomic shared reservations must cover both creation orders and races, including credential rotation while supported. This adds a small persistent security model and test coverage; it does not authorize a migration or backfill of old development records.
- Credential reservation retention: retain the minimal digest/scope/owner reservation after capability expiry and credential rotation so a historical secret cannot cross authentication scopes later. These reservations are operational security metadata, not detailed logs or active setup sessions. The cost is cumulative small-record storage, bounded in ingestion rate by public admission budgets; B03 must still expire detailed events and provisional session metadata according to their own retention rules.
- Ruling: B03 event ownership is the stable installation ID for both setup and permanent authentication. This preserves `(installationId, eventId)` deduplication when a queued event crosses pairing or setup-token expiry, without rewriting old event identity. Admin worker timelines resolve the existing installation binding. The cost is making this canonical owner explicit in B03/W03 fixtures and rejecting missing installation bindings rather than inventing an owner.
- Ruling: W01 includes the narrow backend identity-response addition for installationId. The current protocol-3 response omits the binding that the new worker must verify before claiming. Resolve it against the authenticated worker ID/current digest, reject a missing binding, and test the response. This adds a small backend change to the extraction scope; no old-client fallback or unrelated update-capability change is needed.
- Ruling: B06 removes the normal backend manual raw-key creation endpoint, keeping audited idle rotation. B02 pairing is the final enrollment authority; waiting for D01 is unnecessary in this explicitly breaking development checkout. D01 removes the old form before integrated deployment. The cost is a temporarily unavailable old UI action and converting temporary manual-create tests to rejection assertions, with no compatibility endpoint retained.

## Progress

| Task | State | Evidence |
| --- | --- | --- |
| F01 | In progress; local admission source reviewed | Hardware profiles remain unqualified; native artifact/GPU/boot evidence is open. |
| B01–B06 | Locally reviewed | Individual reports/reviews and current task index record backend validation; B06 legacy removal and polling follow-up are reviewed. |
| W01–W04 | Locally reviewed | Individual reports/reviews; W04 scoped correction and actual control-client integration passed. Native installation and boot are separate gates. |
| I01 | In progress | Shared review corrections and native reporting follow-up; `I01-report.md`, `I01-shared-review.md`, `I01-bootstrap-report.md`, `I01-bootstrap-review.md`. |
| I02–I04, D01–D03, H01–H02, V01–V03 | Not started | Native Windows handoff is prepared; no native service, dashboard, distribution or production completion proof. |

## Baseline

`cd backend && npm test -- src/worker/worker-registry.service.spec.ts src/worker/dto/worker-claim.dto.spec.ts`: 2 files, 15 tests passed. Existing Mongoose validateSync deprecation warnings. This is focused baseline evidence, not complete application validation.

`cd backend && npm test -- src/worker/`: 10 files, 63 tests passed. `npm run typecheck`: passed.

`PYTHONPATH=windows-worker python3 -m unittest discover -s windows-worker/tests -q`: 161 tests ran, OK with 23 skipped. The skips and non-Windows host mean this is not Windows service or GPU proof.

`cd dashboard && npm run typecheck`: passed. `npm test -- src/features/workers` found no matching test files and exited 1; this is missing baseline coverage, not a passing suite. D01–D03 must introduce the planned worker UI behavior tests.

## Cross-task boundaries checked

| Boundary                  | Resolution                                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| F01 → W01/W02/B05/H01/V01 | Candidate metadata and real qualification evidence are distinct; packaging cannot mark an untested candidate qualified.   |
| B01 → B02/B03/B04/B05/D03 | New protocol-v3 fixture is authoritative; runtime is separate from desired registration and assignment ownership.         |
| B02 → B03/I01/D01         | Installation capability reports before pairing; permanent credentials are separately bound locally before approval.       |
| B04 → W03/B05/D02/H02     | Explicit selected targets and stable-new-install selection are separate policies; artifacts must be signed and immutable. |
| B05 → B06/W04/V01         | Claim gates use the same lifecycle fence; updates and readiness cannot re-enable drained/revoked machines.                |
| W01 → B06/W02/W03/I01     | Move shared modules once; no legacy import adapter or duplicate Windows engine.                                           |
| W02/W03 → W04/I01/H01     | GPU lock/model identity travels with a complete release; independent launcher survives failed worker environments.        |
| W04/I01 → I02/I03/I04     | Native boot services and descendant shutdown provide the shared activation contract.                                      |
| I02/I03/I04 → H01/V01     | Installer unit tests do not substitute for boot/service/native GPU proof.                                                 |
| H01 → H02/V01             | Candidate packaging precedes hardware qualification; only qualified artifacts can be stable.                              |
| B06/D02/D03/H02/W04 → V02 | Fault checks must exercise integrated ownership, update and log behavior.                                                 |
| V01/V02/H02 → V03         | Prepare reviewable deployment evidence; ask for deployment authorization only after preparation is complete.              |

## Review log

- F01 initial focused suite: 10 tests passed (implementer and reviewer). Reviewer demonstrated an unsafe synthetic qualified recipe being admitted. Findings cover immutable recipe validation, contradictory evidence, offline versus wire report separation, and omitted ARM64 candidates. Fix round 1 assigned to the original implementer; F01 is not complete.
- F01 fix round 1 passed 16 tests but re-review found malformed-input crashes, absent absolute numeric bounds, and an insufficiently explicit runtime approval boundary. Fix round 2 addressed these with 18 passing tests and is awaiting scoped re-review.
- F01 fix round 2 resolved those findings; round 3 tightened vendor/provider values, exact Boolean flags and integer schema version. The final scoped re-review passed all 20 tests, compilation, JSON and targeted probes, with no remaining critical/important finding. This completes the local admission increment, not the entire F01 hardware/artifact task.
- Root independently streamed and hashed the complete upstream Kim Vocal 2 asset; see `model-artifact.md`. A reproducible integer-only synthetic smoke fixture is described in `synthetic-fixture.md`. Neither observation supplies native qualification or model redistribution approval.

- B04 initial implementation passed focused signature and compiled native HTTP/Redis/Mongo tests. Independent review reproduced two defects: runtime/model upgrades were blocked by target-equality checks before installation, and fresh verified workers were classified offline using update-stage age. Fix round 1 is assigned to b04_rollouts.
- Ruling: add signed source-transition tuples and explicit rollback permission with target OS/architecture. Selection/activation validate the old source; running/verification validate the new target. Current fallback policy and state-reader limits remain mandatory. This changes receipt producers/consumers before first publication, at the cost of coordinated local contract edits; it adds no old-client decoder.
- B04 fix round 1 passed independent re-review: four signature tests and expanded real Mongo/Redis/Nest integration, covering signed recipe transitions/reverse fallback, truthful observed builds, tampering/ambiguity/platform rejection, and liveness separated from update-stage age. No remaining critical/important scoped finding. B05 is now active and will finish fresh-claim enforcement.
- B05 implementation is under independent review. The implementer reports 52 passing focused tests and passing isolated admission, rollout, runtime and fairness integrations. One broad processing run had 14 passes and seven old worker fixture failures, listed exactly in B05-report.md for B06 conversion. No legacy bypass was added. B02 and B06 execution briefs are prepared; neither task is implemented yet.
- B05 initial review reproduced two important defects despite passing baseline tests: an acknowledged activating state still permitted a fresh claim, and unowned-job availability ignored approved media ceilings. Fix round 1 is assigned to the original implementer. Both defects are in current scope; neither is deferred to native installers or solved by compatibility code.
- B05 fix round 1 passed scoped independent re-review: 59 focused tests, build and compiled readiness integration, including actual activation-before-delayed-claim ordering, duration/byte boundaries, measured-duration overrides, busy capacity and owned visibility. Both findings are resolved; no important scoped regression found. B02 implementation is now assigned to b02_pairing. Overall task-pack completion remains unproven, with native qualification and fleet-only broad fixtures still outstanding.

## Legacy deletion inventory

- Ruling: B03 deduplication/conflicting-ID history ends when retained event records
  are physically deleted; no permanent per-event tombstones. New admission requires
  server receipt minus 30 days < occurredAt <= server receipt, so an identical old
  payload cannot reappear as fresh history after TTL. An expired retained duplicate
  may acknowledge without renewal. A changed payload reusing a deleted ID cannot be
  compared to deleted content. Safe future-clock errors and server UTC support
  W03/I01 timestamp correction. This bounds metadata retention at the cost of
  bounded conflict detection and a required client clock-correction path.

W02's requested independent artifact research is recorded in
`portable-runtime-assets.md`: downloaded/verified portable Python archive and
interpreter match, nine upstream symlink aliases, exact FFmpeg wheel/member
identities and actual GPL-enabled executable inspection, plus current FFmpeg9.0.1
source/detached-signature/public-key hashes. Isolated GPG verification returned
GOODSIG/VALIDSIG matching the official published fingerprint; no personal keyring
was changed. The old FFmpeg7.1 wheel remains a local test candidate only; no
current native binary, codec qualification or release publication was claimed.

- Ruling: W02 may replace the broad audio-separator runtime dependency with a
  Kim Vocal 2-specific path inside the sole shared separator, avoiding unrelated
  Torch/diffq model-family dependencies that prevent the binary-only Mac solve.
  Preserve pinned upstream MDX preprocessing/postprocessing and required output
  semantics, record source/license attribution, and prove comparison on
  deterministic audio/tensor fixtures; finite output alone is insufficient. This
  narrows package dependencies, not the requested Kim Vocal 2 behavior, at the cost
  of owning DSP parity and maintaining that model-specific implementation. An
  isolated numerical reference runner is validation only; product CPU-only
  inference/admission remains unsupported. Service/boot/capacity gates remain open.

B03 fix round 1 passed scoped independent re-review: both processing-disabled
diagnostics and all 14 required setup/GPU code findings are addressed, with no
remaining actionable regression. Final focused evidence is 41 unit, 15 event
integration and 83 HTTP tests plus build/static checks. W02 is now assigned to
`w02_gpu_runtime` for real GPU runtime preparation/selection/qualification and
narrow provider-contract alignment, using the new Mac session evidence and full
separator dependency-solve blocker. No profile is promoted by that smoke evidence.

The initial B03 review found two actionable issues: permanent event reporting was blocked by
the global processing toggle, and the safe code allowlist omits required shared
setup/GPU reasons. Fix round 1 is assigned to the original implementer, covering
authenticated reporting while disabled and exact structured code readback without
loosening privacy or revocation checks. Other reviewed boundaries had no findings.

The initial B03 review handoff recorded:
The report records
889 unit tests before the final query ordering correction, 166 final E2E tests and
14 compiled event/dashboard integrations; the ordering correction has focused
native/E2E/build coverage. Review explicitly includes whether permanent diagnostics
must bypass the global audio-processing availability toggle while preserving
credential/installation authorization. No approval or whole-fleet completion is
claimed yet.

Root gathered isolated local Mac model-session evidence while B03 implementation
continued. The pinned Kim Vocal 2 bytes passed the official full ONNX checker.
With batch_size fixed to one through a session override, the M4 Pro run produced
finite synthetic output, one CoreML profiling event and no CPU-provider execution;
CoreML's compute plan assigned all 178 operations to the GPU. Details, exact
versions, initial probe correction and limitations are in `macos-coreml-smoke.md`.
This does not promote a candidate or prove full audio/service/boot qualification.

- Ruling: unchanged progress admission uses server receipt time, while exact
  accepted retries bypass re-throttling. W03 coalesces unchanged progress and
  respects delay responses without discarding terminal/failure records. Reporting
  summary uses the highest sequence within its reported operation, so late older
  progress cannot replace its terminal outcome; it is separate from authoritative
  current worker/installation state. Existing workers.read permissions govern
  admin event access, including viewer/support roles already granted that right.
  This costs explicit spool batching and reporting-scope semantics, rather than
  trusting client clocks or inventing a new administration role.

B06 independent review approved its local scope with no actionable findings. The
review checked explicit ownership/authentication, removal paths, retained races,
integrity-only audit and existing validation evidence; it did not repeat broad
suites. B03 structured setup/runtime events is now assigned to `b03_worker_events`
with the canonical installation owner, exact retention, HTTP parser and weighted
quota requirements in its execution brief. Full native/dashboard/distribution
requirements remain open; this approval is not fleet completion or deployment.

The preceding B06 review handoff recorded:
Its report records
873 unit tests, 164 E2E tests, 21 processing integrations and focused final
lifecycle/audit checks. The final empty-fleet integrity regression passed after
removing the obsolete nonempty-fleet gate. No migration executable/package or
compiled remnants remain. The full backend verification preceded only the final
audit gate and fixture updates; those have focused follow-up verification. B06
remains unapproved pending independent review; B03 is prepared but not started.

Root B06 integration checks: converted runtime/readiness/rollout fixtures use
explicit approved installation ownership (three compiled integrations passed).
The full dashboard fixture now pairs through the actual installation services.
It exposed worker feature modules registering the admin guard before the auth
guard; restoring authentication-first module order fixed the failure without
weakening the anonymous 401 expectation. The updated independent route inventory
passed 75 authorization tests and the compiled dashboard workflow passed with 36
requests and 13 audit events. Build passed. All seven root-owned backend paths
were handed back to the B06 implementer for final validation and review.

Root checked active Markdown/scripts/workflows outside backend while B06 owns
backend conversion. The only actionable executable match was the dashboard E2E
isolated backend's obsolete auth-mode setting; it was removed from
`dashboard/e2e/helpers/isolated-backend.mjs`, and `node --check` passed. This is
syntax/reference evidence, not a dashboard E2E run. Dated validation and execution
records retain their historical commands; no real environment file was read.

W01 independent review accepted the scoped extraction with no critical or
important finding. The reviewer reran the shared/qualification/backend suites,
archive checks and additional launcher failure/stale-ownership probes. B06 is now
active with ownership of direct legacy removal and conversion of the existing
lifecycle tests to new paired/qualified fixtures. Earlier review-request notes
below remain historical evidence and do not imply native qualification.

W01 is under independent review. Final reported proof: 167 shared tests pass with
14 explicit skips (8 Windows-native, 6 NumPy/soundfile), separate F01 20 tests pass,
source-archive extraction passes 21 boundary plus 20 qualification tests, and the
backend identity addition passes 12 focused tests plus one isolated HTTP
integration. W01-report.md records all 15 retired checks and 21 replacements.
The normal processing entrypoint still refuses operation until downstream native
adapter/child integration is supplied; no native hardware or boot proof is claimed.

Cross-component gap queued for W02: F01 inventories MIGraphX, OpenVINO and ArmNN,
but the current backend signed provider type/verifier accepts only CUDA, DirectML
and CoreML. `W02-execution-brief.md` requires alignment of the exact provider
vocabulary and GPU-only configuration/evidence checks; it does not promote any
unavailable recipe. This remains an open full-scope integration requirement.

B02 independent review accepted the bounded local implementation with no critical
or important finding. The reviewer reran 65 focused tests, build and both compiled
integrations, plus an isolated real-Redis concurrency/refund/no-partial-charge
probe. W01 shared core extraction is now active; B06 follows it. The earlier B02
review-request note below remains historical evidence of the fixture limitations.

B02 is under independent review. Its final scoped run passed 65 tests and the
compiled installation/readiness integrations. The earlier broad unit run passed
868 tests before the final credential reservation change; it is not final broad
proof. Targeted admin-worker integration exposed ten additional nested old
qualification fixture failures (plus the parent failure), detailed in
`B02-report.md`. B06 must convert these alongside the seven processing fixtures,
preserving real lifecycle/race assertions rather than adding a bypass.

The user's development-only clarification remains binding throughout execution:
no migrations, backfills, legacy decoders or installation compatibility adapters.
The B02 handoff is prepared in `B02-execution-brief.md`; it uses fresh installation
pairing and B05 qualification authority. Its Markdown formatting check passed.

The existing mode branches span worker registry/auth/routes/terminal/claim wait, jobs query, admin overview and admin worker management. Migration entry points are `backend/src/operations/worker-fleet-migrate.ts` and `backend/src/worker/worker-fleet-migration.ts`, associated scripts/specs, and migration-only integration tests. B06 must audit uses of `WORKER_ID` carefully: `WORKER_ID_PATTERN` remains useful identity validation and must not be deleted by substring replacement.
