# Job request rate-limit deployment

Deployed to CapRover app `api` at `https://captain.music-mute.com` on
2026-09-14. Active image verified in Version History: `img-captain-api:36`.
CapRover build log ended with `Build has finished successfully!`.

## Scope

The deployment used the verified version 35 source archive, whose 270 files
matched commit `e70c48290d91c7a0e63d8b37b44b2db489211c45`, with exactly these
seven production files changed:

- `backend/src/auth/auth.decorators.ts`
- `backend/src/auth/auth.guard.ts`
- `backend/src/config/environment.ts`
- `backend/src/http/health.controller.ts`
- `backend/src/http/security.module.ts`
- `backend/src/jobs/jobs.controller.ts`
- `backend/src/rate-limits/api-throttler.guard.ts`

Only the processing-read allowance and overall IP ceiling additions were taken
from environment.ts. Unrelated workspace changes were excluded.
No environment values, credentials, database migrations, Git commits or Git
pushes were included or performed.

Job reads have a separate per-user allowance of 60 per minute. The overall
IP ceiling is 600 per minute. Rate-limit failures include standard Retry-After.

Archive: `/tmp/musicmute-api-rate-limits-6ZTZSk/api.tar` (temporary local file).
SHA-256: `2ad62dc698fc633b0181545bade848a1f02b310f9db02bf31e74c3d511e131c4`.
Archive comparison confirmed the same 270 regular files and exactly seven
changed file contents; dependencies, tests and generated build output excluded.

## Validation

Against the isolated deployment source in
`/tmp/musicmute-api-rate-limits-6ZTZSk/backend`:

- `npm run typecheck`: passed.
- `npm run build`: passed.
- `npx vitest run src/auth/auth.guard.spec.ts src/jobs/jobs.controller.spec.ts`:
  29 tests passed.
- `npx vitest run --config vitest.http.config.ts`: 10 security HTTP tests passed.
- CapRover Docker build: passed.

Public read-back at 2026-09-14T15:42:17Z from `https://api.music-mute.com`:

| Request                                    | Status | Evidence                                                            |
| ------------------------------------------ | ------ | ------------------------------------------------------------------- |
| `/api/v1/health/live`                      | 200    | `status: ok`, exempt from both IP buckets                           |
| `/api/v1/health/ready`                     | 200    | `status: ok`, default limit 60 and overall limit 600                |
| `/api/v1/jobs?limit=1` without credentials | 401    | `UNAUTHENTICATED`, overall limit 600, no legacy default read bucket |

Production was not load-tested to trigger 429. Per-user bucket behavior and
Retry-After were validated locally. Mobile request-coordination changes need
an updated app build to reach users; deploying the backend does not distribute
Android or iOS changes. See `job-request-coordination.md` for implementation
and broader local validation details.
