# 05 — Unify iOS picked-media preparation

**Status: implemented locally; physical-device timing pending.** Depends on tasks 01–04. Own iOS
policy, import/export and prepared-upload admission.

Updated 2026-09-26: device URL acquisition is removed. See [removal evidence](../mobile-url-acquisition-removal.md).

## Source entry points

- `ios/Vocal/Processing/ProcessingMediaPolicy.swift` and `MediaSourceInspector.swift`
- `ios/Vocal/Processing/AudioInputPreparer.swift` and `AudioPreparationEngine.swift`
- `ios/Vocal/Processing/PreparedInput.swift` and `MediaPreparationCoordinator.swift`
- Existing preparation, upload and policy tests under `ios/VocalTests/`

## Planned work

1. Update the strict 256 kbps policy reader and native encoder target to the
   reviewed shared policy. Reuse AVFoundation inspection while the asset is
   already open; do not export a second file merely to determine its bitrate.
2. Preserve compatible compressed audio at or below 160 kbps. Extract/remux the
   selected video audio track when possible. Encode once with the existing native
   AAC/M4A path when required, honoring known lower rates and the unknown policy.
   Avoid WAV upload and avoid a second conversion to MP3 on the phone.
3. URL acquisition is server-only through `/media-imports`; no phone source
   downloader or stream-selection package is bundled.
4. Enforce 50,000,000 prepared-upload bytes before upload begins. Keep existing
   source limits and preserve security-scoped file access, background upload
   receipts, cancellation, insufficient-space errors and cleanup. Reuse valid
   prepared artifacts on resume/retry without repeated lossy encoding.
5. Keep policy fields, prepared metadata, content type/extension, checksum and
   backend requests aligned. Use current progress/timing infrastructure to expose
   any longer encoding time honestly; do not promise a five-second finish.

## Acceptance and validation

- Match Android's shared decision fixtures for lower/equal/higher rates, video,
  lossless sources, unsupported input, unknown metadata, VBR and size boundaries.
- Verify output duration and decodability, pass-through payload preservation,
  one encoder pass when needed, and no repeated preparation on recoverable upload resume.
- Inspect the current Xcode scheme/test instructions. For device/UI tests use
  only iPhone 17 Pro / iOS 26.0 simulator
  `3CC14436-EC3C-4419-A079-C84951E5FA07`, explicitly selected with parallel testing
  disabled. Do not create clones or substitute a different destination.
- If the authorized simulator is unavailable, report the runtime-test blocker;
  complete available static/build checks. Physical-phone preparation speed remains
  unproven even if simulator tests pass.
- Handoff: parity report, commands actually run, simulator evidence where available,
  prepared-file sizes and remaining physical-device quality/performance gaps.
