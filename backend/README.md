# MusicMute backend

YouTube audio sharing includes guest Chrome/Mac contributions through a
separate capability API. Personal file uploads remain account-private. Read
[the guest publication contract](../docs/url-imports/youtube-community.md) for
producer fencing, durable recovery, quarantine validation, provenance, private
R2 retention and the native snapshot protocol. All account clients can reuse
accepted artifacts through existing URL imports. New YouTube cloud producers keep
full vocals and derive requested trimming without another model run; nullable
`requestedTrimEnabled`, `outputRecipeSnapshot` and durable `renditionPending`
fields preserve the immutable worker recipe while presenting the delivered
rendition. The worker ACK releases its slot before backend trimming; the owner
job stays `uploading_result` until its rendition is committed, avoiding repeated
inference after an HTTP timeout or restart. Existing documents need no rewrite.
Source and isolated fixtures do not establish deployment.

NestJS backend for the MusicMute native apps. Includes Firebase authentication,
profiles, installation/version tracking, voluntary verification, password recovery,
shared Redis limits, processing-access policy and logout-all. MongoDB, external
Redis and R2 provide the infrastructure foundation. Audio-processing availability
is controlled by backend policy and capacity. Existing audio history,
completed-result access, cancellation, deletion, and notifications remain supported.

- [API client contract](../docs/api/client-contract.md)
- [OpenAPI HTTP contract](openapi.yaml)
- [URL imports: private provider adapter, configuration, cleanup, and verification](../video_providers/videoscale/README.md)
- [Administrator dashboard setup](../dashboard/README.md)
- [Zalando guideline index](../docs/backend-security/zalando-guidelines-index.md)
- [Exhaustive route and security matrix](../docs/backend-security/route-matrix.md)

## Email verification and account quotas

Accounts without verified email receive one fifth of their resolved monthly
processing seconds, daily/monthly upload grants, monthly confirmed upload bytes,
monthly download grants/estimated bytes and retained-output storage quota. Resolve
the saved global policy and any active account override first, then divide these
quotas by five and round down to whole units (limits below five become zero).
The current default processing allowance is 7,200 seconds for unverified accounts
and 36,000 seconds after verification. Per-file limits, waiting/processing capacity,
retry budgets, signed URL lifetime and service-wide outbound limits are unchanged.

The backend reads the synchronized, trusted email-verification status in the same
MongoDB session as quota admission. `/processing-usage` and realtime usage snapshots
report the reduced limits. Verification and profile synchronization restore the
full current allowance; existing usage, reservations and retained files are
preserved. Accounts already above a reduced quota have zero remaining allowance,
and accepted processing reservations retain their original settlement behavior.
Android, iOS and web Account screens explain the reduced allowance and offer the
existing verification action.

API preflight: [Zalando guidelines](https://opensource.zalando.com/restful-api-guidelines/)
read on 2026-09-30; rules 104 (OpenAPI), 106 (compatible contracts), 132
(snake_case), 151 (responses) and 118 (security). Existing routes, response shapes
and authorization remain compatible; the quota reduction is the intended behavior
change.

## Default queue capacity

Each account defaults to 20 waiting jobs (`awaiting_upload` plus `queued`) and
one processing job. Admission rejects a new job with `PROCESSING_LIMIT_REACHED`
(HTTP 409) when its waiting capacity is full. Existing monthly and storage limits
still apply. Saved global account policies take precedence: deployments with a
saved limit of 3 require an explicit administrator update of `max_waiting_jobs`
to 20; changing the source default does not migrate stored policies.

API preflight: [Zalando guidelines](https://opensource.zalando.com/restful-api-guidelines/)
read on 2026-09-28; rules 106 (compatibility) and 151 (success/error responses).
Existing routes, authorization and response shapes are preserved.

## URL import throughput

The [2026-10-01 pipeline performance review](../docs/media-pipeline-performance/README.md)
maps mobile-to-user stages, the current read-only CapRover routing check, local
transfer/native/worker improvements and remaining deployment boundaries.

New URL jobs reference [permanent shared media](../docs/url-imports/shared-media.md)
in private R2. Canonical URL hashes deduplicate acquisition; recipe hashes separate
trim/model/output variants. Later users reuse originals and matching vocals without
per-user copies. Local uploads stay private. Shared artifacts/catalog rows have no
TTL and survive job/account deletion.

Completed matching results now create their owned ready job directly, bypassing
the download queue and its outstanding limit. The authenticated cache-only command
`POST /media-imports/cache-deliveries` takes the normal URL/request/trim body and
returns the normal import view. `IMPORT_CACHE_MISS` (404) creates no import,
producer, quota hold or paid work. Mac Local and extension clients use this
command after owner-history lookup; a miss preserves their selected Local path.
Ready reuse does not require URL acquisition to be enabled, while normal account,
processing policy, media, logical storage and download checks remain in force.

URL submissions return a durable queued import immediately, including while other
imports are downloading. The BullMQ import queue defaults to 20 active executions
across all backend replicas (`URL_IMPORT_CONCURRENCY=20`) and at most five new
executions per second (`URL_IMPORT_REQUESTS_PER_SECOND=5`). These shared limits apply
to every acquisition provider. The generic private router and VideoScale use
`ACQUISITION_CONCURRENCY=20` and `ACQUISITION_REQUESTS_PER_SECOND=5` settings.
The selected [yt-dlp YouTube adapter](../video_providers/ytdlp/README.md) allows
ten overlapping acquisitions and two starts per second. Its three Residential
attempts and final Mobile attempt share an immutable 120-second acquisition budget,
with at most thirty seconds per adapter execution. Initial queue time and worker
processing are excluded. See the [2026-10-03 deployment record](../video_providers/ytdlp/docs/DEPLOYMENT-2026-10-03.md)
for bounded live qualification and remaining limitations.
Backend configuration and business logic remain provider-neutral.

After source upload, job admission acquires the global, account and active-user
fences before exchanging the import allowance hold for measured job usage in the
same transaction. Reads on a transaction session run sequentially, and policy
queries preserve MongoDB retry labels so transient conflicts can retry within the
existing transaction budget. Confirmed-source recovery reuses R2 audio without
another provider download. Import timings include `shared-source-confirmation`
and `job-submission`, including inline recovery time.

The 2026-10-04 live diagnostic batch confirmed MongoDB admission contention:
one confirmed-source handoff retried fourteen callbacks with `WriteConflict`
code 112 before the ten-second transaction deadline. Recovery submitted that
source without reacquisition. Shared-source and cached-result job handoffs now
take FIFO turns before opening their MongoDB session, so waiting does not consume
the transaction budget. Acquisitions remain parallel. The per-process gate allows
64 waiting handoffs, expires a wait after 120 seconds and releases its turn after
session cleanup on success or failure. Existing MongoDB fences, quotas, ten-second
transaction deadline and idempotency remain authoritative across replicas.
`processing-transaction-handoff` logs separate queue wait from transaction time.
The gate reduces contention within one API replica; it is not a distributed lock.
The real-policy regression fixture uses pool size ten, the global fence, ten
confirmed inputs and 50 ms of controlled latency per session-bound query. The
pre-fix runtime accepted five and timed out five; the fixed runtime accepted all
ten with one callback each, no conflicts and exactly-once usage accounting.
Queue waiting brought the batch to about 20 seconds while each transaction kept
its original deadline. This is local qualification, not live capacity proof.

The guarded four-file runtime overlay was deployed through CapRover as API109
on 2026-10-04 (Cairo time). All replacement checksums matched, 1,021 other
runtime/dependency files stayed identical, configuration/environment digests
were unchanged and internal MongoDB/Redis readiness returned HTTP 200. The router
remained version 9 and yt-dlp remained version 6. Both authenticated post-fix
ten-source batches finished with ten submitted imports and ten ready jobs.
The final batch's ten UI starts spanned 7.914 seconds. It reached nine waiting
handoffs and a 33.577-second maximum wait; complete handoff time was
14.875–48.219 seconds including queue/recovery. One transaction still exhausted
its ten-second deadline amid concurrent admissions, then confirmed-source
reconciliation submitted it successfully without a new provider download. No
import remained failed and no manual retry was needed. All ten input declarations
were native WebM audio. These post-fix batches reused the existing media cache;
they establish the tested live handoff/recovery, not ten fresh proxy acquisitions
or arbitrary future batch capacity. The earlier diagnostic batch included one
successful fresh native format-250 acquisition on yt-dlp version 6.

Batch-handoff API preflight: [official Zalando guidelines](https://opensource.zalando.com/restful-api-guidelines/)
read on 2026-10-04; rules 104 (secure endpoints), 106 (compatibility), 177 (no stack
traces) and 229 (idempotent commands). Existing authorization, quota checks,
idempotency and sanitized client errors remain in place; no wire schema changes.

The API emits JSON at error level. Routine realtime socket metrics, successful
stage/handoff messages and transient callback-retry warnings are muted. Failed
import stages, reconciliation, timing writes and final transactions retain their
sanitized correlation and failure context as errors. Fatal/startup diagnostics
remain enabled; no raw exception message, stack, source URL or credential is added.

Local qualification on 2026-10-04 passed `pnpm run verify` (1,367 unit and 181
API tests), `pnpm run test:imports:integration` (30) and
`pnpm run test:processing:integration` (19). The isolated shared-media fixture
includes ten simultaneous native audio acquisitions, inline handoff recovery
without reacquisition, exact quota accounting, idempotent replay, near-limit hold
exchange and denied-admission rollback. These fixtures use loopback storage and
isolated MongoDB/Redis; they do not establish production batch capacity.
The guarded candidate Docker build also passed on the server: only the five
modules and their maps changed, and 1,013 other runtime/dependency files stayed
byte-identical to API106. The running API service was not changed by that check.
The same archive was then deployed through CapRover as API107 on 2026-10-04
(Cairo time). The running replica matched all ten replacement checksums,
MongoDB/Redis readiness returned HTTP 200, and backend/router/adapter environment
digests and both provider image IDs were unchanged. This establishes deployment
and readiness, not a new authenticated production batch qualification.
The external readiness probe from the server received HTTP 403 with a Cloudflare
response; the successful check above used the API replica's loopback endpoint.

`URL_IMPORT_MAX_OUTSTANDING=100` counts queued, downloading, validating and uploading
imports globally: up to 20 can be active while the rest wait for a slot. A full
100-import backlog returns `IMPORT_QUEUE_FULL`; successful and failed imports release
their capacity. The starts-per-second limit is distinct from simultaneous execution:
20 long downloads can overlap while starts remain bounded. Existing account waiting
limits, allowance reservations and transfer quotas still apply.

Each transfer reserves its maximum byte allowance before acquisition so simultaneous
downloads cannot all spend the same free disk space. The reservation remains held
during streaming and is released after transfer, when the filesystem accounts for
the written file. Allow up to 4 GB of scratch capacity plus
`URL_IMPORT_MIN_FREE_BYTES` headroom for twenty maximum-size 100-MB files and their
conservative in-flight reservations per backend container. Validation, uploads and
cleanup retain their existing bounds. Changing source defaults does not override
existing process environment values; update the backend, router and both adapters
together after the provider plan supports the configured rate.

API preflight: [Zalando guidelines](https://opensource.zalando.com/restful-api-guidelines/)
read on 2026-09-30; rules 104 (OpenAPI), 106 (compatibility) and 176 (asynchronous
processing). The existing `/media-imports` queued response and authorization remain
compatible. Redis-backed concurrency and rate limiting were checked against the
[BullMQ global concurrency](https://docs.bullmq.io/guide/queues/global-concurrency)
and [global rate limit](https://docs.bullmq.io/guide/queues/global-rate-limit) guides.

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
- Health endpoints do not prove live R2 connectivity or private-bucket configuration.
  Storage checks report cached sanitized evidence; transfer operations validate
  actual object identity. Required configuration is validated at startup.
- Readiness also does not validate Firebase credentials or provider settings.
- Public release resources are `GET /privacy`, `GET /delete-account`,
  `GET /support`, and `GET /public-policy`. They use repository-owned defaults,
  require no authentication, contain no account lookup, and remain available when
  optional publication overrides are absent.

## Environments

For CapRover, use the repository-root `captain-definition` and set Container HTTP
Port to **80**. Configure runtime variables as described below; private acquisition
app setup is in the [provider guide](../video_providers/videoscale/README.md).

`APP_ENV=local` loads `.env.local`. Production and test ignore dotenv files, so
CapRover's process environment is the only production configuration source.
`NODE_ENV=production` must match `APP_ENV=production`. Actual environment files
and service-account JSON files are ignored by Git; only safe examples are tracked.
The production example intentionally contains invalid placeholders, not credentials.

`PUBLIC_SITE_ORIGIN`, `PUBLIC_SUPPORT_EMAIL`, `PUBLIC_DEVELOPER_NAME`,
`PUBLIC_DELETION_TIMEFRAME`, and `PUBLIC_RETENTION_NOTICE` may replace the public
policy defaults. The origin must be an exact HTTPS origin without credentials,
path, query, or fragment. Overrides are bounded and escaped; malformed values fail
startup or page rendering without exposing the submitted value. Verify that the
published support mailbox is monitored before store submission.

MongoDB uses `MONGODB_URI`: a database-specific local URI in development and an
Atlas `mongodb+srv` URI with certificate verification in production. Configure
Atlas network access for the VPS IP and a database-scoped user.
Local authentication/device/deletion writes now require a MongoDB replica set too,
because account fencing and associated writes commit in transactions. Production
Atlas already provides transaction support; standalone local MongoDB is insufficient.

After connecting, startup awaits Mongoose model initialization so collections and missing schema
indexes are created before the API accepts traffic. The database user therefore
needs index-management permission. Audit declared schema indexes before any
separately authorized database maintenance.

Operational details have automatic expiry; see [MongoDB retention](../docs/mongodb-retention.md)
for the exact periods, completed-only guards, existing-data behavior and isolated
verification commands. Successful Library media remains retained. Already-deleted
jobs become eligible for coordinated metadata/attempt cleanup 30 days after media
cleanup completes, with compact request receipts preserving replay protection.

The storage provider is private Cloudflare R2 Standard. Configure all six required
backend-only values: `STORAGE_PROVIDER=r2`, the account-root HTTPS
`STORAGE_ENDPOINT`, `STORAGE_REGION=auto`, `STORAGE_BUCKET`,
`STORAGE_ACCESS_KEY_ID` and `STORAGE_SECRET_ACCESS_KEY`. There is no AWS profile,
SDK default credential chain, session token or provider fallback. The AWS SDK v3
is deliberately retained for the S3-compatible protocol. See the
[current R2 setup and transfer contract](../docs/r2-storage/README.md) for scoped
credentials, browser CORS, retention, billing and remaining live checks.

The owner approved fresh MongoDB schemas and breaking worker storage identities:
quoted `etag` replaces `version_id`. The owner resets MongoDB themselves; no code
here copies old media, deletes AWS objects or resets a database. Worker runtime
archives, qualification fixtures and APK releases must be republished and verified
in R2 before the corresponding real installation/release flow becomes usable.

## Architecture and external Redis

```text
Native apps -> TLS reverse proxy -> API (main.ts)
                                      | MongoDB / Atlas
                                      | private R2 bucket
                                      | external Redis (REDIS_URL)
```

- `src/config/`: environment selection and validation.
- `src/http/`: shared HTTP policies and health endpoints.
- `src/auth/`, `src/users/`, `src/devices/`: identity and owner-scoped APIs.
- `src/admin/`: verified Google administrator admission and role permissions.
- `src/rate-limits/`: persistent counters and atomic mail reservations.
- `src/app-policy/`: live verification and minimum-build policy.
- `src/infrastructure/`: MongoDB and R2 Nest modules.
- `src/jobs/`, `src/processing/`: durable audio history and temporary unavailable boundary.
- `src/storage/`: restricted transfers and bucket preflight.
- `src/notifications/`, `src/job-errors/`: durable push delivery and safe error records.
- `src/app.module.ts`: HTTP composition.
- `Dockerfile`, `captain-definition` and `scripts/package-caprover.mjs`: API-only
  deployment image and allowlisted CapRover packaging.
- `AGENTS.md`: commands, conventions and boundaries for AI-assisted development.

## Local desktop media sync

Mac ARM64 local separation can publish an already processed original/vocal pair
through `/local-media-syncs` without reserving cloud compute or worker capacity.
The [client contract](../docs/api/client-contract.md#mac-local-media-sync) describes
idempotent pair upload grants, full audio validation, owner Library publication,
transfer/storage allowance and bounded pending cleanup. Cloud mode continues to
use normal `/jobs` and `/media-imports`; it is an explicit user choice.

The additive routes require the normal private R2 configuration and transactional
Mongo replica set. Full validation uses the existing `URL_IMPORT_FFPROBE_PATH` and
`ffmpeg` beside it; no new cloud service or model execution is introduced. Local
sync schema/index initialization and private cleanup run independently of the
cloud-separation enablement flag. Device-declared YouTube media is account-private
and is never promoted into the trusted global shared cache.

Fixture checks (no Firebase/R2 credentials or production media):

```sh
pnpm run build
node --test test/local-media-sync.integration.mjs
pnpm exec vitest run src/local-media-syncs
pnpm exec vitest run --config ./vitest.config.e2e.ts test/local-media-sync.e2e-spec.ts
```

These checks do not establish deployment, native account login, actual R2 grant
acceptance or separation quality.

Production checkpoint, 2026-10-02: the user explicitly authorized deployment of
the allowlisted uncommitted-checkout archive, SHA-256
`9947d58cb43b61f7bf91646b2d50dcfbb230a40b9983b18597d69d2e8e197c16`.
CapRover `musicmute` / `api` reported deployed version 104,
`img-captain-api:104`, one instance and no build in progress. Live
`/health/live`, `/health/ready` and `/app-policy` returned HTTP 200;
unauthenticated local-sync creation/recovery and realtime-ticket requests returned
HTTP 401. No commit or push was made. This establishes deployment and route
protection, not completed native login, authenticated R2 pair saving/downloads,
mobile Library appearance or separation quality.

## Media usage and transfer contract

Standard defaults: 600 successful processing minutes/month, 30-minute/100-MB
prepared audio, 100 upload grants/day and 1,000/month, 5-GB confirmed uploads/month,
5-GB retained storage, 1,000 download grants and 50-GB downloads/month, and a
500-GB service outbound ceiling/month (decimal bytes). Saved global values take
precedence over code defaults; active account overrides keep their values.
Existing native clients retain 20-minute/50-MB local-upload policy ceilings.
Clients opt into expanded media using `media_limits_version=2` on `/processing-policy`.

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
omitted fields continue using the global value. Administrators change policy values or explicitly reset current usage through the audited reset route; object metadata is never rewritten.

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

### Native Desktop Google exchange

`POST /auth/desktop-google-token-exchanges` is a public pre-Firebase operation
for the registered Mac Desktop OAuth client. Its closed body contains only
`authorization_code`, `code_verifier` and the exact dynamic
`http://127.0.0.1:<port>/oauth2callback`. The port must be canonical decimal
1–65535. It is a Google form value, never a fetch destination. The backend uses
only `https://oauth2.googleapis.com/token`, with no redirect, no retry, a total
five-second deadline and a 32-KiB counted response limit. HTTP 200 exposes only
the bounded `google_id_token`; existing native Firebase sign-in and account
session bootstrap continue independently. The exchange persists no Google access,
refresh or identity tokens.

Set **both** `GOOGLE_DESKTOP_CLIENT_ID` and `GOOGLE_DESKTOP_CLIENT_SECRET` through
backend-only secret configuration. The secret must never enter a Mac/browser
bundle or public config. Both absent preserves existing authentication and makes
this route return safe 503; partial or malformed configuration fails startup
without printing values. The configured Desktop client must also be permitted by
the Firebase Google provider's audience policy. This implementation does not
change provider permissions or production secrets.

`DESKTOP_GOOGLE_EXCHANGE_IP_PER_MINUTE` defaults to 10 and
`DESKTOP_GOOGLE_EXCHANGE_SERVICE_PER_MINUTE` to 300. Existing global request
ceilings apply too. One atomic shared Redis reservation precedes upstream work;
refusal returns 429 with `Retry-After`, Redis failure returns 503. The only special
upstream failure is Google's actual 400 `invalid_grant`, exposed as safe
400 `GOOGLE_TOKEN_INVALID_GRANT` so the app can restart sign-in. All other
upstream/configuration failures are generic 503 `SERVICE_UNAVAILABLE`. A consumed
or ambiguous code is never replayed automatically.

All responses are `no-store`. The exchange logs only fixed operator reasons
(`config_missing`, `config_invalid`, `security_store_unavailable`,
`upstream_timeout`, `upstream_unavailable`, `upstream_client_invalid`,
`upstream_request_invalid`, `response_invalid`) and, when available, numeric
upstream status. Never log code/verifier/body/token/secret/IP. Existing Sentry
capture strips request data and upstream exception messages globally. Unit and
HTTP fixtures cover redaction and deadlines; `test/rate-limits.integration.mjs`
also covers compiled exchange admission with isolated real Redis and absent
Google configuration, without a credential exchange.

API preflight: [official Zalando guidelines](https://opensource.zalando.com/restful-api-guidelines/)
read 2026-10-02, rules 101, 104, 106, 118, 129, 134, 148, 151, 153, 176, 177
and 227. The [client contract](../docs/api/client-contract.md) and
[OpenAPI](openapi.yaml) define the exact wire shape. This new source is not part
of the earlier API 104 deployment checkpoint; the later API 105 activation below
provides separately approved configuration/deployment. The real account sign-in
acceptance checkpoint is recorded separately below.

Local verification of this exchange passed `pnpm run verify`: **1,329 unit tests
in 149 files**, **181 HTTP fixtures in 29 files**, format, zero-warning lint,
typecheck, tracked-secret checks, transfer benchmarks and build. The new route's
21 HTTP fixtures are included, with trailing-line-terminator regressions for
code/verifier/callback/config/token validation. `node --test test/rate-limits.integration.mjs`
passed **12 tests** with isolated real Redis, including cross-instance public
exchange admission and atomic refusal preserving the other bucket. Neither
command uses a real Google exchange credential or establishes production login.

Production activation, 2026-10-02: the human explicitly approved retrieval of the
registered Desktop client secret, private backend configuration and deployment
of the tested Google fix. The client pair was configured backend-only, with
private file/directory permissions (600/700) and other environment values
preserved; no secret values were printed or bundled. The CLI application-setting
regression and repair below qualify the original preservation claim. Archive SHA-256
`4e1af692844b0e71558f2c82317fc8f65d61a9b7847e35c13ed9bb40fda65d02`
deployed successfully as `img-captain-api:105`. Protected CapRover readback
confirmed `deployedVersion: 105`, the actual deployed image, one instance and
`isAppBuilding: false`.
`/health/live`, `/health/ready` and `/app-policy` returned HTTP 200. Empty
`POST /auth/desktop-google-token-exchanges` returned 400 `INVALID_INPUT`;
one synthetic invalid code with valid PKCE returned 400
`GOOGLE_TOKEN_INVALID_GRANT`, both `no-store`. The latter proves the configured
server-to-Google fixed-client path reached the provider, not successful real
Google/Firebase sign-in, a backend account session or private R2/media sync.

The CapRover CLI 2.3.1 configuration update unexpectedly cleared
`websocketSupport` and `serviceUpdateOverride`. HTTP health and protected REST
checks passed while three bounded synthetic RFC 6455 handshakes reached ordinary
Nest JSON 404 on realtime/worker-hint socket paths. Both settings were restored
from the owned before-snapshot through a direct API update containing all 13
fields; every other application field was deep-compared for preservation.
Correct unauthenticated `/realtime/socket` upgrade then returned 401, restoring
the expected upgrade rejection path. Actual image `img-captain-api:105`, one
instance/no build, health 200 and synthetic exchange 400/no-store remained valid.
Authenticated WebSocket snapshots require their own acceptance; HTTP health alone
did not expose this repaired regression.

Real Google consent subsequently completed in installed Mac build 86ee4723.
The authoritative token-free accepted-account state contains UID and session
generation, which native source publishes only after Firebase sign-in and
backend session bootstrap acceptance. This establishes actual sign-in without
printing tokens or identity values. Signed-in visual inspection remains pending.

The installed 86ee4723 app subsequently completed a live owner-pair acceptance
with an owned synthetic three-second WAV. The local desktop bridge prepared
vocals, and the native watcher obtained authorization internally and drained
automatic `SYNC`. A receipt is accepted only from `LocalSyncTransfer`'s ready
server view with `committed: true`; the matching outbox was committed/error-free
with that receipt. The staged original was removed after confirmation, local
vocals remained **61,170 bytes**, and the selected WAV remained **264,678 bytes**.
Same-owner/same-file replay returned in **183 ms** with a cache hit, ready sync
state and the same server job; its progress omitted model-load/processing/
separation/encoding stages. This establishes one local synthetic result plus a
live authenticated private-R2 original/vocals commit and warm reuse, without
extracting Keychain or bearer credentials. See the
[owner-save proof](../chrome-extension/output/oauth-review/owner-sync-smoke.json)
and [warm proof](../chrome-extension/output/oauth-review/owner-warm-smoke.json).
Mobile Library UI, authenticated WebSocket snapshots, cloud quota/processing,
Chrome end-to-end playback and listening quality remain separate acceptance.

Final protected operator readback reconfirmed API 105, its actual deployed image,
one instance/no build and WebSocket support enabled. The backend-only Desktop
pair remains configured and matches the installed public client ID. Owned
temporary credential/configuration staging was removed once rollback staging
was unnecessary; no generated Desktop-secret scratch remains. No credentials,
identity values or staging paths are included in these records.

### Shared HTTP controls

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
messages and uses a renewable Redis lease to allow one connection per machine
across API instances. Each connection rotates after one hour.

Public APK grants retain a 10/IP/minute route limit and have an atomic
`PUBLIC_RELEASE_GRANTS_PER_MINUTE` service ceiling (default 300). A signed R2
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
to configured Atlas/R2 accounts or existing local databases. Temporary test data
and owned child processes are cleaned up afterward.

For provider runtime isolation and scratch limits, see
[provider operations](../video_providers/videoscale/README.md).

The [API client contract](../docs/api/client-contract.md) and
[OpenAPI](openapi.yaml) define the current authentication, account, and device
routes and wire schemas.

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
behavior without touching the real Firebase project, Atlas, R2 or a mailbox.

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
- [R2 with the AWS SDK](https://developers.cloudflare.com/r2/examples/aws/aws-sdk-js-v3/)
- [Caddy reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)

## Optional silence trimming (2026-09-26)

`POST /jobs` and `POST /media-imports` accept the optional JSON boolean
`trim_enabled` (default `true`). Set it to `false` to keep quiet sections and the
full separated-audio timeline for future video synchronization. This still removes
music and encodes MP3; encoder delay/padding must be handled by the future muxer.
The choice is immutable per job and is preserved by retries. Changing it with an
existing `request_id` conflicts; omitted and explicit `true` are equivalent.
Strings and null are rejected. Audio acquisition remains audio-only.

Recipe revision 6 trims at -40 dBFS, with the existing 0.6-second minimum gap,
0.2-second padding and 5 ms fades. Revision 5 queued/retry snapshots retain -32
dBFS. Deploy upgraded workers before the backend creates revision 6 jobs: older
workers reject unknown recipe snapshots. No mobile switch is added in this change.

API preflight: https://opensource.zalando.com/restful-api-guidelines/ read on
2026-09-26; rules 101 (OpenAPI), 104 (security), 106 (compatibility), 118
(snake_case), and 176 (problem responses). Existing auth and errors are preserved.

## Client intake

`POST /jobs` accepts prepared local files (`audio_file` or `video_file`,
`source_kind: file`). It rejects the removed device URL-upload flow and
`source_url` request fields. All link acquisition uses `POST /media-imports`.
The public media policy no longer publishes device source-download bounds.
Server imports save included titles and URL attribution. There is no old-device
compatibility route. See the [client contract](../docs/api/client-contract.md).

## Private SaaS acquisition

Follow [provider architecture](../video_providers/README.md).
`AudioAcquisitionClient` calls a private adapter through
`AUDIO_ACQUISITION_API_URL` and `AUDIO_ACQUISITION_API_KEY`.
Only the adapter holds the vendor credential and knows its task/download APIs.
Audio bytes return through the adapter to NestJS for independent validation,
bounded scratch storage, private R2 upload and normal worker submission.
Included sanitized metadata is nullable MongoDB `extra_data`; no paid metadata
request is made. Source titles use its optional `title` field.
Replace providers by deploying another adapter with the same contract and
changing these settings; no migration bridge or vendor-specific NestJS code.

Each backend execution makes one acquisition request. Its private headers carry
the persisted `X-Import-Attempt` and `X-Import-Max-Attempts` (one through four)
and the canonical UTC `X-Import-Acquisition-Started-At`. The first active claim
sets that start once, excluding the initial queue wait; retries preserve it,
including subsequent backoff and queue time. These headers let an adapter enforce
an import-wide budget; they do not replace the backend's per-execution deadline
or provide idempotency. Existing adapters may ignore the added context.
New admissions retain the four-attempt ceiling; historical records without a
saved retry budget retain one attempt. Eligible pre-upload transient failures
keep the existing 5/10/20-second backoff unless a trusted private 502/503 response
provides an integer `Retry-After` between one and twenty seconds. The hint changes
only scheduling and is not exposed or persisted in public import errors.
`IMPORT_ACQUISITION_EXHAUSTED` is a sanitized terminal 503; it never authorizes
another acquisition attempt. Accepted jobs and uncertain uploads retain their
existing recovery fences.

VideoScale enables the shared public-item site catalog; separate audio is checked
per request, with live E2E evidence currently limited to YouTube. Run build-producing checks
sequentially and distinguish local checks from the dated live evidence.

Import maintenance reconciles terminal BullMQ executions in downloading,
validating and uploading states every 30 seconds, preserving confirmed jobs
without replaying acquisition. Unknown states retain the deadline fallback.
Stage logs correlate with adapter diagnostics by opaque execution UUID. Fatal
Node errors emit bounded code locations before the normal exit; infrastructure
must retain logs across container deletion. See
[reliability notes](../video_providers/videoscale/docs/IMPORT-RELIABILITY.md).

## Realtime processing

Processing updates use authenticated raw WebSocket snapshots with automatic
reconnection. See the [protocol and rollout notes](../docs/realtime-processing-queue/PROTOCOL.md)
and [local validation ledger](../docs/realtime-processing-queue/IMPLEMENTATION.md).
HTTP remains responsible for authentication, commands and file transfers.

## Audio transfer performance

See [R2 setup and verification](../docs/r2-storage/README.md) for create-only
uploads, ETag/checksum identity, billing-aware checks and the bounded, explicit
opt-in synthetic benchmark. AWS acceleration and bucket-versioning assumptions
are removed. [Earlier transfer measurements](../docs/audio-transfer-performance/README.md)
remain historical and do not prove R2 latency.

### Monthly admission and URL import reservations

New local jobs and uncached URL processing are admitted while used plus reserved monthly
processing seconds are below the limit. An accepted file runs in full even if
its duration crosses that limit; subsequent submissions are blocked. URL imports
reserve a temporary per-file-cap hold before acquisition, then atomically exchange
it for measured job duration. The hold does not require a full file's allowance
remaining. Failed/stalled imports release it. Measured duration reconciliation
honors existing admission instead of rejecting an already accepted file.
Existing authentication, per-file caps and transfer limits remain unchanged.
Completed shared results need no compute/upload reservation and can be reused
after monthly processing or waiting capacity is exhausted, subject to account,
policy, media and logical Library storage checks. Source-only reuse still requires
normal compute admission. Fresh acquisition keeps normal upload billing.
Run `pnpm run test:imports:integration` for isolated Mongo concurrency, recovery,
pre-acquisition rejection and one-minute-remaining regression coverage.

## Account usage reset

The user detail page's **Reset usage** action calls
`POST /admin/users/:id/account-usage-resets`. It zeroes current UTC-month processing
used/released seconds, upload grants/confirmed bytes, download grants/estimated
bytes, and current UTC-day upload grants. Quota limits, overrides, actual stored
file usage, files, historical periods and service-wide bandwidth remain unchanged.
Active jobs, imports or reservations must finish or be cancelled first.
The operation requires `users.processing.manage`, fresh authentication, a reason,
a UUID operation ID, and the displayed usage revision/month/day. Stale confirmations
return 409; refresh and reopen the dialog. Successful operation replays cannot erase
new usage. Audit records retain before/after values; deployment alone resets no user.

API guideline preflight: [official Zalando guidelines](https://opensource.zalando.com/restful-api-guidelines/),
read 2026-09-29: rules 101, 104, 106, 118, 149, 151 and 176 (OpenAPI,
authorization, compatibility, snake_case, HTTP semantics and problem responses).

## Administrator announcements

`POST /admin/notifications` queues a system announcement; `GET /admin/notifications`
(cursor, limit 1–50/default 20) and `GET /admin/notifications/:id` expose safe history.
Only owners receive `notifications.read` and `notifications.send`. Creation requires
fresh authentication, the sensitive admin rate limit, an operation UUID v4 and an
audit reason. Existing transaction receipts prevent duplicate commands and fence
revoked administrator access. Persisted notification content may appear on lock
screens; do not include private user data. All responses are no-store.

The new `notification_campaigns` and `notification_campaign_deliveries` collections
are initialized with declared indexes; no existing collection/index is migrated.
The dispatcher runs independently of audio processing admission. It freezes at most
100 registration references per pass, excluding bindings updated after creation,
and rechecks active account/session/installation ownership before each send.
It handles four sends per renewable 60-second lease, at most ten passes per
five-second maintenance tick per API process. Tokens remain only in registrations.
Transient errors retry up to eight attempts using the existing backoff; known
invalid destinations deactivate only the exact current binding. Startup/restart and
multiple replicas recover through durable leases and per-binding attempt records.
History counts are per device, not unique users, and grow while targets are frozen.
New per-account deliveries use the shared account-deletion transaction fence.
Completed campaigns save final counters before their delivery details expire after
30 days; their historical counters remain stable after detail/account cleanup.
Campaign content and summaries expire 365 days after completion. Counts already
lost through account cleanup before this policy cannot be reconstructed.
Administrator audit history expires after 365 days; command replay receipts remain.

FCM submission is at least once: a crash or timeout after provider acceptance but
before its durable receipt can produce a duplicate. Stable event IDs and collapse
identifiers reduce duplicate presentation; there is no delivery/read receipt claim.
Current native foreground behavior is unchanged. Existing Firebase Admin messaging
and APNs configuration is required. Nothing in local tests establishes live delivery.
Run `pnpm run build && node --test test/admin-notifications.integration.mjs` for
isolated replica-set tests, and `pnpm run verify` for static/unit/HTTP checks.

API guideline preflight: https://opensource.zalando.com/restful-api-guidelines/
read on 2026-09-29. Rules 101 (OpenAPI), 104 (endpoint security), 106
(compatibility), 118 (snake_case), 159 (pagination), 176 (problem responses)
shape the additive contract. Existing lowercase states and receipt conventions
are retained for consistency.

Batch-failure diagnostic follow-up (2026-10-04): the supplied 22:04–22:06 UTC
batch and a bounded read-only production query identified nine logical imports:
seven ended failed after validated source upload/confirmation, and two submitted
successfully. One submitted import recovered after an initial handoff warning.
Initial post-confirmation warnings appeared 10.46–14.06 seconds later; failed
imports accumulated 20.12–25.93 seconds in job submission including recovery.
These timings suggest transaction timeout/contention but do not prove the driver
exception. Added private acquisition-correlated transaction step/callback/error
classification, job-submission and reconciliation outcomes. Timing-ledger writes
are best effort so they cannot replace the original exception or fail an accepted
job. Original driver retry labels and transaction/retry budgets remain intact.
No raw error message, stack, source URL/title, account identity or storage key is
included in these diagnostics. This follows the official Zalando guidelines read
on 2026-10-04, rules 106 (compatibility), 177 (no stack traces in public errors)
and 229 (idempotent operations). Live batch retest remains required after rollout.

Diagnostic qualification passed `pnpm run verify` (1,400 unit tests and 181 API
E2E tests), `pnpm run test:imports:integration` (30 tests), and
`pnpm run test:processing:integration` (19 tests). The pinned yt-dlp suite passed
74 tests without skips. Isolated candidate images also passed redaction/original
error checks and Python acquisition fixtures. Guard tests rejected altered base
runtime, unexpected helper files and altered backend dependency manifests.

Deployed through CapRover on 2026-10-04 Cairo as API108 (22:40:21 UTC Oct 3) and
private yt-dlp6 (22:41:44 UTC Oct 3). Eight backend JS/map checksums and four
adapter module checksums matched the tested overlays; image configuration and
runtime environment hashes remained unchanged. Internal API readiness and adapter
health returned HTTP 200/ok. Router9 remained unchanged. Candidate scope comparison
preserved 1,017 other backend runtime/dependency files and nine other adapter
files. No user batch was generated during this rollout, so the timeout/contention
hypothesis still requires a batch retest and the newly classified errors. These
are backend/adapter changes; no client build or Android installation is required.

### Trusted original reuse (2026-10-05)

`POST /youtube-contributions/:id/source-deliveries` accepts an empty JSON body
with the existing guest bearer. Only the owned active producer can request it.
It returns `video_id`, `provenance: trusted`, `source_identity_verified: true`,
and `original: { declaration, grant }` with `Cache-Control: no-store`. The source
must be a validated, immutable backend-acquired shared source; a ready vocal
rendition is not required. Missing originals return `IMPORT_CACHE_MISS` (404);
authentication, ownership and lease errors retain existing 401/404/409/410 codes.
The delivery reserves original bytes against existing session/IP/global limits
and rechecks session/producer after signing. It never acquires media or admits
cloud work. Clients fall back to local acquisition only on that explicit cache
miss, never on authorization errors or an unrecognized 404.

Deployment evidence (2026-10-05): the 372-file allowlisted archive
`e8fd8ee2cff0b5456c0bf04f1cf535dbcab07a303f72868a42495dec6efe3be1`
was deployed with CapRover CLI to `musicmute` / `api`, active version **115**.
Readback showed one instance, no build in progress, and identical application
configuration. `/health/live`, `/health/ready`, and `/app-policy` returned 200;
the new source-delivery route returned 401 `UNAUTHENTICATED` without a guest
capability. These probes do not establish authenticated live R2 delivery or
end-to-end cloud playback. Local source-delivery integration used isolated
MongoDB/Redis and synthetic audio.
