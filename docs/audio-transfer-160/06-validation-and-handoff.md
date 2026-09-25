# 06 — Validate the complete flow and compare time/quality

**Status: automated validation in progress; integrated timing and listening pending.** Depends on tasks 01–05. Own the
cross-component acceptance report and updates to the operator/developer guidance.

## Functional matrix

Use private task-owned fixtures covering short, three-minute and near-limit
durations, plus the previously approved full-length song identified by fixture
hash. Do not commit user audio or personal filesystem paths.

| Case | Required evidence |
| --- | --- |
| MP3/AAC at 64, 96, 128 and 160 kbps | Compatible payload copied/extracted; no encoding; final MP3 does not raise the known rate. |
| MP3/AAC at 192, 256 and 320 kbps | Exactly one mobile encode targeting 160; one final worker MP3 encode. |
| Decodable WAV/lossless and video | Compressed audio-only upload; correct selected track, duration and channel handling. |
| Server URL imports | Audio-only acquisition, provider title persistence, bounded transfer and S3 handoff; no device extraction. |
| VBR/missing metadata/unsupported low MP3 rate | No fabricated rate; approved edge-case behavior; no extra full media scan. |
| 49,999,999 / 50,000,000 / 50,000,001 bytes | Mobile admission and backend declared/actual size boundary tests. |
| False size/MIME/rate hints and malformed files | Existing ownership/media validation protects processing and reports useful errors. |
| Cancellation, retry, app resume and worker failure | No unnecessary re-encode, stale prepared artifact, duplicate completion or leaked temporary files. |

## Performance and listening evidence

1. Compare the same input, same GPU/model, one active job and one inference window
   against the previous candidate. Keep cold/warm runs distinct. No CPU model
   benchmarks and no claim that a lower bitrate accelerates neural inference.
2. Record source download, inspection/preparation, upload, queue, worker download,
   probe/decode, GPU separation, final encoding and result upload separately.
   Use existing measurements; do not add another inspection stage for the report.
3. Compare complete preparation-plus-upload time and complete user wait, not just
   bytes transferred. Report source/prepared/output bytes and observed throughput;
   distinguish measured transfers from calculated estimates and simulated links.
4. For three-minute, 160 kbps audio, 3.6 MB is an approximate payload calculation,
   not a measured file size. Container overhead and VBR behavior can change it.
   Lower-rate sources should not be inflated solely to reach the cap.
5. Repeat bounded comparable runs and report the median/range, device/runtime
   identity, thermal/network conditions and sample count. Five seconds remains
   a target to measure, with any slower cases reported explicitly.
6. Listen to decoded final vocal audio, including quiet speech, sibilants, music
   leakage, transients, stereo handling and seams. Compare the existing candidate,
   mobile-compressed input and final MP3 to identify quality losses from each
   encode. Matching bitrate numbers or valid output is not a listening pass.

## Validation boundaries and completion

- Run focused component tests first, then required backend/worker verification
  and applicable Android/iOS checks after resolving actual failures. Exercise the
  joined API/storage/worker flow with isolated local services and fixtures.
- Respect the device rule in the README. Android physical/device proof requires
  an explicit exception; physical iOS timing also needs an authorized phone.
  The allowed simulator can prove flow behavior, not physical-phone speed.
- Do not stop a busy worker or use production services for a timing experiment.
  Recheck GPU availability/exclusivity when testing begins.
- Update the operator guide to explain selected output rate, unknown metadata,
  upload-size rejection, recipe/profile mismatch and preparation-versus-separation
  timing using existing CLI commands.
- Report tested code/runtime identity, before/after measurements, actual commands,
  listening verdict, failed cases and gaps. Keep implementation complete,
  integration verified, device verified and quality approved as separate statuses.
- This task does not authorize commits, publication, deployment or installing a
  candidate into the user's running worker. Prepare a clear handoff for those
  actions if they are requested later.

## Local implementation handoff (2026-09-23)

The candidate is in branch `hatem/worker-gpu-processing-performance` only.
Backend and mobile agree on profile `audio-cap-aac-lc-160-v1`; the worker recipe
is revision 3 with `encode-mp3-up-to-160k-v1`. The worker's existing ffprobe
call reads audio bitrate, and the final result and CLI performance cohort use
the selected encoded MP3 rate. The model's live inference remains one window per
call. Earlier 192 kbps and grouping reports are historical comparisons only.

Verified locally:

- Backend `pnpm run verify` passed before the final storage boundary assertion;
  the focused `pnpm exec vitest run src/storage/storage-transfers.service.spec.ts`
  then passed all 11 tests. Backend `pnpm run format:check` passed.
- Worker `pnpm run verify` passed after the final CLI report change: 262 TypeScript
  tests passed, 2 skipped; 51 Python engine tests passed; build and formatting
  passed. This used the installed worker's Python runtime for dependencies.
- Android `:app:testDirectDebugUnitTest :app:assembleDirectDebug` passed. The
  private Firebase config was linked only during the build and its worktree link
  was removed afterward. No Android device test was run.
- iOS `xcodebuild ... test` passed on the specified iPhone 17 Pro / iOS 26.0
  simulator with parallel testing disabled: 168 unit tests passed, 1 skipped;
  10 UI tests ran, 2 skipped, 0 failures. The private Firebase config link
  was removed afterward. Changed Swift files passed `swift-format lint`.
- `git diff --check` passed. The 50,000,000-byte boundary is tested in mobile
  policies and backend declaration validation; backend storage confirmation
  rejects an actual object larger than its reservation.

Not yet verified: physical-phone preparation/upload time, a complete transfer
through deployed backend/storage/worker versions, GPU separation timing with
this exact recipe, and listening quality of a final 160 kbps vocal result. The
existing local MPS worker was running, so this validation did not stop it or run
a competing GPU benchmark. Release requires coordinated mobile, backend and
worker versions because the profile and recipe identifiers changed.
