# W16 Library source and fixture evidence

Historical foundation checkpoint. Current direct-original, standalone trimmed
voice, native Share source binding and availability/fault closure are recorded in
the [production journey audit](W13-W16-W18-source-journey-audit-2026-10-09.md).
The original 57-test record below does not describe the final whole source state.

The Windows Library now reuses shared desktop catalog/job metadata and merges personal results only through an explicit current-account link and matching output digest. Personal original/voice pairs persist in the Windows-user guest partition and remain usable signed out. Account metadata, links, preferences and downloaded originals/voices are partitioned by UID; generation fences reject old socket snapshots, commands, downloads and media opens. Raw full socket snapshots replace the account page atomically; there is no HTTP live-read polling.

`LibraryController` supplies search, newest/title/most-played sorting, offline/online/starred/removed filters, star/hide/restore, server rename/delete, distinct cached-copy/local-pair removal, verified download, trusted cloud-result adoption and exact visible playback order. History recovery remains separate from Library media usability. The personal agent writes a durable local catalog entry before announcing READY. Account trim ranges are validated at 44,100 Hz; old nullable maps retain their Library row while trimmed playback still fails closed in the player timeline layer.

`createWindowsLibrary` returns the controller, trusted playback provider, artifact cache, pin registry and thumbnail cache for main-process composition. Playback receives private paths only in main and binds each pin to an exact immutable artifact. Pins belong to the actual consuming Node/Electron process birth, not a replaceable native helper. Cache publication reuses an existing verified artifact and never overwrites a pinned file. Cache removal holds the native cache mutex through pin recheck and file deletion; local-pair deletion stages an owned renamed tree with catalog rollback on precommit failure. No selected user source or export path is accepted by deletion.

Original and vocal account downloads use the existing bounded R2 transfer policy, exact bytes/SHA/content type and current account scope; no bearer token reaches R2. Export uses an exclusively opened trusted Save/Share destination descriptor, Windows-safe names, exact source hash and file identity, fsync and commit/discard hooks while retaining the source pin. The trusted native Save/Share dialog/UI integration belongs to main/W21 and Windows acceptance.

Thumbnails accept only sanitized public YouTube URLs, redirects disabled, bounded JPEG/WebP pixels/dimensions and a 128-file cache. Catalog/query events hydrate at most 50 visible rows with concurrency three, URL deduplication, a 4 MiB inline-pixel budget and generation/query fencing. Failure produces a safe null fallback. Library/Now Playing/Up Next presentation wiring is owned by the root app/player implementation.

Commands actually run on this Mac:

- `windows-desktop`: focused Library model/controller/artifact/export/thumbnail/provider tests plus personal controller/events and cloud transfers: **57 passed across nine files**.
- `windows-desktop`: `npx tsc --noEmit`: passed after the app bridge fixture was updated by its owner.
- `windows-desktop`: `npm run build`: passed, no CJS import-meta warnings.
- Scoped Prettier check passed; scoped oxlint returned0warnings/0errors.
- `worker/engine`: `../.venv/bin/python -B -m unittest tests.test_consumer_personal tests.test_pipeline tests.test_provider_adapter tests.test_windows_gpu tests.test_qualification -v`: **45 passed**, injected providers/hardware and synthetic source-owned media only.

Filesystem fixtures translate Windows path joins into isolated temporary Mac directories and inject the native boundary. They prove source behavior, immutable publication, pin lifetime, scope fencing, original transfer, export collisions, cleanup allowlists and thumbnail fallback; they do not establish real Windows ACLs, reparse protection, open-file semantics, actual FFmpeg/media decode, GPU inference or native shell sharing. No genuine model/runtime was downloaded or executed, no live account/API/R2 transfer occurred, and no Windows release was produced.

Remaining acceptance: real large Libraries, native cache mutex/ACL and sharing semantics, account/offline relaunch, byte/freed-space accounting, native player images, downloaded audio and UI interactions on Windows 10 22H2/Windows 11 x64 remain W34 checks.
