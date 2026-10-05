# Detailed delivery plan

## Manual verification and helper startup — 2026-10-06

Owner-requested change: trust installed executable/model contents during normal
use. Full integrity/readiness checks belong to Prepare, updates and the popup's
explicit **Check again** action, not normal playback, separation or popup opening.

- [x] Separate normal runtime launch from expensive runtime verification; retain
      path/version/ownership checks and update leases without inventory scans.
- [x] Remove installation/tool/model audits from normal separation; preserve
      actual media validation, engine loading, cancellation and account fences.
- [x] Add an explicit bounded manual-check contract and popup progress/results;
      ordinary status must not trigger checks or imply freshly verified readiness.
- [x] Add actionable installation-failure guidance without hiding source/network
      errors; record safe startup/check timings.
- [x] Retain local READY grants across a five-second same-tab reload handoff;
      preserve silence, stale-document fences, cancellation and update release.
- [x] Cover missing setup, invalid active version, rapid reloads, expiry, account/
      mode changes, different videos/tabs, native loss and in-flight acknowledgements.
- [x] Run component verification, native/Python checks and scoped fixture proof;
      review the complete diff and document measured evidence and limitations.
- [x] Rebuild final extension `dist` and an ad-hoc macOS DMG, independently verify
      the packaged artifact, and hand it to the user for manual installation/testing.

The initial delivery stopped at the manual-test artifacts. The later authorized
installation and timed live-test follow-up is recorded in
[the installed validation report](live-e2e-2026-10-06.md). No real-data reset,
commit, push, deployment or public release is part of that follow-up. Earlier
verification policies below are historical where they conflict with this explicit
owner-requested execution policy.

The current setup, YouTube tools, cloud handoff and update work is recorded in
[setup and updates](setup-updates.md). Its source/test evidence is separate from
the preceding installed app and live playback checkpoints below. Apple release
work and Chrome Web Store delivery are deferred.

The saved Home processing choice now routes Chrome requests through local
separation or native-authorized cloud YouTube URL import. See [processing selection](processing-selection.md)
for the contract, account fences and source-validation boundaries.

The 2026-10-04 browser hardening and store-candidate workflow is recorded in
[Chrome Web Store preparation](chrome-web-store.md). Historical checks and installed
package identities below retain their dated scope; they are not current release proof.

The account-connected Mac follow-up is tracked in
[desktop-tasks.md](desktop-tasks.md), including local-default/cloud-optional
processing, account saving and the configurable offline vocals budget (2 GB by default). The evidence
below describes the preceding extension milestone.

The first runnable target is macOS ARM64, whole-file processing, original YouTube
video plus a separate untrimmed vocals player, and local diagnostics. This plan
also defines Windows offline and MusicMute online boundaries. A task being coded
does not establish its browser/device/live acceptance; check validation.md.

## Playback performance implementation — 2026-10-05

- [x] Cloud submits the canonical URL; no local original acquisition/conversion/upload.
- [x] Cache/shared hits bypass model readiness; immutable checksum receipts avoid layer-by-layer rehashing.
- [x] Trusted shared originals can be reused under an owned guest producer lease.
- [x] App/Chrome share a private persistent RuntimePipeline with idle expiry and cancellation retirement.
- [x] First-playback timing and warm-engine diagnostics are recorded without private media identifiers.
- [x] Rebuilt production extension and ad-hoc macOS package/DMG; backend deployed as version 115.
- [ ] User installation and live YouTube/cloud playback acceptance for this new package.

See the latest entry in [validation.md](validation.md). Earlier installed checkpoints
below remain historical and do not imply this package was installed.

## Status supersession — 2026-10-05

The current package/install checkpoint is build
`c14116b8-cf2c-4865-8a24-f9f1dce2a119` / `CFBundleVersion` `1791212763`: an
exact 17,663,025-byte ARM64 ad-hoc package whose 139 package/installed leaves,
build identity and architecture matched, with deep strict signing passing.
External inventory SHA-256 is
`3e5d49e98f7147ac049224d36a1227b3ad46cb48f08711ff2f79f8762e00a276`;
the embedded bundle-audit file SHA-256 is
`4de0acb10e0b5790fd2ad42f143a6329cb96c8700a471d96c9daab59d7a87331`.
It reused the exact 58d runtime/model. The disposable package-only proof at
`output/packaged-tools-proof/e9fb0a01-33a0-44b9-b18a-391fe2130002.noindex/result.json`
passed all 15 checks, and installed full verification created the private
authenticated runtime receipt. This ordinary update is not clean-Prepare,
native-app processing/UI or account acceptance. A separate refreshed real
YouTube tab reached **MusicMute · On this Mac** and **Voice-only playback** under
the c141 companion, with `cache_hit=true` and `playback_started`; this is only a
warm-cache local playback start, not fresh acquisition/downloader/MPS separation,
listening, selected-source, lip-sync or sustained-use proof.

The 679/cb material below is historical. The later interim e2aa thin-package,
clean support-data Prepare, synthetic native playback/relaunch and
unpacked-Chrome local-mode/helper evidence is preserved in
[validation.md](validation.md#interim-e2aa-package-reset-prepare-and-ui-checkpoint--2026-10-05),
but e2aa is not source-final. Historical 2ed added the Google G and
`account.online` connected-copy fence, but a final audit found that it could still
show connected after socket readiness and before the current account/stream's
first valid jobs snapshot. Final 58d scopes snapshot acceptance to account and
stream, resets/fences stale connections, preserves same-stream pagination
readiness and makes Home/Library connected copy wait for that valid snapshot.
Its clean reset, complete-partial Prepare, signed-out synthetic native
playback/relaunch, loaded-extension bundle alignment and registered-manifest
HELLO/local-mode evidence remain valid only as a historical 58d checkpoint; they
must not be relabelled as c141 results.

- [x] Built and installed c14116b8; exact package/installed inventory, ARM64 and
      deep strict signature checks passed.
- [x] Passed the c141 disposable 15-check package qualification and recorded the
      installed private runtime receipt without claiming GUI/browser inference.
- [x] Confirmed final unpacked `dist` and one post-install c141 real-YouTube
      warm-cache playback start, preserving its uncached/listening/long-run gaps.
- [x] Preserved the 58d clean-support Prepare, synthetic processing/relaunch,
      loaded-bundle and registered-manifest HELLO/local-mode evidence as history.
- [x] Added native receipt regressions and retained the 58d readiness regressions
      for wrong account/stream, reconnect, pagination, teardown and malformed
      jobs snapshots.
- [x] Recorded the package/install, receipt and scope limitations in the README,
      setup guide, delivery ledger, desktop ledger and validation ledger.

Build `2ed7711e-7cd6-4b37-992f-c6fb02782812` / `1791168902` is now explicitly
historical and superseded; its recorded evidence remains scoped to that build.
The historical 58d extension proof does not include a popup observation.

At the historical 679 checkpoint, source passed **448 tests in 21 files**, typecheck, **67-file lint with
zero warnings/errors**, build and formatting. The generated package is
`output/macos/build-67960e3f-97ec-44bf-a29b-662357b28677.noindex/`: 1,113,057,345
bytes, 303 ARM64 native files, ad hoc signed and not notarized. Its installation
at `/Applications/MusicMute Local.app` passes 21 source/package/installed hash
checks and strict code-signature validation, with inventory prefix `1a3f1f61a192`.
Spotlight shows the sole canonical app, the previous app is preserved in a private
backup and Chrome registration is unchanged. The reopened Overview shows Mac
ready. The proof is
`output/panel-controls-proof/5b59b489-8cb1-40a1-bca0-ad7a2abb76b5/installed-alignment.json`.
The same directory contains `source-verify.json` with 88 source pins and the
448-test/21-file checks, plus `installed-app-ready.ax.txt` and
`installed-app-ready.jpg` for the reopened Overview.
Prior `cb26daf3` installation/controls evidence retains its own scope. Former
home-directory bundles remain preserved in owned `retired-apps.noindex`;
generated and preserved packages stay in `.noindex` folders.

The user manually Reloaded the prior `cb26daf3` extension. Ordinary HTTPS YouTube
observations cover a partial cached-source controls cycle, described in D8 below.
That 679-era source added a compact movable panel, persistent dismissal and safe
extension-context retirement. The user then manually Reloaded the
`67960e3f` extension and an ordinary YouTube page refresh exposed its new controls.
Narrow live panel acceptance passes: dismissal persists while playback continues,
reopening preserves the session, keyboard movement stays bounded and Home restores
the top-right anchor. The measured panel is 304 × 127.70px and both icon-center
offsets are zero. The new evidence is listed in D8 below.
Observed active context revocation also paused the video, restored original mute
and showed the disabled waveform/Refresh YouTube notice. Ordinary page refresh
and retry returned to cached voice-only playback; this narrow reconnect check
does not close the browser restart, offscreen closure or sleep/wake matrix.
An older screenshot with a `send` line-111 stack may be historical or stale and
does not establish a new-build failure or successful UI acceptance. The pre-fix
`AUDIO_CONTEXT_LOST` long-pause/retry failure and generic navigation error remain
historical evidence: safe pause/mute
restoration worked, but retry recovery failed. Listening, selected-track matching,
physical lip-sync, measured offscreen closure beyond 30 seconds and the restart
matrix remain open.

## A. Contracts and project structure

1. Shared protocol with version, request/job IDs, provider, state, progress,
   video identity and immutable timeline-preserving output. Runtime validation
   fences malformed frames, stale messages and unsupported providers.
2. Browser-facing provider interface: start, snapshot subscription, cancel,
   resolve playable media and close. Companion engine interface separately owns
   file paths and platform tools. Never require a native work directory from the
   future online provider.
3. Provider capabilities: companion/account requirements, platform, supported
   duration/source/audio types and preservation of timeline. Expose unsupported
   modes as unavailable; require an explicit user choice before online costs.
4. Keep source organization isolated under chrome-extension; do not fork the Kim
   separator or copy the fleet's enrollment/auth/scheduler into the companion.

## B. Developer bug and performance system — before wider release

1. Capture typed handled errors plus unhandled errors/rejections in content,
   background, popup, offscreen, native host and engine. Correlate run/job/request
   IDs, sequence, process/session incarnation and version/build/model identity.
   Recorder identity is owned by the native process; expected model and verified
   model are distinct. Preserve legacy unknown identity and stored verification
   provenance without upgrading fixture/cache observations to inference claims.
   Diagnostic sending contains synchronous runtime throws and rejected promises
   without reading or retaining exception text. Error capture returns an
   idempotent disposer. Exact extension-context invalidation retires content
   handlers, timers, observers and pointer capture, restores owned mute and shows
   a safe instruction to refresh YouTube; ordinary connection errors keep their
   existing failure path.
2. Persist bounded private JSONL with rotation, partial-tail recovery, terminal
   durability and explicit missing/truncated history. Keep a bounded browser
   error buffer while the helper is absent.
3. Measure acquisition/metadata/download, model load, decode/preparation,
   separation, encoding, validation, cache retrieval and playback readiness.
   Preserve nested stage semantics; never sum overlapping timers into totals.
4. Sample process RSS/CPU/active resources and disk reserve outside the hot path.
   Record process scope and sampling coverage. MPS boundary allocations are not
   GPU utilization or peak device memory. Rising samples are warnings, not proof
   of a leak. Use repeated-run baselines before choosing regression thresholds.
5. Track media-clock skew p50/p95/max, hard realignments, audio/video buffering,
   autoplay rejection, navigation, offscreen recreation and unexpected disconnects.
   First diagnostic threshold: sustained >=150ms skew triggers a warning; qualify
   final experience with actual speech/video observations.
6. Stage inactivity warnings, separate startup/process deadlines, process exit
   code/signal and parent-death cleanup. Do not label every exit/timeout as OOM.
7. Doctor and local report export with safe field projection, collision/size
   checks and no media/URLs/tokens/cookies/config values. Logging failure has a
   visible degraded state rather than blocking silently. Bound combined app
   snapshot/export replies, including setup and UI history, to the complete 64 KiB
   envelope; compact summaries explicitly without rewriting the full export.
   Fingerprint only an owned bounded inventory whose directory and opened-file
   identities remain unchanged through the read.
8. Repeatable fault injection: missing helper, corrupt/missing model, malformed
   native frames, child crash/hang, cancellation, decoder failure, invalid output,
   full disk, log-write failure and stale result after switching video.
9. Run a short report-producing developer check after edits. During an active
   Codex session these local artifacts can be read and failures fixed. This does
   not make Codex an always-running remote observer after the chat ends.

## C. macOS local preparation

1. ARM64/platform/readiness checks and no silent CPU fallback. Initial 900-second
   cap, bounded source bytes, disk reserve and one processing owner.
2. Canonical public YouTube watch ID only; metadata-first validation; reject
   playlists, live streams, unsupported duration, private/restricted downloads and
   source ID mismatch. No browser cookie extraction in this MVP.
3. Bound retries/deadlines/output; shell-free downloader; pin and package yt-dlp,
   its EJS components and configured JavaScript runtime for fresh installs.
4. Call existing engine with trim_enabled=False; require equal sample counts,
   removedSamples=0, verified model identity/checksum and valid MP3. Check measured
   source/output/video durations. Duration agreement does not prove dubbed-track
   identity; explicitly qualify or reject alternate audio. Current recipe 8 uses
   best audio in supported HTTPS/materialized DASH transfers, accepts only one
   exposed language/preference profile and rejects ambiguous/described tracks.
   The accepted format is replayed from bounded metadata through stdin, with
   returned identity checked before inference. The guarded bootstrap preserves
   optional full upstream track ID and raw default boolean only from a conservative unique transport match in the already fetched
   player response. Distinct known full IDs are refused and missing evidence stays
   unknown. Raw IDs never enter diagnostics. Original-track and player-selected
   matching still need live qualification; preserved extractor evidence and profile
   agreement alone do not complete C4/D14.
5. Separate owned attempt directories; cancellation/deadline terminates process
   groups; parent guardian prevents orphan downloader/decoder/inference processes.
   Remove partial attempts and allow a clean subsequent job.
6. Retain verified results under canonical video/audio-policy/model/recipe
   identities; recipe 8 invalidates recipe 7 and older reuse while preserving
   files, and requires the pinned model in cached metadata. Cache verification
   claims require provenance written by the trusted native pipeline after model
   and output validation; provider metadata cannot create it. Validate bytes,
   bound retention/disk usage and expose user-controlled clearing. The current cache does not independently detect a
   later upstream audio replacement; include a qualified source version before
   promising that stronger cache identity or supporting alternate tracks.
7. Cold and repeated short-file benchmarks on the existing M4 Pro; then 5/15-minute
   qualification. Measure peak/sample memory, total preparation and each stage;
   listen to Arabic/English speech, quiet speech, music and background singing.
8. Investigate cold helper/tool startup separately from YouTube metadata, network
   transfer and inference. Earlier short native runs ranged from about 19 to 76
   seconds; their ignored evidence artifacts are currently unavailable. New
   recipe-8 installed native acquisition/MPS/Range now passes in 19.021 seconds on
   one public 19-second source, with browser playback false. Do not infer
   real-player performance from source tests or old same-machine measurements.
   Keep tool/archive integrity and capability checks; any validation cache needs
   a verified tool/argument identity. See validation.md for current evidence.

## D. Extension and synchronized playback

1. Stable extension ID/public manifest key; one accessible player icon; status,
   preparation progress, cancel/disable and a lightweight diagnostic popup.
   The current panel is at most 304px wide, initially at the top right, and fits
   smaller players. During an active session the waveform toggles it. Close and
   Escape hide the panel while preserving the job, generation, original mute
   ownership and clocks; progress, READY and playback updates retain dismissal.
   Separate Cancel and Stop actions end the session. Only the context-invalidation
   safety notice may reopen a dismissed panel. Its handle supports clamped
   pointer movement, arrow keys (8px, or 24px with Shift) and Home reset. A
   ResizeObserver reclamps player/panel changes; hiding releases capture and
   disposal removes capture, listeners and the observer.
2. Native Messaging for controls/status; protected loopback only for completed
   media, exact extension origin, session capability, Host checking and GET/HEAD
   Range delivery. No media URL or arbitrary file/command paths in page DOM.
3. Offscreen audio owns decoded playback; follow currentTime/rate/volume using
   generation+sequence fences and small drift deadband. Align after seek/resume.
4. Gate replacement sound during video stalls/seeks/ads. Ads play normally, are
   not skipped, and content resumes at a fresh main-video clock.
5. Restore original owned mute state on stop/failure/navigation. Explicit one-tab
   ownership. No double audio or previous-video vocals after a fast switch.
6. Recover from >30-second paused offscreen closure, MV3 restart, helper loss,
   computer sleep/wake, ended media and autoplay rejection. Use bounded retry and
   an actionable failure, not an endless reconnect loop.
7. Chrome fixture E2E: pause/resume, rapid seeks, rates, ads, buffering, SPA/video
   replacement, two tabs, stop/cancel, native crash and repeated cycles. Capture
   console/page errors, request failures and screenshots with local reports.
   The existing automated harness loads an unpacked extension. Automatic approval
   review rejected extension loading in this session; do not execute that harness
   or use CDP, another browser, shell or indirect UI as a workaround. Current
   actual-handler mocks cover source behavior. The user has completed manual
   Chrome loading; real-browser playback still needs its own acceptance evidence.
   A new ordinary HTTP fixture executes the compiled `content.js` and CSS with a
   fake Chrome runtime, without loading an extension or playing real audio. It
   covers hide/progress/READY/playback/reopen, arrows with Shift, Home, player
   resize to 430px and 320px, and icon centering. Native pointer UI attempts missed
   the intended coordinates; pointer dragging is covered only by the helper's
   unit tests, not a successful browser drag.
   While hidden, the local fixture advanced clock messages from 9 to 2,394 with
   one Start and zero Stop/Cancel calls. Explicit Stop sent one Stop and restored
   mute. Saved `fixture-cases.json` in the panel proof directory also covers
   actual compiled Cancel/Stop handlers and simulated invalidation with restored
   mute and no fixture errors. These fake-runtime observations retain fixture
   scope.
8. Live YouTube smoke tests separately prove a loaded build's DOM integration, permitted
   acquisition and playback/listening. Synthetic fixtures alone do not satisfy this.
   Pre-fix actual Chrome evidence now includes the injected icon, preparation,
   two cold sources of 226.621s/219.521s in 23.270s/22.229s and initial cache/clock
   observations. Long-pause/retry revealed AUDIO_CONTEXT_LOST and navigation
   recorded one UNCAUGHT_ERROR. These failures predate the recovery fix and remain
   pinned to that history. After the user's manual Reload of prior `cb26daf3`, an
   actual cached 219.521-second source showed Play with the original video muted,
   Pause at 82.98 seconds, Home to 0, ArrowRight to 5 seconds, resume at 1.5x,
   restore to 1x and Stop with original mute false. This is partial prior-build
   controls evidence, not physical listening, selected-track matching, measured
   offscreen closure beyond 30 seconds or full restart/recovery acceptance.
   `prior-cb26-host-summary.json` is the latest bounded host history, not a
   correlated report for that UI cycle; it does not establish an error-free cycle.
   Historical `67960e3f` was installed at the same canonical path and the user completed
   manual Reload of the existing extension followed by an ordinary YouTube page
   refresh. New `aria-controls`/expanded state confirms the new controls. On a
   cached 219.521-second source, the panel showed Preparing, Close hid it, and
   playback continued at 142.796858 then 176.52433 seconds with paused false and
   original mute true, without Stop or restart. Pause and reopen at 176.588492
   seconds retained pressed/muted true. ArrowLeft and Shift+ArrowDown moved the
   panel within the 1282.975 × 721.669px player; Escape hid it and focused the
   waveform without changing the session, and Home restored the 12px top-right
   anchor. The panel measured 304 × 127.70px and both icon-center offsets were
   zero. Evidence is in
   `output/panel-controls-proof/5b59b489-8cb1-40a1-bca0-ad7a2abb76b5/real-youtube-panel-cases.json`
   and `real-youtube-compact-controls.jpg` in the same directory.
   Updated `real-youtube-panel-cases.json` also records actual context revocation
   during an active session: the waveform became disabled, the Refresh YouTube
   notice appeared and the video was paused with original mute false.
   `real-youtube-reload-notice.jpg` preserves that notice. An ordinary HTTPS page
   refresh and retry succeeded with cached voice-only playback at 93.725681
   seconds, paused false and original mute true. Final Pause/Stop at 135.563223
   seconds left paused true, original mute false and waveform pressed false.
   This verifies context revocation and reconnect after page refresh without
   establishing what caused the context revocation.
   The final historical `real-youtube-console-summary.json` contains 491 bounded records, all in
   the older 13:52:36–13:53:33 range. It reports zero errors/warnings after the installed
   alignment cutoff `14:19:33.362Z` only, not a cleared profile or error-free
   lifetime history. Synchronous/rejected invalidation and diagnostic handler
   tests pass. `new-build-host-summary.json` holds the latest 117 bounded rows
   across two hosts, including four cache READY results and `code_counts: {}`;
   it is not necessarily correlated to one UI cycle or new inference. Physical
   listening, selected-track matching, native pointer UI dragging, the measured
   > 30-second offscreen case and the full restart/sleep/wake recovery matrix
   > remain open. Do not infer physical sound quality or source-track matching
   > from preparation/READY/clock telemetry.

## E. Standalone macOS delivery — public-launch gate

1. App-owned signed immutable runtime and upstream-only hash-verified model setup;
   a fresh user must not need an existing worker, Homebrew, Node or Python.
2. Per-user Native Messaging registration/lock, no admin daemon; packaged tools,
   notices/licence records and model distribution condition.
3. First-launch setup with progress/retry and explicit disk/RAM/OS requirements,
   selected from actual native qualification. Measure complete installer/runtime
   size instead of quoting just the 67MB model.
4. Signed/notarized app, Gatekeeper/quarantine acceptance, update compatibility,
   rollback, safe uninstall and private-cache retention/clear choice.
5. Clean-user installation, model download interruption/recovery, browser restart,
   app move/update/uninstall and source/runtime mismatch tests.
   Current candidate `c14116b8` occupies standard `/Applications`; its
   package/install inventory, signature and receipt readback passed. Historical
   `58d55f40` owns the clean reset, Prepare and affected local UI evidence on the
   existing development Mac.
   This does not close fresh-user, runtime-network, relocation, notarization,
   updater or public-release acceptance. Explicit
   `--applications-dir /Applications` preserves the default per-user installer
   behavior. Future previous/failed bundles use an owned private same-filesystem
   `.musicmute-backups.noindex` child; generated packages use `.noindex` build
   folders. Source guard/temporary-filesystem checks pass 53 cases. Actual recovery
   qualification remains separate and was not rerun by the source audit.
6. Chrome Web Store review/listing/privacy disclosures and packaged extension
   acceptance. Publishing/signing/deployment requires a separate direct request.

## F. MusicMute online provider — later phase

1. Explicit online mode/account sign-in; scoped extension auth/session integration
   with existing Firebase/backend policy and platform-installation headers. Do not
   reuse dashboard or fleet credentials. Confirm how extension sessions are
   represented before enabling production use.
2. Read processing policy/quotas once as needed; submit canonical URL through
   existing POST /media-imports with request_id and trim_enabled:false.
3. Reuse authenticated raw WebSocket tickets/full snapshots and the existing
   import/job live contracts. No periodic job-status GET polling or timer refetch.
4. Follow import->job transitions, stale progress/reconnect snapshot recovery,
   cancellation and idempotent retry semantics. Never auto retry ambiguous paid
   creation or fall back from local to billable processing.
5. Acquire short-lived output download grants; refresh grants through commands,
   not leaked credentials/URLs. Extension-owned player supports HTTPS media with
   narrowly reviewed grant origins/CSP. No R2 credentials in the browser.
6. Normalize online media into the same timeline/output descriptor as offline;
   verify trim false, requested video/source/audio language and measured timing.
   The repository currently documents a source-version mismatch in its YouTube
   provider activation: fixing and proving requested-source identity is a release
   gate, not something the extension can infer from valid MP3 or equal duration.
7. Review backend metadata needed for encoder delay/sample-alignment/duration and
   source/audio-track identity. Reuse existing fields; any required additions must
   update OpenAPI, backend, shared clients and tests compatibly.
8. Test real authenticated cold/warm imports, account/policy failures, session
   expiry, grants, cancellation, reconnect and playback. Backend health/local
   mocks do not establish authenticated end-to-end proof.

## G. Windows offline provider — later phase

1. Reuse extension, provider/job/timeline/diagnostic contracts and the qualified
   DirectML engine; put native installer/path/process containment behind adapters.
2. Bundle correct Node/Python/FFmpeg/downloader/JS runtime and verified model for
   Windows x64. Native Messaging registration is per-user registry-based.
3. Replace POSIX locking/process groups with Windows ownership and kill-on-close
   Job Objects; handle locked media/update files and crash-restart semantics.
4. Test CPU/GPU/driver readiness, supported OS/hardware, Unicode/space paths,
   cleanup, reboot, fresh install/update/uninstall and user/browser permissions.
5. Qualify physical Windows performance/listening and shared sync fixtures. A
   compiled adapter or previous fleet DirectML proof is not extension acceptance.

## Acceptance order

1. Contract/redaction/clock/process unit checks.
2. Native fixture preparation + Range playback and failure cleanup.
3. Chrome extension/native bridge fixture with measurable timing and error capture.
4. Real local Kim/MPS separation and repeated resource measurements.
5. Permitted live YouTube acquisition + original player/listening proof.
6. Standalone clean-user macOS package; only then public MVP launch.
7. Online and Windows phases each pass their own native/authenticated gates.
