# Validation — 2026-09-29

## Scope and delivery

Implementation lives only on `hatem/android-listening-features`, based on
`main` commit `1ac92dad`. The primary checkout and production were not changed.
No dependencies or runtime permission prompts were added. The playback service
is now exported for media discovery, with Media3 controller authorization and
current-owner/update admission checks before returning or playing media.

## Local checks

Run from `android/` with JDK 17 and SDK 36:

```sh
./gradlew :app:assembleDirectDebug :app:assemblePlayDebug \
  :app:lintDirectDebug :app:lintPlayDebug \
  :app:testDirectDebugUnitTest :app:testPlayDebugUnitTest \
  :app:compileDirectDebugAndroidTestKotlin
```

- Direct: 297 JVM tests passed, zero failures/errors/skips.
- Play: 277 JVM tests passed, zero failures/errors/skips.
- Both debug APKs assembled; both lint tasks passed with warnings.
- Android framework test sources compiled. They were **not executed**.
- `git diff --check` passed.
- Build uses the existing ignored local Firebase client config. It is not included
  in the branch. No signing credentials were copied or changed.

The new JVM tests cover loop/clip boundaries, sleep duration bounds, bookmark
owner/job/source isolation, corruption recovery, size limits and atomic storage.
A legacy-browser regression also covers bounded pagination, More folders and overflow.
Existing playback, queue, ownership, processing, UI presentation and update tests
also ran. The opt-in runner accepts `-e check listeningFeatures` for synthetic
WAV waveform/cache/clip checks plus share URI and shortcut identity validation.
The framework runner creates and deletes only its own synthetic fixtures.

Initial compiler/lint findings were fixed: resource names, Compose snapshot reads,
and the Android Auto media-search intent/handler. Existing dependency-update,
Android API and style lint warnings remain; lint success is not warning-free.

## Implemented limits and behavior

- A–B loop boundaries are enforced by the service at up to 100 ms intervals;
  these are listening loops, not sample-accurate editing. End-of-media pausing
  prevents advancing the queue past a loop ending at the track boundary.
- Timed sleep uses elapsed realtime; end-of-track stops at the media boundary.
  Timers/loops/silence selection are session controls, not persisted reboot jobs.
- Waveform PCM decoding is local, streaming, cancellable and bounded to three-hour
  inputs / a two-minute decoding watchdog, with 240 cached peak bins per source.
  PCM16 is supported; unsupported decoder output reports a recoverable failure.
- Clips are local PCM WAV, 0.5–300 seconds and at most 64 MB. Normal player audio
  stays unchanged. Old temporary outputs are pruned on subsequent exports, with
  retained files bounded by count/bytes; logout clears listening cache files.
- Shared inputs must be a single audio content URI. Temporary read grants are
  copied into durable private intake files (100 MB each, bounded owner storage)
  before queuing the existing review flow. No raw filesystem URI is accepted.
- Bookmarks are per account/job/source, limited to 100 with 80-character labels.
  Account deletion clears their private directory; sign-out does not expose them
  to another account. Waveforms/clips are discarded on sign-out.
- Car browse/search only returns visible completed tracks. System recent/resume
  uses the existing account-scoped queue. Missing auth, mandatory updates,
  unavailable files and unsupported host behavior can prevent playback.

## Not proven by local checks

No Android phone, emulator, Android Auto host, or Play track was used. Existing
instructions authorize only the named iPhone simulator for device/UI tests; it
cannot validate these Android features. Required release checks remain in
TASKS.md: cold/warm intents, temporary grant lifetime, widget resizing, background
playback/timer/loop behavior, waveform/clip fidelity, Auto integration, TalkBack,
large fonts, Arabic RTL and OEM system resumption. No production deployment or
store approval is claimed.
