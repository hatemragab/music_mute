# Task: guest PO-token path on first Prepare, then cloud when YouTube still refuses

You are changing the MusicMute macOS local downloader and the Chrome extension panel. The goal is to make a first-time **Prepare my Mac** install the cookieless YouTube guest stack, use it on every local YouTube download, and stop showing a 15-minute local failure when the real remaining choice is MusicMute cloud.

Do the work in `/Users/hatemragap/work_spaces/music_remover`. Read these before editing:

- `chrome-extension/AGENTS.md`
- `chrome-extension/README.md`
- `chrome-extension/docs/youtube-runtime.md`
- `chrome-extension/docs/setup-updates.md`
- the repository root `Agents.md`, Chrome-extension section only

Do not commit, push, deploy, publish, or touch production data. Do not read or print dotenv values, tokens, cookies, or media URLs.

## What the user saw

On 2026-10-05 at 23:30:10Z the Chrome panel showed **YouTube access paused**:

`SOURCE_BOT_CHALLENGE` at stage `metadata`. YouTube refused the guest download with a bot check. Fresh downloads were held, with about 14 minutes left of the 15-minute cooldown. The panel also said signing into Chrome does not authenticate the isolated guest downloader, and it offered **Open Mac app** and **Use MusicMute cloud**.

That code is raised in `classifyAcquisitionFailure()` in `chrome-extension/src/companion/local-provider.ts` when yt-dlp’s text matches “sign in to confirm you’re not a bot”, a captcha, or unusual traffic. The hold is `ACQUISITION_REFUSAL_COOLDOWN_MS` in `chrome-extension/src/companion/acquisition-gate.ts` (15 minutes). The panel copy is built in `failureGuidance()` in `chrome-extension/src/extension/error-guidance.ts`.

## Do not do this

These are excluded by this product’s guest-only acquisition policy. Do not claim that any one configuration necessarily causes or prevents an account ban.

- No `--cookies`, `--cookies-from-browser`, cookie file, Chrome cookie database, or YouTube login session.
- No OAuth, no manually pasted PO token, no visitor-data field supplied by the user.
- No proxy, residential IP, or account-backed client.
- No second downloader, no Node or Bun runtime beside the pinned Deno, no bgutil HTTP server, no plugin-directory search, no npm or pip install on the user’s machine.
- Do not remove `--no-cookies` or `--no-cookies-from-browser`.
- Do not shorten or remove the 15-minute hold. Retrying a flagged address faster makes the next refusal more likely.
- Do not auto-submit a cloud job. Cloud still requires the existing manual confirmation and the signed-in app account.
- Do not treat a PO token as a guarantee that YouTube will accept the request.

## What is already implemented

Do not rebuild this. Verify it and close the holes below.

First-time Prepare already downloads one pinned external runtime. `chrome-extension/docs/youtube-runtime.md` records:

- Deno 2.9.7
- yt-dlp 2026.08.19 and EJS 0.8.0
- bgutil 2.0.1 script provider, loaded from its hash-pinned wheel
- guest acquisition selects the `mweb` client
- a fresh private guest `HOME` per run
- account cookies are rejected inside `install_token_provider()`
- `youtube_ready` is true only when the downloader, Deno, token provider, processing runtime, model, and Chrome registration all pass

The launch line is in `chrome-extension/engine/downloader_bootstrap.py`:

```text
--extractor-args youtube:player_client=mweb
--no-cookies --no-cookies-from-browser
```

`BgUtilScriptDenoPTP` is registered only when `--musicmute-youtube-runtime` is present. Status fields are `javascript_ready`, `token_provider_ready`, and `youtube_ready` in `chrome-extension/src/companion/app-setup.ts`.

yt-dlp’s non-cookie recommendation is: a JavaScript runtime, plus a PO-token provider, using the `mweb` client and a **GVS** proof-of-origin token from a provider such as bgutil. The files above are that recommendation. Do not infer that a metadata bot challenge was caused by a missing GVS token. Trace the pinned extractor first: player tokens and GVS tokens have different request contexts. Its GVS token is requested during format extraction after the player response. Fail clearly at that boundary if no token is available.

## Required behavior

### 1. First-time Prepare owns the guest stack

**Prepare my Mac** remains the only installer. A new Mac must not be offered local YouTube acquisition until Prepare has finished and `youtube_ready` is true.

Trace the Chrome start path. If a local YouTube `START` can run while `javascript_ready` or `token_provider_ready` is false, stop it before yt-dlp starts. The panel must tell the user to open the Mac app and run Prepare. Use the existing setup-error copy style. Do not start a download that will be classified as `SOURCE_BOT_CHALLENGE` just because Deno or bgutil is missing.

Ordinary startup and acquisition must reuse saved execution evidence for the current app/runtime identity plus cheap installed-path checks. Do not add repeated execution probes or inventory hashes to the processing path. Missing or stale evidence requires an explicit Check or Prepare. Apply the gate immediately before fresh acquisition so cached vocals, shared originals and local files still bypass guest tools.

Prepare’s offline checks stay offline. They must keep proving the pinned Deno binary, the EJS challenge fixture, and the pinned bgutil script can execute. Do not add a live YouTube call to Prepare. Do not mark `youtube_ready` from file existence alone.

A machine that already completed Prepare must not download the runtime again.

### 2. Require the correctly bound GVS token for media formats

Trace the pinned extractor’s metadata and media-request sequence first. Keep
`mweb` as the only selected client and the pinned bgutil Deno script provider as
the only registered provider. Do not add another client or provider fallback.

GVS tokens authenticate media streaming requests; player tokens authenticate
player API requests. Do not attach a GVS token as a player token or require one
before the player call on the assumption that it fixes metadata bot challenges.
At the extractor’s GVS boundary, require a valid token while preserving its
visitor/video content binding. An empty response must fail clearly rather than
silently dropping playable formats or allowing tokenless media transfer.

Keep tokens out of logs, diagnostics and Chrome. Preserve the existing bounded
private native transfer of selected media metadata; never expose its URLs.
Reject imported/account cookies, proxy and authenticated session fields. Allow
yt-dlp’s own anonymous guest cookie jar, and continue forwarding an empty jar
to the provider. “Cookieless” means no imported or account cookies, not that
YouTube can never create anonymous cookies in the isolated guest process.

Missing Deno/EJS/provider installation or failed setup evidence uses the existing
setup error codes with Check/Prepare/update guidance. Empty, invalid or timed-out
GVS generation uses `SOURCE_TOKEN_REQUIRED`, connection/diagnostic/update guidance
and the manual cloud option; a temporary network failure does not prove that
reinstalling is necessary. None of these errors alone starts a refusal cooldown.
Sanitize provider exceptions before upstream logging; never forward raw script
output or token values.

An explicit YouTube bot response remains `SOURCE_BOT_CHALLENGE` and starts the
hold even if it occurred before GVS generation. Do not reclassify a real refusal
as a setup failure merely because no token was attached yet.

### 3. When YouTube still refuses, show cloud

A real `SOURCE_BOT_CHALLENGE` or an active `ACQUISITION_COOLDOWN` keeps the 15-minute hold. Change the panel so the user is not left looking at a local retry:

- Lead with **Use MusicMute cloud**. That button must keep using the existing cloud handoff. It must not submit the import by itself.
- Keep **Open Mac app** as the second action.
- Disable **Remove background music** until `retry_at` has passed. Clicking it during the hold must not start another guest download.
- Keep the sentence that Chrome sign-in does not authenticate this downloader. Keep the countdown, the cached-vocal sentence, and original-sound availability.
- Do not say that signing in, exporting cookies, or waiting out the timer will clear a flagged address.

Cached vocals and local files stay playable during the hold. They never go through this guest request.

### 4. Leave the pinned versions alone

Do not bump yt-dlp, EJS, Deno, or bgutil in this task. A newer extractor is a separate release: new URLs, hashes, licenses, and `npm run setup:youtube-runtime`. Do that only if a test proves the pinned bgutil provider cannot answer an `mweb` GVS request at all. If that is true, stop and report it. Do not silently replace the pins.

## Files

Expect to edit:

- `chrome-extension/engine/downloader_bootstrap.py` — require a GVS token at the pinned extractor’s media-format boundary and fail clearly when the provider does not return one.
- `chrome-extension/src/companion/local-provider.ts` — do not map a missing-token failure onto `SOURCE_BOT_CHALLENGE` or the 15-minute hold.
- `chrome-extension/src/extension/error-guidance.ts` and the content panel that renders **Remove background music** — cloud is the primary action during the hold, and local retry is disabled until the hold ends.
- The Chrome start gate, if local YouTube can start while `youtube_ready` is false. Likely `chrome-extension/src/extension/background.ts` and the native hello or status payload that already reports `youtube_ready`.

Read, and edit only if the gate cannot be expressed with the current status fields:

- `chrome-extension/src/companion/app-setup.ts`
- `chrome-extension/src/companion/acquisition-gate.ts`
- `chrome-extension/macos/` Prepare progress and the Home setup screen

Update `chrome-extension/docs/youtube-runtime.md` only to record the GVS requirement and the rule that a missing token is not a bot hold. Do not claim a live YouTube test you did not run.

## Tests

Add or adjust tests that fail on the old behavior:

- A metadata invocation with the YouTube runtime registers the pinned Deno provider and requests an `mweb` GVS token. No cookie-import argument is present; the disabling flags remain.
- Provider failure or an empty GVS response becomes a setup or `SOURCE_TOKEN_REQUIRED` error and does not write the 15-minute refusal state.
- Stderr that says “Sign in to confirm you’re not a bot”, including a refusal before GVS generation, is still `SOURCE_BOT_CHALLENGE` and still starts the hold.
- The bot-challenge panel exposes cloud, disables the local retry control while `retry_at` is in the future, and does not mention cookies as a remedy.
- Local YouTube start is refused when `javascript_ready` or `token_provider_ready` is false, with Prepare guidance and no yt-dlp process.

Run from `chrome-extension/`:

```sh
npx vitest run tests/local-provider.test.ts tests/acquisition-gate.test.ts
```

Add the specific background, content, or bootstrap test file you changed to that command. Say which commands ran. Do not claim `npm run verify` unless you ran it. Offline tests do not prove that today’s YouTube address will accept the token.

## Acceptance

- A first-time user cannot start a local YouTube download until Prepare has installed the pinned Deno, EJS, yt-dlp, and bgutil provider.
- Local metadata uses `mweb`; media formats requiring GVS receive a correctly bound token from the pinned provider, with no imported/account cookies.
- Missing setup evidence sends the user to Check/Prepare; transient token generation failures offer connection/diagnostic guidance and cloud. Neither starts a 15-minute bot hold.
- A real bot refusal still holds for 15 minutes, and the panel’s primary action is **Use MusicMute cloud**.
- No cookie, proxy, manual token, second runtime, or version bump was added.

Out of scope: the reload helper grace in `AI-PROMPT-reload-cached-vocals.md`, separation speed, and any design that passes a YouTube account into the downloader.
