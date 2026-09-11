# Backend contributor guide

Read README.md, docs/starter-plan.md, package.json and the affected modules before
editing. Scope includes infrastructure and the approved auth/users/devices feature;
follow docs/auth-api.md and its implementation plan for those contracts.
Preserve unrelated mobile work and deleted legacy backend files in the parent repo.
Do not commit, push, deploy, create cloud resources or change real data without a
direct request. Never read or print real dotenv values, AWS keys or connection URIs.

## Architecture rules

- Use strict TypeScript, Nest dependency injection and cohesive feature modules.
- Search existing modules before adding abstractions or dependencies.
- ESM imports use `.js` suffixes. Use `import type` for types, especially Mongoose
  Connection; it is not an ESM runtime named export. Keep injectable runtime classes
  available for decorator metadata or use explicit injection tokens.
- Validate new environment keys centrally, update both safe examples and docs.
- Run only the HTTP API. Redis is external and configured with REDIS_URL.
- Reuse the shared security Redis client for rate limits and readiness.
- Design authorization before exposing data or presigning an S3 operation.
- Do not reintroduce workers or job queues without explicit authorization.
- Automatic production database changes are limited to creating collections and
  indexes declared by the registered Mongoose schemas during awaited model
  initialization. Never automatically drop or rewrite indexes, migrate documents,
  or create cloud resources.
- Keep production credentials out of source, images, tests, fixtures and logs.
- Do not add framework boilerplate, dummy feature handlers or speculative utilities.

## Commands

From backend/: `npm ci`, `npm run start:dev` with external MongoDB and Redis URLs.
After edits: `npm run format`, `npm run verify`.
After infrastructure/runtime changes: `npm run test:integration` with isolated
local mongod/redis-server. Never substitute live production services for tests.
Audit dependencies with `npm audit --omit=dev`. Preserve package-lock.json and
do not use `--force` or `--legacy-peer-deps` to hide incompatibility.

Tests belong beside configuration (`*.spec.ts`), in test/ for HTTP policies
(`*.e2e-spec.ts`), or the opt-in native-process integration test. Assert observable
behavior. Verify native compiled Node startup; transformer tests alone can miss
ESM import issues. Keep watch outputs separate and incremental build metadata
inside its output directory. Verify a second build still emits the API entry point.

Report commands actually run and distinguish local proof from Docker builds,
Atlas/S3 access or VPS deployment. Those are separate validation boundaries.
