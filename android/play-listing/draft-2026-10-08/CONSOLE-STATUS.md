# MusicMute Play Console draft status

Date: October 8, 2026. Current requested scope: complete the existing MusicMute
app's dashboard setup and upload a signed **1.0.0 / build 20 Play AAB** to an
unpublished release draft. **Review submission, rollout and publication are not
authorized.** This supersedes the earlier preparation-only upload restriction.

## Console state

The owner created the app in the currently open developer account:

- Name: **MusicMute**.
- Package: **com.hatem.musicmute**, confirmed available by Play Console.
- Default language: **English (United States), en-US**.
- Type: **App**.
- Price: **Free**, changeable before publication.

Console app ID: **4972253489037683247**. The initial dashboard setup is now
**complete**: after the listing was saved to Publishing overview, the 10-of-11
setup card disappeared and the previously locked release tasks became available.
Privacy policy, sign-in details, ads, content rating, target audience, Data
Safety, government apps, financial features, health, category/contact details,
and the store listing are all saved. Category is Music & Audio with Music &
audio and Tools tags. Owner-supplied contacts and the HTTPS support URL are saved;
private contact values are not copied into this file.

English and Arabic text, icon, localized feature graphics and screenshots are
saved in Publishing overview as **Ready to send for review**. Each locale has
four phone screenshots at 1080 x 1920, four 7-inch tablet screenshots at
1440 x 2560, and the same responsive tablet set in the required 10-inch group.
Play's review screen shows 4/8 assets in each of the three screenshot groups for
both languages. The source-faithful HTML/CSS compositions and both localized
feature graphics are declared as created or edited using AI; the existing
source-derived icon remains unlabelled. Nothing was sent for review, rolled out
or published.

Listing proof:

- `artifacts/google-play-console-2026-10-08/store-screenshots-review.png`;
- `artifacts/google-play-console-2026-10-08/store-screenshots-review-ar.png`;
- `artifacts/google-play-console-2026-10-08/dashboard-setup-complete.png`;
- `artifacts/google-play-console-2026-10-08/store-listing-ready-not-submitted.png`.

IARC is **Completed** for All Other App Types. Current calculated ratings are
ESRB Everyone, PEGI 3, ClassInd All ages, USK All ages and IARC/Google Play 3+.
There are no content descriptors; the certificate ID still displays a dash.
The exact Online Content question is answered No under Google's explicit
user-imported-content exclusion, including private user-submitted URL imports.
MusicMute has no promoted media catalogue or native user-to-user exchange.
Guidance: https://support.google.com/googleplay/android-developer/answer/11070055.
Target audience is saved as **18 and over**, with optional minor blocking off.

The owner completed Sign in details, verified by the live Console dashboard.
An earlier bounded Firebase email/password check returned
INVALID_LOGIN_CREDENTIALS; it did not test Google OAuth. Saved Console access
details do not establish a successful runtime sign-in, which remains unverified.
Credentials are not stored here.

Data Safety is **saved and completed in Console** with 14 data types and usage
answers: collection Yes, transit encryption Yes, email/password and OAuth
creation, and the account-deletion URL. Only Crash logs and Diagnostics are
marked Shared for Analytics as a conservative provisional disclosure; Precise
location is also included provisionally pending physical-area classification.
The optional external data-only deletion answer is blank because no qualifying
URL is verified. Console accepted the current 783-row CSV schema and showed all
14 handling forms Completed. After Target audience was saved, final Save
succeeded without sending the app for review.
Proof: `artifacts/google-play-console-2026-10-08/data-safety-saved.png`.

Google's URL checker returned **403** for the deletion page twice. All 12
read-only GET/HEAD checks from this computer returned 200 with Chrome, Googlebot,
Google-InspectionTool and no user agent at 09:37–09:39 UTC. Source public-route
guards do not block it. Checker-specific edge/network filtering is plausible,
but not confirmed; Cloudflare Security Events at the attempt time are the next
decisive evidence. No WAF or security settings were changed.

The signed 1.0.0/build 20 AAB was accepted by Play (version **20 (1.0.0)**, API
levels 26+, target SDK 36). The production track confirms **Draft release:
1.0.0 (20)**, Inactive and zero installs. Egypt is saved as the initial editable
country setting (one targeted country). English and Arabic
release notes are saved. No review or publication action has been taken.

Artifact: `android/app/build/outputs/bundle/playRelease/MusicMute-1.0.0-build20-play-release.aab`.
SHA-256: `5763275b4e5544fd69b602416f2a713886a0d8924fee6a66b4e5f53a6f6304ff`.
Size: 11,641,555 bytes. Release proof:
`artifacts/google-play-console-2026-10-08/production-draft-build20.png`.

Historical app-creation prepared-form screenshot:
`artifacts/google-play-console-2026-10-08/create-app-ready.png`.

Current draft proof: `artifacts/google-play-console-2026-10-08/arabic-listing-draft.png`.
IARC approval view: `artifacts/google-play-console-2026-10-08/iarc-terms-ready.png`.

## Prepared assets and text

- English/Arabic title, short description and full description: `en-US/`, `ar/`.
  Character counts are 9/56/1813 (English) and 9/52/1577 (Arabic), within
  Google's 30/80/4000 limits.
- Contact/category/privacy/deletion settings: `store-settings.json`.
- Source-backed app-content/data-safety draft: `app-content-draft.json`.
- Current collection/sharing evidence and unresolved questions: `privacy-audit.md`.
- Caption and alt-text candidates: `screenshot-captions.json`.
- Uploaded icon and localized feature graphics:
  `../assets/2026-10-08/`. Icon: 512 × 512 opaque RGBA PNG; feature graphics:
  1024 × 500 RGB PNG without alpha. All three were visually checked and their
  dimensions/formats verified; deterministic rerender hashes match.
- Uploaded screenshot gallery and exports:
  `../assets/2026-10-08/store-screenshots/play-store-screenshots.html` and
  `../assets/2026-10-08/store-screenshots/renders/`. Phone assets are
  1080 × 1920 and tablet assets are 1440 × 2560; the same tablet set is saved in
  both the 7-inch and 10-inch groups. Every Play asset is an exact 9:16 PNG below
  8 MB. English and Arabic each have Home, processing, player comparison and
  Library images. The manifest records dimensions, byte sizes and SHA-256
  hashes.

No suitable current raw Android captures exist in the reviewed materials.
The existing `fiftee_qa` Pixel 7 emulator (API 35, 1080 × 2400) was started with
its existing Quick Boot snapshot. The signed Play APK 1.0.0/build 20 was installed
successfully using `adb install -r`, preserving existing user data. No other
AVD, runtime or device was created, downloaded, substituted or modified.
The computer-use tool could not bind this SDK's bundleless native emulator
window. The owner then explicitly instructed that Android emulator runs and
tests stop. The emulator exited, its PID is absent, and ADB reports no connected
devices. Do not restart it or perform further device tests. No ADB UI input or
runtime screenshots were produced. The new store images are HTML/CSS promotional
compositions grounded in current Android source; they do not claim device proof.
The prepared APK is at
`android/app/build/outputs/apk/play/release/MusicMute-1.0.0-build20-play-release.apk`.
Its SHA-256 is `387d336f5a019c1429f1776b253a5c75f0fb709c84125f88e07ee41dbae4a195`.
iOS and web captures are not substituted.

## Privacy URL corrected and deployed

The existing public privacy HTML now discloses retained Cloudflare IP-derived
device location, estimated coordinates, actual purposes and account cleanup. It
states that these are estimates, not GPS measurements, with no GPS/location
permission requested. This corrects the omission introduced by the native
country-visibility/device-location feature.

The privacy-only update was deployed as **API127**, one instance, not building.
The package differs from the previously deployed API126 package only in
`backend/src/public-pages/public-pages.controller.ts`. Archive SHA-256:
`c9c9bd99921fb7654cf314eb4cbd17012f916379871d926e58b64b5fb08428e0`.
All protected CapRover configuration fields compare unchanged, including
environment, domains, ports, nginx, WebSockets, hooks and service settings.

Fresh public checks returned HTTP 200 for `/health/live`, `/health/ready`,
`/privacy`, `/delete-account`, `/support` and `/public-policy`. The privacy body
contains the expected new disclosure and retains no-store/no-transform headers,
with no scripts/forms. Its SHA-256 at verification was
`5b9ec33fc58edd5e40e55a3833e56946e79cfa44629992edb6dc2d14c928f3ac`.
Visual proof:
`artifacts/google-play-console-2026-10-08/privacy-ip-location-live.png`.

Private deployment proof is under
`/var/folders/jh/kqzv5jvj1qgfq85qwnwclz4w0000gn/T/musicmute-play-draft-deployment-b6wr0nfq/`.
Only sanitized `deployment-proof.json` and `public-proof.json` should be shared;
the complete CapRover snapshots must remain private.

Executed validation: 22 focused public-page tests, touched-file formatting/lint,
full backend typecheck/build, deployment packaging and archive comparison,
protected configuration comparison, live HTTP/body checks, and browser inspection.
No application permission, schema, route, processing behavior or runtime
environment was changed for this privacy correction.

Backend validation commands, run from `backend/`:

```sh
pnpm exec prettier --check src/public-pages/public-pages.controller.ts \
  src/public-pages/public-pages.controller.spec.ts ../docs/google-play-release.md
pnpm exec vitest run src/public-pages/public-pages.controller.spec.ts
pnpm exec oxlint --deny-warnings src/public-pages/public-pages.controller.ts \
  src/public-pages/public-pages.controller.spec.ts
pnpm exec tsc --noEmit
pnpm run build
pnpm run package:caprover
```

## Store listing completion

- The owner approved the English/Arabic compositions, and all phone, 7-inch and
  10-inch groups are saved in the Console listing.
- The dashboard no longer shows the initial setup card, confirming that its
  final store-listing task is complete.
- Publishing overview lists both languages under **Changes not yet submitted for
  review**. The review action was not used, and the app remains unpublished.
- Further Android emulator runs and device tests remain explicitly prohibited.

## Before any later app review

- Review the editable 18+ audience choice.
- Confirm working reusable reviewer access; saved Console details do not prove
  runtime authentication. Credentials were not saved to this repository.
- Resolve Google's account-deletion URL checker 403.
- Confirm Sentry organization DPA acceptance/data-use settings and applicable
  provider-sharing exceptions before a definitive no-sharing declaration.
- Establish whether retained IP-derived coordinates meet Google's precise
  location threshold. Approximate location is included; GPS permission absence
  or decimal coordinates alone do not settle precise-location classification.

The current instruction authorizes the specified AAB upload and editable setup
drafts. It explicitly excludes submitting for review and publishing.
