# MusicMute landing page

Public English/Arabic landing page for MusicMute. It uses the existing dark studio
visual language and Solo Signal mark while keeping product and release claims aligned
with the currently verified destinations.

## What is included

- Responsive one-page React/TypeScript site with English and Arabic RTL.
- Browser-language detection, saved explicit override, English fallback, and an
  addressable `/ar/` route with localized metadata.
- Product explanation, supported-input caveats, three-step journey, features,
  a synchronized original/voice-only listening demo, real-app showcase, privacy
  controls, honest platform statuses, FAQ, and `#downloads` anchor.
- Centralized public destinations in `src/product-links.ts`.
- Reciprocal English/Arabic crawl metadata, canonical URLs, and the existing Solo
  Signal favicon.
- Minimal Node static server with `/healthz`, strict security headers, caching rules,
  explicit 404s, and graceful shutdown.
- Allowlisted CapRover source archive that includes the public site artwork while
  excluding credentials, dependencies, generated output, test artifacts, and
  unrelated repository files.

The only currently advertised launch action is
[`https://app.music-mute.com`](https://app.music-mute.com). Android, iOS, macOS,
and Chrome show accurate pending statuses without store badges or unverified download
links.

## Local development

Use Node.js 24 and npm from this directory:

```sh
npm ci --ignore-scripts
npm run dev
```

The development page is served at `http://127.0.0.1:4177/`.

## Audio demo files

The public comparison uses these two checked-in files:

```text
landing_page/public/audio/original.webm
landing_page/public/audio/voice-only.mp3
```

Use these lowercase names with no spaces. `original.webm` is the original WebM/Opus
mix; `voice-only.mp3` is the MusicMute MP3 result. Keep each file's extension aligned
with its real container instead of renaming one format as another. Both files must:

- contain the same excerpt, starting at the same moment and using the same timeline;
- be short enough for a landing-page preview;
- be audio you own or have permission to publish publicly;
- contain valid audio bytes for the extension shown above.

The player preserves its current position and play state when users switch tabs. If
either file cannot be loaded, it shows a friendly “being prepared” message instead
of a broken player. These files are public website assets, so do not place private or
customer audio there.

## Verification

```sh
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run test:server
npm run test:deployment
npm run test:e2e
```

The browser suite uses installed desktop Chrome with local content only. It verifies
the main CTA, safe links, English/Arabic RTL, the stable Downloads anchor, keyboard
focus, synchronized demo switching, and phone-width overflow. It does not prove live
Firebase, API, processing, storage, native-app, or store-release behavior.

## CapRover package

Create the source archive from this directory:

```sh
npm run package:caprover
```

The command prints an absolute path to `landing-page.tar`. For CapRover app `www`:

- upload the generated archive;
- use the root `captain-definition` included in the archive;
- set the container HTTP port to `3000`;
- use `/healthz` for the health check.

The canonical public URL is `https://music-mute.com/`, because existing MusicMute
clients already use `https://music-mute.com/#downloads`. Attach the apex domain to
the landing app and redirect `www.music-mute.com` to the apex before publication.
On 2026-10-07, a read-only network check found the CapRover placeholder at `www`
while the apex did not resolve, so that DNS/redirect step is still required.

No deployment is performed by the package or verification commands.

## Content boundaries

- Do not promise perfect separation, fixed processing time, free/unlimited usage,
  arbitrary website support, offline/PWA behavior, or local video intake on web.
- Keep the rights-confirmation statement visible.
- Do not add a store badge or direct download until that exact public artifact is
  verified from the release registry or store.
- Keep privacy, support, and account-deletion destinations HTTPS-only and public.
- Add a real audio comparison only when both clips are owned/licensed and the result
  accurately represents MusicMute processing.

See [`docs/design-research.md`](docs/design-research.md) for the open-source template
review and the reason this page uses a small custom implementation.
