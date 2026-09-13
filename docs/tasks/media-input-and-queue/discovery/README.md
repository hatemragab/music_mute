# Discovery and benchmark tasks

**Status: not started; plan approval required.** Read [scope](../scope.md) and [contracts](../contracts.md) first. These tasks produce evidence and local test tooling after approval; this document does not authorize access to production or another device.

## R01 — Source fixtures, format compatibility, and local resource limits

**Depends on:** plan approval. **Produces:** `compatibilityRevision`, verified preparation profile, source/download/preparation limits for C1/C5; fixture manifest consumed by every subsystem.

**Files / ownership:**

- Create `tests/media-input/generate-fixtures.py`, `tests/media-input/manifest.schema.json`, and `tests/media-input/README.md` for reproducible synthetic fixture generation and expectations.
- Create `docs/tasks/media-input-and-queue/evidence/compatibility.md` during execution only, recording observed platform support and commands. Store generated media outside tracked source in the existing ignored artifact area; verify ignore rules before creating it.
- Inspect `android/app/build.gradle.kts`, `android/gradle/libs.versions.toml`, `ios/project.yml`, both `AudioInputPreparer` implementations, `AndroidAudioInspector.kt`, `ios/Vocal/Data/AudioFiles.swift`, and installed platform API documentation before choosing adapters.

**Steps:**

- [ ] Establish an initial matrix: MP3, AAC/ADTS, M4A/AAC, M4A/ALAC, WAV/PCM, FLAC, AIFF/PCM, OGG/Vorbis, OGG/Opus, WebM/Opus; MP4/MOV/M4V video with AAC; WebM video with Opus. MKV and other codecs are candidates only if native demux/audio support is evidenced. Do not advertise all candidates as supported.
- [ ] Generate synthetic 1-, 5-, 15-, and 30-minute fixtures, boundary cases 1799.999/1800/1800.001 seconds at an appropriate sample rate, and corrupt/empty/spoofed/no-audio/unknown-duration inputs. Include multitrack default-language selection, default-not-first, invalid default plus usable alternate, truncated providers, variable-frame-rate video, AAC priming/padding, and unsupported image codec with usable audio.
- [ ] Include 99,999,999/100,000,000/100,000,001-byte **transport fixtures** for size boundaries. Do not falsely classify padded synthetic byte files as valid audio; validate media and transfer limits separately.
- [ ] Record source container, audio codec, track selection metadata, measured presentation duration, bytes, expected copy/conversion/rejection, and SHA-256 in a versioned manifest. Do not store real user media or downloaded third-party video as fixtures.
- [ ] Measure preparation time and peak temporary bytes on the authorized simulator. Review Android API support and unit-test adapters; label Android decoder/device rows `unverified` under the current no-Android-device constraint. Simulator measurements are not physical-phone storage/thermal proof.
- [ ] Select a tested profile: preserve compatible tracks; AAC-LC/M4A 256 kbps for tested mono/stereo conversion, preserving supported channel count and sample rate. Verify sound quality, duration, clipping, track choice, and upload size. Reject unsupported multichannel conversion rather than silently changing it.
- [ ] Record exact original-source byte ceiling, download byte/time ceiling, preparation timeout, streaming buffer bounds, and free-space formula based on maximum simultaneous source/output copies plus measured overhead. Cloud sources with unknown size must be read through a bounded stream; inability to avoid a copy must be budgeted before copying. Explain conservative defaults and unsupported cases.

**Reproducible fixture seed (documented command to incorporate into the generator):**

```sh
ffmpeg -f lavfi -i sine=frequency=440:sample_rate=48000 \
  -t 1800 -c:a aac -b:a 256k audio-1800s.m4a
ffprobe -v error -show_entries format=duration,size -of json audio-1800s.m4a
```

Generator tests must assert the manifest has all three duration boundaries and separate transport-byte fixtures; subsequent platform/worker tests measure decoded duration rather than trusting the `ffprobe` format field.

**Acceptance:** exact support/evidence matrix with `verified`, `rejected`, or `unverified` per platform; no broad “any format” claim; reproduction commands and chosen numerical resource bounds recorded. Unsupported platform evidence is a release limitation, not a reason to substitute an unauthorized device.

## R02 — Offline processing benchmarks and capacity recommendation

**Depends on:** R01 and authorized idle Windows test access. **Produces:** C3 `QueueCostModel`, `QueuePolicy`, execution/probe timeout recommendations, attempt budgets, and the single-slot long-job decision.

**Files / ownership:**

- Reuse `windows-worker/musicmute_worker/benchmark.py`, `windows-worker/tests/test_benchmark.py`, `windows-worker/musicmute_worker/engine.py`, and `windows-worker/README.md`.
- Modify the benchmark only if essential stage/timing fields are missing; do not change production worker behavior here.
- Create `docs/tasks/media-input-and-queue/evidence/worker-capacity.md` after actual measurements; keep raw machine reports in a private ignored artifact directory without credentials/identifying paths.

**Steps:**

- [ ] Confirm benchmark execution has no queue claims, no secret loading, and no conflict with a live machine lock. If the machine is active/unavailable, report blocked and continue independent tasks. Never stop it automatically.
- [ ] Run the existing cold/warm benchmark on synthetic representative 5-, 15-, and 30-minute speech/music-like inputs, with repeated runs and one separator slot. Do not pass `--compare-two` in this package.
- [ ] Measure probe/decode, separator execution, output validation, and transfer estimates independently. Record hardware/provider/model/runtime, input properties, output duration/size, cold start overhead, peak RAM/VRAM, available temperature readings, failures, and cancellation stop latency. Missing sensors are `unavailable`.
- [ ] Derive a conservative cost estimate from fixed overhead plus audio duration times measured processing ratio. With a small sample set, report min/max and a safety margin, not invented p95/p99 statistics. Check prediction error against held-out fixtures.
- [ ] Produce exact candidate settings for maximum outstanding jobs/audio seconds/estimated worker seconds; short/long threshold; aging threshold; processing/probe/preparation-related timeouts; and bounded reservation/invalid/cancellation/retry attempt budgets. Include workload simulations explaining resulting wait ranges.
- [ ] Simulate many independent accounts submitting 30-minute work, continuous short arrivals, and one heavy account repeatedly cancelling. Quantify wait introduced by a running long job under one slot. Report whether expanded long-job admission can be enabled or must remain off pending a separately reviewed capacity solution.
- [ ] Verify the 100 MB prepared limit and proposed output limit against observed 30-minute output; all backend/storage/worker/client limits must support the measured result. Do not lower quality secretly to hide a mismatched output ceiling.

**Existing benchmark invocation, from an authorized Windows worker test folder with generated fixtures:**

```powershell
$env:PYTHONPATH = (Get-Location).Path
.\.venv\Scripts\python.exe -m musicmute_worker.benchmark `
  .\fixtures\audio-300s.m4a .\fixtures\audio-900s.m4a .\fixtures\audio-1800s.m4a `
  --repeats 3 --output-dir .\benchmark-results\media-input-30m
```

The command assumes the existing private test configuration/runtime is available; do not create credentials or point it at production to make the command run. Unit validation: `PYTHONPATH=windows-worker python3 -m unittest discover -s windows-worker/tests -p 'test_benchmark.py' -v` from repository root.

**Acceptance:** actual numerical evidence and a readiness decision. An unrun benchmark is explicitly blocked; it cannot be replaced with estimated measurements from a model, old memory, or a faster development machine.
