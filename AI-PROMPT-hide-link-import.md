# Task: dashboard-controlled link-import UI visibility for Android, iOS, and macOS

You are implementing one MusicMute product control in `/Users/hatemragap/work_spaces/music_remover`.

The dashboard gets a setting that hides **import from a link** and leaves **import from a file** in **Android, iOS, and the macOS app only**. The default is hidden. Saving the setting updates connected, signed-in native apps through the existing owner `policy` WebSocket snapshot. A country multi-select hides the link-import UI for the chosen countries. Country comes from Cloudflare's visitor-location headers, forwarded by CapRover nginx, and is stored on the user's device record.

**This setting only hides client UI. It does not restrict API access or processing. Queued imports, running jobs, active downloads, and their existing retries continue normally. Do not add server enforcement or stop work when visibility changes. The web client and Chrome extension browser UI are outside this task and keep their existing behavior.**

Do not commit, push, deploy an image, publish, or change production data. The one production edit allowed below is the API app's nginx header forward, and only as specified.

## Read before editing

- Root `AGENTS.md` and `CLAUDE.md`
- `docs/realtime-processing-queue/PROTOCOL.md`
- `docs/api/client-contract.md` sections for processing policy, media imports, and devices
- `backend/AGENTS.md`
- `dashboard/README.md`
- `chrome-extension/AGENTS.md` before touching the macOS app

Do not read or print dotenv values, tokens, cookies, media URLs, or raw IP addresses.

## Locked decisions

These are the product rules. Do not invent a second settings document, a new socket resource, or a client-supplied country field.

1. **File import stays.** Local audio, video, and photo pickers keep working. This flag never gates `/jobs`, upload grants, or local file preparation.
2. **Link import is hidden by default.** Missing Mongo field, missing client cache, failed checkout with no cache, and a policy older than the parser all mean hidden. Do not flash the link field while the request is in flight.
3. **One setting, one revision.** Store the flag on the existing standard account policy (`account_policies`, id `standard`), edited from the existing dashboard settings page, with `settings.read` / `settings.manage`, `expectedRevision`, the reason dialog, and fresh admin auth. Do not add a permission or a second endpoint.
4. **The existing `policy` snapshot is the push.** `account_policies` is already in the change-stream feed and already invalidates the owner `policy` resource. Android, iOS, and macOS (`desktop-policy`) already subscribe. Extend that snapshot for native UI visibility; the web client must ignore the new visibility fields. Do not add a parallel event, a poll, or a refresh button.
5. **Checkout on every open.** Each native app in scope reads `GET /processing-policy` when the app or the signed-in session opens, then applies later `policy` snapshots on top. `Cache-Control` stays `no-store`.
6. **Cache the last good payload.** Offline reopen uses that cache. No cache means hidden. A newer snapshot replaces the cache. Scope the cache to the app installation, not a world-readable log.
7. **UI visibility only; existing work continues.** Do not use this setting in `ImportsService`, API admission, cache delivery, acquisition reservation, acquisition retry, or job scheduling. Do not reject `POST /media-imports` or `POST /media-imports/cache-deliveries` because the UI is hidden. Queued imports, running jobs, active downloads, and existing retries continue normally. Keep current server checks and error behavior unchanged; do not add a new restriction or error code.
8. **Preserve `URL_IMPORT_ENABLED`.** That existing process flag defaults to false and stays. Native link-import UI is hidden when either the dashboard value is off or this env flag is off. Do not change the env value, default, or existing server enforcement. The admin screen must show when the existing process flag keeps the native link-import UI hidden. Saving the dashboard visibility setting must not change API availability.
9. **Country is an edge fact.** The device report DTO must not grow a country, city, or coordinate field. Ignore any client JSON that tries to send one.
10. **Only Android, iOS, and the macOS app are in scope.** Do not modify `web-client/` or hide its URL mode. Do not apply the setting to the Chrome extension browser panel. The macOS app lives under `chrome-extension/macos/` and is in scope: hide its YouTube source and paste-link controls. Do not delete or restrict the local downloader.

## Visibility rule

Evaluate in this order. Use the same function for the HTTP policy checkout and the socket policy snapshot. This result controls native UI visibility only; do not use it to authorize or reject imports.

| Condition | Link control |
| --- | --- |
| Dashboard switch off, or `URL_IMPORT_ENABLED` is not true | Hidden. Reason `globally_hidden`. |
| Switch effectively on and the disabled-country list is empty | Visible, even when Cloudflare sent no country. Reason `allowed`. |
| Switch effectively on, list is non-empty, country missing, `XX`, `T1`, or not a real alpha-2 code | Hidden. Reason `unknown_country`. A missing header must not bypass a country block. |
| Switch effectively on and the country is in the list | Hidden. Reason `country_hidden`. |
| Otherwise | Visible. Reason `allowed`. |

An empty country list does not hide anyone. Unknown country fails closed only while at least one country is selected. That is deliberate: after nginx is wrong, turning the global switch on with no country selected still shows link import; turning it on with Egypt selected does not show link import to a request that has no trusted country.

Do not use GPS, the device locale, or the SIM country.

## Dashboard

Page: `dashboard/src/features/settings/processing-settings-page.tsx` and `processing-settings-form.tsx`. Same save mutation, same reason dialog.

Add:

- A switch, **Show import from link**. Off by default. Helper text: file import stays available on Android, iOS, and Mac. Off hides their paste-link / URL import controls. Web is unaffected, and existing work continues.
- A searchable multi-select, **Hide link import in these countries**. Always visible. Selected countries render as removable chips with the English name and the code. Store uppercase ISO 3166-1 alpha-2 codes only. Build names with `Intl.DisplayNames` and a static code list in the dashboard bundle. Do not call a country API.
- Helper text when the switch is off: link import is already hidden in all three native apps; the selected countries remain hidden after the switch is turned on.
- Helper text when `URL_IMPORT_ENABLED` is not true: the existing API process flag keeps the native link-import UI hidden.

Validation on the admin write:

- Boolean for the switch.
- Country array, unique, sorted, maximum 250.
- Each item matches `^[A-Z]{2}$`.
- Reject `XX` and `T1`. They are not countries an operator can select. Unknown and Tor already fail closed while the list is non-empty.
- Revision conflict stays `REVISION_CONFLICT`.

Wire format remains snake_case through `backend/src/http/snake-case-wire.ts`. TypeScript names stay camelCase.

Suggested stored fields on `AccountPolicy`:

- `linkImportEnabled: boolean`, default `false`
- `linkImportDisabledCountries: string[]`, default `[]`

Existing production documents do not have these fields. Read them as `false` and `[]`. Do not run a migration that rewrites production documents.

## Client payload

Add these fields to `AccountPolicyService.publicPolicy()` and therefore to both `GET /processing-policy` and the owner `policy` snapshot. These additive fields are consumed only by Android, iOS, and macOS for UI visibility; the web client and import endpoints keep their existing behavior. Keep schema version `2`. Existing clients ignore unknown JSON keys; do not require the new keys for the old media-limit parse.

| Field | Meaning |
| --- | --- |
| `link_import_enabled` | Effective global switch. False when the stored value is missing, false, or `URL_IMPORT_ENABLED` is not true. |
| `link_import_disabled_countries` | Sorted alpha-2 codes. Empty array when missing. |
| `visitor_country` | Trusted country for this principal, or null. |
| `link_import_visible` | Result of the visibility rule. This is what the UI renders. |
| `link_import_reason` | `globally_hidden`, `country_hidden`, `unknown_country`, or `allowed`. |
| `link_import_policy_revision` | The account-policy revision used for this decision. |

`visitor_country` on `GET /processing-policy` is the country parsed from **this** request's Cloudflare headers.

`visitor_country` on the socket snapshot is the country observed on that connection's `POST /realtime-tickets` request and kept with the realtime session. If that observation has no trusted country, null. Do not pick "the user's latest device" when several devices are signed in. A snapshot for the wrong country would hide or show the control on the wrong app.

Admin `GET /admin/settings/account-policy` returns the stored switch, the stored country codes, the revision, and whether the process flag is forcing the feature off. It does not return a visitor country.

## Cloudflare headers and CapRover

The zone already has the managed transform **Add visitor location headers**. Cloudflare documents these request headers:

| Header | Nginx variable | Stored as |
| --- | --- | --- |
| `cf-ipcountry` | `$http_cf_ipcountry` | `country` |
| `cf-ipcontinent` | `$http_cf_ipcontinent` | `continent` |
| `cf-region` | `$http_cf_region` | `region` |
| `cf-region-code` | `$http_cf_region_code` | `regionCode` |
| `cf-ipcity` | `$http_cf_ipcity` | `city` |
| `cf-postal-code` | `$http_cf_postal_code` | `postalCode` |
| `cf-metro-code` | `$http_cf_metro_code` | `metroCode` |
| `cf-timezone` | `$http_cf_timezone` | `timezone` |
| `cf-iplatitude` | `$http_cf_iplatitude` | `latitude` |
| `cf-iplongitude` | `$http_cf_iplongitude` | `longitude` |

`CF-IPCountry` can exist from IP Geolocation even when the managed transform is off. Prefer a real alpha-2 from `cf-ipcountry`. Treat `XX` and `T1` as unknown.

City and region may be UTF-8. Cloudflare's docs describe non-ASCII header bytes as UTF-8. Decode a value that arrives as literal `\u00XX` escapes. Cap length (country 2, continent 2, region code 8, metro code 8, postal code 16, timezone 64, city and region 120). Drop the field if it contains control characters. Never fail the API request because a city is unusable. Country is the only field the visibility rule reads.

Latitude and longitude are decimal strings, not JavaScript numbers. Accept a bounded decimal or store null.

### Nginx

CapRover terminates TLS in its nginx and proxies to the API container on port 80. The API app is `api` on the `musicmute` CapRover machine. Native apps call the API origin directly, so the API app's nginx is the config that matters. Do not change the web container for this task.

Read the live API nginx config before changing it. Confirm whether `proxy_pass_request_headers` is off. Default nginx forwards client headers, but a custom CapRover template that turns that off will drop `CF-*` unless they are copied explicitly.

If those ten headers are not already passed through, add only these lines on the API location that proxies to the container, including the WebSocket upgrade location if it is separate:

```nginx
proxy_set_header CF-IPCountry $http_cf_ipcountry;
proxy_set_header CF-IPCity $http_cf_ipcity;
proxy_set_header CF-IPContinent $http_cf_ipcontinent;
proxy_set_header CF-IPLatitude $http_cf_iplatitude;
proxy_set_header CF-IPLongitude $http_cf_iplongitude;
proxy_set_header CF-Region $http_cf_region;
proxy_set_header CF-Region-Code $http_cf_region_code;
proxy_set_header CF-Metro-Code $http_cf_metro_code;
proxy_set_header CF-Postal-Code $http_cf_postal_code;
proxy_set_header CF-Timezone $http_cf_timezone;
```

Before saving, copy the previous nginx config to a file outside the repo. Do not change timeouts, body size, WebSocket upgrade, TLS, or any other directive. Do not reload a different app. If the CapRover CLI or dashboard is not available, do not guess the live file. Leave the snippet in the deployment note and say the production forward is not applied.

Trusting the header is only sound when the origin is not reachable except through Cloudflare. Check that the API hostname is proxied (orange cloud) and whether the CapRover public port is limited to Cloudflare. Do not open ports, do not add a rotting Cloudflare IP list in NestJS, and do not claim the header is authentic if direct origin access is still possible. Record that gap in the final report. A client that can hit the origin IP and set `CF-IPCountry` can lie. Fail closed still applies when the header is absent.

Do not log the headers.

## Device record

`backend/src/devices/device.schema.ts` is `user_devices`. Add one embedded object, not new top-level client input:

```ts
location: {
  country: string | null;
  continent: string | null;
  region: string | null;
  regionCode: string | null;
  city: string | null;
  postalCode: string | null;
  metroCode: string | null;
  timezone: string | null;
  latitude: string | null;
  longitude: string | null;
  source: "cloudflare";
  observedAt: Date;
} | null
```

Default null. Update it from trusted headers when an authenticated request already identifies the installation:

- `PUT /users/me/devices/:installationId` (`DevicesService.sync`)
- `POST /realtime-tickets` when the auth context already carries that installation

Write only when the parsed location changed, or at the same cadence `lastSeenAt` already uses (five minutes). Do not write the device on every policy read. Do not add `user_devices` to the `policy` realtime dependency list. A last-seen write would wake every policy subscriber.

Country changes on a connected app are picked up on the next ticket or the next `GET /processing-policy`. An admin country-list change does not need that write. The `account_policies` change stream already pushes a new `policy` snapshot, and each connection applies the list to the country stored on its ticket.

Expose `location` from `presentDevice` on `GET /users/me/devices`. If an admin user screen already renders device rows, show country, city, and `observedAt` there. If it does not, do not build a new admin devices page. Do not return latitude and longitude to the mobile clients in the policy payload. The device read can include the full saved object because the user asked for it on the device record. Do not put coordinates in analytics or logs.

No new Mongo index. Visibility does not query by country.

## Clients

In Android, iOS, and the macOS app only, hide the link control when `link_import_visible` is not true. Keep file import on screen. Leave the web client and Chrome extension browser panel unchanged.

| Client | Link UI to hide | File UI to keep |
| --- | --- | --- |
| iOS | `URLImportCard` in `ios/Vocal/UI/HomeView.swift` | `homeImportAudio`, `homeImportVideo`, the file importer |
| Android | The URL field and submit action in `android/app/src/main/java/com/hatem/musicmute/ui/home/HomeScreen.kt` | The existing file / video picker |
| macOS | The YouTube segment, paste field, and paste button in `sourcePanel` of `chrome-extension/macos/DesktopMediaViews.swift` | Choose Audio and file drop |

Search the three native apps for other new-link entry controls that post `/media-imports` or start a local YouTube URL, and hide those controls using the same flag. Do not add guards to the underlying processing functions. Existing history, retry actions, queued imports, and running work stay unchanged. Do not extend this search-and-hide task to the web client or Chrome extension browser panel.

Behavior:

- With no cached policy and before the first successful checkout or snapshot, render file-only. If a valid cached policy exists, use it while the checkout runs.
- On open, call `GET /processing-policy?schema_version=2` (the clients already do this for media limits). Parse the new fields without failing the old limit parse when the fields are absent. Absent means hidden.
- Android's hand parser is `ProcessingMediaPolicy.parse` in `ProcessingMediaPolicy.kt`. It currently ignores unknown keys. Read the new keys there and default hidden.
- iOS `ProcessingPolicyResponse` is `Decodable` and ignores unknown keys. Add the new fields with `decodeIfPresent`. Missing means hidden. Do not make them required. Old fixtures must still decode.
- macOS already subscribes in `DesktopWorkspace.swift`. Apply the snapshot on the visible source picker, including while that screen is open. A signed-out Mac still calls public `GET /processing-policy` on launch and uses the cache. Do not require sign-in before hiding the YouTube segment. Signed-out Macs have no owner policy socket and update on the next public policy checkout; offline apps keep the last cached value.
- A saved macOS source preference of YouTube must not win over a hidden policy. Force the file source.
- English and Arabic layouts must not leave an empty segmented control or a gap. RTL stays intact.
- Do not add a new banner that explains the hide. Remove the control.
- History rows and existing retry actions stay. Do not block a retry because the link-import UI is hidden; preserve the existing server behavior.
- Queued imports, running jobs, and in-flight downloads continue normally on every platform. Do not cancel, pause, restart, or kill any work because the visibility setting changed.

## Docs and contract

Update `docs/api/client-contract.md` and `docs/realtime-processing-queue/PROTOCOL.md` for the additive `policy` fields and the native-only UI visibility rule. Explicitly document that the web client, import endpoints, queues, and running work are unaffected. Update `backend/openapi.yaml` only if this repo generates it from source or checks it in as authored contract. Do not hand-edit a generated file if a generator exists. Say which one you used.

Document the nginx lines next to the existing CapRover API instructions in `backend/README.md`. State that production header forwarding is an edge config, separate from an image deploy.

## Tests

Extend the existing tests. Do not add a new test framework.

Backend, from `backend/`:

- Missing stored fields produce hidden / empty country list.
- Switch off hides even with a real country.
- Switch on and empty country list shows with a null country.
- Switch on, Egypt selected, `CF-IPCountry: EG` hides and `US` shows.
- `XX`, `T1`, empty, and a spoofed body country do not count as a real country.
- With all existing server prerequisites satisfied, changing the UI visibility setting does not reject normal imports or cache deliveries.
- Changing UI visibility does not stop queued imports, acquisition retries, or running jobs.
- Updating the policy bumps the revision and the `policy` snapshot contains the new list.
- Device sync persists a parsed location and does not accept country from the JSON body.
- Unchanged location does not cause an extra write beyond the current last-seen rule.

Dashboard, from `dashboard/`:

- Switch and country picker render on the settings page.
- Save sends the revision, reason, boolean, and sorted codes.
- A role with `settings.read` only cannot save.

Clients:

- iOS, Android, and macOS render file import and omit the link control when the policy fields are missing, `link_import_visible` is false, or there is neither a cache nor a successful checkout/snapshot.
- A later snapshot with `link_import_visible: true` shows the link control without a restart.
- A snapshot back to false hides it while the screen is open, without interrupting an import, download, or job already in progress.
- Parser fixtures with the old policy JSON still pass.

## Checks

Run the affected checks from the component directory. Do not claim a check passed unless it exited 0.

- `backend/`: the targeted vitest files, then `pnpm exec tsc --noEmit` and `pnpm exec oxlint` on the touched files if a full `pnpm run verify` is too large. Say which you ran.
- `dashboard/`: `npx vitest run` on the settings tests, plus `npm run typecheck` if the form types changed.
- Android: the unit test that parses processing policy and the home test that covers the URL field, if one exists.
- iOS: the policy decoder test and the home UI test. Use only the authorized simulator if you run UI tests: iPhone 17 Pro, iOS 26.0, UDID `3CC14436-EC3C-4419-A079-C84951E5FA07`.
- macOS: the existing Desktop source-picker tests.

Do not run a production import, do not call a paid provider, and do not print a real `CF-Connecting-IP`.

## Done when

- Dashboard save hides or shows link-import UI in Android, iOS, and the macOS app only.
- A connected, signed-in Android, iOS, or Mac session changes the control from the next `policy` snapshot without a manual refresh.
- Signed-out Macs update on the next public policy checkout; offline apps retain the cached value.
- The web client and Chrome extension browser panel retain their existing UI and behavior.
- A killed app, reopened offline, uses the cached value, and a first launch with no cache shows file import only.
- Every open performs `GET /processing-policy` and replaces the cache when the network succeeds.
- Native link-import UI follows the country visibility table, including its unknown-country rule, when an app next receives a successful policy checkout or snapshot.
- The device document stores the Cloudflare location fields after an authenticated device sync or realtime ticket.
- CapRover API nginx forwards the ten headers, or the report says it was not applied and why.
- File import still works while link import is hidden.
- The visibility setting adds no API restrictions. Normal imports, cache deliveries, queued imports, existing retries, running jobs, and active downloads retain their existing behavior.
