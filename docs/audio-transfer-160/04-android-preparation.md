# 04 — Unify Android picked-media and YouTube preparation

**Status: implemented locally; physical-device proof pending.** Depends on tasks 01–03. Own Android
preparation, YouTube selection, policy parsing and upload admission.

## Source entry points

Paths below are under `android/app/src/main/java/com/hatem/musicmute/`:

- `processing/ProcessingMediaPolicy.kt`, `MediaSourceInspector.kt` and `AndroidAudioInspector.kt`
- `processing/AudioInputPreparer.kt`, `AudioPreparationEngine.kt` and `DecodedAudioValidator.kt`
- `processing/MediaPreparationWorker.kt`, `AudioUploadWorker.kt` and `S3FormUploader.kt`
- `download/YoutubeAudioDownloader.kt`, `AudioDownloadPolicy.kt` and `SourceDownloadBounds.kt`
- Existing tests under `android/app/src/test/java/com/hatem/musicmute/processing/`
  and `android/app/src/test/java/com/hatem/musicmute/download/`

## Planned work

1. Consume the new backend profile and update strict 256 kbps validation, local
   defaults and fixtures together. Reuse existing source inspection results to
   decide copy, compressed-track extraction/remux, or one encode.
2. Preserve supported compressed streams at or below 160 kbps. For video, use the
   selected audio stream's rate, not video bitrate. When encoding is needed,
   use the existing native AAC/M4A encoder at 160 kbps or the reviewed lower
   target for a known lower-rate incompatible source. No MP3-after-AAC pass.
3. Select the highest compatible YouTube audio-only stream at or below 160 kbps
   before download when reliable metadata exists. Prefer an exact 160 option;
   retain lower options unchanged. If only a higher supported option is available,
   download once within existing limits, then enter the same preparation path.
   Apply task 01's unknown-rate rule; do not guess from resolution or total bitrate.
4. Check the prepared upload against 50,000,000 bytes before starting upload.
   Preserve existing source limits, cancellation, foreground/background work,
   low-storage checks, temporary-file ownership and cleanup. Preparation/upload
   retries must reuse a valid prepared artifact instead of lossy re-encoding.
5. Preserve content identity, checksum, extension/MIME correctness and required
   request metadata. Reuse current progress and timings so preparation, download
   and upload remain distinguishable; do not invent an extra visible stage.

## Acceptance and validation

- Cover picked MP3/M4A, decodable WAV/lossless input, AAC video extraction, high-rate
  conversion, lower-rate pass-through, unsupported codec and unknown/VBR cases.
- Test YouTube stream choice and the fallback with deterministic metadata fixtures;
  no second media download or video-track download for an available audio-only path.
- Assert stream preservation and encoder invocation count, prepared-size boundaries,
  cancellation, retry reuse and cleanup. Include content-provider sources with
  missing size/bitrate and non-seekable streams without unbounded copying.
- Inspect Gradle tasks and run the applicable local unit tests/build/static checks.
  No Android device or emulator runs are authorized under the current device rule.
  Record mobile-runtime and physical-phone timing as pending until an explicit
  device exception is granted; do not substitute desktop encoding measurements.
- Handoff: route matrix, unit/build results, prepared sizes and device-proof gaps.
