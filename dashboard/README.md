# MusicMute administrator dashboard

Private React + TypeScript + Vite operations console for the MusicMute NestJS API. The dashboard covers administrator access, jobs, user processing controls, private media grants, releases and APK verification, update policy, processing settings, health alerts, audit history, and bounded CSV exports.

## Local setup

Install the locked dependencies and start the development server:

```sh
npm ci
cp .env.local.example .env.local
npm run dev
```

Like the backend, the dashboard uses `APP_ENV=local` with
`NODE_ENV=development` for local work. Only `.env.local` is loaded, and values
in the shell take precedence. Production and tests ignore all dotenv files.
`APP_ENV=production` must be paired with `NODE_ENV=production`.

Configure these public values through the local environment while running Vite:

- `VITE_API_ORIGIN`: HTTPS API origin, or a loopback HTTP origin for local work.
- `VITE_APP_BASE_PATH`: optional root-relative deployment path; defaults to `/`.
- `VITE_FIREBASE_API_KEY`
- `VITE_FIREBASE_AUTH_DOMAIN`
- `VITE_FIREBASE_PROJECT_ID`
- `VITE_FIREBASE_APP_ID`

The Firebase values are browser client configuration. Never place Admin SDK credentials or service-account files in this app. The API origin must list the dashboard origin in its `CORS_ORIGINS` setting.

The Playwright command selects a separate test-only auth adapter with Vite's `e2e` mode. That adapter is excluded from production builds.

## Validation

```sh
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:deployment
npm run test:e2e
npm run build
```

`npm run test:e2e` uses installed Google Chrome. It starts the Vite app plus a compiled NestJS fixture backed by test-owned, loopback-only MongoDB and Redis processes. It requires `mongod` and `redis-server` locally, uses synthetic Firebase/storage/APK-verifier doubles, and removes its temporary database files when the run ends.

The browser suite also uses deterministic route fixtures for UI states. Those fixtures prove browser behavior but do not prove live Firebase, S3 CORS/IAM, production data, or deployment.

## Security and behavior

- The backend derives every permission from the admitted administrator role.
- Mutation requests carry revision fences and operation IDs. Ambiguous responses are reconciled through the durable operation receipt and a server read-back without resending the write. One-time keys, upload grants and short-lived media URLs report a safe recovery action when their response cannot be recovered.
- Private media URLs are requested only after a deliberate reviewed action, remain in memory, and expire after five minutes.
- Page modules load on demand so the initial application bundle stays bounded.

## CapRover package

Build the tested root-shaped upload archive from `dashboard/`:

```sh
npm ci
npm run test:deployment
npm run package:caprover
```

The last command prints the absolute path to `dashboard.tar`. Upload that tarball to the dashboard CapRover app and use `./captain-definition` as the Definition Path. The image listens on container port `80` and exposes `/healthz` for health checks.

The server sends a Firebase/API-compatible Content Security Policy and
`Strict-Transport-Security: max-age=31536000` on every response. CapRover must
terminate TLS, force HTTPS, and preserve both headers. Verify them on the public
HTTPS response after each proxy or deployment change.

Set these variables on the CapRover dashboard app before it starts:

- `APP_ENV=production`
- `NODE_ENV=production`
- `HOST=0.0.0.0`
- `PORT=80`
- `VITE_API_ORIGIN=https://api.example.com` — HTTPS origin only, without `/api/v1`, credentials, query or fragment.
- `VITE_APP_BASE_PATH=/` — use a root-relative subpath such as `/operations` only when the reverse proxy serves the app there.
- `VITE_FIREBASE_API_KEY`
- `VITE_FIREBASE_AUTH_DOMAIN`
- `VITE_FIREBASE_PROJECT_ID`
- `VITE_FIREBASE_APP_ID`

Despite their established `VITE_` names, the production server reads these values when the container starts and writes a no-store browser runtime configuration response. Rebuilds are unnecessary for value changes; restart the app after changing them. The packaging script uses an explicit source allowlist and rejects symlinks. It excludes `.env*`, dependencies, build output, tests and browser artifacts. No dotenv file belongs in the CapRover upload.

Use [.env.production.example](.env.production.example) only as the CapRover key
reference. The production server never reads it from disk.

Configure the backend `CORS_ORIGINS` with the exact public HTTPS dashboard origin. If the dashboard uses a subpath, the origin still contains only scheme, host and optional port.

See the [approved scope](../docs/tasks/full-dashboard/scope.md), [API contracts](../docs/tasks/full-dashboard/contracts.md), and [local validation record](../docs/validation/full-dashboard-local.md).

## Processing administration

User detail includes rolling usage, reservation holds, individual replenishments,
and temporary allowance increases/revocation. Expiry, reason, operation ID,
expected revision and fresh authentication are required for allowance changes.
Suspensions can have an optional expiry; effective access comes from the server,
not a client timer. Allowance writes perform authoritative read-back.
