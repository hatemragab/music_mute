# MusicMute Google Play draft artwork

Prepared October 8, 2026 for the existing MusicMute brand. The artwork and
promotional screenshot compositions are saved in the Play Console listing as
**Ready to send for review**. They are not an Android build, publication or
device test, and nothing was sent for review.

| File                              | Use                           | Dimensions | PNG format                      |
| --------------------------------- | ----------------------------- | ---------- | ------------------------------- |
| `icon-512.png`                    | Store app icon, all languages | 512 × 512  | 32-bit RGBA; every pixel opaque |
| `feature-graphic-en-1024x500.png` | English feature graphic       | 1024 × 500 | 24-bit RGB; no alpha            |
| `feature-graphic-ar-1024x500.png` | Arabic feature graphic        | 1024 × 500 | 24-bit RGB; no alpha            |

## Artwork sources

- The icon preserves the existing Solo Signal geometry, colors, stroke widths,
  rounded ends and opacities from
  `android/app/src/main/res/drawable/ic_vocal.xml`. `icon-source.svg` records
  the equivalent vector. It has no baked-in corner mask, badge or drop shadow.
- The feature graphics extend that visual identity with an abstract layered
  audio signal. The dark green/mint palette matches the app icon; the orange
  accent is Android's default `0xFFFF814A` from `AccentPalette.kt`.
- Copy follows the existing listing artwork and product behavior: “Keep the
  voice. Reduce the music.” / “احتفظ بالصوت. قلّل الموسيقى.” The design makes
  no guarantee of perfect separation, speed, availability, pricing or ranking.
- `render.swift` draws directly with AppKit/CoreGraphics and system fonts. It
  preserves Arabic shaping and RTL alignment. No remote assets, new packages or
  paid services were used. Play's AI declaration labels both localized feature
  graphics as created or edited using AI; the source-derived app icon remains
  unlabelled.

Reproduce from the repository root on macOS:

```sh
swift android/play-listing/assets/2026-10-08/render.swift
```

`manifest.json` records the PNG dimensions, channel modes, file sizes and
SHA-256 checksums. Validation on October 8: all three images visually inspected;
`file`, `sips` and Pillow confirmed exact dimensions/channel formats; the icon's
alpha channel is fully opaque and its size is below 1 MB.

## Accessibility descriptions

- English feature graphic: `MusicMute. Keep the voice. Reduce the music. An abstract mint audio signal on a green background.`
- Arabic feature graphic: `MusicMute. احتفظ بالصوت وقلّل الموسيقى. موجة صوتية بلون النعناع على خلفية خضراء.`
- App icon: `MusicMute's mint Solo Signal waveform on a green square.`

Each description is under Google's recommended 140-character limit.

## Store screenshot compositions

The `store-screenshots/` folder now contains a reviewable HTML/CSS promotional
series based on the current Android Home, processing, player, Library, theme, and
wide-layout source. It exports four English and four Arabic phone images at
1080 x 1920, plus matching tablet images at 1440 x 2560. The same responsive
tablet set is saved in both the 7-inch and required 10-inch groups. Every upload
asset is an exact 9:16 PNG and is below 8 MB.

These are source-faithful marketing compositions, not captures from an Android
runtime. They use generic sample names and contain no account or personal data.
The HTML, renderer, review contact sheets, dimensions, sizes, and checksums are
documented in `store-screenshots/README.md` and `store-screenshots/manifest.json`.

## Runtime screenshot evidence remains separate

No suitable, current, raw Android phone screenshots with release and public-media
provenance were found in the repository. Existing dashboard/web/iOS captures are
not Android screenshots. The public
`landing_page/public/screenshots/musicmute-app-showcase.png` is a composite of
older phone screens with media titles and an earlier Home/link layout; it does
not establish the exact Play release, a clean public-media review account, or a
current standalone screenshot. It was not repurposed for this listing pack.

No Android device or emulator was run to make the HTML/CSS compositions. If a
future review requires device-runtime evidence, capture it separately from the
intended Android release with rights-cleared review audio and no personal data.

The icon, feature graphics and screenshots follow the [official Google Play
preview asset requirements](https://support.google.com/googleplay/android-developer/answer/9866151)
checked October 8, 2026. Console review confirms four assets in the phone,
7-inch and 10-inch groups for both languages. The screenshot setup gate is
complete; runtime proof and later review/release gates remain separate.
