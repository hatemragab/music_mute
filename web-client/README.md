# MusicMute web client

This is the end-user browser client for MusicMute. It uses the existing NestJS API,
Firebase Authentication and signed S3 transfers. It is separate from the admin
dashboard. The Android app is the visual and journey reference; approved browser
adaptations are recorded in [`tasks/`](tasks/README.md).

## Local development

Use Node 24 and npm. Install with `npm ci --ignore-scripts`, copy
`.env.local.example` to an ignored `.env.local`, and fill in the **public Firebase
Web SDK configuration** from the existing Firebase project's registered web app.
`VITE_API_ORIGIN` must be an HTTPS API origin, or loopback HTTP for a local API.
These Firebase Web SDK values are public client configuration, never Firebase
Admin credentials. Start with `npm run dev`. The web API must include the
browser origin in its configured CORS allowlist for real local sign-in; the
production CORS allowlist does not include localhost by default.

The production server reads its public runtime values from:

| Environment variable          | Purpose                                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------------------- |
| `PUBLIC_API_ORIGIN`           | HTTPS origin of the MusicMute API                                                                       |
| `PUBLIC_FIREBASE_API_KEY`     | Firebase Web API key                                                                                    |
| `PUBLIC_FIREBASE_AUTH_DOMAIN` | Firebase auth domain                                                                                    |
| `PUBLIC_FIREBASE_PROJECT_ID`  | Firebase project ID                                                                                     |
| `PUBLIC_FIREBASE_APP_ID`      | Firebase web app ID                                                                                     |
| `PUBLIC_MEDIA_ORIGIN`         | Optional exact HTTPS S3 transfer origin; defaults to `https://music-remover.s3.us-east-2.amazonaws.com` |
| `PORT`                        | Listener port, default `3000`                                                                           |

These values are served through non-cacheable `/config.js`, allowing one image
to be configured per environment without rebuilding. Do not place private AWS
credentials, Firebase Admin service accounts, backend `.env` values, database
URLs or bearer tokens in these variables. The client does not store signed S3
URLs or identity tokens in its own local storage; Firebase manages its own
session persistence. The API and S3 bucket enforce their own authorization and
CORS policies. The server provides an SPA fallback and `/healthz`.

## Verification

Run `npm run format:check`, `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:server`,
`npm run test:e2e`, and `npm run build`. The Playwright suite uses the installed
desktop Google Chrome and synthetic fixtures; it writes screenshots to ignored
`test-results/screenshots/`. The authenticated preview is **mocked** and served
only by Vite from `tests/preview.html`; the production Docker image excludes it.
Real Firebase/production API integration requires a dedicated test identity.
The API web-platform support was deployed on 2026-09-26 and verified by health,
isolated integration tests and browser-origin CORS preflight; authenticated
production journeys have not been exercised. Backend verification lives in
`backend/`.

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
the server and never download provider media into the browser.

The AAC encoder bundle is about 1 MB before compression and is fetched only when
conversion is needed. Mediabunny and its AAC encoder declare MPL-2.0; their
notices and the Noto Sans Arabic font license are served from `public/licenses/`.

## Packaging and release boundary

The `Dockerfile`, `.dockerignore`, `captain-definition` and server are scoped to
this folder. `npm run package:caprover` produces an allowlisted source archive;
upload it to CapRover app `app` with container HTTP port `3000`. The production
site is `https://app.music-mute.com`; HTTP redirects to HTTPS. API CORS,
Firebase authorized-domain and S3 CORS preflights are recorded in
[`tasks/08-infrastructure.md`](tasks/08-infrastructure.md). The archive and
runtime configuration must be reviewed for each release. Real Firebase popup,
signed S3 transfers and authenticated account/job flows remain unverified in
production.

The public `/` entry page has a descriptive title, canonical URL and share
metadata. `robots.txt` and `sitemap.xml` list only that URL. Authenticated SPA
routes carry `X-Robots-Tag: noindex, nofollow`, and unknown paths return 404, so
private screens are not advertised as search results. The favicon is rendered
from Android's `ic_vocal.xml` brand mark; update `public/favicon.svg` and its
192-pixel PNG together if the native mark changes. These measures support branded
discovery; the signed-in application is not a substitute for a public product
landing page, and indexing is controlled by search engines.

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
