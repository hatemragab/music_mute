# Audio pipeline specification

## 1. Source-derived behavior versus new decisions

The attached [separate.py](../reference/separate.py) is the authoritative reference for current audio preparation, Kim selection, gap trimming and MP3 defaults. It is not the new fleet architecture. The line-level review is in [TRIMMER-REVIEW.md](../reference/TRIMMER-REVIEW.md).

**Source facts:** input is prepared as nonempty PCM16 stereo 44,100 Hz WAV; Kim Vocal 2 returns the vocal stem via FLAC; trimming always runs; output is MP3 at 192 kbps by default; the script has no noise-reduction step. Its loader explicitly requires DirectML, so it cannot be reused unchanged as the Apple runtime. Its local file-polling IPC is not a backend protocol.

**New MVP decisions:** support real trim enable/disable, an optional conservative denoise step, immutable recipes, dashboard policy, and cross-platform acceleration. Start with the script-compatible default: trim **on**, denoise **off**. These added features are design choices, not capabilities already present in the attachment.

## 2. Fixed execution order

```text
Pinned S3 input download and checksum verification
    → Validate/probe local media and limits
    → Prepare PCM16 stereo 44.1 kHz WAV
    → Kim_Vocal_2.onnx, voice-only separation
    → Optional denoise
    → Optional reference-compatible gap trimming
    → MP3 encoding
    → Validate final audio, measure duration, hash bytes
    → Attempt-scoped S3 upload and conditional completion
```

All steps use an attempt-local directory. Filenames are generated from trusted identifiers, not user titles. Validate duration after decode, since declarations alone are not trusted. Bound decoded sample count, disk use, subprocess time, output size and media metadata. FFmpeg reads a local file and must not fetch arbitrary playlist/network inputs. Enforce a local-media protocol policy and safe argument arrays; never assemble shell commands from request values.

Use the pinned separator's existing preprocessing/model implementation behind a small adapter. Do not hand-reimplement STFT, overlap-add or Kim tensor layouts unless actual compatibility requires it and regression evidence is supplied. On warm workers reset per-file state between jobs without unloading the inference session; isolate mutable work directories and test two successive jobs for cross-contamination.

## 3. Gap trimmer: exact semantics to preserve

The v1 step is `trim_vocal_gaps`, not an edge-only trim and not FFmpeg `silenceremove` under a new name.

| Property             | Reference behavior                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------ |
| Analysis window      | `max(1, round(sampleRate * 0.01))`, nonoverlapping nominal 10 ms windows                                     |
| Level estimate       | RMS per channel, then use the **largest** channel RMS                                                        |
| Threshold            | Strictly below `10 ** (thresholdDb / 20)`; default -45 dBFS                                                  |
| Partial final window | Compute RMS from its actual sample count                                                                     |
| Eligible run         | Silent duration at least `round(minSilenceSeconds * sampleRate)`; default 0.8 seconds                        |
| Padding              | Preserve 0.2 seconds next to adjacent non-silent phrases; do not add imaginary padding outside the recording |
| Cut locations        | Leading silence, trailing silence, **and qualifying internal gaps**                                          |
| Retained boundaries  | Up to 5 ms linear fades, limited to half a retained region; no overlap/crossfade shortening                  |
| All below threshold  | Preserve the recording rather than return empty output                                                       |
| PCM output           | Explicit nearest-integer `rint`, clipping and int16 conversion; preserve existing quantization               |

Read samples in bounded blocks. The reference still allocates masks proportional to the number of 10 ms windows and interval lists; it is not strictly constant-memory. Apply the job-duration bound and measure memory with the largest allowed fixture.

Preserve validation: finite numeric values, `thresholdDb < 0`, `minSilenceSeconds > 0`, `paddingSeconds >= 0`, and `2 * paddingSeconds < minSilenceSeconds`. Reject invalid input rather than silently clamping it. Empty media is rejected before the trimmer.

Examples at defaults: tone 1 s + silence 1 s + tone 1 s becomes 2.4 s; silence 1 s + tone 1 s + silence 1 s becomes 1.4 s; an all-silent 1 s file stays 1 s. These cases were checked only against the provided trimmer, not through Kim.

When trim is disabled, omit this step entirely. Do not pass a threshold that approximates disabling it. Preserve original timing, apart from normal codec framing/padding, and do not apply the trimmer's fades. The old `--trim_silence` flag cannot disable trimming; do not carry this UI bug into the new contract.

## 4. Optional noise reduction

**MVP choice: FFmpeg `afftdn`, preset `afftdn-conservative-v1`, disabled by default.** This reuses the already-required FFmpeg runtime. It is an FFT-based filter; its parameters include reduction and noise floor. FFmpeg's RNN-based `arnndn` alternative is speech-oriented and requires an additional model. [T7]

The selection is for implementation simplicity, not a claim that it is the highest-quality denoiser for every recording. Voice/singing quality must be reviewed on rights-cleared real samples before enabling it as a default. Noise reduction is not another music separator and should not be advertised as guaranteed removal of all noise.

Proposed fixed starting preset:

```text
afftdn=nr=6:nf=-50:tn=0:gs=3
```

These values are our conservative initial choice, not a measured universal optimum. Do not expose arbitrary FFmpeg filter strings. Use a typed, allowlisted preset ID. Test the selected FFmpeg build for the filter and parameters; unsupported builds fail capability validation rather than silently ignoring denoise.

Run denoise **after separation and before gap trimming**, to avoid feeding cut discontinuities to it. Use a lossless floating-point intermediate where needed, preserve sample rate/channels, and avoid repeated lossy encoding. With denoise off, the trimmer must see the unchanged separated stem so its parity tests remain meaningful.

Evaluate clean speech, noisy speech, singing, quiet phrases, stereo imbalance and all-silent input. Measure noise reduction only on controlled noise-only sections, and separately inspect distortion/word retention on vocal sections. Do not pass a quality gate simply because file hashes differ or the whole clip got quieter. Retain A/B fixtures privately or as rights-cleared test assets. If the preset harms content, keep it disabled and report the issue; do not substitute a no-op.

## 5. Recipes and immutable configuration

Support four named combinations rather than a workflow editor:

| Dashboard label                        | Recipe ID                    | Trim | Denoise              |
| -------------------------------------- | ---------------------------- | ---- | -------------------- |
| Kim Vocal 2                            | `kim-vocals-v1`              | Off  | Off                  |
| Kim Vocal 2 · Gap trimming             | `kim-vocals-trim-v1`         | On   | Off; initial default |
| Kim Vocal 2 · Denoise                  | `kim-vocals-denoise-v1`      | Off  | On                   |
| Kim Vocal 2 · Denoise and gap trimming | `kim-vocals-denoise-trim-v1` | On   | On                   |

All four recipes use the verified `Kim_Vocal_2.onnx` model. The `v1` suffix is
the immutable recipe-contract revision; it is not the Kim model generation.
Operator-facing surfaces display **Kim Vocal 2** as the model and show the raw
recipe ID only as secondary contract metadata. Renaming these IDs would break
queued-job snapshots, capability matching and deterministic recipe digests.

A recipe snapshot contains the recipe ID/revision, model filename and verified artifact digest, ordered step versions/parameters, encoder/bitrate, preparation profile, and a deterministic recipe digest. The backend chooses and stores it when creating the job. Unknown steps, fields, URLs or digest mismatches are rejected.

The runtime reports both **installed validated capabilities** and **allowed policy**. Effective eligibility is their intersection, narrowed by any child-worker override. The dashboard changes new-job defaults separately from machine/worker allowlists.

Example: the fleet default is denoise+trim. The owner disables denoise for the Z440. New denoise jobs must use the M4 or remain queued with an accurate capacity explanation. They must **not** silently run on the Z440 without denoise. The owner can change the global default to a non-denoise recipe for future submissions. Existing jobs, including retries on another machine, keep their old recipe.

Policy changes have `desiredRevision` and `appliedRevision`. Apply admission changes between jobs; active jobs continue their snapshot unless explicitly cancelled. Removing a model/runtime needed by an active attempt waits for drain. Per-worker overrides can narrow but not exceed machine capabilities/capacity. A replacement process inherits its stable slot policy.

## 6. Output contract and timing metadata

Keep the current product's voice-only MP3 as the required output, with `audio/mpeg` and a default 192 kbps bitrate. Allow only the reference bitrate set if configuration exposes it: 64, 96, 128, 192, 256, 320 kbps. Do not add instrumental output or multistem billing/client changes in this MVP.

Record source/measured input duration, final output duration, removed samples, sample rate, recipe digest, and per-stage times. When trim removes internal intervals, a single leading offset cannot describe alignment. Keep retained source sample ranges and corresponding output ranges, or an equivalent compact edit map, in attempt metadata. Report separately if only codec padding explains a small encoded-duration difference.

The no-denoise trim-on path must match reference PCM16 output for the same separated input. Do not require bit-identical Kim model results across CoreML/DirectML floating-point implementations. Require validity and explicitly bounded quality/numerical regression checks on common fixtures.

Output uploads use fresh attempt-specific keys and pinned S3 versions. The client-visible job reference is assigned only by successful backend finalization.

## 7. Model/artifact manifest

Record filename `Kim_Vocal_2.onnx`, provenance, verified SHA-256 hexadecimal digest, byte size, download location, redistribution/license notes, runtime compatibility, inference settings and recipe version. Do not infer a model version from a guessed number or use the original roadmap's illustrative size/hash.

Download/cache by content digest, verify before use, and keep old model artifacts required by a rollback. Dependency pins must come from branch B feasibility tests. Do not use a compatible GPU vendor as evidence that the actual Kim graph is accelerated.

The benchmark fixture is a versioned rights-cleared asset uploaded once by the owner/backend test harness to a scoped S3 location. Installer services download it with a scoped grant and upload a small result only under a fixture-specific grant. They never receive S3 account credentials.

Future Demucs/MDX/dereverb/normalize/bass/drum/karaoke steps fit this recipe boundary, but are not installed or implemented now.
