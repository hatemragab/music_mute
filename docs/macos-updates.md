# Dashboard-managed macOS updates

The administrator dashboard's **Mac updates** page manages MusicMute Local's
direct-download Sparkle releases independently of Android/iOS release policy.
Source implementation and fixture checks do not establish a deployed publisher
or an accepted Apple release.

## Configure the publisher

1. Sign in as the dashboard owner and open **Mac updates**.
2. Save the existing Sparkle signing key's **public** Ed25519 key with a reason
   and fresh authentication. The key is canonical Base64 containing 32 bytes.
   Read only the public key from the local signer, for example:
   `output/sparkle/2.10.0.noindex/bin/generate_keys --account MusicMute-Updates -p`
   from `chrome-extension/`. Use the actual existing account name. If no key
   exists, create one locally using Sparkle's key setup before configuring the
   publisher. Never upload a private key or Apple credentials.
3. Download the public publisher configuration. Its feed and archive addresses
   come from backend `PUBLIC_SITE_ORIGIN`. Production example addresses are
   `https://api.music-mute.com/macos-updates/appcast.xml` and
   `https://api.music-mute.com/macos-updates/artifacts/`.

The public-key trust anchor cannot change after release records exist. This
prevents a dashboard edit from disconnecting already sealed apps from their
publisher. Key rotation requires a separately designed compatible release.

## Build and upload an update

From `chrome-extension/`, point packaging at the downloaded JSON and choose a
new marketing version and monotonically increasing integer build:

```sh
export MUSICMUTE_UPDATE_CONFIG_FILE=/absolute/musicmute-macos-updates.json
export MUSICMUTE_MAC_VERSION=0.2.0
export MUSICMUTE_MAC_BUILD=2
npm run package:macos:release
```

Developer ID signing, runtime qualification, notarization and stapling still run
locally through the [existing release workflow](../chrome-extension/docs/macos-release.md).
Keep its real certificate selection and Keychain profile private. After that
workflow reports an accepted, stapled, Gatekeeper-verified `release-result.json`:

```sh
npm run prepare:macos:update -- \
  --release-result /absolute/release-UUID.noindex/release-result.json \
  --dashboard-config /absolute/musicmute-macos-updates.json \
  --keychain-account MusicMute-Updates
```

Preparation reads the existing local signing key and matches it to the sealed
app and downloaded configuration. It creates an immutable
`MusicMute-VERSION-BUILD-arm64-SHA256.dmg`, signed `appcast.xml` and local
`update-result.json`. It does not publish anything.

Select that DMG and appcast in **Mac updates**, supply a reason, and upload. The
browser hashes the archive in bounded chunks, requests a create-only private R2
grant, sends its exact required headers and asks the API to verify it. The API
checks the signed feed against the pinned public key, restricts its complete
one-version contents and archive address, then checks the uploaded object's
identity and streams its byte count/SHA-256. Archives are limited to 2 GiB;
appcasts to 32 KiB, allowing their Base64 command payload to fit the existing
64 KiB API request limit. Verification is bounded and does not buffer an entire DMG.

Publish a verified draft after fresh authentication. Publication atomically
selects its signed appcast and requires an increasing build. The public endpoint
serves the exact uploaded XML, including its embedded signature. Archive URLs
redirect to short-lived R2 downloads; the bucket stays private. Downloads use
immutable create-only object keys, because Sparkle cannot supply a custom ETag
header after a redirect. Server-side verification uses conditional reads.
Sparkle verifies the archive's Ed25519 signature before extracting it on the Mac.

## Recovery and retention

Mutation operation IDs and revision fences preserve audited, idempotent commands.
If a transfer fails, its draft remains visible; use the page's recovery action
instead of creating another release blindly. A lost publication response can be
reconciled through its operation receipt.
After a page reload, select **Resume upload** on the awaiting draft and choose
its matching DMG. The saved signed appcast stays on the server; recovery grants
target the same create-only archive identity.

Withdrawal removes a selected feed from automatic discovery. Previous signed
feeds and ever-published archives remain retained; downloaded appcasts can still
resolve their immutable archive. No real data, older artifacts or R2 objects are
deleted by this feature. Abandoned upload reservations and unused archives also
remain retained; any storage cleanup needs a separate reviewed retention policy.
The **In update feed** marker identifies the selected release. The newest
withdrawn release can be republished; selecting a build below an ever-published
newer build is refused.

The feed returns 404 until a verified release is published. Deploy the backend
before the matching dashboard, retain private R2/CORS configuration, and configure
the API proxy to allow bounded verification requests (up to ten minutes). A
proxy timeout can lose the response while the server finishes; use receipt/detail
recovery. Deployment, a real R2 upload and a downloaded-update/relaunch on a
signed Mac app are separate acceptance checks.

## API review

The [official Zalando RESTful API and Event Guidelines](https://opensource.zalando.com/restful-api-guidelines/)
were read on 2026-10-04. Rules 101 (OpenAPI), 104/105 (security and permissions),
118 (snake_case JSON) and 106 (compatibility) shape the admin API. Sparkle's
public signed XML and archive downloads are deliberate protocol exceptions to
authenticated JSON APIs. No mobile authentication platform or update-policy
contract changes.

## Production checkpoint: 2026-10-04

The authorized CapRover CLI deployment activated API **114** and dashboard
**25**. The backend release inherited the running API 113 image and added only
the seven updater modules, their maps, and AppModule registration/map. Checks
confirmed all 31,518 other runtime/dependency file and symlink entries stayed
identical, and image configuration plus production environment values stayed
unchanged. The router and yt-dlp remained versions 9 and 6.

Public and replica-local API liveness/readiness checks returned HTTP 200. The new
admin configuration/list endpoints returned HTTP 401 without authentication.
The appcast returned an empty, no-store XML HTTP 404 before publication. Dashboard
health, `/macos-updates`, the actual referenced Mac page chunk, hashing worker and
runtime configuration returned HTTP 200, with CSP/HSTS and the correct API origin.
The first dashboard build hit a BuildKit session timeout; retrying the identical
verified archive succeeded. The fresh dashboard deployment suite passed 11 tests.

The browser displayed the approved-administrator sign-in screen at the live Mac
updates URL. This deployment did not configure a signing key, upload an accepted
DMG to R2, publish a Mac release or perform an installed-app update/relaunch.
Those authenticated publisher and native acceptance checks remain separate.
