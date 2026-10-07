# R2 companion downloads — October 7, 2026

The owner requested migration of the GitHub release assets using Chrome, a
release folder in R2, and corrected macOS Prepare URLs. No benchmarks were run.

## Published destinations

- Bucket: `musicmute-downloads`, Standard, Western Europe.
- Folder: `releases/`, with the original release tags as subfolders.
- Public domain: `https://downloads.music-mute.com`.
- Current app: [MusicMute Local 0.1.1, build 1791395910](https://downloads.music-mute.com/releases/macos-store-companion-2026-10-07/MusicMuteLocal-0.1.1-arm64-development-build-1791395910.dmg).
- Checksums: [SHA256SUMS-build-1791395910.txt](https://downloads.music-mute.com/releases/macos-store-companion-2026-10-07/SHA256SUMS-build-1791395910.txt).
- Current runtime manifest: [runtime-bootstrap-r2.json](https://downloads.music-mute.com/releases/macos-runtime-2026-10-06/runtime-bootstrap-r2.json).

All 21 original release assets (494,803,244 bytes) were matched against the
GitHub-published SHA-256 identities locally and uploaded through Chrome. This
includes older DMGs, all seven runtime ZIPs, checksums, the original bootstrap,
notices, engine license, FFmpeg/LAME sources, and their reproducible build script.
The new R2 bootstrap and rebuilt app/checksum add three objects. The original
bootstrap remains an exact historical copy; the new app seals the distinct R2
bootstrap. The new DMG is 16,104,463 bytes with SHA-256
`483c048b710ba0b76d40c52dd9c48c35ccdb925ed00ef6a42f2afb5fa5450c6c`.

## Prepare and packaging

Segmented-runtime imports now honor the download-base and redirect-host overrides
just like the existing single-runtime import. Relocation changes only delivery
URLs and the allowed download hosts. Runtime identity, inventory, signatures,
component checksums, byte counts, and aggregate identity remain unchanged. The
rebuilt app's seven ZIP URLs use the R2 domain and its only runtime download host
is `downloads.music-mute.com`. Kim Vocal 2 stays at its approved upstream source;
no model weights were mirrored. Prepare retains its existing staged download,
checksum, extraction, verification, activation and per-component ZIP cleanup.

```sh
MUSICMUTE_RUNTIME_COMPONENTS_DIRECTORY=/absolute/verified-r2-components.noindex \
MUSICMUTE_RUNTIME_DOWNLOAD_BASE_URL=https://downloads.music-mute.com/releases/macos-runtime-2026-10-06/ \
MUSICMUTE_RUNTIME_REDIRECT_HOSTS='' \
MUSICMUTE_DESKTOP_PUBLIC_CONFIG=/absolute/public-desktop-config.json \
node scripts/package-macos.mjs
```

The component input directory holds the verified ZIPs and a `runtime-bootstrap.json`
whose runtime URL names `runtime-bootstrap-r2.json`. The packager validates the
complete extracted inventory and signatures before sealing this configuration.
Install the new app and choose Prepare my Mac. Already downloaded older apps keep
their sealed GitHub URLs; their original assets are retained for compatibility.
This remains an ad-hoc development build without Apple notarization or a configured
updater. The app-data Chrome extension folder and Library control fix are included.

## Verification scope

- 14 focused relocation/manifest tests passed; TypeScript, lint and formatting passed.
- Package creation, DMG checksum and mounted 160-leaf inventory/strict signature passed.
- All 21 original R2 object URLs returned HTTP 200 with exact expected sizes using
  the native runtime's `MusicMuteLocal-runtime/1` user agent.
- Actual public downloads of the new DMG, checksums and R2 bootstrap exactly matched
  local bytes and SHA-256. No transfer-speed measurements were recorded.
- No installed app replacement, fresh-user Prepare, model network download, inference,
  account, browser extension loading, or notarization was tested in this migration.

Evidence is under `output/r2-release-migration.noindex/` and
`output/macos/build-04b2ebc7-a637-4923-b5fb-8cc9bede748e.noindex/distribution.noindex/`.
The application's private `music-mute` bucket and its access policy were not changed.
