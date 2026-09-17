# Review of the supplied separate.py

## Basis and limits

This review describes the attached file, not a replacement algorithm. The unchanged reference is [separate.py](separate.py), SHA-256 `b376a185d24811560fbc6cc681542517e61130a6d737077360ace5f502a32f1d`. Line numbers below refer to that exact attachment. Product additions and external research are separately identified.

The file is a local DirectML Kim Vocal 2 processing script with file-based IPC. It does not implement the new distributed machine/worker architecture, enrollment, backend leases, S3 grants, dashboard policy or safe updater. Preserve the useful signal-processing behavior without restoring the deleted old worker architecture.

## Source-derived behavior

| Section | Lines | Actual behavior |
| --- | --- | --- |
| `trim_vocal_gaps` | 19–114 | Detects and removes qualifying silent regions, including internal gaps |
| `prepare_audio` | 117–164 | FFmpeg decodes first audio stream to PCM16 stereo 44.1 kHz WAV; prepared path validates exact nonempty format |
| `load_separator` | 167–183 | Forces DirectML, requires `DmlExecutionProvider`, loads `Kim_Vocal_2.onnx`, writes only Vocals as FLAC |
| `process_audio` | 186–279 | Reuses loaded model, resets per-file paths, separates, always trims, encodes MP3, reports timing |
| Local protocol helpers | 282–302 | Bounded JSON writes with replace and Windows-specific short sharing-denial retry |
| `serve` | 305–391 | Loads model once, accepts local requests, processes sequentially and returns sanitized status/timings |
| `main` | 394–483 | Parses local CLI options, validates numeric trimming constraints and checks FFmpeg |

### Detection semantics to preserve

Read float32 samples in chunks. Group them into non-overlapping windows of `max(1, round(sample_rate * 0.01))` samples. Compute RMS separately per channel and take the maximum channel RMS. One loud channel therefore keeps that window nonsilent. A partial final window uses its actual sample count.

A window is silent only when its RMS is strictly less than `10 ** (threshold_db / 20)`. Default threshold is **−45 dBFS**. Complete-window RMS is cast to float64 before comparison to preserve the source's comparison behavior.

Adjacent silent windows form runs. A run qualifies when its sample duration is at least `round(min_silence * sample_rate)`, with default minimum **0.8 seconds**. For an internal run, the source retains **0.2 seconds** at each side by default and cuts the remainder. Leading/trailing silence has padding only next to the retained audio, not outside the recording.

Retained ranges are written in order. Internal boundaries receive linear **5 ms** fades, limited to half the retained range. These are fade-in/fade-out operations, not overlapping crossfades. The source rounds to PCM16 using `np.rint`, clips to the PCM16 range, and writes integer samples. Changing this to float WAV writing can change quantization and is not parity.

If no retained range remains, the entire source is preserved and a warning is emitted. The design must keep this all-silent fallback instead of returning empty audio.

Sample IO is chunked, but silence masks and interval arrays grow with recording duration. Describe this as bounded-by-input and much smaller than loading all audio, not mathematically constant memory.

### Product-visible implications

This script shortens qualifying pauses **inside** speech/singing as well as at the boundaries. A timing map for the new worker must describe every retained source interval and its output interval. One leading offset cannot represent this edit.

The reference uses a FLAC vocal stem, a PCM16 trimmed WAV intermediate, then `libmp3lame` MP3. Default bitrate is **192k** with 64k/96k/128k/192k/256k/320k choices. Output files get a collision suffix rather than overwrite an existing file.

`--trim_silence` is `store_true` with `default=True` and documented as always enabled. There is no disable option. The service path calls processing with its default trim/bitrate parameters; accepting a flag in the standalone CLI does not mean a remote caller can configure it.

There is **no noise-reduction implementation** in the attached file.

### Existing local safety features worth retaining conceptually

The script validates prepared audio; validates finite trimming parameters; confines separator outputs to its work directory; bounds its local JSON payloads to 16 KiB; publishes JSON via a temporary file/replace; and resets per-file model state while keeping the model loaded. The new implementation should retain these goals with its new pipe protocol and per-attempt sandbox.

Do not expose the old local request file as a network API. It contains absolute paths and lacks the new machine authentication, lease authority and capability policy.

## New design decisions, not claims about the attachment

The new engine adds true trim-on/off and denoise-on/off controls, backend-selected immutable recipes, device-specific adapters, cancellation/progress, edit maps, direct-S3 orchestration and durable attempts.

The compatibility default is Kim → reference gap trim → MP3, **denoise disabled**. With denoise enabled the order is Kim → denoise → optional trim → MP3. Trimming then intentionally detects the denoised signal; parity against the old trim-only output is not expected for that recipe.

For the MVP choose FFmpeg `afftdn` with a conservative fixed preset, because FFmpeg is already required and this avoids another neural model distribution/runtime. Proposed filter: `afftdn=nr=6:nf=-50:tn=0:gs=3`. Parameters and behavior are documented in primary source T7. This is an engineering choice for dependency simplicity, not a universal audio-quality ranking. Default remains off until the owner enables it. Validate clean/noisy speech and singing by listening; singing preservation is not proven by a speech-only test.

Do not expose arbitrary filter strings or silently swap in RNNoise/another model. A later denoise algorithm is a new versioned recipe with its own validation and provenance.

## Synthetic tests actually executed during package preparation

Only the unchanged `trim_vocal_gaps` function was extracted from the attachment using Python AST and run with synthetic WAV inputs in the assistant's Linux sandbox. The Kim loader, service loop, GPU and project implementation were not run.

| Case | Input seconds | Output seconds | Result |
| --- | ---: | ---: | --- |
| 1 s internal silence between 1 s tones | 3.00 | 2.40 | PASS |
| 1 s edge silence on each side of 1 s tone | 3.00 | 1.40 | PASS |
| All silent | 1.00 | 1.00 | PASS |
| Internal 0.79 s pause | 2.79 | 2.79 | PASS |
| Internal pause at exact 0.80 s minimum | 2.80 | 2.40 | PASS |
| One loud stereo channel | 2.00 | 2.00 | PASS |
| Partial final silence window | 1.805 | 1.20 | PASS |
| Shorter-than-window loud clip | 176 samples | 176 samples | PASS |

Machine-readable case names and exact sample counts are in [trimmer-reference-tests.json](../validation/trimmer-reference-tests.json). These tests support the listed observations, not complete equivalence proof or model-quality certification. D must add threshold-boundary, rounding/fade sample parity, multiple gaps, invalid values, large input and all recipe tests against the refactored implementation.

## Required parity method

Use the same separated vocal file for reference/new trimmer comparisons. Compare retained interval boundaries and PCM sample arrays before MP3 encoding. Do not use different GPU inference outputs as inputs to a bit-equality test, and do not compare lossy MP3 file bytes. Keep the original attachment immutable as a regression oracle under documentation only.
