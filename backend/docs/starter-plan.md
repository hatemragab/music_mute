# MusicMute backend starter

> Historical implementation record (2026-09-08). Superseded on 2026-09-09 by
> the API-only architecture in [README](../README.md): the worker and BullMQ
> have been removed, and Redis is external via `REDIS_URL`. The verification
> results below describe the original starter, not the current runtime.

## Scope and design

Initialize infrastructure only. No music processing, downloads, authentication,
user records, upload routes, business endpoints, or production job handlers.

Use one strict TypeScript NestJS project with separate `main.ts` (HTTP API) and
`worker.ts` (application context, no HTTP listener). Share configuration,
Mongoose, AWS SDK v3 S3 client, and BullMQ queue registration through small Nest
modules. Redis is an independent service with AOF persistence and no eviction;
restarting the API must not remove queued jobs. No consumer is registered until
a real, idempotent job handler is designed. Tests may consume synthetic jobs.

BullMQ fits NestJS and a single VPS with fewer moving parts than RabbitMQ.
AWS SQS would outsource durability but adds a separate AWS service and a custom
Nest integration. A MongoDB polling queue avoids Redis but requires implementing
leases, retries and recovery. Select BullMQ and document at-least-once semantics.

Use `.env.local` and `.env.production`, selected explicitly by APP_ENV, with
safe example files and fail-fast validation. Local MongoDB runs on loopback;
production requires Atlas SRV/TLS. AWS credentials use the standard SDK chain,
never committed files. Production Redis is password protected and private.

HTTP defaults: Helmet, bounded JSON bodies, strict DTO validation, explicit
CORS origins, proxy trust disabled unless explicitly configured, global rate
limits, generic server errors, and health endpoints without credentials or
dependency details. Docker image uses non-root Node, separate API/worker
services, graceful shutdown and a host TLS reverse proxy deployment guide.

## Implementation and verification checklist

- [x] Scaffold official Nest CLI starter, pin dependencies and npm lockfile;
      add scripts for API/worker local and production, lint, formatting, tests,
      type checks, build and verification.
- [x] Validate environment selection and settings with unit tests (including
      malformed numeric settings, insecure production URIs and unsafe origins).
- [x] Wire MongoDB, S3 and durable BullMQ infrastructure; keep consumers out
      of the API and leave business handlers absent.
- [x] Configure and test HTTP headers, DTO rejection, payload limit, CORS,
      throttling and proxy behavior using a real Nest HTTP application.
- [x] Add isolated MongoDB/Redis integration checks, including API restart
      survival and Redis persistence/restart of synthetic jobs where tools exist.
- [x] Add local infrastructure Compose, production API/worker/Redis Compose,
      Dockerfile, environment templates, agent guide and VPS operations guide.
- [x] Run formatting, lint, unit/HTTP/infrastructure tests, type checks, build,
      dependency audit and diff review. Report Docker/Atlas/S3/VPS verification
      boundaries; do not deploy or commit.

All changes remain in `backend/` except the root README backend link. Preserve
the existing mobile changes and deleted legacy backend. Work directly in the
requested checkout. Real Atlas/S3/VPS values are supplied at deployment time.

## Verified on 2026-09-08

- Clean `npm ci --ignore-scripts` succeeded; lockfile uses registry.npmjs.org.
- `npm run verify`: formatter, lint (zero warnings), type checks, 15 environment
  tests, seven HTTP security tests and compiled API/worker all passed.
- `npm run test:integration`: real isolated MongoDB/Redis, compiled API startup,
  forced API crash/restart, bounded readiness 503 during Redis outage, forced Redis
  crash/AOF recovery, separate starter worker startup and subsequent synthetic job
  consumption passed. A reproduced review finding was fixed: unavailable Redis at
  first worker startup now exits with code 1 after an explicit five-second check.
- Independent worker build emitted `dist-worker/worker.js` while preserving
  `dist/main.js`. Repeated default builds also retained executable output.
- Both Compose documents passed the official Compose JSON schema (2020-12).
- `npm audit --omit=dev`: zero known vulnerabilities reported.
- Actual local/production dotenv files exist with mode 600 and are Git-ignored;
  both safe examples and package-lock.json are trackable. Diff whitespace passed.

Docker is not installed on this host: images and Compose runtime remain untested.
Atlas/S3 credentials, buckets, VPS services and public TLS were not provisioned,
used or deployed. S3 validation here covers client configuration only. Production
environment placeholders must be replaced before use. No business handlers,
commits, pushes or deployment were made.
