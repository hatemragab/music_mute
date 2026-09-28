# Public worker release progress — 2026-09-27

This is separate from the earlier local readiness review. The user authorized
S3 upload, npm publication, replacement of the development CLI and local testing.

## Completed

- Corrected the npm scope to `@music-mute/worker` to match the existing organization.
- Rebuilt `0.1.0-rc.1` from current worker source with its private native dependencies.
- Full verification: 419 TypeScript tests passed, 2 skipped; 73 Python tests passed,
  1 skipped; 7 packaging tests passed; protocol, format, lint, typecheck and build passed.
- Exact packed consumer installation, help/version and dependency audit passed.
- Native archive extraction verified all 20,109 inventory entries and bundled Node CLI.
- Actual Mac GPU qualification passed for both recipes: MPS dispatch proven, no CPU
  fallback events reported, generated MP3 independently decoded. Qualification took
  32.68 seconds including model preload. This was a local candidate-engine test,
  not a new live backend job or a fresh enrollment test.
- Uploaded the private versioned S3 runtime and downloaded the complete object again;
  its byte count and SHA-256 match the local candidate. No bucket permissions changed.
- Removed both old npm installations (`/opt/homebrew` and `~/.local`), the development
  `mw` launcher and the legacy command links. Backups are retained outside the checkout.
- Published `@music-mute/worker@0.1.0-rc.1` publicly to npm and verified the registry
  tarball SHA-256 and integrity match the tested artifact exactly. Reinstalled the
  exact version globally from npm using a fresh cache; help/version smoke passed.
  `mw` resolves to `/opt/homebrew/bin/mw` and reports CLI `0.1.0-rc.1`.
- Publication requested the `next` tag. npm also assigned `latest` on first publication.
  An authenticated attempt to remove `latest` returned HTTP 400; both tags currently
  point to the release candidate. This does not establish stable runtime acceptance.
- Restored the pre-existing worker service and its active intent after qualification.
  Pairing, model cache, credentials and job data were preserved.

## Release identities

- Artifact directory: `/Users/hatemragap/.codex/tmp/musicmute-worker-public-rc1-l1ttcv3u`
- S3 key: `worker-installation-artifacts/releases/darwin-arm64/0.1.0-rc.1.tar.gz`
- S3 object version: `HfsTKlxvF54j1n95tsQ7ab2XeteBii3H`
- Runtime bytes: 330846735
- Runtime SHA-256: `214ec41cf9115950015697a03cee8c802321bb3f44076a2bf349c9771ac467de`
- npm tarball: `npm-final/music-mute-worker-0.1.0-rc.1.tgz`
- npm SHA-256: `c4c0751eef6adabf376ebb93bc45e816995172ee1ad6a77ba861a65df84bbc6b`
- npm integrity: `sha512-3jdVhpKzdaTmEDl2S+gdTKSdQN07++xsjICKkqfYGZ90j+xqSaWhxitKeSSlotMrngjHen92TUQ6U3AyZ0GgVw==`

## Pending

- The available local operator signing key does not match the built-in
  `worker-release-2026-09` trust key. The approved key's location was requested.
  No replacement trust key, unsigned update bypass or catalog promotion was performed.
- Production update catalog still advertises `0.1.0-mvp.33`, sequence 2. The running
  local service remains `0.1.0-mvp.45-socket.local.20260927.1`, not the new candidate.
  The new CLI and new S3 archive alone do not update this service.
- With the approved signature: verify candidate consistency, promote only the release
  catalog, run the normal signed update, then verify service health and processing.
- Clean enrollment, reboot/logout/login, sustained workload and live failure scenarios
  still require separate acceptance. This release is a `next` prerelease, not stable.

No Git commit/push, model rehosting, signing-key rotation, production permissions
change, credential purge or deletion of real job data was performed.
