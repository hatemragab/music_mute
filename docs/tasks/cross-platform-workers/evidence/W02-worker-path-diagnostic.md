# W02 worker media path diagnostic

Local test on 2026-09-14, after fix round 1. The saved
`w02-worker-path-probe.py` is the executed diagnostic snapshot. It uses explicit
local paths and temporary fixture identities; it is not a product launcher.

Called the real `Worker._result` with a two-second synthetic WAV, local fake
download/API/lease boundaries, and `PATH=/nonexistent`. Real worker input probing,
decoding/preparation, checkpoint recording, and final MP3 probing/validation used
the prepared runtime's explicit Jellyfin FFmpeg/ffprobe pair. The engine transport
was replaced with a diagnostic adapter invoking the existing `--qualify` child,
which ran actual Kim Vocal 2 GPU separation, FLAC writing, trimming, and MP3
encoding. Its actual encoded MP3 was returned to the worker for validation.

The candidate profile and runtime descriptor were not changed to qualified.
No claim, production API call, upload, boot service, or product admission was
performed. This proves the worker media paths around real diagnostic GPU execution;
it is not proof of the product SeparatorEngine/admission path or service readiness.

Result: PASS, exit 0, empty stderr. Wall time 6.288338208 seconds. Prepared and
output duration both 2.0 seconds. Output 49,571 bytes, SHA-256
`d8996b854e680c94b187cd4d7d1a99a6dc1a2637a8a3ea1e8922ae36e64957d7`.
ORT profiling plus CoreML compute placement observed 178 neural operations,
all 178 accelerated and zero on CPU. Shared Python source hashes were unchanged
through the run. Candidate status remained unchanged, and no qualification report
was manufactured. A separate post-run inventory comparison passed: all 9,435
entries exactly matched the prepared snapshot, with no added, removed, or changed
entries.

Raw local results: `/tmp/musicmute-w02-worker-path-result.json` and
`/tmp/musicmute-w02-worker-path.log`. Runtime:
`/private/tmp/musicmute-w02-round1-prepared`. This remains a short synthetic
fixture, not representative vocal-quality, sustained-capacity, or pre-login proof.
