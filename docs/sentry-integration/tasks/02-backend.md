# SEN-02 — NestJS backend

Status: TODO. Priority: P0. Dependency: SEN-01.

## Owned implementation scope

Existing: `backend/package.json`, lockfile, `src/main.ts`, `src/app.module.ts`,
`src/config/environment.ts`, `src/config/environment.module.ts`,
`src/http/public-exception.filter.ts`, `Dockerfile`, and package/start scripts.
Proposed: a small `src/observability/` adapter, configuration, and tests.
Read `backend/AGENTS.md` before implementation.

## Work

1. Add the dedicated NestJS SDK as a production dependency. Initialize through
   an ESM bootstrap/preload before instrumented dependencies. Reconcile the early
   bootstrap with existing local-only dotenv loading; production/tests must not
   start reading dotenv files. Cover both `start:prod` and Docker's direct command.
2. Integrate with `PublicExceptionFilter`; preserve all public/admin response
   bodies, status mappings, request IDs, cache headers, and Retry-After behavior.
   Use exactly one capture owner. Sentry's NestJS decorator excludes ordinary
   HttpExceptions; explicitly cover unexpected infrastructure/handled 5xx cases
   under the common policy without blindly reporting every 503.
3. Add isolated request context with route templates and safe existing request
   IDs. Do not capture headers, bodies, raw URLs, user objects, database statements,
   or credential-bearing startup exceptions. Keep stacks after redaction.
4. Audit caught background failures in worker fleet, cleanup, push delivery, and
   release maintenance. Instrument actionable terminal boundaries, with limits;
   do not report every retry, scheduled poll, or incoming client-error record.
5. Capture startup/fatal errors best-effort, then preserve failure exit behavior.
   Implement bounded shutdown flush through existing lifecycle hooks. SDK failure
   must not affect health checks, requests, shutdown, or admission decisions.
6. Update safe configuration examples and README. Add no public test-crash route.
   Keep tracing integrations and extra trace headers for SEN-10.

## Acceptance and tests

- [ ] Fake-transport tests: unexpected exception captured once; expected errors filtered.
- [ ] HTTP tests prove existing public/admin bodies, status and headers unchanged.
- [ ] Concurrent requests cannot inherit each other's context; event fixtures are scrubbed.
- [ ] No DSN, invalid optional config, timeout, and Sentry 429 leave API behavior intact.
- [ ] A built `node` process proves ESM initialization, startup failure, and shutdown.
- [ ] Production container/package contains SDK dependencies and no upload secret.

Run focused new tests first, then `pnpm run verify` in `backend/`. Run relevant
isolated backend/worker integration tests when those boundaries change. Use
`pnpm run test:worker:integration` for the loopback fixture flow; do not use the
`:s3` variant or real infrastructure as a substitute. Complete SEN-08 for maps.
