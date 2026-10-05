# YouTube extension settings

The playback panel has a gear beside Close. Settings open inside the panel;
opening or closing that view does not stop preparation or playback. Done and
Escape close the settings view and return focus to the gear. A subsequent Escape
can close the playback panel through its existing controls.

| Setting                  | Default    | Allowed values                   | Behavior                                                                                                       |
| ------------------------ | ---------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Dialog transparency      | 5%         | Whole percentages from 0% to 80% | Preview changes immediately; only the panel background becomes transparent. Text and controls remain opaque.   |
| Auto-start videos        | On         | On or off                        | Eligible videos start local voice preparation automatically on page load, refresh and subsequent navigation.   |
| Only videos shorter than | 20 minutes | Whole minutes from 1 to 20       | The comparison is strictly less than the selected limit. At 10 minutes, 9:59 is eligible and 10:00 is skipped. |

Transparency changes save after a short 200 ms debounce or the range control's
change event. Removing the panel during that debounce retains the last slider
change. Other controls save on change. Auto-start and duration edits apply from
the next video; they do not begin processing the video underneath the settings
view. Restored preferences can apply when a newly loaded page exposes an eligible
video, including after a page refresh. A saved off preference remains off. The
existing manual-start ceiling is 20 minutes (1,200 seconds), matching Android; an automatic
limit of 20 minutes still excludes a video lasting exactly 20:00. Existing saved
lower limits remain respected.

Native duration contract preflight read the [official Zalando guidelines](https://opensource.zalando.com/restful-api-guidelines/)
on 2026-10-04. Rules 106 and 118 preserve compatible JSON messages and snake_case
fields; REST route/status rules do not apply to this native IPC limit update.

## Duration and automatic playback

Automatic eligibility reads the already loaded `HTMLVideoElement.duration` and
media readiness. This decision makes no additional yt-dlp metadata request and
does not fetch a separate player API. An admitted processing request still uses
the existing guarded downloader and validates the acquired audio and complete
vocals timeline.

The extension checks that the route ID and the containing `ytd-watch-flexy`
element's `video-id` identify the same video. When available, the watch element's
public duration metadata must agree with the media duration. Captured
`loadstart`, `emptied`, `loadedmetadata` and `durationchange` events, together with
navigation boundaries, distinguish a reused player's previous media from the new
video. Source strings are compared in memory only; they are not persisted or
sent to the companion. An ad boundary requires evidence that the main video has
returned, preventing an ad's short duration from qualifying its longer video.

Only a playing, non-ended, non-seeking standard watch video with finite
positive duration can start automatically. Ads, live streams, unknown duration,
stale media and unsupported routes are skipped. An already paused video stays
paused and does not begin automatic preparation. Each video visit has one
automatic attempt, so repeated player events cannot create duplicate jobs.
Explicit navigation starts a fresh visit even when the selected video ID is the
same. That visit still waits for fresh main-video media. A late update to the
watch page's duration metadata also rechecks eligibility immediately.

The YouTube tab can be in the background or its window unfocused. Focus and page
visibility do not affect eligibility; a background video that is already paused
still waits for playback. The duration limit, main-video freshness, ad/live
checks and single-session rules apply equally to foreground and background tabs.

An eligible playing video pauses while MusicMute prepares the vocals. Once ready,
the existing playback path resumes the video and synchronizes the vocals. If
Chrome refuses the resume, the panel asks the user to press YouTube Play. Stop,
Cancel, selecting original sound, manual activation and terminal failure suppress
another automatic attempt for that visit. The waveform icon still provides
explicit manual activation.

The background controller independently reloads committed settings and checks
the strict duration limit and that the originating tab still exists before admitting an automatic
request. Automatic requests cannot replace another tab's active session, pending
start or stop handoff. Generation and ownership checks continue to reject late
results after Stop, navigation or a successor request.
On refresh, a new document in the same tab waits for the old document's cleanup
before admission. It cannot take another tab's session, and delayed messages from
the old document cannot reclaim playback.

## Local persistence and compatibility

Settings use `chrome.storage.local` in the current Chrome profile. They survive
Chrome restarts and ordinary extension updates, and storage-change subscriptions
apply committed values across open YouTube tabs. They are not Google-account
sync settings and require no account login, cookie access or new permission.
Removing the extension or clearing its storage can remove these preferences.

The storage schema is:

```json
{
  "musicmute.settings.v1": { "version": 1 },
  "musicmute.settings.v1.transparencyPercent": 5,
  "musicmute.settings.v1.autoStartEnabled": true,
  "musicmute.settings.v1.maxDurationMinutes": 10
}
```

Each field has its own key. Writes are serialized within a content context, and
independent edits in separate tabs cannot overwrite another field with a stale
whole-settings snapshot. Missing values use defaults. Numeric values are rounded
and bounded; auto-start accepts only a boolean. Completely absent settings use
the on default without writing to storage. A valid schema with no auto-start
field also uses that default. Explicit false is preserved; malformed values,
unsupported schemas and latent fields without a valid schema keep auto-start off.
Failure to read settings also keeps auto-start off.

The UI reports loading and saving failures rather than claiming a save succeeded.
Only restored or successfully committed values reach automatic playback. A
failed write preserves the previous active settings. Corrupt or unsupported
schema data with latent fields refuses partial repair, so changing transparency
cannot reactivate an old auto-start value. That failure exposes Reset settings;
the explicit reset atomically writes all three defaults and hides the recovery
button after success. The recovery button is absent from the normal view.

The content-to-background `MM_START` message adds an optional `intent` outside the
payload. Missing intent preserves existing manual behavior; recognized values
are `manual` and `automatic`. The native START payload remains exactly
`video_id`, `duration_seconds` and `provider`. Settings, page media URLs and
account data never become native START fields.

The official [Zalando RESTful API and Event Guidelines](https://opensource.zalando.com/restful-api-guidelines/)
were checked on 2026-10-02 for this contract preflight. Applicable principles are
compatible extension of the existing contract, conservative input validation,
explicit bounded values and safe errors. These are internal Chrome messages and
local storage, so REST resource paths, HTTP methods/status codes, public OpenAPI
registration and OAuth requirements do not apply. No HTTP endpoint or account
authorization contract changes as part of extension settings.

## Refresh and navigation validation (2026-10-04)

The current source passes typecheck, zero-warning lint, build, formatting and
**1,685 tests in 57 files** using `npm test -- --maxWorkers=4`. The initial
unbounded parallel run timed out in five companion filesystem tests; the full
bounded run passes without changing those tests or their timeouts.

An isolated desktop Chrome HTTP fixture using the compiled script/CSS passes
eight checks covering initial auto-start, refresh, next-video handoff, Stop,
same-video revisits, the duration limit, saved off and paused-page behavior. The
existing `npm run test:error-ui` fixture also passes all ten error/recovery checks.
Both fixtures use synthetic media and Chrome runtime state; neither loads an
extension, modifies the everyday browser profile or processes real YouTube audio.

The built extension is in `dist/extension/`. The installed app/extension has not
been updated by these source checks; activation requires loading the updated
extension. Existing saved off settings remain off. Real YouTube playback with
this updated extension still requires separate acceptance.

## Earlier validation evidence and remaining acceptance

At the 2026-10-02 settings checkpoint, `npm run verify` passed TypeScript checks,
zero-warning lint across 106 files, **777 tests in 38 files**, the extension build
and formatting. Coverage includes storage restoration, concurrent independent
field writes, malformed values, save failure, recovery, accessible controls,
pause/resume, strict duration boundaries, navigation/ad freshness, duplicate
events and background session/active-tab admission.

An ordinary HTTP browser fixture using the compiled script/CSS and synthetic
Chrome/video state observed saved settings after reload, 80% background
transparency, skipping a 600-second video with the 10-minute limit, automatic
preparation and resume for a 120-second video, and Stop suppression. This fixture
does not load an extension, call yt-dlp, use YouTube or prove real audio playback.

The installed Chrome extension still requires a manual Reload followed by a
YouTube page refresh to activate replacement code. Real Chrome/YouTube automatic
next-video behavior, ads, autoplay, selected audio and synchronized listening
remain separate acceptance checks. Source and fixture validation do not establish
which extension build is currently loaded in the browser.

The extension-only update was installed at `/Applications/MusicMute Local.app`
from build `dad51a73-81cb-495d-9d92-1a6ab10933d5`, based on the installed native
checkpoint `c482315f`. Only the three extension JS/CSS files, audit record and app
signature seal changed. Native executable code matched after removing signature
seals from temporary comparison copies; 11,312 other resource files matched the
previous installation byte for byte. Installed extension hashes matched the
compiled source, deep strict code signing passed, the downloader guard hash was
retained, and the atomic installer preserved the previous application bundle.
See [the local installation proof](../output/macos/build-dad51a73-81cb-495d-9d92-1a6ab10933d5.noindex/extension-update-proof.json)
and [the browser fixture preview](../output/settings-ui/116a676b-1703-4b88-b3e2-5b2c6cd1ee51/settings-panel.jpg).

## Background-tab correction (2026-10-03)

The initial settings implementation incorrectly required a visible document and
an active Chrome tab. Both focus restrictions have been removed. A playing
eligible next video can prepare and resume while YouTube stays in the background,
and changing tabs during settings loading no longer denies admission. The
background check still verifies that the originating tab exists and retains the
single-session reservation, duration limit, Stop and native-payload safeguards.

`npm run verify` passed typecheck, zero-warning lint across 109 files, **892 tests
in 40 files**, build and formatting. Focused regressions cover hidden-tab
preparation/resume, paused hidden videos, strict duration boundaries, inactive
senders/current tabs, switching away during settings loading, tab closure,
reservation cleanup and another tab's active playback.

The extension-only correction was installed at `/Applications/MusicMute Local.app`
from build `0a6df9fc-c6a3-4886-a20d-667514402f97`, retaining native checkpoint
`86ee4723`. Installed `background.js` and `content.js` hashes match the current
build, deep strict signing passes, native executable code matches before/after
resealing, and 11,313 other resources remain unchanged. The previous application
was preserved. The [installation proof](../output/macos/build-0a6df9fc-c6a3-4886-a20d-667514402f97.noindex/extension-update-proof.json)
also verifies the unchanged downloader privacy guard. Chrome Reload and a YouTube
page refresh are still needed to activate the installed replacement scripts.

An ordinary HTTP compiled-script fixture confirmed next-video handoff, preparation
and resume. The controlled pages reported visible at START, so that observation
is not claimed as real hidden-tab proof; hidden/inactive admission is covered by
the focused content/controller fixtures. Real YouTube sustained background
playback and browser autoplay/timer behavior still need loaded-extension acceptance.

A later whole-tree formatting check found a concurrently edited
`src/shared/protocol.ts` outside this correction. The touched source, tests and
documentation passed their scoped formatting check; that unrelated file was preserved.
