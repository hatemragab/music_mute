# Integration and readiness tasks

**Status: not started; plan approval required.** These are future acceptance gates, not completed checks. Read [scope](../scope.md), [contracts](../contracts.md), and the [task index](../README.md).

## V01 — Cross-component contracts, races, and regression coverage

**Depends on:** B01–B06, W01–W02, A01–A04, I01–I04, D01–D03. **Consumes/produces:** shared fixture manifest, API contract fixtures, isolated lifecycle evidence and requirement traceability.

**Create:** `backend/test/media-input-queue.integration.mjs`, `tests/media-input/contracts/README.md`, and contract fixture files needed by existing native/dashboard test harnesses. Create `docs/tasks/media-input-and-queue/evidence/integration.md` only after tests actually run.

**Modify:** relevant existing test harness registration and API docs as needed. Do not build a new production test service. Keep portable contract fixtures small and synthetic; generate media outside tracked source.

- [ ] Run the shared C1–C6 response fixtures through backend producers and Android/iOS/dashboard parsers. Cover unknown fields/version, v1 fallback, all safe errors, nullable evidence, rolling replenishments, and stale revisions. Confirm old consumers do not silently accept expanded physical limits.
- [ ] Run audio file, extracted video soundtrack, and bounded YouTube fixture workflows through preparation → reservation → upload verification → queue → measured validation → processing → output validation → ready. Prove only audio bytes cross the upload boundary and source labels do not change quota rules.
- [ ] Exercise simultaneous same-owner/different-owner reservations, global last-slot contention, grant renewal, upload-complete/expiry race, claim race, underdeclared duration, and verified measured adjustment rejection before AI.
- [ ] Exercise cancel before/after processing, duplicate terminal callbacks, output-completion/cancel race, user deletion/suspension, exception expiry/revocation, worker disconnect/recovery, process-stop uncertainty, and restart during ledger settlement. Assert no leaked/double-refunded quota or released live slot.
- [ ] Exercise unknown/malicious metadata, unsupported default soundtrack, no audio, byte ceilings, decode timeout, huge compressed-duration input, invalid checksum, and excess output. Verify failure happens at the appropriate bounded stage.
- [ ] Simulate continued short arrivals and heavy-account cancellation/retries; verify aging and recent machine consumption prevent unfair reset without guaranteeing fixed wait while workers are unavailable. Measure query plans against representative synthetic queue size.
- [ ] Verify policy edits apply to new reservations, legacy jobs keep old snapshots, old workers cannot take v2 work, and a long-job admission pause does not strand accepted jobs. Test that pending source preparation must recheck definitive admission.
- [ ] Run required subsystem checks once after integrated changes; distinguish environmental/baseline failures from regressions. Fix errors introduced by implementation before handoff.

**Commands:** backend `npm run verify` plus the new isolated integration file and existing processing/dashboard integration scripts; dashboard `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:e2e`, `npm run build`; Android commands from A04; iOS commands from I04; worker `PYTHONPATH=windows-worker python3 -m unittest discover -s windows-worker/tests -v` from root. Use isolated MongoDB/Redis/S3-compatible fixtures according to existing test helpers, never production credentials.

**Acceptance:** evidence identifies each invariant and the exact test proving it. Simulated services do not establish live MongoDB/S3/YouTube/Windows behavior. No live API writes, deployment, or existing user-media processing is required for this task.

## V02 — Authorized device acceptance and release-readiness review

**Depends on:** V01, R01, R02. **Produces:** `docs/tasks/media-input-and-queue/evidence/readiness.md` with implementation status, chosen limits, actual commands, evidence and blockers; no deployment.

**Files / ownership:** own readiness evidence and corrective test/docs changes only. Product regressions discovered here return to their owning task; do not hide them with a test-only workaround.

- [ ] Verify the existing simulator is exactly iPhone 17 Pro / iOS 26.0, UDID `3CC14436-EC3C-4419-A079-C84951E5FA07`. If unavailable, stop device work and record blocked; do not create/download/substitute a runtime.
- [ ] On that simulator, run synthetic Files and Photos video selection, common audio conversions, exact-30-minute acceptance, excess rejection, default-track selection and unusable-default explanation, cancellation, relaunch recovery, low-space/provider-access failures, English/Arabic UI, allowance exhaustion, queue busy, and cleaned-audio-only playback/share.
- [ ] Test background/suspension within actual simulator capabilities and report observed behavior. Separate mocked permission/space/provider conditions from real OS behavior. Do not infer physical iPhone thermals, iCloud availability, or forced-quit execution guarantees.
- [ ] Record Android JVM/lint/build results and explicitly leave Android device/decoder/picker/background evidence unverified under current authorization. Do not silently remove this limitation from release-readiness claims.
- [ ] Attach offline Windows benchmark and stop-evidence results if authorized and available. If absent, leave numerical worker tuning/long-job enablement blocked. Never use production processing to fill the evidence gap.
- [ ] Read back settings in the isolated environment: 1800 seconds inclusive; one unfinished job; 3600 seconds/86400-second allowance; validated 100 MB prepared ceiling; chosen output/source/download/capacity/timeout limits; fair scheduling; exception expiry; accepted-job snapshots. Display exact values and evidence revisions.
- [ ] Review diff for unrelated edits, privacy leaks, generated files, schema compatibility, and unnecessary dependencies. Run `git diff --check`. Report any package/project generated-file change for explicit review rather than casually committing generated artifacts.
- [ ] Present readiness separately for backend, dashboard, Android local checks, iOS simulator, worker unit tests, offline Windows hardware, and live production. Live production remains **not tested/not deployed**. Deployment, publication, forced updates, live worker changes, and new concurrency require a separate user request.

**Acceptance:** honest review package with demonstrated behavior and material limitations. If a required platform/capacity gate is blocked, report partial readiness; do not mark the whole feature complete or enable expanded long-job admission automatically.

## Requirement-to-evidence checklist

| Requirement | Evidence owner |
| --- | --- |
| Common formats and default audible track | R01, A01, I01, V02 |
| 30-minute inclusive duration for every origin | B01, W01, A01/A03, I01/I03, V01 |
| Audio-only upload and cleaned-audio-only output | A01/A02, I01/I02, W01, V01/V02 |
| Local quality-preserving extraction/conversion | R01, A01, I01 |
| Files/Photos, cancellation, OS-bound background/recovery | A02, I02, V02 |
| Temporary storage and source preservation | A02, I02, V01/V02 |
| YouTube live/playlist/unknown-duration and transfer limits | A03, I03, V01 |
| Shared account allowance/one unfinished job | B02, A04, I04, V01 |
| Full-queue admission/lease expiry safety | B03, B05, V01 |
| Fair scheduling and no starvation of eligible long work | B04, R02, V01 |
| Measured validation before AI and trusted stop/usage settlement | B05, W01/W02, V01 |
| Dashboard policy/queue/user exceptions and audit | B06, D01/D02/D03, V01 |
| Old client/worker compatibility and accepted snapshots | B01/B05, W01, V01 |
| Accurate usage/reset/estimate presentation | B06, A04, I04, D02/D03 |
| Evidence-based source limits/capacity/timeouts | R01/R02, D01, V02 |
| No unsupported concurrency, live operation, or deployment | All tasks; V02 final review |
