# 160 kbps mobile upload and worker output plan

**Status: implemented locally in the isolated worktree; release and physical-device validation pending.**

Prepared on 2026-09-23 in `hatem/worker-gpu-processing-performance`. The checkout
already contains earlier worker implementation changes. This follow-up was
authorized separately and implemented here; `main` remains untouched.

Updated 2026-09-26: mobile source downloaders are removed; see
[the cleanup and validation record](../mobile-url-acquisition-removal.md).

## Agreed behavior

- Mobile prepares picked local audio/video before upload using this bitrate policy: preserve a supported compressed audio stream
  when its known bitrate is at or below **160,000 bits/s**; encode once at
  160,000 bits/s when it is higher. Do not raise a known lower bitrate.
- URL acquisition is server-only through `/media-imports`. No source media is
  downloaded or prepared on the phone for a URL import.
- Extract the selected audio track from video. Upload compressed audio, not an
  uncompressed WAV. WAV remains a possible picked source when the platform can
  decode it. Preserve compatible MP3/AAC uploads; reuse native AAC/M4A for required
  mobile encoding rather than forcing another MP3 conversion.
- Mobile checks the prepared upload against **50,000,000 bytes** before issuing
  the upload. Backend also enforces that maximum, including actual object size.
- Backend does not convert media. Worker decodes the uploaded audio as part of
  its existing processing flow and encodes the final vocal result as MP3 at no
  more than 160 kbps. A known lower input rate selects a supported output rate
  no higher than that input rate.
- Reuse existing inspection, preparation, validation and encoding steps. Do not
  add a bitrate inspection job, a second full decode just to measure bitrate, or
  a backend transcoding stage. Normal validation remains required.
- Keep one GPU job and one window per inference call. No model changes or CPU
  inference benchmarks are included. Lower bitrate targets transfer size, not
  faster GPU separation.
- Local development permits coordinated breaking contract changes. Update all
  producers, consumers, fixtures and tests together; no migrations, backfills,
  dual formats for legacy clients, or compatibility adapters.

The 160 kbps value is an audio encoding target/average-rate policy, not a promise
that every variable-bitrate packet is below 160 kbps. Container overhead does not
count as audio bitrate. This distinction must be consistent across platforms.
Reducing bitrate is lossy; equal bitrates across AAC and MP3 do not imply equal
quality. Listening validation remains necessary.

## Implemented decision table

| Selected source audio | Mobile upload | Worker final MP3 |
| --- | --- | --- |
| Supported MP3/AAC with known rate at or below 160 kbps | Preserve compatible stream; extract/remux video audio when needed | Highest supported MP3 rate no greater than known input rate |
| Known rate above 160 kbps or decodable WAV/lossless | Encode once to AAC/M4A targeting 160 kbps | 160 kbps maximum |
| Missing or unreliable rate | Encode once to AAC/M4A targeting 160 kbps | Use the probed rate if available; otherwise 160 kbps |
| Known rate below 32 kbps at worker intake | Mobile preserves supported stream | Reject because the current 44.1 kHz MP3 output profile cannot preserve that ceiling |
| Malformed media, ambiguous default audio track, or prepared upload above 50,000,000 bytes | Check container/tracks/duration/size before upload; checksum the prepared bytes | Worker independently validates and decodes downloaded media during processing |

The new preparation profile is `audio-cap-aac-lc-160-v1`. The worker recipe uses
revision 3 and step `encode-mp3-up-to-160k-v1`. The final MP3 bitrate is a
measured per-job result, while the recipe's 160 kbps value is its maximum.

## Scope and relationship to the earlier tasks

This package includes Android, iOS, backend and worker CLI planning. For this
follow-up it supersedes the old source-quality-preservation/192 kbps output
decision and the mobile exclusion in [the earlier worker package](../worker-performance/README.md).
That package's evidence remains historical; do not rewrite previous measurements
or mark its old results as proof of the new 160 kbps behavior.

Source review found native mobile encoders and policy validators expecting
256 kbps, backend policy publishing that target, worker recipes naming
`encode-mp3-192k-v1`, and an existing worker `probe_audio` call. The current
candidate updates these paths together. Historical reports retain their old
recipe and bitrate identities.

## Execution order

Tasks 01–05 are implemented locally. Task 06 has automated validation but still
needs physical-device timing, integrated transfer/GPU measurements and listening
approval. Keep the candidate local until those checks and deployment are approved.

| Order | Task | Dependency and result |
| --- | --- | --- |
| 01 | [Define bitrate policy and contract cases](01-policy-and-contracts.md) | First: one decision table for all components and explicit edge-case decisions. |
| 02 | [Update backend policy and upload protection](02-backend-policy-and-size.md) | 01: publish the policy and enforce declared/actual upload size without transcoding. |
| 03 | [Update worker output and CLI diagnostics](03-worker-output-and-cli.md) | 01–02: reuse the input probe and produce MP3 at the selected rate. |
| 04 | [Unify Android picked-media preparation](04-android-preparation.md) | 01–03: prepare once, enforce size, and upload with consistent metadata. |
| 05 | [Unify iOS picked-media preparation](05-ios-preparation.md) | 01–04: match the same behavior using existing native media APIs. |
| 06 | [Validate the complete flow and compare time/quality](06-validation-and-handoff.md) | 01–05: measured transfer/preparation totals and reviewed vocal output. |

## Review decisions and limits

- Unknown or unreliable bitrate: reuse metadata from existing inspection. If
  still unknown, encode once at 160 kbps as the user approved. This can enlarge
  a lower-rate source; never claim its original rate was preserved.
- URL audio is acquired by the server through `/media-imports`. Mobile preparation
  applies only to picked local files. Phone extraction packages are removed.
  Picked compatible audio retains bounded inspection and checksum checks without
  a redundant complete decode on the phone.
- MP3 supports particular bitrate/sample-rate combinations. Propose the nearest
  supported rate at or below the requested rate; document very-low-rate sources
  that cannot meet this without changing output sample rate. Do not silently
  up-rate or introduce a new downsampling policy.
- The 50 MB rule here governs the prepared upload. Server acquisition,
  local source-file, duration and preparation-resource limits remain in force unless
  the user separately changes them. This plan does not authorize importing an
  arbitrarily large original file just because it could shrink below 50 MB.
- Five-second preparation is a measurement target, not a guarantee. Higher-rate
  input needs an encode to meet the cap, which can take longer and can outweigh
  the upload saving on fast networks.
- Device/UI runs are restricted to the existing iPhone 17 Pro / iOS 26.0 simulator
  `3CC14436-EC3C-4419-A079-C84951E5FA07`, with parallel cloning disabled. Android
  unit/build checks are allowed, but Android device tests and physical-phone
  timing require a later explicit device exception. Simulator timing is not
  proof of preparation time on physical phones.

## Handoff rules

The completed work is local only. No commit, installation, publication,
deployment or database change has been made. The operator must validate the
candidate with isolated services and task-owned fixtures before release. No
production test or destructive state cleanup is implied.

Each completed task must report behavior before/after, affected files/contracts,
actual validation results, known gaps and the next task's prerequisites. Keep
audio, credentials, signed URLs, model weights and personal paths out of tracked
reports. Use fixture IDs and private ignored artifacts for quality evidence.
