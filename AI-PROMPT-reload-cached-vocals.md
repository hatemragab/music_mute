# Task: reuse a finished local vocal job across a Chrome reload

You are implementing one performance fix in the MusicMute Chrome extension and its native macOS helper. A YouTube video whose vocals are already on this Mac must not relaunch the helper, and must not run separation again, when the user reloads the page.

Do the work in `/Users/hatemragap/work_spaces/music_remover`. Read these before editing:

- `chrome-extension/AGENTS.md`
- `chrome-extension/README.md` (the paragraphs about Chrome auto-start, refresh, and idle helper release)
- `chrome-extension/docs/processing-selection.md`
- `Agents.md` at the repository root, the Chrome-extension section only

Do not commit, push, deploy, publish, or touch production data. Do not read or print dotenv values, tokens, or media URLs in logs.

## Problem, measured on this Mac

Signing out is not the cause. **On this Mac** already processes locally. A repeat of a cached video is ready in about 60 ms once the helper is running.

A page reload is the cause. The old YouTube document sends `MM_STOP` from `pagehide`. `stop()` in `chrome-extension/src/extension/background.ts` treats a `READY` job as owning a native media grant and sends `CANCEL`. `closeIdleConnection()` then drops the Native Messaging port. The helper exits. The reloaded page calls `MM_START` about 1.5 s later, after the process is already gone, so the two documents never overlap.

Chrome then shows this panel for the whole cold start:

> The video is paused while MusicMute checks your saved processing choice. You can cancel anytime.

That string is set in `start()` in `chrome-extension/src/extension/content.ts` before any job snapshot exists. The `<progress>` element has its `value` removed, so the bar is indeterminate. It is not a percentage and it is not separation.

The native log at `~/Library/Application Support/MusicMuteLocal/logs/events.jsonl` showed three reloads on 2026-10-05 around 20:18–20:19 UTC:

| Event | Time |
| --- | --- |
| Gap from `companion_stopped` to the next `companion_started` | 50.0 s, 50.0 s, 50.7 s |
| `job_ready` with `cache_hit: true` after the new helper logged `companion_started` | 66 ms, 59 ms, 67 ms |
| Extension `start-to-playback` | about 43–49 s, recorded at the same instant as `job_ready` |

`companion_started` is logged only a few milliseconds after `Diagnostics` is constructed. The 50 s is before that log line: process launch and the work in `host.ts` before the logger exists, including `NativeHostLauncher.verifiedRuntime` in `chrome-extension/macos/ProcessBridge.swift`. The cache lookup is not the 50 s.

`codesign --verify --strict` of `/Applications/MusicMute Local.app` was about 0.01 s on this machine. Do not “fix” this task by skipping runtime verification, receipt checks, or signature checks.

## Outcome

Reloading a YouTube watch page whose local vocals are already `READY` must play again without launching a new helper and without a new `START`.

Target: the reloaded page leaves the preparing panel in well under a second on a warm helper. The native log for that reload must not contain a new `companion_started` or a new `job_started`.

A song that is not cached still uses the existing acquisition and separation path. It must not pay a helper relaunch if the previous helper is still inside the grace window. The first request after the helper has really exited may still pay the cold start. That cold start is out of scope. Do not weaken it.

## Behavior to implement

### 1. Grace after the page goes away

When the content script sends `MM_STOP` because the document is going away, and the current job is `LOCAL_MACOS` and `READY` and still has its `media` grant:

- Do not send native `CANCEL` yet.
- Do not call `closeIdleConnection()` yet.
- Do not send `MM_AUDIO_STOP` until you know the grant will not be reused, or send it and be prepared to `loadAudio()` again on reuse. Either is acceptable. The 50 s bug is the helper process, not the offscreen element. Pick the simpler one and test it.
- Keep the Native Messaging port open.
- Remember the tab id, video id, duration, job id, provider, media grant, and processing provider that was already negotiated on `hello`.
- Start a 5 second grace timer.

`closeIdleConnection()` and `installPendingUpdate()` must treat this retained grant as still in use. An in-flight playback acknowledgement must not drop the port during the grace window.

If a real `MM_CANCEL`, a user Stop, a failure, an account or processing-mode change, or `PLAYBACK_PAGE_LOST` happens, cancel the grace immediately and use today’s release path.

If the grace expires with no accepted successor:

- Send native `CANCEL` for that job id.
- Disconnect the helper the way `closeIdleConnection()` does today.
- This preserves the existing rule that an idle Chrome connection must not block an app update. The extra hold is at most 5 seconds, not the whole time a tab was open.

In-progress work is different. `DOWNLOADING`, `PROCESSING`, and `VALIDATING` jobs are not reusable. On `pagehide`, still cancel that native job before any new `START`, because a half-finished pipeline must not be resumed blindly. Do not disconnect the helper until the grace expires or the successor has taken the port. The successor’s `START` must run on the already-open port.

`ONLINE_MUSICMUTE` jobs are not part of this reuse path. Keep today’s cancel-and-release behavior for them.

### 2. Reuse the finished job for the same video

If a new `MM_START` arrives during the grace window, reuse the retained job only when all of these are true:

- Same Chrome tab id.
- The new sender is an active document. Reject `cached`, `prerender`, and `pending_deletion` exactly as today.
- The new document id is different, or this is the same-document generation handoff the current refresh code already allows. A retired document must still be rejected. A generation older than the current document must still be rejected.
- `payload.video_id` equals the retained job’s video id.
- `payload.duration_seconds` is within 2 seconds of the retained job’s duration. A larger difference is a different request. Cancel the retained job and `START` normally on the still-open port.
- `payload.provider` is `LOCAL_MACOS`.
- The retained snapshot is still `READY`, still `LOCAL_MACOS`, and still carries the same `media` object.
- The negotiated `hello.processing_provider` is not `ONLINE_MUSICMUTE`. If the open hello says cloud, do not hand back the local grant. Cancel it and follow the existing cloud confirmation rules. Do not launch a second helper only to re-read that preference when hello is already connected.
- Native `jobs.current()` still reports that same `job_id` in `READY`. If it does not, the grant is gone. Fall through to a normal `START` on the open port. Do not invent a media URL in the extension.

On a successful reuse:

- Retire the old document id the way a refresh already does.
- Bind `active` to the new generation and document id.
- Do not post native `CANCEL`. Do not post native `START`. Do not post `HELLO` if the port is already up and negotiated.
- Give the new page the existing `READY` snapshot (`MM_JOB`) and load the existing loopback media into the offscreen document for the new generation (`MM_READY` through the current `loadAudio()` path).
- The old document must not receive clocks, stop, or cancel acceptance for the new generation. Existing `documentId` and generation fences stay.
- Reset the extension `startedAt` used for `start-to-playback` at the new `MM_START`, or the metric will still include the grace. The metric is not the bug. Do not let a reused job look like a 50 s processing run.
- Cancel the grace timer. The helper now stays up for the same reason an ordinary playing session stays up.

The content script already pauses the video and shows the preparing sentence before `send(MM_START)` returns. The background reply plus `MM_JOB` / `MM_READY` must be what clears it. Do not add a content-script cache. The page does not store vocal bytes.

### 3. A different video during the grace window

Cancel the retained `READY` job first, wait for that `CANCEL` to finish, then `START` the new video on the same port. `JobManager` allows one job. A second `START` while the old grant is still `READY` is `LOCAL_COMPANION_BUSY` and is a bug.

A cache hit for the new video then takes the existing peek-cache path, about 60 ms, with no `companion_started`. A miss runs metadata, download, and separation as it does today.

### 4. Panel copy

In `chrome-extension/src/extension/content.ts`, replace the sentence set at the start of `start()`:

> The video is paused while MusicMute checks your saved processing choice. You can cancel anytime.

with a sentence that describes helper startup, not processing-mode lookup and not separation. Keep “You can cancel anytime.” Example:

> The video is paused while MusicMute starts on this Mac. You can cancel anytime.

Do not change later stage text that already comes from real job stages (`metadata`, `downloading`, `separation`, and so on). Those strings are correct once a snapshot arrives.

The indeterminate progress bar can stay for this startup wait. Do not give it a fake percentage.

### 5. What must not change

- Do not skip `NativeHostLauncher` verification, the verification receipt, model identity checks, cache checksums, or timeline checks.
- Do not read the vocal cache from Chrome or from page JavaScript. Reuse is “the helper process and its current `READY` grant are still there,” not a second cache implementation.
- Do not keep the helper open for the whole time after the user leaves YouTube. The grace cap is 5 seconds.
- Do not reuse a grant across tabs, video ids, or a cloud processing selection.
- Do not resume an in-progress separation in place. Cancel it, then let the warm helper `START` again.
- Do not spawn `MusicMute Local.app --browser-processing-bridge` any more often than today. This task does not require caching that preference read. If hello is already connected, use it.
- Do not change worker fleet code, backend routes, or R2.
- Leave unrelated dirty files alone.

## Files

Expect to edit:

- `chrome-extension/src/extension/background.ts` — grace, reuse, and the `closeIdleConnection()` hold.
- `chrome-extension/src/extension/content.ts` — the one startup sentence. Only change the page script if reuse cannot be completed with the existing `MM_JOB` / `MM_READY` messages.
- `chrome-extension/tests/background-playback.test.ts` — refresh tests currently require `CANCEL` then a second `START` even for a finished job. Update the cases that now reuse a `READY` local grant. Keep the security cases listed below.
- `chrome-extension/README.md` — the sentence that says a refresh waits for the previous page’s playback to stop before starting the new page. Describe the 5 second reuse of a finished local grant, and say that an in-progress job is still cancelled. Do not claim a live YouTube timing you did not measure.

Read before changing the handoff, and change them only if the current messages cannot express reuse:

- `chrome-extension/src/extension/messages.ts`
- `chrome-extension/src/extension/offscreen.ts`
- `chrome-extension/src/companion/jobs.ts` (`current()`, `cancel()`, `peekCache()`, `busy()`)
- `chrome-extension/src/shared/protocol.ts` (`JobSnapshot`, `MediaSource`)

Do not add a native protocol message unless reuse cannot be done with `current()` state the background already holds plus the open port. A new wire message needs the protocol rules in `chrome-extension/docs/processing-selection.md` and the native tests. Prefer not adding one.

## Tests that must stay strict

In `chrome-extension/tests/background-playback.test.ts`, these rules stay red if broken:

- A document in `cached`, `prerender`, or `pending_deletion` cannot take the session.
- An older generation cannot replace the current document.
- A retired document cannot `MM_START`, `MM_CLOCK`, `MM_STOP`, or `MM_CANCEL`.
- A second tab cannot steal the grace grant.
- A different video id does not receive the previous song’s `media` URL. It gets `CANCEL` then its own `START`.
- An in-progress `DOWNLOADING` job is still `CANCEL`led before the refreshed page’s `START`.
- After the grace timer fires, the next start is a normal `START` on a new port if the helper was released. Use fake timers. Do not `setTimeout` a real 5 seconds.
- `AUTO_START_BUSY` still applies while the old document’s silence handoff is unresolved, and while a newer refresh has already replaced a middle document.
- User `MM_CANCEL` during grace releases the native job and the port.

Add tests that fail on the old code:

- Reload of the same tab and same video, with a `READY` `LOCAL_MACOS` snapshot and `media`, posts no `CANCEL` and no second `START`. The new document receives `MM_JOB` for that same `job_id` and can clock. The native port object is the same one.
- That reload still works when `MM_STOP` finished before `MM_START`, which is the measured race. Today `rejects an old document after its pagehide stop completed before refresh admission` assumes stop has fully released the session. Split “old document rejected” from “helper and READY grant released.” The old document stays rejected. The grant stays reusable until 5 seconds pass.
- At 5 seconds plus a tick, with no successor, one `CANCEL` is posted and the port disconnects.
- A different video during the grace posts `CANCEL` for the old job id and then one `START` for the new video id, on the same port.
- Cloud `ONLINE_MUSICMUTE` is not reused by this path.

Run from `chrome-extension/`:

```sh
npx vitest run tests/background-playback.test.ts
```

Also run any content test that snapshots the replaced sentence, if one fails. If you touch native Swift or the companion protocol, run the matching native or vitest file too. Say which commands ran. Do not claim `npm run verify` unless you ran it.

## Acceptance

The implementation is done when:

- A finished local song survives a reload on the same tab without `companion_started`, `CANCEL`, or `START`.
- A different video, another tab, a cloud selection, a stale document, and an expired grace cannot use that grant.
- An idle helper still exits after the grace, so an update is not blocked by a closed page.
- The preparing sentence no longer says MusicMute is checking the saved processing choice.
- The new and updated vitest cases pass.

Out of scope: making the 50 s cold start faster, YouTube metadata time, model-load time, and shared-catalog lookup time. Mention them only as left alone.
