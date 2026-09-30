# Backend contributor guide

Private R2 Standard is the only application storage provider. Read the [current storage guide](../docs/r2-storage/README.md) before storage changes. Credentials stay backend-only; old version IDs, acceleration and AWS setup are unsupported. Historical validation records are not live R2 proof.

Read README.md, package.json and the affected modules before editing. Scope includes
auth/users/devices, administration, processing/imports, worker coordination and
realtime snapshots. Follow [the client contract](../docs/api/client-contract.md)
and [OpenAPI](openapi.yaml) for API/authentication contracts, and
[the AI handoff](../docs/realtime-processing-queue/AI-HANDOFF.md) for realtime changes.
Preserve unrelated mobile work and deleted legacy backend files in the parent repo.
Do not commit, push, deploy, create cloud resources or change real data without a
direct request. Never read or print real dotenv values, object-storage keys or connection URIs.

## Architecture rules

- Use strict TypeScript, Nest dependency injection and cohesive feature modules.
- Search existing modules before adding abstractions or dependencies.
- ESM imports use `.js` suffixes. Use `import type` for types, especially Mongoose
  Connection; it is not an ESM runtime named export. Keep injectable runtime classes
  available for decorator metadata or use explicit injection tokens.
- Validate new environment keys centrally, update both safe examples and docs.
- The NestJS API serves HTTP and raw WebSocket upgrades on the same HTTP server.
  Reuse `src/http/websocket-upgrades.ts`; independent upgrade listeners can reject
  each other's connections. Redis is external and configured with REDIS_URL.
- Reuse the shared security Redis client for rate limits and readiness.
- Design authorization before exposing data or presigning an R2 operation.
- Reuse the existing MongoDB worker-claim scheduler and separate BullMQ URL-import
  runtime. The realtime projection is read-only: never call claim/admission writes
  to calculate queue rank or introduce a second processing scheduler.
- Extend realtime resources through `src/realtime/realtime-protocol.ts`,
  `realtime-resources.service.ts`, `realtime-dependencies.ts` and the feed collection
  allowlist. Keep domain validation, ownership and admin permissions in place.
  Authentication must be rechecked around asynchronous reads; job revision is not
  a WebSocket sequence number. Feed loss must not leave clients marked live.
- Automatic production database changes are limited to creating collections and
  indexes declared by the registered Mongoose schemas during awaited model
  initialization. Never automatically drop or rewrite indexes, migrate documents,
  or create cloud resources.
- Keep production credentials out of source, images, tests, fixtures and logs.
- Do not add framework boilerplate, dummy feature handlers or speculative utilities.

## URL acquisition

Follow [provider architecture](../video_providers/README.md). Keep
`AudioAcquisitionClient` independent of vendor APIs; use only the generic
acquisition URL/key configuration. The private adapter returns audio bytes and
optional structured metadata. NestJS validates/hash-counts temporary audio,
enforces limits, uploads to R2 and submits the existing job.
Store only included sanitized metadata as nullable `extra_data`; no paid lookup
or separate title-header protocol. Preserve cleanup, ownership and admission
checks. Do not restore extraction runtimes, migration hooks or old-provider env
aliases. Keep provider-specific source/tests/deployment under `video_providers/`.
Run `pnpm run verify`, `pnpm run test:imports:integration` and
`pnpm run test:processing:integration` for affected behavior, sequentially to
avoid conflicting builds in `dist`.

## Verification commands

From backend/: `pnpm install --frozen-lockfile`, `pnpm run start:dev` with external MongoDB and Redis URLs.
After edits: `pnpm run format`, `pnpm run verify`.
After infrastructure/runtime changes: `pnpm run test:integration` with isolated
local mongod/redis-server. Never substitute live production services for tests.
After realtime changes, run `pnpm run test:realtime:integration` as appropriate;
it starts owned loopback Mongo replica-set/Redis fixtures. Update OpenAPI for ticket
HTTP changes and ../docs/realtime-processing-queue/PROTOCOL.md for wire changes.
Audit dependencies with `pnpm audit --prod`. Preserve pnpm-lock.yaml and
do not use `--force` or `--legacy-peer-deps` to hide incompatibility.

Tests belong beside configuration (`*.spec.ts`), in test/ for HTTP policies
(`*.e2e-spec.ts`), or the opt-in native-process integration test. Assert observable
behavior. Verify native compiled Node startup; transformer tests alone can miss
ESM import issues. Keep watch outputs separate and incremental build metadata
inside its output directory. Verify a second build still emits the API entry point.

Report commands actually run and distinguish local proof from Docker builds,
Atlas/R2 access or VPS deployment. Those are separate validation boundaries.
