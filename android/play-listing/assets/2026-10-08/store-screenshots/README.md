# MusicMute Play screenshot compositions

This folder contains a source-faithful Google Play screenshot series built in
plain HTML and CSS from the Android app's current visual language and implemented
screens. It does not contain a device capture, emulator test, account data, or a
claim that the release was exercised on Android.

Open `play-store-screenshots.html` to review the English gallery and switch to
Arabic. Each rendered asset is also available directly under `renders/`.

## Play assets

Each locale has four phone images and four responsive tablet images:

1. Home and private file import.
2. Realtime processing progress.
3. Voice-only/original comparison in the player.
4. Searchable processed-audio Library.

| Play group      | Dimensions  | Ratio | Files per locale |
| --------------- | ----------- | ----- | ---------------- |
| Phone           | 1080 x 1920 | 9:16  | 4                |
| 7-inch tablet   | 1440 x 2560 | 9:16  | 4                |
| 10-inch tablet  | 1440 x 2560 | 9:16  | 4, reused        |

All PNGs are below 8 MB. `manifest.json` records dimensions, sizes, and SHA-256
checksums. The `renders/preview/` files are contact sheets for review and are not
Play upload assets.

Re-render from the repository root on macOS:

```sh
node android/play-listing/assets/2026-10-08/store-screenshots/render-store-screenshots.mjs
```

The renderer uses the installed Google Chrome binary in headless incognito mode.
It installs no package and makes no network request.

## Play Console state

The owner approved these compositions on October 8, 2026. All English and
Arabic phone, 7-inch and 10-inch groups are saved in the default store listing,
which is **Ready to send for review**. The same tablet files are deliberately
reused for both tablet groups. Play's AI declaration labels all screenshot
assets as created or edited using AI. The listing remains under **Changes not
yet submitted for review**; no review, rollout or publication action was used.

Console proof is stored in:

- `../../../../../artifacts/google-play-console-2026-10-08/store-screenshots-review.png`;
- `../../../../../artifacts/google-play-console-2026-10-08/store-screenshots-review-ar.png`;
- `../../../../../artifacts/google-play-console-2026-10-08/store-listing-ready-not-submitted.png`.
