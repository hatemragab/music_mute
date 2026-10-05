# Downloader account isolation

MusicMute's local YouTube downloader runs as a logged-out guest. It does not
import Chrome cookies, Chrome profiles, Google login tokens, browser headers or
browser visitor/PO tokens. The Chrome extension has no `cookies` or `webRequest`
permission. Its Start request contains only the video ID, duration and provider;
both the extension background and native host reject additional fields.

The pinned yt-dlp bootstrap requires config and plugin isolation and accepts only
the reviewed CLI options used by the local pipeline and offline readiness probes.
Cookie imports, login/password options, netrc, config overrides, aliases, arbitrary
headers, browser impersonation and supplied visitor/PO tokens are rejected before
the downloader archives are imported. Download metadata is projected by the native
provider, omits account fields and credential headers, and is replayed through
stdin rather than loading a user file or fetching the watch page again.

Each downloader launch creates a fresh private guest directory under the owned
temporary root. Its `HOME`, `TMPDIR` and XDG directories point there; inherited
account, proxy, Python and Node environment variables are dropped. Imports, EJS
checks and child processes use this environment. Normal exits and handled failures
remove the guest directory. Forced process termination can leave a guest directory
under the owned temporary root; it contains no imported Chrome account data.
This is application-level isolation, not a separate operating-system user or
filesystem sandbox. No real browser cookie/profile files are needed for validation.

The guard supplies `--no-cookies` and `--no-cookies-from-browser`. yt-dlp may still
use its own anonymous in-memory cookies returned by YouTube; those are independent
of the signed-in browser session. The token-provider guard accepts only the
isolated extractor's own YouTube jar without account-cookie markers. It
rejects imported jars, account cookies, authenticated context and credential
headers, and passes an empty jar to the bundled token script while preserving
the extractor's anonymous visitor binding. Rejecting every nonempty jar also
rejects yt-dlp's automatically created guest `PREF`/`SOCS` cookies, preventing
playback-token generation and leaving the audio format selector with no usable
download. MusicMute account sign-in does not authenticate this guest request.
Netrc remains disabled by default and enabling
it is forbidden by the guard. Restricted content fails rather than importing an
account session. See the [upstream cookie options](https://github.com/yt-dlp/yt-dlp#filesystem-options)
and [account-cookie warning](https://github.com/yt-dlp/yt-dlp/wiki/Extractors#exporting-youtube-cookies).

The acquisition policy sets HTTP, fragment and extractor retries to zero, keeps
download fragment concurrency at one, spaces extraction requests by one second,
and waits five seconds before downloading. The bootstrap rejects overrides that
weaken those values. Existing verified vocals are reused without another download.
The downloader stops on rate-limit or sign-in errors; there is no automatic cookie
fallback, client impersonation, proxy rotation or retry loop. Native admission
serializes fresh metadata/download operations across MusicMute processes for the
current macOS user and spaces their starts by at least five seconds. The short
admission wait is cancellable and precedes the first request; it does not retry a
failed extraction.

An explicit bot/CAPTCHA refusal or rate limit starts a persistent 15-minute
acquisition cooldown. The triggering attempt retains its exact error category;
later attempts fail locally with `ACQUISITION_COOLDOWN` without launching the
downloader. This interval is a MusicMute protection policy, not an estimate of
when YouTube will accept guest access again. Restricted videos and unexplained
401/403 responses do not start a global cooldown. The private state contains only
its schema version, fixed pending/refusal/recovery reason and admission/cooldown timestamps; no source or
account identity. Restarting MusicMute or clearing the vocals cache does not
reset it. Unsafe state fails closed with `ACQUISITION_STATE_INVALID`, and another
active acquisition returns `ACQUISITION_BUSY`. A durable pending marker is written
before any extraction. Known completion clears it; an interrupted or uncertain
attempt starts a fresh 15-minute recovery cooldown when another helper takes the
lock. A failed cooldown write leaves that marker, so reopening the helper cannot
silently admit another download. A confirmed bot/rate-limit response retains its
cooldown even when cancellation races with it; actual cancelled extraction clears
pending safely. This recovery does not claim YouTube refused it.

Verified cached vocals and local-file processing remain available. Automatic
starts refused by guest access/cooldown restore original playback only if the
same video was playing before MusicMute paused it and no user pause, navigation
or ad changed that ownership. The saved auto-start setting remains enabled.

These settings reduce unnecessary traffic. They cannot guarantee that YouTube will
accept anonymous requests: the downloader and Chrome still share the internet
connection, and YouTube can challenge or rate-limit its IP or guest sessions.
The official [YouTube extractor guidance](https://github.com/yt-dlp/yt-dlp/wiki/Extractors#common-youtube-errors)
recommends spacing downloads when guest-session rate limits occur. Offline tests
prove configuration and credential boundaries, not future YouTube availability or
Google account enforcement decisions.

## Acquisition failure diagnostics

Failed acquisition keeps only a fixed category: `SOURCE_BOT_CHALLENGE` for explicit
bot/CAPTCHA refusal, `SOURCE_AGE_RESTRICTED` for age gating,
`SOURCE_ACCESS_RESTRICTED` for private/member access, `SOURCE_TOKEN_REQUIRED` for
an explicit missing/rejected playback PO token, `SOURCE_HTTP_UNAUTHORIZED` or
`SOURCE_HTTP_FORBIDDEN` for otherwise unexplained HTTP 401/403, and
`ACQUISITION_RATE_LIMITED` for explicit rate limits. Generic sign-in refusal still
uses `SOURCE_AUTH_REQUIRED`; unrelated format, JavaScript and network failures
retain their own categories. Empty and incomplete transfers, TLS failures, local
write failures, postprocessing failures and exact argument/isolation guard errors
also have fixed categories. DNS errors retain `ACQUISITION_NETWORK_FAILED`. An error category identifies the observed response,
not an account ban or the scope of an IP/session restriction.

The classifier uses the terminal error instead of nonfatal warnings and ignores
generic cookie-help suffixes when identifying the primary reason. Terminal local
job logs and desktop metadata failures can include the acquisition stage
(`metadata`/`download`), numeric process exit code and an explicit HTTP error
status. Locally blocked starts include an allowlisted `acquisition_block_reason`
for bot refusal, request limit or interrupted acquisition. The downloader also
records a fixed `acquisition_stderr_kind` (`empty`, `terminal_error`,
`python_traceback` or `unclassified`) and a received-byte count bounded to
128 KiB. The raw text is never retained. These observations distinguish missing
error output from an unmatched terminal error without preserving a traceback.
Locally blocked starts do not invent an
upstream stage, exit code or HTTP response. Missing evidence stays absent. Raw tool output, URLs, titles, account
data, cookies and tokens remain excluded from logs and exports. These fields do
not make another YouTube request. Old `SOURCE_AUTH_REQUIRED` records cannot be
retroactively refined; the next user-initiated attempt produces the new evidence.

## Bounded installed observation — 2026-10-03

One fresh acquisition using the installed guarded runtime failed with
`SOURCE_BOT_CHALLENGE` during metadata fetching: process exit 1, 3.216 seconds
from job start to failure, and no explicit HTTP status. Separation never started.
The observation used a separate private test root with no cache hit or browser
cookie import. It identifies the guest downloader refusal; it does not identify
an account ban or distinguish IP enforcement from guest-session enforcement.
After more than 30 minutes, one bounded retry used installed build
`f3e3dc94-b662-4dee-bdfc-7ee3fd6ef244` and succeeded without a cache hit.
Whole-helper wall time was 35.195 seconds: metadata 4.876 seconds, download
6.940 seconds and processing 18.840 seconds. The native pipeline measured
31.056 seconds; these stage durations are not added to nested engine timers.
The full-timeline output was 255.048 seconds against a 255.061-second video,
with trim disabled, a verified model and protected MP3 Range delivery
(HTTP 206, 1,024 bytes). This is one installed native-protocol success, with
no browser playback or listening-quality claim. Guest access was accepted for
this retry; future guest availability and IP/account enforcement remain unknown.
Safe evidence is retained in the same private test root as `retry-result.json`
and `retry-diagnosis.json`. No additional fresh extraction was needed.

Separately, the existing Chrome tab played verified cached vocals and the Stop
control closed its panel. Cached playback is not evidence of fresh acquisition
success. The safe observation artifact is in
`output/live-smoke-1790987143290-35ec7793-6dc6-411b-845e-e1ed419540c5/diagnosis.json`.
The installed benchmark code and packaged runtime also passed a 10-second
synthetic speech-plus-tone MPS check in 9.612 seconds, with all 441,000 samples
preserved and no trimming. This isolates the source-access failure from local
separation; it does not establish listening quality or a successful YouTube
download. Its report is
`output/output/engine-proof/c50e915a-83cf-4b5a-bf50-9c17a1cafbe2/result.json`.
The guest-protection update then passed `npm run verify`: 1,251 tests in 45 files,
typecheck, zero-warning lint, build and formatting. Build
`f3e3dc94-b662-4dee-bdfc-7ee3fd6ef244` was installed locally; all 11,326 package
file/link entries, six companion bundles and the content bundle matched the
installed copies, and deep strict signature verification passed. The downloader
runtime, manifest permissions and unsigned native code were preserved.

Two fresh OS processes ran the acquisition-gate definitions from the installed
host bundle with outbound network denied. Both refused the seeded cooldown
without invoking the acquisition operation or changing its state. This is an
installed gate-logic fixture, not a full native-protocol or live-browser result;
the sandboxed full helper stopped at `PROCESS_IDENTITY_UNAVAILABLE` because the
OS refused its process-inspection subprocess. The passing gate report is
`output/installed-gate-ab3c2854-3312-41bb-8727-cd35a46bbc47.noindex/result.json`.
The full verification log is
`output/acquisition-diagnostics-update.noindex/guest-access-verify-final.log`.
New Chrome messages and automatic recovery still need manual extension Reload,
ordinary page refresh and browser acceptance. The fresh YouTube refusal above
used the preceding diagnostics build. The single later installed retry described
above supplies fresh acquisition and inference success.

The final durability update, build `daaeaa96-d790-44ff-883b-fdd0ea8557ca`,
passed `npm run verify`: 1,279 tests in 46 files, 122-file zero-warning lint,
typecheck, build and formatting. All 11,326 installed entries match its package,
with companion/content source alignment and deep strict signature verification.
Its three-process, network-denied gate fixture intentionally exits after pending
is persisted; two later processes reject locally with
`ACQUISITION_COOLDOWN` / `ACQUISITION_INTERRUPTED` and zero operation calls.
The recovery cooldown is durable and unchanged by the third process. This is
installed gate-logic evidence, not another YouTube probe or full native-protocol
restart result. The report is
`output/installed-gate-34a58df7-c0e1-47b8-b309-9d1aafa4fbaf.noindex/result.json`;
the final verification log is
`output/acquisition-diagnostics-update.noindex/durable-guest-access-verify-final.log`.

## Activated browser download failure — 2026-10-03

Chrome activated build `daaeaa96-d790-44ff-883b-fdd0ea8557ca` before its
11:50 UTC attempt. A 364.101-second source passed metadata acquisition and failed
during the subsequent download with `TOOL_FAILED`, process exit 1, no recognized
explicit HTTP status, and no inference. The native pipeline elapsed value was
41.419 seconds; the earlier account-cache check was separate. Historical raw
stderr was discarded, so this record cannot establish a transport, storage or
postprocessing cause. Missing HTTP evidence does not establish missing network
activity. Safe records are in
`output/download-error-review.noindex/observed-failure.json`.

The pinned downloader includes previously unclassified terminal templates for
empty/incomplete transfers, local writes, TLS, DNS, postprocessing and exact
bootstrap errors. Offline regressions now cover those templates, including both
`Downloaded N bytes, expected M bytes` and the distinct numeric
`content too short (expected N bytes and served M)` form. New user guidance keeps
these failures paused and directs local-tool failures to app diagnostics; it never
suggests disabling certificate checks, importing cookies or rotating identities.
The activated failure panel's red Stop was verified to close it while preserving
the paused, unmuted original video. Screenshots are in the same private review
folder. This covers that failure-state Stop action, not successful voice playback.

Build `0a05dbf4-76f0-4502-9024-3c259e561e11` was then installed locally after
`npm run verify` passed 1,332 tests in 46 files, typecheck, 122-file zero-warning
lint, build and formatting. All 11,326 installed file/link entries matched the
package, including six companion bundles and the extension content bundle; deep
strict signing verification passed. Native code, the guest downloader runtime
and extension permissions were preserved. The installed proof is
`output/macos/build-0a05dbf4-76f0-4502-9024-3c259e561e11.noindex/installed-guest-access-proof.json`;
the full verification log is `output/download-error-review.noindex/verify-final.log`.

Exactly one bounded retry of that same source used the new installed app and a
separate guest test root, without a cache hit or Chrome-cookie import. It
succeeded in 42.641 seconds of whole-helper wall time: metadata 4.797 seconds,
download 7.913 seconds and processing 22.389 seconds. The pipeline measured
35.574 seconds; nested timings are not additive. Output duration was 364.089
seconds against the 364.101-second source, with trimming disabled, the expected
model verified and MP3 Range delivery confirmed (HTTP 206, 1,024 bytes).
The safe summary is `output/download-error-review.noindex/retry-diagnosis.json`.
This proves that installed native-protocol attempt, without establishing the
historical failure's exact cause, listening quality, selected audio-track
identity, browser playback or future YouTube availability. Chrome activation was
subsequently confirmed in the local-lock investigation below.

The subsequent reload review found no newer `job_failed` event in the available
main native log and retained rotation. At that checkpoint, the last failure was the 11:51 UTC
download failure above. Later cached starts at 12:28, 12:30 and 12:31 UTC all
used the same helper session started at 11:50 UTC, with the preceding package
fingerprint. They therefore do not activate or qualify the new failure logger.
The projected review is `output/download-error-review.noindex/reload-error-review.json`.
Page refresh replaces the content context while an existing background/native
port can remain connected; Stop releases playback but keeps that port. A true
unload of the owning extension context closes the pipe, and the native helper
and lock wrapper both implement bounded shutdown. No shutdown defect was
established. The next browser attempt must first be correlated with a fresh
helper session and the new installed package fingerprint.

The existing Sia cache was separately verified against its retained hash, model
and full duration before refreshing that ordinary YouTube page. Actual cached
Chrome playback then showed the voice waveform running, stopped the waveform
when paused, kept every bar paused during original-audio playback, preserved the
video's 255.061-second progress maximum, closed the panel with Stop and restarted
cached vocals from the player icon. The two ready events measured 80.979 and
59.016 milliseconds and reported cache hits. Screenshots are retained as
`output/download-error-review.noindex/cached-vocals-playing.jpg` and
`output/download-error-review.noindex/cached-vocals-paused.jpg`. These checks used
the older native session, did not make another extraction request and do not
establish listening quality or background next-video acceptance.

## Activated local lock failures — 2026-10-03

After Chrome restarted, the native helper started at 13:09:44 UTC with the
installed `0a05dbf4` package fingerprint. Cached 255.061-second vocals reached
ready in 72.985 milliseconds. This establishes activation of that companion
build; the projected evidence is
`output/download-error-review.noindex/current-helper-activation.json`.

The subsequent playlist video failed locally with `ENOENT`, after its separate
account-cache restore and about 11 milliseconds of local pipeline work. A later
364.101-second attempt failed with `OUTBOX_BUSY`, after account-cache restore and
about 51 milliseconds of local work. Neither reached the downloader or
inference. Desktop restore workers were still finishing local transactions when
Chrome began both attempts. These records do not show a Google refusal. The
historical `ENOENT` syscall and path were discarded, so its exact origin cannot
be recovered. The safe event projection is
`output/download-error-review.noindex/activated-local-failures.json`.

Source review identified two independently reproducible handoff races: a local
writer can release its lock between an exclusive-link collision and inspection,
and a short outbox transaction was treated as an immediate terminal refusal.
The outbox now waits asynchronously for at most two seconds and tolerates normal
release handoffs. Cache acquisition retries disappearing locks with a fixed
attempt limit; a verified live cache holder still refuses immediately because
its lease covers the whole processing pipeline. Malformed records, unsafe
links, ownership and inode checks, active pins and storage admission remain
protected. Temporary-filesystem regression tests exercise release, competing
writers, timeout, stale recovery and replacement safety without touching user
data or making acquisition requests.

Terminal job logs now add the allowlisted `local_job_phase` and exact
`filesystem_errno`, when applicable. Phases distinguish cache locking/lookup,
account restore, workspace, pins, outbox admission, provider, validation,
publication, cache budget and playback. Provider errors retain their acquisition
attribution; cancellation suppresses local fault metrics. No raw paths,
exception messages, stack traces, URLs or credentials are retained. These are
internal diagnostic fields; the job message contract remains unchanged.

The local fix is installed as build
`6d9cc6ac-c6d9-4501-ab9d-38dd9dbe86d1`. Full `npm run verify` passed 1,376 tests
in 46 files, typecheck, 122-file zero-warning lint, build and formatting. Five
companion bundles and content changed; 11,317 unrelated file/link entries and
the native code, downloader runtime and extension permissions were preserved.
All 11,326 installed entries matched the package; all six companion bundles and
content aligned with current dist, and deep strict signing verification passed.
The installed proof is
`output/macos/build-6d9cc6ac-c6d9-4501-ab9d-38dd9dbe86d1.noindex/installed-guest-access-proof.json`.
The full source check log is
`output/download-error-review.noindex/verify-local-locks.log`.

An ordinary YouTube refresh activated a fresh native helper at 13:46:41 UTC
with package fingerprint `9422b548dc43`. The previously failing 364.101-second
source passed account restore, acquisition and inference, reaching ready in
48.285 seconds from job start, including its separate restore. Its local
pipeline measured 43.745 seconds, with no cache hit and a 364.089-second output.
Actual Chrome playback resumed with the original muted and the waveform running;
Pause stopped the waveform, and Stop hid the panel and restored the paused,
unmuted original. The later 254.861-second playlist source also passed a fresh
download and inference, with a 39.062-second local pipeline and a
254.851-second output. These successful attempts establish current source access
and local/browser recovery for these sources, while future guest availability
and listening quality remain separate.

A controlled natural playlist transition then verified background automatic
playback using existing cached Sia vocals. Native tab state showed the preceding
video playing but unselected at 13:59:03 UTC. The next video started at
13:59:10.590 UTC and reached ready at 13:59:10.704 UTC, with a 100.195-millisecond
cached pipeline. Before inspecting that target again, native window/tab evidence
confirmed it still was not the focused video. The safe projections are
`output/download-error-review.noindex/background-next-focus.json` and
`output/download-error-review.noindex/latest-native-session.json`. This is a
background cache-hit acceptance check; the earlier fresh-download playlist
success above is a separate observation.

Actual current Chrome controls also stopped all waveform bars during
original-sound playback, kept the full 255.061-second progress duration, and
paused/stopped safely. The final saved preferences match the pre-test values:
2% dialog transparency, automatic next videos enabled and a strict
shorter-than-ten-minute limit. Both YouTube test players were left paused with
original sound restored, panels hidden and the temporary blank tab closed.
Current proof images are
`output/download-error-review.noindex/lock-fix-vocals-playing.jpg` and
`output/download-error-review.noindex/background-next-vocals-playing.jpg`;
control evidence is
`output/download-error-review.noindex/final-browser-controls.json`.
