# 04 — Unify Android picked-media preparation

**Status: implemented locally; physical-device proof pending.** Depends on tasks 01–03. Own Android
preparation, policy parsing and upload admission.

Updated 2026-09-26: device URL acquisition is removed. See [removal evidence](../mobile-url-acquisition-removal.md).

## Source entry points

Paths below are under `android/app/src/main/java/com/hatem/musicmute/`:

- `processing/ProcessingMediaPolicy.kt`, `MediaSourceInspector.kt` and `AndroidAudioInspector.kt`
- `processing/AudioInputPreparer.kt`, `AudioPreparationEngine.kt` and `DecodedAudioValidator.kt`
- `processing/MediaPreparationWorker.kt`, `AudioUploadWorker.kt` and `S3FormUploader.kt`
- Existing tests under `android/app/src/test/java/com/hatem/musicmute/processing/`

## Planned work

1. Consume the new backend profile and update strict 256 kbps validation, local
   defaults and fixtures together. Reuse existing source inspection results to
   decide copy, compressed-track extraction/remux, or one encode.
2. Preserve supported compressed streams at or below 160 kbps. For video, use the
   selected audio stream's rate, not video bitrate. When encoding is needed,
   use the existing native AAC/M4A encoder at 160 kbps or the reviewed lower
   target for a known lower-rate incompatible source. No MP3-after-AAC pass.
3. URL acquisition is server-only through `/media-imports`; no phone source
   downloader or stream-selection package is bundled.
4. Check the prepared upload against 50,000,000 bytes before starting upload.
   Preserve existing source limits, cancellation, foreground/background work,
   low-storage checks, temporary-file ownership and cleanup. Preparation/upload
   retries must reuse a valid prepared artifact instead of lossy re-encoding.
5. Preserve content identity, checksum, extension/MIME correctness and required
   request metadata. Reuse current progress and timings so preparation
   and upload remain distinguishable; do not invent an extra visible stage.

## Acceptance and validation

- Cover picked MP3/M4A, decodable WAV/lossless input, AAC video extraction, high-rate
  conversion, lower-rate pass-through, unsupported codec and unknown/VBR cases.
- Validate server URL imports separately from native local preparation.
- Assert stream preservation and encoder invocation count, prepared-size boundaries,
  cancellation, retry reuse and cleanup. Include content-provider sources with
  missing size/bitrate and non-seekable streams without unbounded copying.
- Inspect Gradle tasks and run the applicable local unit tests/build/static checks.
  No Android device or emulator runs are authorized under the current device rule.
  Record mobile-runtime and physical-phone timing as pending until an explicit
  device exception is granted; do not substitute desktop encoding measurements.
- Handoff: route matrix, unit/build results, prepared sizes and device-proof gaps.
