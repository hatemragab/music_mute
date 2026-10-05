# MusicMute web client

This is the end-user browser client for MusicMute. It uses the existing NestJS API,
Firebase Authentication and signed R2 transfers. It is separate from the admin
dashboard. The Android app is the visual and journey reference; approved browser
adaptations are recorded in [`tasks/`](tasks/README.md).

## URL imports

URL imports go through NestJS and a private SaaS adapter, not browser extraction
or direct vendor calls. NestJS validates the returned audio and uploads it to
private R2 for processing. The catalog includes YouTube, Instagram/Reels, TikTok,
Vimeo, SoundCloud and Facebook/Reels. Actual separate audio availability is
checked per request; enabled sites are not universal acquisition guarantees. Live import/job updates use
WebSocket snapshots. See [provider architecture](../video_providers/README.md).
Failed imports stop their loading indicator and show localized source/service
errors. The submission form becomes available as soon as NestJS accepts the request.
Multiple imports keep independent WebSocket progress and account-scoped recovery
identities; completed imports expose an explicit job link without navigating
away from the next draft. Eligible failed imports offer **Try again**, matching
Android's transient-error allowlist. It preserves the original link, trim choice
and confirmed intent, keeps the failed card until acceptance, and retains one
retry UUID across uncertain responses and reloads. Owner import snapshots restore
the original link/trim for older cards; malformed or missing context cannot start
a retry. Double clicks and late responses from another session are fenced.
Failed imports can also be dismissed. Terminal imports are retried only by an
explicit user action; shared source/result caches remain authoritative.

## Development setup

Use Node 24 and npm. Install with `npm ci --ignore-scripts`, copy
`.env.local.example` to an ignored `.env.local`, and fill in the **public Firebase
Web SDK configuration** from the existing Firebase project's registered web app.
`VITE_API_ORIGIN` must be an HTTPS API origin, or loopback HTTP for a local API.
These Firebase Web SDK values are public client configuration, never Firebase
Admin credentials. Start with `npm run dev`. The web API must include the
browser origin in its configured CORS allowlist for real local sign-in; the
production CORS allowlist does not include localhost by default.

The production server reads its public runtime values from:

| Environment variable          | Purpose                                                                |
| ----------------------------- | ---------------------------------------------------------------------- |
| `PUBLIC_API_ORIGIN`           | HTTPS origin of the MusicMute API                                      |
| `PUBLIC_FIREBASE_API_KEY`     | Firebase Web API key                                                   |
| `PUBLIC_FIREBASE_AUTH_DOMAIN` | Firebase auth domain                                                   |
| `PUBLIC_FIREBASE_PROJECT_ID`  | Firebase project ID                                                    |
| `PUBLIC_FIREBASE_APP_ID`      | Firebase web app ID                                                    |
| `PUBLIC_MEDIA_ORIGIN`         | Required exact HTTPS R2 account origin for storage CSP; no AWS default |
| `PORT`                        | Listener port, default `3000`                                          |

These values are served through non-cacheable `/config.js`, allowing one image
to be configured per environment without rebuilding. Do not place private R2
credentials, Firebase Admin service accounts, backend `.env` values, database
URLs or bearer tokens in these variables. The client does not store signed R2
URLs or identity tokens in its own local storage; Firebase manages its own
session persistence. The API and R2 bucket enforce their own authorization and
CORS policies. The server provides an SPA fallback and `/healthz`.

## Verification

Run `npm run format:check`, `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:server`,
`npm run test:e2e`, and `npm run build`. The Playwright suite uses the installed
desktop Google Chrome and synthetic fixtures; it writes screenshots to ignored
`test-results/screenshots/`. The authenticated preview is **mocked** and served
only by Vite from `tests/preview.html`; the production Docker image excludes it.
Real Firebase/production API integration requires a dedicated test identity.
The API web-platform support was deployed on 2026-09-26 and verified by health,
isolated integration tests and browser-origin CORS preflight. On 2026-09-27,
a generated WAV completed real authenticated browser preparation, signed S3
upload, worker processing and playback. Account lifecycle and the remaining
production journeys are still pending; see the
[implementation ledger](../docs/production-readiness-implementation-2026-09-27.md).
These dated AWS results do not establish R2 acceptance. Backend verification lives in `backend/`.

## Startup recovery

The startup screen identifies whether the browser is restoring Firebase sign-in or
connecting the account session to the API. Each step has a 15-second limit. If a
step stalls, the screen shows a localized explanation and Retry; retry starts a
new auth subscription and cancels the previous session request. This avoids an
unbounded loading screen without signing users out or discarding their data.

## Audio behavior

Local intake accepts audio only. Browser-decodable MP3, AAC/M4A, Ogg/Opus and
WebM at an average bitrate no higher than 160 kbps are preserved; higher-bitrate
or other browser-decodable audio is converted to AAC-LC in M4A with lazily loaded
Mediabunny and its AAC encoder. Browser conversion limits sources to
80 MB and 120 seconds of execution to bound tab memory and CPU; the API may
have lower account limits, which the client reads before admission. Source
audio that the browser cannot inspect is rejected with an actionable message.
The server remains authoritative for duration, format, checksum, quota and job
state. Closing the tab interrupts preparation or upload. URL imports happen on
the server and never download provider media into the browser. A bundled
[verified-site policy](../docs/url-imports/supported-sites.md) rejects unknown
sites and invalid item links locally before saving retry state or submitting
an import. The catalog in `src/site-policy/data/` is also bundled by Android
and iOS; changing it requires rebuilding all clients.

The AAC encoder bundle is about 1 MB before compression and is fetched only when
conversion is needed. Mediabunny and its AAC encoder declare MPL-2.0; their
notices and the Noto Sans Arabic font license are served from `public/licenses/`.

## Packaging and release boundary

The `Dockerfile`, `.dockerignore`, `captain-definition` and server are scoped to
this folder. `npm run package:caprover` produces an allowlisted source archive;
upload it to CapRover app `app` with container HTTP port `3000`. The production
site is `https://app.music-mute.com`; HTTP redirects to HTTPS. API CORS,
Historical Firebase authorized-domain and AWS S3 CORS preflights are recorded in
[`tasks/08-infrastructure.md`](tasks/08-infrastructure.md). The archive and
runtime configuration must be reviewed for each release. Real Firebase popup,
signed R2 transfers and authenticated account/job flows remain unverified in
production.

The public `/` entry page has a descriptive title, canonical URL and share
metadata. `robots.txt` and `sitemap.xml` list only that URL. Authenticated SPA
routes carry `X-Robots-Tag: noindex, nofollow`, and unknown paths return 404, so
private screens are not advertised as search results. The favicon is rendered
from Android's `ic_vocal.xml` brand mark; update `public/favicon.svg` and its
192-pixel PNG together if the native mark changes. These measures support branded
discovery; the signed-in application is not a substitute for a public product
landing page, and indexing is controlled by search engines.

The signed-out entry and authenticated Settings page advertise the macOS app and
link to the future public landing page's Downloads section. Keep the stable URL
centralized in `src/product-links.ts` as `https://music-mute.com/#downloads`;
do not link browser UI directly to a mutable DMG or to the authenticated web-app
origin. External product links open in a new tab with `noopener noreferrer`.

## Realtime processing

Processing updates use authenticated raw WebSocket snapshots with automatic
reconnection. One app-level socket is shared by all live views and remains open
while the page is loaded, including across route changes and browser-tab switches.
Background tabs suspend only client-side response deadlines; returning to the tab
gives the existing connection a heartbeat grace window before recovery.
See the [protocol and rollout notes](../docs/realtime-processing-queue/PROTOCOL.md)
and [local validation ledger](../docs/realtime-processing-queue/IMPLEMENTATION.md).
HTTP remains responsible for authentication, commands and file transfers.

## Private R2 transfers

Configure `PUBLIC_MEDIA_ORIGIN` to the exact HTTPS R2 account origin in the
production browser server. It is a non-secret CSP allowlist value; URLs and all
signed headers still come from the backend. There is no acceleration setting or
AWS bucket-origin fallback. The bucket remains private and R2 CORS must permit
only the required browser origins and headers. See
[current storage setup](../docs/r2-storage/README.md).

## Deployment updates

Each production build embeds a unique version in its HTML. Open tabs check the
non-cacheable entry page every 60 seconds while visible and online, and on focus,
visibility changes or reconnection. A different valid version automatically reloads
the current URL, including for rollbacks. Development builds do not poll.

Reload waits while a local audio file is selected or being inspected/prepared/uploaded,
while text fields contain drafts, or while visible media is playing. Clear drafts
or finish the operation to allow the next check to reload. Failed, timed-out or
malformed responses leave the current app running. A session-storage guard permits
only one automatic reload per loaded version, with at least five minutes between
automatic reloads across versions, to avoid stale-cache or mixed-replica loops;
when session storage is unavailable, refresh manually.

This takes effect for tabs that have loaded a build containing the monitor. Tabs
opened before its first deployment still need one manual refresh. Reusing the same
built image keeps the same version; changing only runtime configuration does not
trigger a reload.

## Production failure recovery and monitoring

The root React boundary shows an English/Arabic reload action after a render
failure. It does not silently retry mutations or claim an unfinished upload was
saved. Runtime monitoring is opt-in: set `PUBLIC_SENTRY_ENABLED=true` and
`PUBLIC_SENTRY_DSN` to the web project's public HTTPS DSN. With monitoring disabled,
no SDK client is initialized. Error envelopes allow only a generic failure label,
build identity and same-origin asset paths/line numbers; messages, user context,
request URLs, query strings, breadcrumbs, replay and tracing are excluded. Reporting
is capped at ten events per minute per page. Source-map uploads remain a separate
release step requiring a build-only credential.

The server sends host-only HSTS (`max-age=31536000`). CapRover terminates HTTPS
and must preserve the header. CSP permits `blob:` only for media and workers,
including local audio inspection; production-server browser coverage guards this.
Upload checksums use canonical padded base64 SHA-256, matching API/R2 admission.

Run `npm run build` before browser tests that exercise the production server.
`TEST_BROWSER=firefox npm run test:e2e` and `TEST_BROWSER=webkit npm run test:e2e`
exercise the same fixtures with Playwright's installed engines; install them with
`npx playwright install firefox webkit`. WebKit engine results are not a claim of
physical Safari/iPhone certification. Default browser tests still use installed Chrome.

## Current jobs and Library (2026-09-28)

Home and the processing list hide terminal cloud jobs (`ready`, `failed`,
`cancelled`); unfinished local reviews and recoverable local imports stay
accessible. Creation date and time are shown on Home job cards. Filtering is
presentation only: no deletion request, database mutation or media cleanup is
performed, and the administrator dashboard retains job history.

Library has explicit cursor-based Load more with loading/error feedback. Native
Library storage preserves previously discovered completed audio; browser Library
requests `status=ready`, retains loaded pages, and bounds live subscriptions to
the newest page plus nine tail pages. See
[release evidence](../docs/client-current-jobs-release-2026-09-28.md) for validation
and distribution status.
