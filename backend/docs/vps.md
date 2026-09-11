# VPS preparation and operations

The supplied Compose file runs only the API. MongoDB and Redis are managed
externally. No servers, resources or data are changed automatically.

## Configure

1. Copy `.env.production.example` to `.env.production` with mode 600. Configure
   the Atlas `MONGODB_URI`, external `REDIS_URL`, Firebase and AWS settings.
   Percent-encode reserved characters in URL credentials. Production Redis
   requires a password of at least 16 decoded characters.
2. Use `rediss://` for Redis over untrusted networks. Restrict database access to
   the API server and retain TLS certificate verification. Inside a container,
   localhost is the API itself, so use a reachable external database hostname.
3. Keep `PORT=3000`, `HOST=0.0.0.0` and `TRUST_PROXY=1` for the supplied Compose
   topology with exactly one host reverse proxy. The API port is published only
   on `127.0.0.1:3000`. Configure HTTPS using `deploy/Caddyfile.example`.
4. Prepare the production indexes using [auth operations](auth-operations.md).
   Configure persistence, backups and `noeviction` on the external Redis service
   to protect shared rate-limit counters and mail budgets.

After reviewing configuration, the operator can run:

```sh
docker compose --env-file .env.production -f compose.production.yaml config --quiet
docker compose --env-file .env.production -f compose.production.yaml build
docker compose --env-file .env.production -f compose.production.yaml up -d api
curl --fail http://127.0.0.1:3000/api/v1/health/ready
```

Use `config --quiet`; rendered configuration can disclose secrets. Dotenv files
are excluded from the image. The API runs as non-root with a read-only filesystem,
bounded resources, an init process and graceful shutdown. Its Docker healthcheck
uses liveness; check readiness before sending traffic. Compose does not restart
a container solely because its healthcheck is unhealthy.

## Migration, update and recovery

Set `REDIS_URL` before upgrading. The old separate Redis settings and queue prefix
are unused. The worker and bundled Redis service have been removed from Compose.
If upgrading an existing stack, keep its Redis service/volume running independently
until the external connection is verified, and stop its old worker separately.
Do not use `--remove-orphans`, `down -v` or data deletion as part of this migration.
This repository change does not stop existing deployed services.

Build a versioned `IMAGE_TAG`, recreate only the API and retain the previous tag
for rollback. API updates must not recreate or erase external Redis storage.
Monitor readiness, 5xx/429 responses, Redis capacity and persistence failures.
Test database backup restores in isolation. Verify real Atlas authentication,
Redis TLS/authentication, Firebase, S3 permissions and proxy configuration before
release; local tests do not prove those external settings.
