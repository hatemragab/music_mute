# App-managed YouTube setup

The Apple Silicon release supplies Deno 2.9.7, yt-dlp 2026.08.19, EJS 0.8.0,
and the matched bgutil 2.0.1 script/provider plugin in its pinned external
runtime. **Prepare my Mac** downloads and verifies that runtime when required,
executes the included challenge solver, loads the native canvas binding and
provider graph, prepares the voice model and registers Chrome. Users do not run
Homebrew, npm, pip, Deno installation commands or Docker.

`local_processing_ready` covers the processing runtime/model. `youtube_ready`
also requires the downloader, Deno, challenge scripts, token provider and Chrome
registration. Status performs bounded offline execution before reporting YouTube
tools ready; a failed version or provider execution never becomes a green check
merely because its files exist. Cached vocals and local files retain their own
readiness. These checks do not contact YouTube or establish guest access.

## Acquisition and privacy

The exact pinned plugin is imported explicitly from its hash-verified Python
wheel. Ambient plugin directories stay disabled. Only the Deno script provider
is registered; there is no HTTP token server or Node provider fallback. Guest
acquisition selects `mweb`, retains audio-only/original-track validation and the
complete timeline. No Chrome cookies, account sessions, proxy settings, user
configuration or private environment values reach the downloader.

Every invocation receives a fresh private guest HOME. The provider token cache is
limited to 16 entries, 256 KiB and a one-hour maximum retention inside that HOME;
it is removed when acquisition ends. Deno's analysis cache also lives there.
The shipped node_modules graph works with an initially empty Deno cache, frozen
locks and cached-only resolution. Runtime execution cannot fetch npm/JS packages.

The reviewed provider patch bounds each network request to five seconds and
removes the upstream internal retry/sleep loop. The owned script has an 18-second
whole-operation deadline under the plugin's 20-second subprocess deadline and
the existing whole-acquisition deadline. Existing cancellation, parent-death
process-group cleanup, five-second pacing and durable bot/rate-limit hold remain.
Deno's native FFI is needed for canvas; it is not a security sandbox for its native
libraries. The build verifies that all native binaries are ARM64 and their dynamic
dependencies resolve inside the package or Apple's system directories.

JavaScript challenge failure, a missing/rejected playback token, and a guest
bot/rate-limit refusal remain distinct. Tokens and Deno cannot guarantee acceptance.
Updating the app replaces the matched tools together. A refusal offers original
playback or an explicit cloud handoff with the account's monthly usage confirmation.

## Build-time preparation

From `chrome-extension/`, run:

```sh
npm run setup:youtube-runtime
MUSICMUTE_LOCAL_DOWNLOADER_TARGET="$PWD/output/downloader-runtime-v2.noindex" npm run setup:downloader-wheels
MUSICMUTE_LOCAL_RUNTIME="/absolute/canonical/versioned/runtime-root" \
  node scripts/qualify-youtube-runtime.mjs
```

The offline qualifier deliberately has no installed-app runtime default. Point
`MUSICMUTE_LOCAL_RUNTIME` at an explicit, canonical (already resolved, not a
symlink) external runtime root that is owned by the current user and is not
group/world writable. A missing or unsafe root fails the qualification instead
of silently reading an obsolete `Contents/Resources/runtime` tree.

The runtime builder exclusively creates a new ignored target and refuses to
replace an existing directory. Set `MUSICMUTE_YOUTUBE_RUNTIME_TARGET` to a new
absolute path for another build. Packaging reads this directory (default
`output/youtube-runtime.noindex`) and the explicitly selected downloader target.
It copies the complete native/library closure, signs Deno with JIT entitlements,
signs nested native code and refreshes the generated inventory. Mac packaging
then emits the complete tree as a content-addressed ZIP, verifies an extraction
round trip and seals only its exact bootstrap manifest into the thin app.
End-user setup installs this verified runtime automatically when its identity is
not already active, and downloads the verified model only when absent.

The source archive and release hashes are pinned in
`scripts/youtube-runtime-artifacts.mjs`. Deno's ARM64 ZIP is SHA-256
`5cd46d6268f6f78f5d88bdc7159d20bd44cdaa4b3303474839f87ec6fe7ae25c`;
bgutil's 2.0.1 source archive is
`bae71b7971fa22376af57edca8d3487724ac9a8ada56d1cccf07a547b4b9b62c`;
canvas's ARM64 native prebuild is
`38c296c9d81c05598db849fb8103543d6649fec7246c35197d9be8199c75116f`.
The production-only lock is derived from upstream's verified lock; every retained
npm package's complete integrity/graph entry must equal the upstream entry before
use. Lifecycle scripts remain disabled; canvas is extracted from its exact pinned
prebuild with no build or download fallback. Bundle manifests inventory every
file/link, reject foreign entries and escaping links, and detach build-cache
hardlinks. Owned wrapper and patched session-manager hashes are pinned separately.

## Notices and source

The bundle's `licenses/` contains bgutil's GPL-3.0-only license, exact corresponding
source archive and the applied patch/wrapper, Deno's MIT license and source, and
canvas's source. npm dependency packages retain their source, manifests and
license files. Native Cairo/Pango/GLib and other dynamically linked libraries
have their own terms; review their notices and corresponding-source obligations
against the pinned prebuild before public redistribution. This task does not
publish a release or assert Apple notarization.

Upstream references: [bgutil setup](https://github.com/Brainicism/bgutil-ytdlp-pot-provider),
[yt-dlp PO tokens](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide),
[Deno command permissions](https://docs.deno.com/runtime/fundamentals/security/),
[canvas native releases](https://github.com/Automattic/node-canvas/releases/tag/v3.2.3).

## Offline verification

`qualify-youtube-runtime.mjs` uses the explicitly selected external processing
Python read-only and a fresh private scratch directory. It checks exact downloader/Deno versions,
downloader capabilities, actual EJS signature/n fixture and parser/generator,
actual bgutil graph and canvas rendering. The shipped inventory must remain
identical afterwards. It makes no YouTube/cloud acquisitions and performs no
inference or account operations. Python source-identity fixtures retain independent
track/default evidence; successful tool setup does not prove selected-track
matching or current YouTube player compatibility.

`test_process_lease.py` verifies actual update-lock inheritance through the tool
guardian. Even when the guardian dies, an owned live child prevents an exclusive
update until that child exits. Closed/foreign lease descriptors are rejected before
tool execution. The existing guardian additionally destroys its owned group when
its Node parent disappears.
