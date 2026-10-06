# Playback interruption recovery — 2026-10-06

This change addresses the reported disappearing controls and unexpected return
to original audio. Source and synthetic checks do not establish that the user's
installed app or already-open YouTube tab has been updated.

## Behavior

- A replacement video element can inherit the active session when the watch
  route, watch container ID and finite duration still match the selected video.
  The previous element is paused and detached, its original mute is restored,
  and the replacement keeps the user's mute preference, session generation,
  preparation and panel dismissal. A paused replacement stays paused.
- A replacement whose metadata is not ready receives a bounded five-second
  handoff. Vocals pause during that interval. A changed route, ad or unmatched
  timeline cannot be admitted as the original video.
- Prepared vocals suppress the source through Chrome's tab mute setting rather
  than forcing `video.muted`. In the isolated Chrome reproduction, a newly
  replaced video first played muted paused when hidden; tab suppression kept
  the source timeline advancing. The video's mute flag now tracks the user's
  own choice. Ads regain original audio only after the offscreen pause
  acknowledgement; resumption acquires the tab mask before vocals play.
- Tab restoration metadata contains only the tab, session owner and previous
  mute boolean in `storage.session`. Stop restores only a mask still owned by
  this extension. A later browser mute change stops vocals and remains in effect;
  an old Stop cannot release a successor's mask. Navigation clears orphan masks.
- Audio startup gets one bounded alignment opportunity during its first second
  if drift exceeds 250 ms; ordinary playback retains gradual speed correction.
- The existing five-second stale-clock audio pause remains. Fresh clocks realign
  and resume the existing player; stale samples never authorize continued audio.
- Before the 90-second page lease cancels work, the background script probes the
  exact owning document. `MM_PAGE_PROBE` carries its generation and responds with
  an optional current `MediaClock`. Only a fresh, validated sample for that owner
  renews the lease; no response is bounded to three seconds. This is local Chrome
  IPC, not HTTP status polling.
- Local READY session identity is retained in Chrome's memory-only
  `storage.session`. It contains no audio capability, account identity or tokens.
  After background state loss, a matching tab/document/generation may reattach
  only if native `STATUS` confirms the exact same READY local job and timeline.
  Native STATUS also checks the account and saved processing choice. Recovery
  never sends START or submits cloud work. If the native process/grant has gone,
  recovery fails safely with `PLAYBACK_SESSION_LOST`; it cannot resurrect a
  terminated native process's media grant. Stop invalidates the saved identity.

## Crash and diagnostics

A subprocess regression reproduced `COMPANION_CRASH` by closing Chrome's reply
pipe before the native STATUS reply. The host now handles EPIPE/ECONNRESET as
`NATIVE_PIPE_CLOSED`, suppresses writes during shutdown and releases resources.
Other stream errors remain failures. The older observed crash lacked sufficient
detail to prove that it had this cause.

Uncaught exceptions/rejections record only a bounded exception category, native
command and stage. Error text, stacks, media URLs, credentials and arbitrary
exception properties are excluded. Diagnostics now retain session loss, source
replacement timeout, navigation, explicit Stop, competing-session replacement
and clock/page loss codes rather than losing them as generic unknown errors.

## Verification

Relevant regressions are in `content-ad-mute.test.ts`,
`background-playback.test.ts`, `offscreen-playback.test.ts`,
`playback-session.test.ts`, `tab-audio.test.ts`, `sync.test.ts`,
`host-processing-selection.test.ts` and
`diagnostics.test.ts`. They cover metadata handoffs, dismissal/user pause,
stale events, document fences, Stop during recovery, missing/wrong/cloud native
jobs, bounded page probes, stale-clock recovery, output-pipe closure and safe
diagnostic projection.

The Chrome fixture adds active element replacement with same-job readback. Its
`--long-run` mode minimizes the isolated Chrome window and samples six minutes
of hidden playback, followed by pause/resume, offscreen recreation, seeks, ads,
navigation and exclusive-tab ownership. It uses synthetic media and an isolated
native host/profile, not the user's accounts, YouTube acquisition or inference.
Executed on 2026-10-06:

- `npm run typecheck`, `npm run lint`, `npm run format:check` and
  `git diff --check` passed.
- `npm test`: 2,065 passed, four skipped, across 68 files.
- `npm run test:store`: all 32 checks passed using the packaged production
  extension and isolated native fixture. Maximum timestamp-adjusted sampled
  drift was 249 ms. Evidence: `output/e2e-1791246572534/results.json`.
- `npm run test:store -- --long-run`: all 35 checks passed. All 24 hidden
  samples remained playing across six minutes; the audio timeline advanced
  345.09 seconds between the first and last samples. Playback recovered after
  a 40-second pause. Maximum sampled drift after startup settled was 199 ms.
  Evidence: `output/e2e-1791246765663/results.json`. The measurement uses
  timestamp-aligned samples after three seconds of audio advancement; it does
  not claim a sub-250-ms bound during initial browser startup.
- The harness ran the production build, including native Swift compilation,
  before testing and restored the production `dist` afterward.

These are source/build and synthetic browser results. The installed app was not
replaced, existing user tabs were not reloaded, and real YouTube acquisition,
model inference, account/R2 and listening quality were not exercised.

## Contract review

Read the current [Zalando guidelines](https://opensource.zalando.com/restful-api-guidelines/)
on 2026-10-06. Applied portable rules 106 (compatibility), 109 (bounded validated
inputs), 177 (no stack traces), 200 (no sensitive event data), and 214
(duplicate-safe consumption). Existing native commands and fields are unchanged;
the renderer probe and optional `source_muted` acknowledgement are additive,
and older content scripts simply do not renew
the lease. REST URL, HTTP method/status and OpenAPI rules do not apply to this
internal Chrome messaging change.
