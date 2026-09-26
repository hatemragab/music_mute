# Infrastructure snapshot and release evidence

Observed and verified in this conversation on 2026-09-26; recheck before a later
release because external configuration can drift. No credentials belong here.

| Item                     | Verified state                                                                                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Intended web origin      | `https://app.music-mute.com`                                                                                                                                    |
| API origin               | `https://api.music-mute.com`                                                                                                                                    |
| CapRover                 | Existing `https://captain.music-mute.com`                                                                                                                       |
| Firebase project         | `music-mute`                                                                                                                                                    |
| Firebase Authentication  | `app.music-mute.com` added to authorized domains; existing domains preserved                                                                                    |
| API `CORS_ORIGINS`       | `https://dashboard.music-mute.com,https://app.music-mute.com`; saved and read back after CapRover reload                                                        |
| API health after restart | `/health/live` and `/health/ready` returned HTTP 200, status ok                                                                                                 |
| API CORS                 | App and dashboard OPTIONS returned 204 with matching allow-origin; unrelated origin had no allow-origin                                                         |
| S3                       | Bucket `music-remover`, region `us-east-2`; public access block remained on                                                                                     |
| Existing S3 CORS         | Origins `https://music-mute.com`, `https://*.music-mute.com`; methods GET/HEAD/PUT; allowed headers `*`; exposed ETag/x-amz-request-id/x-amz-id-2; max age 3000 |
| S3 checks                | App-origin upload and download preflights returned 200 and matching allow-origin; no S3 configuration change was needed                                         |

These initial configuration/preflight facts do not prove real user authentication
or media processing. A transient 502 occurred during the API
restart, followed by successful health checks. Browser health-page display was
blocked and Python urllib requests received Cloudflare 1010; ordinary curl
completed the health and API preflight checks without changing security settings.

## Deployment on 2026-09-26

The existing MusicMute Dashboard Firebase web registration supplies the public
SDK values for the client. CapRover app `app` has only the public API origin and
Firebase Web SDK settings. Do not place Firebase Admin data, AWS keys, CapRover
credentials, database URIs or backend dotenv in this app.

The API backend web-platform update is CapRover image 68. `/health/live` and
`/health/ready` returned status `ok`; browser-origin `/auth/sessions` preflight
returned 204 with `https://app.music-mute.com`. The web client is CapRover app
`app`, image 2, with container port 3000, HTTPS enabled and forced HTTP-to-HTTPS
redirect. `https://app.music-mute.com/healthz` returned 200; `/`, `/auth`,
`/jobs`, `/library` and `/settings` returned SPA HTML. `/config.js` contained
only the expected public configuration keys. Chrome showed the signed-out page
in English and Arabic. S3 app-origin PUT preflight returned 200. No AWS or
Firebase Admin secret was copied to the web app.

Authenticated Firebase popup/login, production API requests, signed S3
upload/download, processing and account lifecycle still need a dedicated
test identity and safe live fixture. Local browser previews were mocked. At
initial deployment, no commit, push or PR had been made; check the task ledger
for subsequent source publication and image versions.

## Source publication and latest web release

[PR #35](https://github.com/hatemragab/music_mute/pull/35) merged the web
implementation into `main` at `bcc0f520d4e44127e415a2401b7339541896b0a3`.
The feature and main branches were synchronized locally and on `origin`. A fresh
allowlisted archive from that checkout deployed as CapRover web image 3. Live
checks confirmed HTTPS redirect, web health, the 192-pixel PNG favicon, root
title/description/canonical, `robots.txt`, root-only sitemap, private-route
`noindex` and unknown-route 404. Installed Chrome displayed both languages with
Arabic RTL and no application exceptions at phone width. Search inclusion is
not guaranteed; production authenticated workflows still need a test identity.
