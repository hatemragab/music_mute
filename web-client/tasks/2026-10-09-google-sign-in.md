# Mobile Google sign-in release evidence

Date: 2026-10-09. Scope: the end-user web client at
`https://app.music-mute.com`, deployed to CapRover app `app`.

## Behavior

- iPhone/iPad/Android Google sign-in uses a same-tab Firebase redirect, including
  iPad desktop mode. Desktop browsers retain popup sign-in.
- Startup resolves the redirect result once per provider/page lifetime and keeps
  the existing 15-second restoration/session deadlines. Failures require an
  explicit retry. Late redirect failures cannot replace authenticated sessions.
- English/Arabic errors distinguish unfinished sign-in, blocked popups, network
  failures, unavailable browser storage and configuration failures.
- The browser server proxies only Firebase's seven documented auth helper paths
  to the validated project host, with bounded bodies and a deadline. It does not
  forward application cookies or authorization headers. Helpers preserve the
  Firebase protocol and policy; normal app routes retain their CSP.

## Local validation

From `web-client/`:

- `npm run format:check`: passed after formatting the edited files.
- `npm run lint`: passed with zero warnings.
- `npm run typecheck`: passed.
- `npm test`: 275 tests passed in 24 files.
- `npm run build`: passed; existing large-chunk warning remains.
- `npm run test:server`: 23 tests passed.
- `npm run test:e2e`: 12 fixture tests passed in installed desktop Chrome.
- `git diff --check`: passed.
- `npm run package:caprover`: produced an allowlisted 62-file archive, each entry
  byte-compared with its source. No tests, dotenv, dependencies, generated output
  or unrelated component files were included.

Archive SHA-256:
`f2c0ac55421999194b52015dfefa8595948247a2fda9ed7e67291e001bc8d5bf`.

## Live deployment and configuration

- CapRover CLI reported successful deployment. Read-back confirmed active image
  `img-captain-app:24`, one instance, container port 3000.
- The only changed app configuration field was environment variable
  `PUBLIC_FIREBASE_AUTH_DOMAIN`, now `app.music-mute.com`.
- Computer-use checks confirmed Firebase already authorizes `app.music-mute.com`
  and Google sign-in is enabled.
- Updated the existing Google web OAuth client through Google Cloud UI to include
  JavaScript origin `https://app.music-mute.com` and redirect URI
  `https://app.music-mute.com/__/auth/handler`. The previous Firebase origin and
  callback were preserved. Google Cloud displayed “OAuth client saved”; reopening
  the editor confirmed the new values.
- `/config.js` and `/__/firebase/init.json` returned HTTP 200, `no-store` and the
  same app auth domain. `/healthz`, handler/iframe HTML and their JavaScript
  resources returned HTTP 200. Unknown auth helper paths returned 404.
- The app page retained CSP; helper pages loaded without the incompatible app
  CSP, and the live iframe allowed same-origin embedding. CapRover's edge emits
  `X-Frame-Options: SAMEORIGIN`; app CSP still uses `frame-ancestors 'none'`.
- Live build identity: `a375785d-5fd0-4efd-9279-d91945671880`.

## Browser acceptance and remaining limit

Computer use opened a separate in-app desktop browser session, temporarily set
an iPhone Chrome user agent and a 390 by 844 viewport, then clicked **Continue
with Google** on the deployed app. Real Firebase Google sign-in completed: the
authenticated account screen showed a verified account with Google as its linked
provider, and Home showed active live updates. No media/import requests or account
settings were changed. The existing separate Chrome password-account session
restored successfully after the update. Temporary browser emulation was cleared.

This establishes the live Google authentication and API-session round trip using
the mobile code path. It does not establish actual iPhone Chrome/WebKit behavior;
an affected iPhone should still verify the fix. No device/simulator test was run.
No commit or push was made.

## Protocol references

- [Firebase Google sign-in](https://firebase.google.com/docs/auth/web/google-signin)
  recommends redirect sign-in on mobile.
- [Firebase redirect option 3](https://firebase.google.com/docs/auth/web/redirect-best-practices)
  defines the same-origin helper proxy and callback/auth-domain configuration.
- [Zalando guidelines](https://opensource.zalando.com/restful-api-guidelines/),
  reviewed live on 2026-10-09, shaped method handling, status/media-type
  preservation, compatibility and private failure responses. These opaque
  Firebase OAuth helpers retain their vendor-defined non-REST wire contract.
