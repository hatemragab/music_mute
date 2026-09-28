# VideoScale rollout — 2026-09-27

- [x] Qualify the four provider API operations and an audio-only VPS transfer.
- [x] Collect research under this provider directory (`docs/`).
- [x] Implement the private, bounded audio acquisition adapter and contract tests.
- [x] Use a provider-neutral NestJS acquisition client.
- [x] Persist sanitized, included metadata as nullable MongoDB `extra_data`.
- [x] Verify cleanup, failure handling, backend tests and compiled startup.
- [x] Package only allowlisted source files; inspect release contents.
- [x] Create/configure a private CapRover app using Chrome; deploy and verify it.
- [x] Deploy the backend with generic acquisition settings; verify live import,
      MongoDB metadata, S3 transfer, worker completion and scratch cleanup.
- [x] Record exact release evidence and remaining limitations here.
- [x] Remove the old downloader component, temporary deployment bridge and
      separate title-header parser locally; update current guides (2026-09-28).
- [x] Verify local cleanup: 949 unit, 148 HTTP, 6 import integration and 12 adapter
      tests passed. See [cleanup evidence](docs/LOCAL-CLEANUP.md); not deployed.

- [x] Deploy backend 82 and verify a fresh real YouTube import, MongoDB metadata,
      exact S3 identities, worker completion, playback and cleanup (2026-09-28).

Deployed: adapter `img-captain-music-mute-videoscale:2`, backend
`img-captain-api:82`. See [release 82 evidence](docs/RELEASE-82.md).
User confirmed private credential access. Live web import
reached Ready; MongoDB metadata and both S3 artifacts verified. See
[deployment evidence](docs/DEPLOYMENT.md) for proof and limitations.

No credentials, signed delivery URLs, real task IDs or user media belong here.
Existing unrelated checkout changes must be preserved.

API preflight: https://opensource.zalando.com/restful-api-guidelines/ retrieved
2026-09-27. Applicable rules: 101 (OpenAPI), 104 (security), 118 (snake_case),
106 (compatibility), 151 (responses), 176 (problem JSON), 177 (no stack traces).
Private bearer authentication preserves the existing deployment model instead
of introducing Zalando-specific OAuth infrastructure. Binary responses preserve
the existing bounded transfer contract; metadata is an optional bounded header.

Cleanup preflight: official guidelines read again on 2026-09-28. Rules 101 and
178 keep the documented structured metadata/binary contract consistent. The
owner explicitly authorizes breaking removal without a migration, overriding
rule 106's compatibility default and providing the shutdown consent in rule 185.
Security, limits, problem responses and nullable included metadata remain intact.
