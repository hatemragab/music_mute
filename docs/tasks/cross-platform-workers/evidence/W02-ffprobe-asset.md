# W02 macOS arm64 probe asset observation

Verified locally on 2026-09-14 for W02 fix round 1. Candidate dependency only;
no release, redistribution package, or native boot qualification is approved.

The [Jellyfin FFmpeg 7.1.4-3 release](https://github.com/jellyfin/jellyfin-ffmpeg/releases/tag/v7.1.4-3)
provides a portable macOS arm64 archive containing both tools:

`https://github.com/jellyfin/jellyfin-ffmpeg/releases/download/v7.1.4-3/jellyfin-ffmpeg_7.1.4-3_portable_macarm64-gpl.tar.xz`

Measured download length: 31,063,636 bytes. SHA-256:
`99d689816a41075574928a0b3059101fd454fc58f465c99105a73b5c415ac86d`.
Both match the release API's asset metadata. The archive contains exactly two
regular files and no links:

| Member | Bytes | SHA-256 |
| --- | ---: | --- |
| ffprobe | 53,300,504 | c60668d7d3a8a3d14d55205bc697aa22af9b3ff208996b2a18dae505817e9ec4 |
| ffmpeg | 53,441,720 | 65dd9d5115fccef41018cae9340655c36e8bc668510034d92d54be83f9bfc17f |

`file` identifies ffprobe as Mach-O arm64. Actual `ffprobe -version` exits 0 and
reports 7.1.4-Jellyfin. `otool -L` shows only macOS system libraries/frameworks,
with no Homebrew or external installation paths. The binary configuration uses
static libraries, GPL/version3, and disables libfdk-aac; `ffprobe -L` reports
GPL version 3 or later. The archive does not include source/notices. H01 must
package complete corresponding source/build details and notices and select a
maintained release before distribution; these observations are not a license
clearance claim.

Executed both tools with `env -i PATH=/nonexistent`, without modifying system
configuration. FFmpeg generated a short stereo 44.1 kHz MP3 via libmp3lame.
ffprobe JSON successfully reported exactly one MP3 audio stream, two channels,
44,100 Hz, and format duration 0.235102 seconds. This proves native standalone
execution and the expected JSON fields for that fixture, not all supported media
or the full worker job path. The W02 implementer owns that integration test.

Local artifacts: `/tmp/musicmute-jellyfin-ffmpeg-7.1.4-3-macarm64.tar.xz` and
`/tmp/musicmute-jellyfin-native.VsZD4o/`. No quarantine removal, signing changes,
system install, service operation, or production request was performed.
