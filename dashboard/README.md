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

Dashboard calls use root-mounted `/admin/...` resource routes and snake_case
JSON/query names on the wire. The API also checks the authenticated
administrator's current role and each operation's permission. See the
[API client contract](../docs/api/client-contract.md) for error, retry, and
pagination rules, and [OpenAPI](../backend/openapi.yaml) for exact operations.

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

The browser suite also uses deterministic route fixtures for UI states. Those fixtures prove browser behavior but do not prove live Firebase, R2 CORS/IAM, production data, or deployment.

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
- `VITE_API_ORIGIN=https://api.example.com` — HTTPS origin only, without a path, credentials, query or fragment.
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

## Mac updates

**Mac updates** is a separate Sparkle release workflow at `/macos-updates`, with
`releases.read` for inspection and `releases.manage` for upload/publication.
An owner saves the 32-byte base64 Ed25519 public key with fresh authentication
and an audit reason. The backend prevents key changes after any Mac release is
created. The private signing key stays in the Mac's Keychain.

Download `musicmute-macos-updates.json` from the page; it contains only public
feed/download URLs and the public key. From `chrome-extension/`, build with
`MUSICMUTE_MAC_VERSION=YOUR_NEW_VERSION MUSICMUTE_MAC_BUILD=YOUR_NEW_BUILD MUSICMUTE_UPDATE_CONFIG_FILE=/path/musicmute-macos-updates.json npm run package:macos:release`,
then run `npm run prepare:macos:update -- --release-result /path/release-result.json --dashboard-config /path/musicmute-macos-updates.json --keychain-account YOUR_SPARKLE_ACCOUNT`.
Existing Developer ID signing and notarization prerequisites still apply.

Select the prepared canonical DMG (at most 2 GiB) and signed `appcast.xml`
(at most 32 KiB). The dashboard hashes the DMG in bounded worker chunks, checks
the pair's version, build, bytes, filename hash and download URL, creates a
draft and uploads through an immutable private R2 grant. The server verifies
the signed appcast and uploaded bytes before publication can be confirmed with
fresh authentication and a reason. Withdrawals stop advertising the release in the public feed; existing immutable
archive downloads remain available. The newest withdrawn release can be
republished with a fresh review. Android/iOS releases and update policy are separate.

Mac release reads have no polling or focus/reconnect refetch. Explicit commands
read back committed state. Lost create responses recover the draft through its
receipt; an explicit **Recover upload grant and resume** action replays the same
operation ID for a fresh grant. Signed URLs stay in memory. Unresolved receipts
fence new writes until **Check operation outcome** resolves them. Cancelled or
ambiguous transfers can be verified before retrying. **Resume upload** lets a
manager recover an awaiting draft after reloading the page using the same prepared
DMG; the signed appcast already saved by the server is retained. This workflow's local
fixture checks do not establish live R2, signing, Sparkle or deployment success.

## Processing administration

User detail includes current UTC-month processing usage, upload grants/confirmed
bytes, result grants/estimated bytes, retained-output bytes, effective limits, reset
boundaries, and an optional account policy override. The override can replace selected
processing, media, upload, download, retention, and signed-URL values while blank fields
continue using the global standard policy.
Reason, operation ID, expected revision and fresh authentication are required for
override changes. Suspensions can have an optional expiry; effective access comes
from the server, not a client timer. Override writes perform authoritative read-back.

## Realtime processing

Processing updates use authenticated raw WebSocket snapshots with automatic
reconnection. One app-level socket is shared by all live views and remains open
while the page is loaded, including across route changes and browser-tab switches.
Background tabs suspend only client-side response deadlines; returning to the tab
gives the existing connection a heartbeat grace window before recovery.
See the [protocol and rollout notes](../docs/realtime-processing-queue/PROTOCOL.md)
and [local validation ledger](../docs/realtime-processing-queue/IMPLEMENTATION.md).
HTTP remains responsible for authentication, commands and file transfers.

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

## Push notifications

Owners can open **Push notifications**, compose an 80-character title and
500-character message, review the preview, provide an audit reason, reauthenticate,
and queue a broadcast to all eligible registered native devices. Broadcasts cannot
be recalled. The page streams cursor-paginated FCM history over the shared socket.
History includes content, creator, reason, timestamps and per-device pending,
FCM-accepted, failed, invalid and skipped counts. No device tokens are exposed.
An unresolved operation receipt disables further sending in that page session.

This is broadcast history from this dashboard, not an inbox of job-result pushes.
FCM acceptance does not prove device delivery or reading. Current Android clients
show notification payloads in the background; they do not show announcement banners
in the foreground. iOS display depends on APNs setup and notification permission.
Web users without a native push registration are not reachable by this feature.

## Worker insights and commands

The fleet page summarizes only the currently loaded, filtered page. Worker detail
explains contact, policy-sync and slot blockers against the server observation
time, and labels cached data when disconnected. It does not promise scheduler
eligibility or an ETA. The overview links directly to failed jobs, worker capacity,
health and push history according to administrator permissions.

Owners can request Runtime snapshot (service/storage), Engine checks
(model/provider/FFmpeg), full Doctor, and one Kim Vocal 2 Benchmark. Existing
pause/drain/resume/revoke controls are retained. Commands require an audit reason
and fresh authentication. A pending command disables another of the same kind;
a lost response is reconciled through the operation receipt, and an unresolved
outcome blocks further commands in that page session.

Recent command history shows up to 20 commands, checks, expiry/completion times
and bounded readable metrics. Runtime snapshot metrics on updated workers include
supervisor/host uptime, supervisor resident/heap memory, host total/free memory,
CPU parallelism, and scratch volume available/total space. These are observations
at command execution, not continuous CPU/GPU utilization or memory budgets. Older
workers may omit metrics. The engine checks share one packaged probe: a failed
probe means its requested checks failed or could not complete. Successful unrelated
checks remain visible. See [review and plan](../docs/dashboard/worker-insights-plan.md).
