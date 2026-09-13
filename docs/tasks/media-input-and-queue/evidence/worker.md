# Worker and synthetic media evidence

Updated 2026-09-13; local macOS evidence, not Windows GPU qualification.

## Implemented

- Opt-in media policy version 2 handshake and strict assignment limits. Legacy assignments retain exclusive 600-second/30 MB input limits and the existing local processing timeout.
- Inclusive 1800-second/100 MB parsing, local stricter output/timeout intersection, full decoded duration validation, and rejection of video-bearing prepared payloads.
- Checkpoint identity includes accepted policy limits, so incompatible prepared/output artifacts are not reused.
- Durable per-attempt separator execution clock. Output and terminal reports reuse cumulative measured time with the event identity; upload and restart delays are excluded. An interrupted, unobserved interval remains unavailable instead of inventing a refund or execution estimate.
- Offline benchmark preparation accepts the proposed 30-minute ceiling without expanding production claims or concurrency.
- Reproducible synthetic fixture generator, schema, checksum manifests, exact duration and byte boundaries, and default-second soundtrack/video-only samples.

## Observed validation

- Baseline worker suite: 139 tests, 23 skipped, exit 0.
- Final worker suite after wire negotiation and benchmark preparation: 148 tests, 23 skipped, exit 0 (37.858 seconds). Skips cover Windows-only containment and optional NumPy/soundfile integration dependencies.
- Fixture generator: initial expected failing tests, then 4 passed; final rerun 4 passed (0.336 seconds).
- Black formatted the 12 changed Python files; no project runtime dependency was added.
- Real FFmpeg decoded boundary checks with the proposed inclusive limits:

| Fixture | Bytes | Observed decoded result |
| --- | ---: | --- |
| duration-below.wav | 57,600,046 | 1799.999002 seconds, accepted |
| duration-exact.wav | 57,600,078 | 1800.0 seconds, accepted |
| duration-above.wav | 57,600,110 | INPUT_TOO_LONG |
| audio-1800s.m4a | 34,626,659 | 1800.0 seconds, accepted |

Generated manifests are ignored artifacts under `artifacts/media-input/{smoke,long,boundaries}`. They contain synthetic data only. The sine-wave AAC size does not establish a representative bitrate or production size guarantee.

## Remaining qualification

No configured local Windows worker or authorized idle Z440 execution environment is available in this checkout. DirectML/model memory, cold/warm 5/15/30-minute throughput, resource peaks, cancellation proof on Windows, and measured capacity/timeout revisions are not claimed. Existing platform/dependency skips remain explicit. Expanded admission must stay unavailable until these measurements and native source/preparation ceilings are qualified.
