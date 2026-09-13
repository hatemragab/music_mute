# Media support and qualification

The new input path accepts one local audio/video item or an individual recorded YouTube URL. Device media frameworks determine decoder support; a filename extension alone never proves compatibility. Compatible audio is preserved, video contributes only its selected audio track, and conversion uses the approved AAC-LC/M4A profile. Unsupported or ambiguous media is rejected before upload.

## Observed fixtures

| Fixture or boundary | Observed evidence |
| --- | --- |
| AAC/M4A, exactly 30 minutes and above legacy 30 MB | iOS simulator preparation and full worker FFmpeg decode passed |
| PCM WAV to AAC/M4A | iOS native conversion and original-source preservation passed |
| MP4 video, default second AAC soundtrack | iOS output measured the default 880 Hz signal, not the first 440 Hz track; output contains no video |
| Video without audio | Rejected in native iOS preparation |
| Six-channel WAV | Native iOS rejects before stereo conversion; worker v2 rejects non-mono/stereo metadata before decode |
| 1799.999 / 1800 / 1800.001 seconds | Worker real decoded boundaries accept below/exact and reject above; native policy boundary tests pass |
| 99,999,999 / 100,000,000 / 100,000,001 bytes | Synthetic transport boundary catalog and policy tests; sparse transport files are explicitly not valid media |
| YouTube finite/live/playlist/unknown metadata | Deterministic preflight tests on both platforms; live provider extraction remains unverified |
| Android extraction/conversion and background adapter | Both flavors compile, lint and JVM tests pass; no Android device was substituted for the permitted iOS simulator |

The generator also provides MP3, raw AAC, ALAC, FLAC, AIFF, Vorbis, Opus and WebM candidates for device qualification. Their presence in the catalog is not a claim that every platform/version/codec combination supports them.

## Activation

Prepared input has an inclusive maximum of 1,800 seconds and 100,000,000 bytes under policy v2. Original source/download bounds, preparation deadlines, worker budgets and cost ratios come from an audited qualification record. Missing or stale qualification cannot enable expanded intake. Existing legacy intake remains bounded by its existing exclusive limits.

An operator must record the actual native and worker configuration with the evidence reference before activation. The worker's local output ceiling and processing timeout may be stricter than the assignment; these settings must cover the proposed output and execution budget. Current operational defaults are not benchmark results. Qualification does not add worker slots or change native device-testing authorization.
