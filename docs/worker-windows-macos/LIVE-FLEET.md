# Live Windows/macOS fleet activation

Started 2026-09-29 after explicit authorization to use SSH and the dashboard,
connect both machines to the actual backend, test processing and fix errors.
This extends the earlier synthetic/native acceptance; it is not yet complete.

## Current findings

- Dashboard `https://dashboard.music-mute.com/workers` initially listed only
  Hatem Mac, machine `d4874cbf-1167-4af8-ae15-c029b4acdd65`, offline.
- A real job `6abbb13919d577219e8af586` was queued. No job was deleted or cancelled.
- Windows SSH at `.124` works; service initially Stopped/Manual.
- A 15-minute Windows invitation was prepared and owner identity reverified.
  No invitation has been created: computer-use confirmation for new sensitive
  access is pending. Do not bypass that pending approval through another tool.
- Mac's existing credential successfully opened a live session and read active
  backend policy, but startup failed with WORKER_CONFLICT before claims.
- Current second local slot ID differed from the original paired config. Backend
  dashboard still showed the original two GPU slots, with no active attempt.
  `configureWorkerCapacity` and updater downgrade remove slot 1; later capacity
  expansion generates a new UUID, conflicting with the backend's stable slot.
- Stopped the failed Mac service (forced only after zero attempts/no claims and
  failed runtime could not acknowledge drain). Restored slot 1 identity from
  `state/transactions/limits-20260929/runtime.json`, preserving the previous
  current configuration in private `state/live-fleet-before-identity-repair.json`.
  Installed `loadRuntimeConfig` passed before atomic replacement. No credential,
  backend permission or capacity receipt was changed. Resume intent then start
  with readiness observation initiated; live success remains to be verified.

## Required completion gates

- Preserve stable worker identities across one/two-worker changes and release
  requalification in source, with meaningful regression coverage and native
  package validation. The one-time local repair is not the permanent fix.
- After pending confirmation, enroll the Windows machine through the real
  dashboard invitation and supported CLI flow; retain private credentials.
- Verify both machines online/eligible with two qualified slots, correct native
  service policies and live processing through the same backend/storage.
- Verify actual successful job outputs and backend/worker stage timings, including
  at least one real completed job on each platform. Record precise evidence and
  distinguish concurrent fleet presence from proven simultaneous processing.
- Preserve unrelated repository changes; no commits or publication requested.

## Live Mac result and identity fix

After restoring the original second slot ID and resetting the permanent startup
failure through `restart --force`, the installed Mac became healthy with both
slots ready and backend claims allowed. Job `6abbb13919d577219e8af586`, attempt
`e0974241-17da-4004-a41a-97c4040b81ac`, completed at
`2026-09-29T13:40:18.332Z`. The dashboard independently showed Ready/Not queued.
Measured music removal: 15.01 s; trim: 718 ms; encoding: 3.2 s; result upload:
11.55 s; finalization: 1.82 s. Total 62m17s included 61m12s worker queue.
This is real backend/storage completion. Screenshot:
`/tmp/musicmute-mac-live-job.png`. A browser download observation timed out;
output-file validation remains unverified. Inspect before retrying the action.

Source now retains inactive slots and reuses their worker IDs on capacity
expansion. Both native update plans preserve removed identities. Runtime parsing
validates inactive records and uniqueness but returns only active slots to the
supervisor. Expired evidence still permits reduction to one. Regression tests
cover round-trip identity retention, malformed duplicate rejection and updater
preservation. New native packaging/validation remains due; installed runtimes
have not been patched in place. Windows enrollment confirmation remains pending.

## Slot-identity regression and package evidence

- macOS full suite: `/tmp/musicmute-slot-identities-macos-full.json`, 531 passed,
  17 skipped, zero failures. Final focused suite: 47 passed. Typecheck/lint passed.
- Eight explicitly selected source/test files were transferred to the existing
  `C:\MusicMuteBuild\source-current`; no new checkout was created.
- Native Windows focused suite: `C:\MusicMuteBuild\slot-identities-native-focused.json`,
  32 passed, zero failures/skips. Native typecheck/build passed.
- Mac candidate `0.1.0-native.20260929.3` built with 20,204 manifest entries.
  Archive `/tmp/musicmute-macos-native-JbpeVb/runtime-3.tar.gz`, 330,920,759 bytes,
  SHA-256 `65844888f3196e3b02d0629d635e916fdc80e36f461101101061c9ef60427221`.
  It is not installed or freshly qualified yet.
- Windows direct Node packaging failed because pnpm's entry-point environment
  was missing; the builder removed its incomplete staging tree. The supported
  `pnpm run package:windows` retry is running for candidate `.15` (handle 68206).
- Full native Windows regression is running (handle 18211), with the real WinSW
  fixture enabled; result target `C:\MusicMuteBuild\slot-identities-native-full.json`.
  Poll these handles rather than restarting work from observation timeouts.

## Native packages and update validation in progress

- Native Windows full suite passed: 404 tests, 144 skipped, zero failures;
  `C:\MusicMuteBuild\slot-identities-native-full.json`.
- Windows candidate `.15` package passed: 18,745 entries, ZIP 354,468,604 bytes,
  SHA-256 `fd79a1afd00c66f45d88064b1358b19f0af4a6eaacbef11f297a07ccfce45d3b`.
  The corrected pnpm packaging handle 68206 finished successfully.
- Mac drained/stopped cleanly. Signed update to native `.3` is running via
  `/tmp/musicmute-mac-update-native-3.mjs` (handle 25594), backup
  `state/native-update-X5ID1N`. Temporary fixture settings are guarded/restored;
  successful update should retain original backend/credential, one active slot
  and the original second slot in `inactiveSlots` pending requalification.
- Windows signed update to `.15` is running through the installed manager with
  `/tmp/musicmute-native-update-acceptance-15.mjs` (remote handle 96339).
  It checks the retained inactive second slot in addition to prior update gates.
- Prepared `/tmp/musicmute-mac-capacity-native-3.mjs` requalifies and tests actual
  installed two-to-one-to-two round-trip identity. It has not been run yet.
- Current Mac service is intentionally stopped for this native update; do not
  describe its earlier successful job as proof it stayed online during maintenance.

## Native update completion and live restoration

- Mac `.3` signed update passed. Installed two-worker qualification and the
  two-to-one-to-two identity round trip passed, retaining the original second
  slot and credential. Evidence: private `state/native-capacity-llh1xz/result.json`.
- Mac resume/start completed with readiness `ready`, no blockers, and claims
  allowed. A subsequent status confirmed installed `.3`, both original slots,
  healthy local runtime and an available authenticated backend.
- Real job `6abbc37219d577219e8af58a`, attempt
  `61925b62-9bdc-413e-922f-f89915653c8b`, then completed on `.3`.
  Dashboard showed Ready/Not queued at 17:03 Cairo on September 29. Worker
  separation was 13.02 s, upload 19.51 s, finalization 1.75 s; measured audio
  was 3m36s. Download/playback verification remains pending.
- Windows `.15` signed installed update passed: read-only check, sequence commit,
  preserved SCM policy and retained inactive slot. Temporary trust/sequence were
  removed; `C:\MusicMuteBuild\update-native-result-15.json` records success.
- User supplied a live enrollment invitation and explicitly authorized using it
  for Windows. The earlier approval blocker is resolved. The secret is stored
  only in a protected remote enrollment directory, not this ledger.
- Native Stage qualification followed by supported CLI enrollment is running
  under session 13141. Poll that session; do not start another installer.
  Output directory: `C:\MusicMuteBuild\live-enrollment-15`. The new pairing still
  needs installation, capacity qualification and real-job validation.

## Live Windows enrollment accepted

- Native Stage qualification passed. The initial enrollment request returned
  `NETWORK_UNAVAILABLE`; a bounded public-origin connectivity check succeeded.
  Retrying the same supported CLI command and private state completed exchange,
  qualification upload/report and activation, without a second invitation.
- Activated machine: `8bd8181d-eeb0-473d-91ee-aff313103349`, label
  `Hatem Z440 Windows`. Credentials remain in the protected enrollment directory.
- Installed manager `Repair -LeaveStopped` with the live pairing is running in
  session 93834. Prepared next capacity check is
  `C:\MusicMuteBuild\musicmute-windows-capacity-live-15.ps1`; it tests the live
  machine's new slot identities through two-to-one-to-two transitions.
- Mac result downloaded through Chrome's Save dialog to
  `~/Downloads/vocals-6abbc37219d577219e8af58a.mp3`: 4,328,533 bytes,
  MP3 stereo/44.1 kHz, duration 216.35 s. `ffprobe` inspection and full
  `ffmpeg -v error ... -f null -` decode passed. Browser playback advanced to
  31 seconds. The earlier download timeouts were pending native Save dialogs.
  Job screenshot: `/tmp/musicmute-mac-live-job-native3.png`.

## Installed live pairing and capacity run

- Session 93834 completed successfully: `.15` Repair qualification passed,
  installed the live machine identity/backend, and left the service stopped.
- Capacity acceptance is running in session 2890. The harness syntax passed
  native PowerShell parsing. Await its result before starting operational work.
- Prepared `/tmp/musicmute-windows-live-test.wav`, a newly generated 60-second
  speech-and-tone fixture (10,584,078 bytes). It is selected in the live web app,
  with processing rights acknowledged, but not submitted. Chrome tab 1197879461
  is retained for this upload; dashboard validation tab is 1197879448.
- To ensure Windows processes the test, temporarily pause Mac claims only after
  Windows becomes healthy, submit the prepared file, then resume Mac promptly
  after the Windows claim. Verify completion, output download/decode and both
  machines' final readiness. No existing user job should be cancelled.

## Windows capacity passed; live backend revision defect

- Capacity session 2890 passed on `.15`: standard recipe throughput 1.5298x,
  trim recipe 1.5037x, decoded quality comparisons PASS, stable slot identities
  through two-to-one-to-two, credential preserved. Reports:
  `C:\MusicMuteBuild\capacity-live-15.json` and
  `C:\MusicMuteBuild\capacity-live-15-acceptance.json`.
- Live slots: `e37fb847-c5e9-4e93-85f3-e7e80a78a5cc` and
  `b378451b-c458-4a3e-9f09-c2618ccdee2c`.
- Startup reached model-ready for both slots but failed with
  `Worker configuration revisions are inconsistent`. Backend enrollment defaults
  new machines to policy/desired revision zero; live fleet policy is revision 1.
  Startup reconciliation only covers machines present when the API starts.
- Windows was force-stopped only after confirming zero active attempts. Session
  5635 returned stop success. Do not call this live-ready or submit the test yet.
- Old SSH master stopped returning output, and startup handle 51781 ended 255.
  Reauthenticated pinned-host SSH works through
  `/tmp/musicmute-z440-ssh.Ls4YeS/control-live`; helper `remote-live.py`.
  This connection failure did not justify restarting a running benchmark.
- Local backend fix: configuration sync reconciles stale desired/policy revisions
  with machine revision and session fences; applied revision is left for the
  worker to acknowledge. Newer revisions are never downgraded. Existing wire
  fields/routes/auth remain compatible; OpenAPI describes reconciliation.
- Verification: focused control tests 16 passed; full `pnpm run verify` passed
  (972 unit tests, 151 HTTP tests, formatting/lint/typecheck/secrets/build);
  `pnpm run test:worker:integration` passed against isolated Mongo/Redis and
  compiled API/worker, now exercising enrollment after policy revision 1.
  Logs: `/tmp/musicmute-policy-reconcile-verify.log` and
  `/tmp/musicmute-policy-reconcile-integration.log`.
- API preflight: official Zalando guidelines read 2026-09-29, particularly
  compatibility (106), endpoint authorization (104), and HTTP error semantics
  (151): https://opensource.zalando.com/restful-api-guidelines/.
- No backend deployment performed. Repository instructions require an explicit
  deployment request; Windows live-job validation depends on applying this fix.
- Dashboard policy form also shows a blank Maximum attempts field and disables
  publishing with the current live response. No policy values were changed.

## Backend capacity approval gap

- Enrollment creates capabilities with `maxSlots: 1` in
  `worker/src/enrollment/report-builder.ts`. Activation copies those capabilities
  into the machine. The Windows dashboard confirms one approved slot despite the
  successful local two-worker qualification.
- `WorkerClaimService.registerSlot` rejects slot index 1 when machine approval is
  one. The fleet policy's two-slot ceiling does not override this machine gate.
  `mw capacity` correctly reports `backendApprovalRequired: true`.
- Existing administration exposes lifecycle, policy, doctor and single-recipe
  benchmark commands, but no machine capacity approval update. No production
  capability was edited and no approval check was bypassed.
- Once the policy fix is deployed, a one-slot live test is possible using the
  supported local capacity command (which preserves the inactive slot identity).
  Full two-slot live readiness additionally requires a supported, audited
  capacity approval operation. The installed Windows configuration remains at
  two slots and the service remains stopped pending resolution.
- Deployment approval for the tested policy fix remains pending. The separate
  capacity approval gap is not implemented or included in that patch.

## Approved production rollout: API 90

- User explicitly approved upload and testing on 2026-09-29. Uploaded through
  the authenticated CapRover UI; active image changed from `img-captain-api:89`
  to `img-captain-api:90`, build successful at 15:58 UTC.
- Baseline archive SHA-256 matched the recorded API 89 deployment. Both archives
  have exactly 323 build inputs; only `worker-control.service.ts` differs.
  New archive: `/var/folders/jh/kqzv5jvj1qgfq85qwnwclz4w0000gn/T/musicmute-caprover-RYy98T/api.tar`;
  SHA-256 `034e731334af1f55f90c27f7fccc67efdb2665b72d35adcf18b782ab48938b8b`.
- Actual current API health routes are `/health/live` and `/health/ready`, both
  returned 200 after rollout; `/realtime-tickets` and `/admin/realtime-tickets`
  reject unauthenticated POST with 401. Older `/api/v1` probe paths return 404.
  A transient 502 occurred during replacement. No configuration values changed.
- Windows supported `capacity --workers 1` succeeded, preserving the inactive
  slot identity. Native restart completed; status confirms running/healthy,
  ready model, active lifecycle, policy revision 1 and claims allowed.
  Two-slot live operation remains unapproved; local qualification stays retained.
- Mac live status confirmed healthy/claims allowed and zero active jobs after
  API deployment. Paused local Mac claims for routing the generated 60-second
  fixture to Windows. Submitted job `6abbe16798b7cec3f5839e80` through web UI;
  initially queued. Resume Mac immediately after confirming Windows assignment.
- Deployment screenshot: `/tmp/musicmute-api90-deployed.png`.


## Windows live job and final fleet proof

- Windows machine `8bd8181d-eeb0-473d-91ee-aff313103349` completed job
  `6abbe16798b7cec3f5839e80`, attempt
  `d83239aa-2050-4e9a-bb7e-456499bf7a10`. Dashboard shows Succeeded;
  end-user web app shows Ready. Native history confirms one attempt, no retry
  and zero child restarts. This is live backend/S3 processing evidence.
- Worker-observed attempt: 16:04:06.460Z–16:04:36.315Z (29.855 seconds).
  Input download 3.402s, separation 13.815s (12/12 windows), trim 0.180s,
  encoding 1.558s, upload 5.730s, completion 2.202s. These are local worker
  stage observations, not independent server-monotonic latency measurements.
- Downloaded through the live app and Chrome. Local retained result:
  `~/Downloads/vocals-6abbe16798b7cec3f5839e80.mp3`, 1,202,721 bytes.
  ffprobe: MP3, stereo, 44,100 Hz, 60.070023 seconds. Full FFmpeg decode to null
  passed with no errors; browser playback reached the end.
- Mac claims resumed, revision 220. Final Mac remote status confirms active,
  ready, healthy, claims allowed, zero active attempts. Windows final native
  status confirms active/ready/healthy, policy revision 1, no blockers,
  no maintenance pending and no active attempts, with the successful job above.
- Windows currently operates one backend-approved slot; Mac retains two.
  Two-slot Windows live approval remains separate unfinished work. No claim of
  simultaneous processing on both machines or two-slot Windows production proof.
- Screenshots: `/tmp/musicmute-windows-live-success.png` (worker attribution)
  and `/tmp/musicmute-windows-audio-ready.png` (completed user-facing job).

## Two-slot enablement requested, 2026-09-29

- Added POST `/admin/worker-fleet/machines/:id/capacity-approvals`, restricted to
  `workers.manage`, fresh authentication, bounded DTO, reason, UUID operation ID
  and revision-fenced transactional audit. Only raises one existing GPU to two;
  preserves recipes/provider/other GPUs and rejects revoked or ambiguous targets.
  This is explicit operator approval of reviewed evidence, not server-run GPU
  qualification. Existing local receipt and fleet policy remain independent gates.
- Dashboard capability card offers the matching confirmation/reauthentication
  dialog; live snapshots deliver the changed capability without status polling.
- Checks: backend verify passed (979 unit, 153 HTTP, format/lint/typecheck/build);
  worker integration passed including real Mongo transaction, replay and audit;
  dashboard format/lint/typecheck, 87 tests and production build passed.
- API preflight read current https://opensource.zalando.com/restful-api-guidelines/
  on 2026-09-29: endpoint security (104), OpenAPI (101), HTTP method semantics
  (148), compatibility (106). Uses existing snake_case wire conversion and error
  responses, no new permissions or infrastructure.
- High performance native benchmark PASS: standard 1.441748935x throughput,
  trim 1.289880192x; 18 decoded comparisons passed with zero differences.
  `C:\MusicMuteBuild\capacity-high-performance-15.json`, SHA-256
  `d21a594cfc5b7fbbe7e548b0e4ca031470256c7c8b09c387b9ee3efc8d25a859`.
- Deployment archives byte-compared to active API 90/dashboard 16: only three
  backend control source files and two dashboard worker source files differ.
  API archive SHA-256 `7c611699991a19e277bdc8556ef6af3ab5af095f49335e871f5feac03ca8468d`;
  dashboard SHA-256 `2af19cef97bd27d9c77c859dfef03f058a7ab9ad56e3f770d0c7c58ae5477b5e`.
- Deployed API 91 and dashboard 17 through CapRover; active deployment checks
  confirmed both. API readiness returned HTTP 200; unauthenticated access to
  the new capacity action returned HTTP 401. The live dashboard showed the new
  action. Owner reauthentication and the evidence-bearing approval succeeded:
  Z440 capability increased to two slots at machine revision 44.
- Configured two stable DirectML slots, resumed the local lifecycle and started
  Windows release `0.1.0-win.20260929.15` with `--wait-ready`. At 16:48Z,
  native status reported healthy, active, model-ready, no blockers or pending
  maintenance, and backend claims allowed. Live dashboard showed Online,
  generation 5, revision 46, both slots idle and GPU capability up to two slots.
  Slot IDs: `e37fb847-c5e9-4e93-85f3-e7e80a78a5cc` and
  `b378451b-c458-4a3e-9f09-c2618ccdee2c`.
- Proof screenshot: `/tmp/musicmute-z440-two-workers-active.png`. Concurrent
  execution was verified by the native qualification, not by two simultaneous
  production jobs. Throughput ratios do not imply twice the per-song speed.
- Separate final Mac observation at 16:48:59Z: both MPS slots remain locally
  ready and healthy, but backend machine revision 943 is draining and claims
  are disabled. This setting was preserved; do not interpret the Windows
  enablement as proof that both machines currently accept new jobs.
