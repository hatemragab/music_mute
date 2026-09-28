# Adapter diagnostics and platform admission — 2026-09-28

User authorized clearer CapRover logs, multi-site admission and redeployment.
Deployment evidence is recorded separately below; source changes are not live proof.

## Diagnostic flow

`audio-acquisition-step` records a human-readable message and correlation UUID:
format discovery -> format selection -> one task submission -> task status ->
delivery lookup -> audio transfer -> NestJS transfer. State changes and every
fifteenth poll are logged; there is no per-chunk logging. The final
`audio-acquisition` event explains success/failure, stage, HTTP status, retry/poll
counts, rejected-format counts, selected sanitized audio metadata and elapsed time.

For example, HTTP 404 now says which stage returned it and does not claim that
the source was deleted. A missing valid task ID explicitly says POST was not
retried. Failed tasks include an allowlisted state, not raw upstream text.
Unexpected exceptions provide exception type and the adapter source line only.
No credentials, source URLs, signed delivery URLs, response bodies, local values
or stack source text are logged. Vendor errors without a documented structured
reason remain unknown; diagnostics must not invent the underlying cause.

Find all events with the same `acquisition_id` in the adapter and backend logs.
`SUCCEEDED` means bytes were delivered to NestJS, not that S3/worker processing
has succeeded. CapRover's existing bounded Docker log retention remains intact.

## Platforms

The adapter no longer hardcodes YouTube-only admission. Narrow public item paths
are enabled for the shared twelve-site catalog, including the requested YouTube,
Instagram posts/Reels, TikTok, Vimeo, SoundCloud and Facebook/Reels. Profile,
collection, playlist, malformed, credential-bearing and unknown-host URLs remain
rejected. Tracking parameters are removed from non-YouTube item URLs; Facebook
watch IDs are retained. No source URL is fetched locally.

VideoScale's [public site](https://videoscale.sh/) was read on 2026-09-28. It
advertises distributed yt-dlp and broad platform support. The signed-in docs were
not accessible to the browser tool this turn; existing qualified API paths remain
unchanged. Advertised support is not a guarantee for each URL or for separate
audio. We do not fall back to muxed video or local extraction/conversion.

Eligible formats now include provider-managed HLS/DASH audio and AAC-HE in M4A.
The SaaS assembles these formats; MusicMute downloads only the final HTTPS audio
artifact. DRM, audio-only, codec, advertised quality/size, bounded transfer,
deadline, cleanup and independent NestJS validation remain enforced.

Only YouTube has recorded live MusicMute E2E qualification. Other platforms need
real per-link validation. New catalog entries require native client rebuilds;
backend/adapter deployment cannot replace a bundled allowlist on an old install.

## Contract review

Read the current [Zalando API guidelines](https://opensource.zalando.com/restful-api-guidelines/)
on 2026-09-28. Applicable rules: 104 (security), 101 (OpenAPI), 176 (problem JSON),
177 (no stack traces in responses), 106 (compatible changes). Existing private
bearer authentication, binary response and stable error codes are unchanged;
detailed diagnostic messages stay in private logs, not API responses. No new
Zalando-specific IAM, hostnames or event infrastructure is introduced.

## Validation and deployment

- Adapter: 33 tests passed.
- Web: lint, typecheck, 118 tests and production build passed (existing large-chunk warning).
- Android: focused shared-policy JVM tests passed with the existing local SDK.
- iOS: focused shared-policy test passed on the authorized iPhone 17 Pro simulator.
- Backend `pnpm run verify`: 962 unit tests, 148 HTTP tests, formatting, lint,
  typecheck, secret/transfer checks and build passed.
- Backend import integration: 8 passed; processing integration: 15 passed.
- `git diff --check`, focused Prettier and Swift-format checks passed.

Archives are allowlisted and ignored under this provider directory; no credentials
or dotenv files are included. Credentials and private deployment settings are
preserved. No commit, push, subscription purchase or real-data deletion is needed.

## Verified live release

Deployed with the user's authenticated CapRover CLI connection `musicmute`.
Builds started 2026-09-27 22:33–22:35 UTC (2026-09-28 in Cairo).

| App                   | Before | After | Read-back                                    |
| --------------------- | ------ | ----- | -------------------------------------------- |
| music-mute-videoscale | 2      | 3     | 1/1, Docker healthy, private health HTTP 200 |
| api                   | 82     | 83    | 1/1, public readiness HTTP 200               |
| app                   | 10     | 11    | 1/1, public health HTTP 200                  |

Images use `img-captain-<app>:<version>`. Adapter remains read-only with no
published ports. API has no VideoScale credential; credentials and hooks were
preserved. There were zero pending imports before deployment and zero backend
scratch entries at final verification.

Deployed adapter `service.py` SHA-256 matches local source:
`dd3fa08f750ad26384ef543716382d147abeb6cf0efd138fc03b617cce0f0890`.
An authenticated private unsupported-host request returned 422 and its live log
contained `Source host is outside the enabled platform allowlist.` with stage,
correlation ID and code location. This smoke test made no vendor request.

Backend image contains the fatal-error monitor and correlation header. Public
`POST /realtime-tickets` and an HTTP/1.1 WebSocket upgrade to `/realtime/socket`
returned expected 401 without authentication, not missing routes. An ordinary
HTTP/2 GET is not a WebSocket-upgrade check. Served web entry uses
`index-C-nwumzP.js`; `App-cNxLHplG.js` contains Instagram/TikTok/Vimeo.

Ignored archives retained in the provider directory, SHA-256:

- `videoscale-diagnostics-platforms-2026-09-28.tar`:
  `3597853bc0255e202e0d43fc4eb912b15951d75e55106e0f391253fdad0baf16`
- `backend-diagnostics-platforms-2026-09-28.tar`:
  `aa0881c0aaba6746370e73c51ede200757bc973bdc5f0a92c49a43a585cd7a14`
- `web-diagnostics-platforms-2026-09-28.tar`:
  `30fb8e3646f95da9a8cfc222697cf9e6316c3c3e78f00ffbb9f198bc1696d0f9`

No fresh paid acquisition or authenticated production E2E was performed in this
release. The user will perform mobile end tests. Native installations need a
rebuild for the new catalog entries; see the follow-up device validation below.

## Authorized Android follow-up

The user explicitly requested the connected Android, overriding the default
simulator-only target for this action. Built `:app:assembleDirectDebug` against
`https://api.music-mute.com`, installed with `adb install -r` on CPH2573 (709a147),
and launched `com.hatem.musicmute/.MainActivity` with `Status: ok`. Existing owner
and system-clone profiles were preserved; no uninstall or data clearing occurred.
This proves build/install/startup, not a completed mobile audio import. The shared
catalog in this APK includes the new Instagram/TikTok/Vimeo entries.
