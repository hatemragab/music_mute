# Full dashboard local validation

Validation date: 2026-09-11. Workspace: repository root. Tested from the dirty
local `codex/backend-auth-users-devices` checkout based on revision `719b39be0d8d`;
the implementation is uncommitted. This record covers local implementation,
synthetic provider boundaries, and the dashboard deployment. It does not claim
that authenticated production workflows are operational.

## Delivered surface

The backend implements and documents all B01–B18 administration contracts. The `dashboard/` browser SPA implements D01–D14 with React, TypeScript, Vite, Tailwind CSS, shadcn/ui, React Router, TanStack Query, Firebase Web Authentication, Recharts, Vitest, React Testing Library, deterministic route fixtures, and Playwright.

The dashboard includes all 14 planned route states: overview, workers list/detail, jobs list/detail and attempts, users list/detail, releases list/detail, update policy, processing settings, health/alerts, activity, and administrators.

## Backend proof

The latest backend gate completed locally before the final dashboard run:

- `npm run verify`: passed formatting, lint, type checking, 653 unit tests in 86 files, 134 HTTP tests in 25 files, and the Nest build.
- `npm run test:dashboard:integration`: passed 55 compiled/native tests.
- `npm run test:dashboard:curl`: passed 44 anonymous route probes and 36 authenticated workflow requests with 13 audit events.
- `npm run test:auth:integration`: passed 17 tests.
- `npm run test:processing:integration`: passed 21 tests.
- `npm run test:deletion:integration`: passed 2 tests.
- `npm audit --omit=dev`: passed with zero production vulnerabilities after updating `firebase-admin` to 14.4.0 and constraining the affected transitive Multer and Gaxios/UUID versions. The full backend verification gate passed after the lockfile change.

The curl fixture used a uniquely named database on the local MongoDB replica set, confirmed 43 synthetic documents across 26 collections, and dropped that owned database afterward.

## Browser proof

From `dashboard/`:

- Runtime/toolchain: Node.js 24.18.0, npm 11.16.0, React 19.2.8, Vite 8.3.0, Vitest 5.0.0, Playwright 1.63.0, and installed Google Chrome 153.0.8010.36.
- `npm run format:check`: passed.
- `npm run lint`: passed with zero warnings.
- `npm run typecheck`: passed.
- `npm test`: passed 43 tests in 13 files.
- `npm run test:deployment`: passed the production build and 11 deployment tests covering runtime variables, local/production/test environment isolation, subpath routing, malformed Host isolation, CSP/HSTS response headers, hidden-path and missing-asset rejection, startup validation, production auth isolation, archive shape and dotenv exclusion.
- `npm run test:e2e`: passed 27 tests in installed Chrome using five Playwright workers.
- `npm run build`: passed. Route-level code splitting removed the earlier 1.07 MB entry warning; the largest generated page chunk was about 371 kB before gzip.

The Playwright suite proved:

- Google admission states, backend denial, sign-out, all five roles, exact navigation, direct-route denial, and forged privileged-request denial.
- All 14 routes render without page or console errors.
- Owner administrator creation, worker registration and one-time key handling, idle-worker drain, stopped-work recovery with evidence, alert acknowledgment, direct APK hashing/upload/verification, release policy preview/publication/withdrawal, and processing-settings changes.
- Support processing suspension, deliberate private-media grant, playback, cancellation request, media expiry and reviewed renewal.
- Retry creates and navigates to a distinct queued job; recovery-required work suppresses ordinary retry.
- Cursor pagination preserves opaque cursors across loading and returns to the prior page. Job date filters and worker, release, alert, activity and administrator filters are URL-backed.
- Unsaved processing settings block in-app navigation until the operator keeps editing or explicitly discards the draft.
- A committed settings mutation with a deliberately lost response is reconciled through its operation receipt and a resource read-back without a duplicate write.
- Durable dashboard mutations share operation-receipt reconciliation. Lost one-time worker keys, upload grants and media URLs provide explicit safe recovery instructions because those response values cannot be read back.
- A separate browser test runs against compiled NestJS with isolated MongoDB/Redis and proves owner session admission, support privilege-escalation denial, same-operation concurrency, durable receipt read-back, single-row creation, stale-revision rejection, immediate mid-session revocation, strict media/release/publication request bodies, and every other dashboard mutation against Nest's production validation pipe.
- Axe checks in light and dark themes, keyboard skip navigation and focus, reduced-motion CSS, a chart text/table alternative, and horizontal-overflow checks for every route at 360, 768, and 1440 pixels.

## CapRover package proof

`npm run package:caprover` produced the final 143-entry root-shaped archive at `/var/folders/jh/kqzv5jvj1qgfq85qwnwclz4w0000gn/T/musicmute-dashboard-caprover-zJ93oD/dashboard.tar` with SHA-256 `2a5c9e85f629e56ca4e4157a259118af78ca4e106a139701a88675235d0a8338`. It contains root `captain-definition` and `.dockerignore` files plus only the dashboard build inputs. Archive inspection found zero dotenv files, dependency trees, generated output, coverage files, or browser-test artifacts.

The final archive was uploaded to the new CapRover `dashboard` app and built as version 2. CapRover reported a successful image build, and the server log confirmed the application listening on `0.0.0.0:80`. The app has its production profile, API origin, root base path, and public Firebase web configuration injected through CapRover variables. HTTPS is enabled and forced for [dashboard.music-mute.com](https://dashboard.music-mute.com).

Live probes returned 200 for `/healthz`, `/`, `/runtime-config.js`, `/favicon.svg`, and the `/jobs/example` SPA fallback. The runtime response contained no placeholder or localhost values. Hidden probes `/.env` and `/.git/HEAD` and the missing `/favicon.ico` asset return 404 instead of SPA HTML. A browser loaded the deployed `MusicMute Operations` sign-in page, rendered its Google sign-in action, and reported no console errors. Plain HTTP returned a CapRover 302 response. No Docker command was run or installed on this workstation.

Authenticated production use is still blocked by three independently verified integration gaps:

- Firebase Authentication currently authorizes only its three default domains; `dashboard.music-mute.com` is absent.
- The live API answers the dashboard-origin preflight with 204 but does not return `Access-Control-Allow-Origin` for `https://dashboard.music-mute.com`.
- `GET https://api.music-mute.com/api/v1/admin/session` returns 404, showing that the currently deployed backend does not contain the locally validated administration API.

## Test boundaries

The compiled browser fixture uses real Nest modules, guards, validation, MongoDB transactions, Redis coordination, CORS, and HTTP. Firebase identity, S3 transfer/signing, and APK verification are synthetic doubles. Browser fixture media is synthetic and does not prove codec or byte-range behavior. The live checks prove dashboard delivery and runtime configuration only; they do not prove sign-in, role admission, production data, administrative writes, S3 access, or worker behavior.

No owner administrator was bootstrapped and no production database record was changed by these checks. The dashboard CapRover app and Firebase web-app registration were created as part of the requested deployment. No commit, push, backend deployment, APK publication, mobile installation, or Windows-worker execution was performed. Mobile update implementation remains covered by the separate [Android](../superpowers/plans/2026-09-10-app-updates-android.md) and [iOS](../superpowers/plans/2026-09-10-app-updates-ios.md) plans; worker deployment remains covered by the [multi-machine worker plan](../superpowers/plans/2026-09-10-multi-machine-workers.md).
