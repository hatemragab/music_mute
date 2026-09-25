# MusicMute backend

NestJS backend for the MusicMute native apps. Includes Firebase authentication,
profiles, installation/version tracking, voluntary verification, password recovery,
shared Redis limits, processing-access policy and logout-all. MongoDB, external
Redis and S3 provide the infrastructure foundation. Existing audio history,
completed-result access, cancellation, deletion, and notifications remain supported.
New audio processing is temporarily unavailable while the processing architecture
is redesigned.

- [Audio user API](docs/api/audio-processing.md)
- [Audio operations](docs/operations/audio-processing.md)
- [Dashboard API](docs/dashboard-api.md)
- [Dashboard permission matrix](docs/dashboard-permissions.md)
- [Dashboard local validation](docs/dashboard-local-validation.md)
- [Zalando guideline index](../docs/backend-security/zalando-guidelines-index.md)
- [Exhaustive route and security matrix](../docs/backend-security/route-matrix.md)

## Requirements and local run

- Node.js 24 LTS and pnpm 10. The lockfile defines reproducible dependency versions.
- Independently running MongoDB 8 and Redis 7.4 or later.
- Run all commands from this directory. Scripts target macOS/Linux and the VPS.

```sh
pnpm install --frozen-lockfile
cp -n .env.local.example .env.local
cp -n .env.production.example .env.production
chmod 600 .env.local .env.production
# Configure MONGODB_URI and REDIS_URL in .env.local before starting.
pnpm run start:dev
```

The API connects to existing MongoDB and Redis services; it does not start either
server. Production Compose also runs only the API.

- Liveness: `GET http://127.0.0.1:3000/health/live`.
- Readiness: `GET http://127.0.0.1:3000/health/ready` (MongoDB and Redis).
- Health endpoints do not claim AWS connectivity. Enabled audio processing
  separately checks S3 privacy, versioning and retention prerequisites at startup.
- Readiness also does not validate Firebase credentials or provider settings.

## Environments

For CapRover, use the repository-root `captain-definition` and set Container HTTP
Port to **80**. See [CapRover deployment](docs/caprover.md) for build commands,
environment variables, credentials and external Redis setup.

`APP_ENV=local` loads `.env.local`. Production and test ignore dotenv files, so
CapRover's process environment is the only production configuration source.
`NODE_ENV=production` must match `APP_ENV=production`. Actual environment files
and service-account JSON files are ignored by Git; only safe examples are tracked.
The production example intentionally contains invalid placeholders, not credentials.

MongoDB uses `MONGODB_URI`: a database-specific local URI in development and an
Atlas `mongodb+srv` URI with certificate verification in production. Configure
Atlas network access for the VPS IP and a database-scoped user.
Local authentication/device/deletion writes now require a MongoDB replica set too,
because account fencing and associated writes commit in transactions. Production
Atlas already provides transaction support; standalone local MongoDB is insufficient.

After connecting, startup awaits Mongoose model initialization so collections and missing schema
indexes are created before the API accepts traffic. The database user therefore
needs index-management permission. The explicit
[index operations](docs/auth-operations.md) remain available for audits.

`AWS_REGION` and `S3_BUCKET` prepare the S3 integration. `StorageClient` uses the
AWS SDK v3 standard credential chain. Locally use an AWS profile; on the VPS use
a least-privilege identity with access to only the required bucket/prefix.
If using environment credentials, supply `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY` and, for temporary credentials, `AWS_SESSION_TOKEN` through
the ignored production environment or secret manager. Never use root keys.
Keep the bucket private, enable public access blocking, encryption and lifecycle
rules for temporary media. Bucket creation and live AWS checks are not performed
by this starter. The presigner package is installed for future authorized uploads.

## Architecture and external Redis

```text
Native apps -> TLS reverse proxy -> API (main.ts)
                                      | MongoDB / Atlas
                                      | private S3 bucket
                                      | external Redis (REDIS_URL)
```

- `src/config/`: environment selection and validation.
- `src/http/`: shared HTTP policies and health endpoints.
- `src/auth/`, `src/users/`, `src/devices/`: identity and owner-scoped APIs.
- `src/admin/`: verified Google administrator admission and role permissions.
- `src/rate-limits/`: persistent counters and atomic mail reservations.
- `src/app-policy/`: live verification and minimum-build policy.
- `src/infrastructure/`: MongoDB and S3 Nest modules.
- `src/jobs/`, `src/processing/`: durable audio history and temporary unavailable boundary.
- `src/storage/`: restricted transfers and bucket preflight.
- `src/notifications/`, `src/job-errors/`: durable push delivery and safe error records.
- `src/app.module.ts`: HTTP composition.
- `deploy/` and Compose files: API-only VPS deployment preparation.
- `AGENTS.md`: commands, conventions and boundaries for AI-assisted development.

## Media usage and transfer contract

Authenticated clients read `GET /processing-usage`. Schema version 2 reports
the UTC period, processing use/reservations/refunds, upload grant and confirmed-byte
counters, result-grant and estimated-byte counters, retained-result bytes, effective
media/transfer limits, reset times, and the safe admission reason. These counters
belong to the account, not an installation.

`POST /jobs/:id/download-grants` requires `artifact` plus a UUID-v4 `request_id`.
Replaying the same still-valid request for the same immutable object does not charge
again. A known-expired entitlement requires a new request ID. User result grants are
charged to the account and service estimate; worker input grants affect only the
service estimate. Presigned URLs are never persisted or logged.

The global standard policy and selected per-account replacement values are managed
through the existing audited admin settings and account-override routes. Overrides
may replace processing, media, upload, download, retention, and signed-URL fields;
omitted fields continue using the global value. Administrators change policy values,
not raw usage counters or object metadata.

Set the required `REDIS_URL`, just as you set `MONGODB_URI`:

```dotenv
REDIS_URL=rediss://default:ENCODED_PASSWORD@redis.example.com:6379/0
```

Use `redis://` for a trusted private connection or `rediss://` for TLS. URLs
support an optional ACL username, percent-encoded password, port and database
number. Query parameters and fragments are rejected. Production requires a
password of at least 16 decoded characters. Use TLS over untrusted networks;
certificate verification remains enabled.

One shared ioredis client handles request limits, atomic mail budgets and readiness
PINGs. Connection and command timeouts are five seconds, with bounded request
retries and automatic reconnect. Redis failures produce sanitized 503 responses;
liveness stays available. Configure persistence and `noeviction` on the external
service to preserve security counters across API restarts. Use separate databases
or instances for environments, monitor capacity and test backups/restores.

## HTTP security

Helmet, a 64 KiB JSON limit, request/header timeouts, strict DTO validation,
generic errors and shared 60 requests/IP/minute are configured centrally. Redis
counters persist across API processes and restarts. Liveness is exempt; readiness
is throttled. Protected routes and mail fail closed when security storage is
unavailable. Firebase and edge abuse protections still matter.

Worker HTTP routes retain the 600/IP/minute global ceiling and use an additional
Redis reservation **before** any credential lookup: 300/IP and 3,000/service
per minute by default. Authenticated worker budgets then apply by machine,
installation or enrollment identity, operation class, endpoint and service.
Limits are atomic across API instances, return 429 with `Retry-After`, and fail
closed with 503 if Redis is unavailable. Tune `WORKER_*_PER_MINUTE` only with
worker traffic evidence. The worker hint socket accepts a single-use ticket in
the `Sec-WebSocket-Protocol` header, rejects browser origins and URL query
tickets, and independently limits upgrades by IP, machine and service. Its
one-hop proxy IP behavior follows `TRUST_PROXY`. The socket accepts no client
messages and is capped at two connections per machine per API instance and one
hour per connection.

Public APK grants retain a 10/IP/minute route limit and have an atomic
`PUBLIC_RELEASE_GRANTS_PER_MINUTE` service ceiling (default 300). A signed S3
URL can be fetched repeatedly until expiry; API issuance limits cannot cap
those bytes, so production edge/storage egress controls need separate review.

Browser cross-origin access is denied unless `CORS_ORIGINS` lists exact origins;
production origins require HTTPS. Native apps do not need CORS. CORS does not
authenticate requests. Health, app policy and password recovery are public;
owner routes require checked Firebase tokens and local authorization.
Administrator routes also require a current active `admin_access` record whose
UID and normalized verified email match the current Firebase Google profile;
they never require or create a mobile user profile. Configure the documented
`ADMIN_*` request ceilings to tune the shared Redis-backed administrator limits.
Cookie-based authentication will also require a deliberate CSRF policy.

`TRUST_PROXY=false` is the local default. Production `TRUST_PROXY=1` assumes
exactly one host reverse proxy and a loopback-only published API port. Keep that
topology or revise proxy trust before exposing the API. Never trust arbitrary
client-supplied forwarding headers. Do not log request bodies, tokens or SDK
exceptions containing secrets.

## Verify

```sh
pnpm run verify
pnpm run test:integration
pnpm run test:auth:integration
pnpm run test:processing:integration
pnpm audit --prod
```

`verify` runs formatting checks, lint, TypeScript checks, a tracked-file credential
scan, unit and HTTP security tests, then compiles the API. The scan reports only
file and rule names; explicit example placeholders remain allowed. Tests use SWC decorator metadata so Nest
dependency injection and DTO validation execute as in the TypeScript build.

The opt-in integration test requires `mongod` and `redis-server` on PATH (or
`MONGOD_BINARY`/`REDIS_BINARY`). It allocates isolated ports and temporary data,
starts an actual API process, verifies URL authentication and database selection,
forces API and Redis restarts, and checks outage responses and reconnect. It never connects
to configured Atlas/S3 accounts or existing local databases. Temporary test data
and owned child processes are cleaned up afterward.

See [VPS operations](docs/vps.md).

The implemented feature follows the
[auth/users/devices specification](docs/superpowers/specs/2026-09-08-auth-users-devices.md),
[implementation plan](docs/superpowers/plans/2026-09-08-auth-users-devices.md), and
[task tracker](docs/tasks/auth-users-devices.md).

See the [auth API](docs/auth-api.md) for client contracts and
[auth operations](docs/auth-operations.md) for index/policy management.
Configure `FIREBASE_PROJECT_ID`, `FIREBASE_WEB_API_KEY` and a stable random
`RATE_LIMIT_HASH_SECRET` of at least 32 UTF-8 bytes. On CapRover, provide Firebase
Admin credentials through `FIREBASE_SERVICE_ACCOUNT_BASE64`, or use Application
Default Credentials with an externally mounted credential file. Never commit or
bake a service-account key into the image. Changing the HMAC secret resets the
derived budget namespace and requires operational coordination. Auth emulator
configuration is accepted only in test mode with a loopback host and a `demo-*`
project.

`pnpm run test:auth:integration` uses the pinned Firebase CLI, isolated MongoDB and
Redis, synthetic accounts and emulator-only email actions. It checks compiled API
behavior without touching the real Firebase project, Atlas, S3 or a mailbox.

The runtime audit on 2026-09-09 reports ten package findings: six moderate and
four high, with no critical findings. Removing BullMQ does not resolve these
remaining dependency advisories. No forced dependency downgrade or major-version
override has been applied. Recheck and address the audit before release.

## Sources and version choice

The official CLI scaffold was adapted to NestJS 11.2.3 because the current
`@nestjs/throttler` 6.5.0 peer range does not support NestJS 12. Integration packages
whose major is 12 explicitly support NestJS 11; pnpm resolves without peer bypasses.

- [Nest configuration](https://docs.nestjs.com/techniques/configuration)
- [Nest MongoDB](https://docs.nestjs.com/techniques/mongodb)
- [Nest rate limiting](https://docs.nestjs.com/security/rate-limiting)
- [AWS SDK credential chain](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html)
- [Caddy reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)
