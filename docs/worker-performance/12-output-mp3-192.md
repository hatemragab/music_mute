# 12 — Encode final voice MP3 at 192 kbps while preserving source quality

**Status:** Local worker/backend recipe, encoding comparison and real-GPU
isolated job verified; listening approval remains pending. **Depends on:** 11.
Read [shared rules](EXECUTION-RULES.md) and [validation](VALIDATION.md).

## Objective and scope

Change final voice output from 320 kbps to 192 kbps consistently. A nominal bitrate
reduction of 40% suggests a similar size reduction for equal-duration CBR audio,
but actual bytes must be measured. This mainly affects storage/transfer; do not
attribute an inference speedup to MP3 bitrate.

Read `worker/engine/musicmute_engine/recipes.py`, `media.py`, `pipeline.py`,
`worker/src/platform/macos/runtime-recipes.ts`,
`backend/src/jobs/worker-recipes.ts`, job/attempt DTOs and presenters,
`backend/src/worker-fleet/protocol/v1/protocol.ts`, and recipe tests. Search the
repository for bitrate literals, recipe IDs/digests and output-format assumptions.
Inspect mobile clients for contract impact only; do not modify or test them here.

## Required work

1. Set the canonical output recipe to MP3 192 kbps and update engine arguments,
   validation, metadata, recipe identity/digests, fixtures and generated contracts
   together. Choose a coherent local-development recipe identity; do not leave
   mismatched hardcoded old digests.
2. Update all supported relevant recipe variants, including trim/denoise variants,
   while preserving their intended behavior. Do not change source bitrate,
   preparation sample rate/channels, model parameters or inference precision.
3. Keep the worker's source/input handling unchanged. A 192 kbps final-output
   requirement is not permission to lower or modify mobile uploads.
4. Update CLI/report/bundle and affected product descriptions to show the actual
   output bitrate. Read bitrate from validated runtime/result metadata where possible.
5. Use direct contract updates without migrations, backfills or dual recipe support
   solely for old local data. Use fresh local fixtures rather than deleting history.

## Validation and acceptance

Run recipe, pipeline, protocol, backend DTO/presenter and affected worker tests.
Generate 320 and 192 kbps files from the same separated PCM to isolate encoding.
Use FFprobe and decoded checks for codec, bitrate, duration, channels, sample rate,
finite audio and clipping; listen for audible encoding damage in quiet speech and
sibilance. Record actual bytes, encoding time and local transfer time if measurable.

Confirm input hash/preparation settings stayed constant. Run a local fresh job
through recipe claim, processing, output validation and playback artifact metadata.
Do not claim production or device playback proof from a local decode test.

## Handoff

Provide the canonical recipe/contract changes, size and timing comparison, quality
review, and mobile contract implications for a future task. Explicitly separate
encoding/file-size gains from GPU separation gains.

## Local result — 2026-09-23

Both supported Kim Vocal 2 recipes now declare a final 192 kbps MP3. The worker
engine's encoder reads the same catalog constant used by its recipe snapshot.
The backend catalog, job schema, completion DTO, worker runtime validation,
protocol step ID, acceptance fixtures and cross-language recipe digests have
been updated together. Recipe revision is 2; recipe IDs and source preparation
remain unchanged. The generated worker protocol copy was synchronized from the
backend source. The change is intentionally incompatible with old local
revision-1 claims; no migration or backfill was added. Historical 320 kbps
performance reports are still readable as benchmark evidence.

The input song still has SHA-256
`c5f3967c3509b1ce949cc2557a3d6d7465bf787befd1a5491162b35d79ef454f`.
Its upload/source quality, 44.1 kHz stereo preparation, model and MPS settings
were not altered. For an isolated encoding comparison, the same baseline
separated FLAC was trimmed once to a 7,024,689-sample stereo WAV. FFmpeg 8.0.3
then encoded that identical PCM three times at each bitrate with `libmp3lame`:

| Final encoding | Bytes per MP3 | Three encode seconds | Median |
| --- | ---: | --- | ---: |
| 320 kbps reference | 6,373,920 | 0.9972, 1.0053, 1.0038 | 1.0038 s |
| 192 kbps candidate | 3,824,369 | 1.0048, 1.0052, 1.0070 | 1.0052 s |

The 192 kbps result is 2,549,551 bytes, or 40.0%, smaller for this song.
Encoding time was effectively unchanged in these local samples. Smaller
output may reduce upload, storage and playback transfer time, but no network
transfer saving was measured here. It does not accelerate GPU separation.

FFprobe reported MP3, 44.1 kHz stereo, 159.290 s for both versions, and stream
bitrates of exactly 320,000 and 192,000 bit/s. Both decoded to 7,024,689
stereo samples; the 192 kbps decode had no non-finite or clipped samples.
The decoded 192-versus-320 sample RMS difference was 0.00581 with maximum
difference 0.12281. Those are expected lossy-encode differences, not a
listening-quality pass. Quiet speech and sibilance review remains pending.
Comparison WAV/MP3 artifacts are private under
`$HOME/.codex/musicmute-gpu-baseline-TbPvfE/encoding-*`.

Focused Python recipe/media tests, worker protocol/type checks, and backend
catalog/attempt tests passed after the contract change. Task 15 still needs a
fresh local claim-through-result run and complete changed-component gates.
Mobile clients were inspected read-only for hardcoded bitrate assumptions; no
Android/iOS source or device flow was changed or tested.
