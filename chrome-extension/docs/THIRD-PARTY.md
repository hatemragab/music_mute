# Standalone app dependency notices

This local build carries the MusicMute engine under Apache-2.0. Runtime licenses
remain beside their libraries, including CPython, Node, Torch and its bundled
third parties, NumPy, SciPy, librosa, onnx2torch, ONNX, ONNX Runtime, soundfile,
soxr and audio-separator. Their `.dist-info` and native license directories are
retained. See `runtime/runtime/python/lib/python3.13/site-packages/` and
`runtime/runtime/node/LICENSE` in the separately delivered runtime archive.

FFmpeg 8.0.3 and statically linked LAME 3.100 notices and the exact source pins
are in `runtime/runtime/licenses/` and `media-source-manifest.json`. The original
reproducible build script is included here as `build-macos-media-runtime.sh`.
[FFmpeg source](https://ffmpeg.org/releases/ffmpeg-8.0.3.tar.xz) and
[LAME source](https://downloads.sourceforge.net/project/lame/lame/3.100/lame-3.100.tar.gz)
are the matching upstream source archives. Public distribution must satisfy the
applicable LGPL source/relinking conditions; this local package is not evidence
that the public distribution process has completed that review.

The downloader uses the official pure Python wheels
[yt-dlp 2026.8.19](https://pypi.org/project/yt-dlp/2026.8.19/) and
[yt-dlp-ejs 0.8.0](https://pypi.org/project/yt-dlp-ejs/0.8.0/), retained unchanged
under `runtime/tools/downloader/`. Archive size/SHA-256 and the companion bootstrap
hash are pinned in source and the bundle identity. The isolated Python launcher
verifies both archives before importing code directly from ZIP; it does not install
packages or extract them at runtime. Setup checks both EJS scripts and their
upstream SHA3-512 values. Their complete wheel license files remain inside the
archives; see the [yt-dlp license](https://github.com/yt-dlp/yt-dlp/blob/2026.08.19/LICENSE)
and [EJS license](https://github.com/yt-dlp/ejs/blob/0.8.0/LICENSE).
Optional native/request dependencies are not added to the downloader import path.

Kim Vocal 2 model weights are **not included**. Setup downloads only the approved
owner-hosted model, with exact size and SHA-256 verification. No MusicMute mirror
or worker model cache is used by the packaged app. Model source and prior owner
approval are documented in the repository's
`docs/worker-rebuild/reference/MACOS-RUNTIME-LICENSE-APPROVAL.md`.

The code-bearing runtime ZIP is submitted to Apple separately from the app DMG.
The DMG can be stapled; the ZIP retains its accepted submission ID and exact
digest because ZIP tickets cannot be stapled. Local app and runtime verification
records state their actual signing and execution scope and do not establish a
public release.
