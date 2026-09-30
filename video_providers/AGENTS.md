# Provider contributor guide

Private R2 Standard is the only application storage provider. Read the [current storage guide](../docs/r2-storage/README.md) before storage changes. Credentials stay backend-only; old version IDs, acceleration and AWS setup are unsupported. Historical validation records are not live R2 proof.

Read the root AGENTS/README, [provider architecture](README.md), and the affected
provider's README, private OpenAPI contract and handoff before editing.

- Keep vendor APIs, credentials, status handling, tests and deployment files in
  that vendor's folder. NestJS must remain provider-neutral.
- Return bounded audio bytes through the private adapter contract. Never send
  delivery URLs or vendor credentials to clients/workers or persist raw payloads.
- Prefer metadata included in acquisition. Optional official oEmbed lookups are
  authorized inside adapters only: bounded, nonfatal, no paid enrichment,
  scraping or extraction runtime. Missing descriptive metadata stays absent.
  Preserve NestJS's independent media validation and temporary-file cleanup.
- Use private, least-privilege CapRover apps with bounded memory, scratch and logs.
  The adapter gets no database, R2 or Firebase credentials.
- Never blindly repeat a paid task-creation request. Status polling is internal
  to the adapter and bounded; UI updates use existing WebSocket snapshots.
- Do not restore extraction runtimes, environment aliases, migration bridges or
  old-device compatibility paths. The owner explicitly accepts breaking removal.
- Do not promise universal source support, unlimited quota or zero downtime.
- Use synthetic tests and sanitized fixtures. Never save credentials, signed
  URLs, raw provider responses or user media in source/docs/test output.
- Run the affected adapter tests and backend checks documented in its README;
  serialize commands that rebuild the same backend output directory.
- Keep local, fixture and deployed evidence separate. Deployment, purchases,
  credential changes and real-data deletion require explicit authorization.
