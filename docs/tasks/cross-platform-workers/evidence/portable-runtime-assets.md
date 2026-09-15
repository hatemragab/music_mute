# Portable macOS runtime asset observations

Observed 2026-09-14 for W02/H01. These are verified upstream artifact identities,
archive-layout observations and local executable checks. They do not constitute a
published, signed, qualified MusicMute runtime. No worker/service configuration,
personal GPG keyring, live data or repository profile/lock file was changed.

## CPython 3.12.13, macOS ARM64

The installed uv-managed interpreter reports build `20260408`. The
[upstream release](https://github.com/astral-sh/python-build-standalone/releases/tag/20260408)
provides this exact stripped portable archive:

- [cpython-3.12.13+20260408-aarch64-apple-darwin-install_only_stripped.tar.gz](https://github.com/astral-sh/python-build-standalone/releases/download/20260408/cpython-3.12.13%2B20260408-aarch64-apple-darwin-install_only_stripped.tar.gz)
- Bytes: `17756116`.
- SHA-256: `ac167e74961316ceabdbe4839f19aa6000c592b08e5a1fab4646cb225ede13d5`.
- Inner `python/bin/python3.12` SHA-256:
  `01564940172b2811e1f39a4dc90e84c7a26a19cf071bbc5de67e456d82627bec`.

Downloaded and independently checked the archive length/hash. Its interpreter
bytes exactly match the local uv-managed binary used by the successful CoreML
probe. This comparison does not independently identify which archive variant uv
originally downloaded or prove every installed file matches.

Archive inventory: 1,898 members, nine symbolic links and no hard links. Examples
include `python/bin/python -> python3.12` and `python/bin/python3 -> python3.12`.
Notices include `python/lib/python3.12/LICENSE.txt` and pip/vendor license files.
Canonical release packaging must preserve the notices and handle these known
aliases deliberately; the worker's strict archive extraction must not silently
become a general symlink-following extractor. Resolve safe aliases to regular files
when building the canonical release, or specify and validate an equally confined
representation before signing its final digest.

The non-stripped upstream archive is separately listed as 17,835,759 bytes,
SHA-256 `6000d09545602d3704bdff943f37663b3148b7c1a3a8a1fcc6c1ebd505a3cfc3`.
Those values were API metadata only; that variant was not downloaded in this check.

## FFmpeg wheel candidate — local testing only

[imageio-ffmpeg 0.6.0 metadata](https://pypi.org/pypi/imageio-ffmpeg/0.6.0/json)
identifies the
[macOS ARM64 wheel](https://files.pythonhosted.org/packages/40/5c/f3d8a657d362cc93b81aab8feda487317da5b5d31c0e1fdfd5e986e55d17/imageio_ffmpeg-0.6.0-py3-none-macosx_11_0_arm64.whl).

- Wheel bytes: `21113891`; SHA-256:
  `b1ae3173414b5fc5f538a726c4e48ea97edc0d2cdc11f103afee655c463fa742`.
- Member: `imageio_ffmpeg/binaries/ffmpeg-macos-aarch64-v7.1`.
- Executable bytes: `49368728`; SHA-256:
  `6d175a4743ca50256e89a8cdd731100f9cee33bd79aeea46894d209410dc6617`.

Both hashes/lengths were independently checked. The exact installed member also
matched before execution. `-version` reported FFmpeg 7.1 and `--enable-gpl`; `-L`
reported GPL version 2 or later. `otool -L` listed only system libraries/frameworks.
The wheel's packaged license file is the wrapper's BSD-2-Clause text; it is not a
complete notice/source bundle for that GPL-enabled executable.

This old binary is not selected for production shipping. The
[official download page](https://ffmpeg.org/download.html) now lists FFmpeg 9.0.1
and 7.1.5 among maintained release versions. A reproducible local preparation test
may use the verified candidate, but H01 must provide a current reviewed native
build with its source/build configuration/notices and codec validation before
publishing a qualified runtime.

## Current official FFmpeg source and signature

Independently downloaded and hashed:

| Artifact                                                                  |    Bytes | SHA-256                                                            |
| ------------------------------------------------------------------------- | -------: | ------------------------------------------------------------------ |
| [FFmpeg 9.0.1 source](https://ffmpeg.org/releases/ffmpeg-9.0.1.tar.xz)    | 12036420 | `cf38e0e28c7e5605942c4a77755349b0145804a397af37eb1fb4c77cb237f635` |
| [Detached signature](https://ffmpeg.org/releases/ffmpeg-9.0.1.tar.xz.asc) |      520 | `b613a00005232a1245ace7080088781ac23a916119d3e5b0d6c042368eee0177` |
| [Public release key](https://ffmpeg.org/ffmpeg-devel.asc)                 |     1709 | `397b3becedcd5a98769967ff1ff8501ddc89f8368b8f766e4701377d7dbaabe5` |

GPG verification in a new isolated temporary keyring exited 0 with `GOODSIG` and
`VALIDSIG` for fingerprint `FCF986EA15E6E293A5644F10B4322F04D67658D8`, matching the
fingerprint on the official download page. Signature date: 2026-08-12. GPG also
reported undefined personal UID trust in that temporary keyring; no personal
web-of-trust certification is claimed. The downloaded files remain under
`/tmp/musicmute-ffmpeg-signature.2Feumz`.

No native FFmpeg build or source-code/codec qualification was performed here.
The source archive is not a ready-to-install executable, and upstream signature
verification is distinct from MusicMute release signing and admission.
