# Android listening features

Branch: `hatem/android-listening-features`; isolated managed worktree from
`origin/main` at `1ac92dad`. Scope: the ten approved Android features. No backend,
iOS or production deployment changes. The primary checkout stays on main.

## Delivery sequence

1. Define account-scoped listening models, bookmarks, loop and timer rules.
2. Extend the existing Media3 service for silence skipping, A–B loops, sleep
   timers, safe playback resumption and a browsable Android Auto library.
3. Add home-screen widget and static launcher shortcuts. Route imports/library/
   player through the existing authentication and update gates.
4. Receive one granted audio content URI through the existing review pipeline;
   retain explicit rights confirmation before cloud submission.
5. Decode local audio into bounded cached waveform peaks. Render an accessible
   seek slider with actual peaks; keep original and output timelines separate.
6. Add bookmark, loop, timer, skip-silence and clip-sharing controls in a listening
   tools sheet, with English/Arabic resources, loading/error/cancel states.
7. Export user-selected voice segments locally; share only bounded private
   cache copies via FileProvider with temporary read grants.
8. Run JVM regression suites, both flavor builds/lint, compile framework tests;
   review permissions, account isolation, lifecycle, cancellation and diffs.
9. Commit and push the feature branch to GitHub; keep main unchanged.

## Architecture and acceptance

Reuse Media3 1.8, Compose, coroutines and existing file/queue repositories. Do not
add polling to server data. High-frequency position stays inside player children.
Bookmarks persist per owner/job/source; loops reset on track/source/account change.
Timers belong to the playback service and use monotonic time. Widget contents clear
on sign-out. Resume must not autoplay before a user/system request or cross an
account generation. Android Auto only accepts authorized controllers and serves
current-owner completed library items. External media IDs are resolved internally,
never trusted as URIs. Update gates remain authoritative.

Waveform decoding is cancellable, bounded, off-main and cached by file identity;
no fake waveforms, full PCM buffering or extra server conversion. Clips reuse
native media APIs and have duration/output-size bounds and age/count cleanup.
Share grants are read-only; account changes cancel private work.

## Sources

- https://developer.android.com/media/media3/session/serve-content
- https://developer.android.com/media/media3/session/background-playback
- https://developer.android.com/develop/ui/views/appwidgets
- https://developer.android.com/develop/ui/compose/system/shortcuts/creating-shortcuts
- https://developer.android.com/develop/ui/compose/sharing/receive
- https://developer.android.com/reference/androidx/media3/exoplayer/audio/SilenceSkippingAudioProcessor

## Proof boundary

Android runtime/UI/device tests are not authorized under the existing iPhone-only
rule. Compile instrumentation coverage but do not install on another device.
OEM widgets, Android Auto host behavior, audio fidelity, notification resumption,
file-provider grants and cold/warm navigation remain explicit device gates. Do not
call a build pass device proof or Play approval. No release/deployment is requested.
