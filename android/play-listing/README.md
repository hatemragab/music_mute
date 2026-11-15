# Google Play listing pack

Prepared for MusicMute `0.1.14` (build `15`), package `com.hatem.musicmute`.
These are reviewable submission materials. They do not establish that a Console
declaration, publication, public policy deployment, or device check has happened.
Use the [release guide](../../docs/google-play-release.md) for the remaining gates.

## Listing text and artwork

`en-US/` and `ar/` contain the title, short description, full description, and
release notes. Copy each into the matching Play Console localization. The
descriptions make no timing, complete-separation, free, or unlimited claims.

Generate artwork from the existing MusicMute Solo Signal identity on this Mac:

```sh
# From the repository root; output is ignored by Git.
swift android/scripts/make-play-assets.swift
```

Generated files under `artifacts/google-play/`:

| File                              | Console use             | Format                     |
| --------------------------------- | ----------------------- | -------------------------- |
| `icon-512.png`                    | Main store listing icon | 512 × 512, opaque RGB PNG  |
| `feature-graphic-en-1024x500.png` | English feature graphic | 1024 × 500, opaque RGB PNG |
| `feature-graphic-ar-1024x500.png` | Arabic feature graphic  | 1024 × 500, opaque RGB PNG |

The icon uses the existing app mark. Feature graphics are brand artwork, with
local-language text and no fabricated app screens. Inspect the generated files
before upload. Google may crop artwork in discovery surfaces; all text is kept
inside the central safe area.

## Screenshot capture plan

Capture real screens from the exact Play-installed release. Keep personal data,
private media, credentials, and diagnostic identifiers out of the images. Use a
dedicated review account and rights-cleared audio. Do not substitute iOS screens,
mockups, or synthetic processing results for Android screenshots.

| Shot | Screen and evidence                               | English caption            | Arabic caption          |
| ---- | ------------------------------------------------- | -------------------------- | ----------------------- |
| 1    | Home with local file selection visible            | Bring your audio           | أضف ملفك الصوتي         |
| 2    | Prepared local audio and rights confirmation      | Review before processing   | راجع الملف قبل المعالجة |
| 3    | Real completed job with Original/Voice comparison | Compare original and voice | قارن الأصل بالصوت       |
| 4    | Library with completed review files               | Keep your audio together   | احتفظ بملفاتك في مكتبتك |
| 5    | Privacy, support, and deletion controls           | Manage your account        | إدارة حسابك             |

At least two phone screenshots are required. Prefer four consistent portrait
screenshots, 1080 × 1920 when available, in each promoted language. Follow the
[current official asset rules](https://support.google.com/googleplay/android-developer/answer/9866151)
for dimensions, format, ratios, and discovery recommendations. Avoid unsupported
performance or availability claims in captions. Screenshots remain **pending**:
the current device instruction permits only the named iPhone simulator, which
cannot prove the Android app or produce Android listing screenshots.

## Evidence to record before submitting

- [x] Live privacy/deletion/support pages and policy metadata match this release
      (verified on API 125, October 8).
- [ ] `check-play-release.py --live` passes against the new signed AAB.
- [ ] Firebase contains the Play **app-signing** fingerprints; clean Play install
      can use all offered sign-in methods.
- [ ] Dedicated reviewer credentials work without one-time codes or expiring steps;
      available allowance and a completed sample remain usable during review.
- [ ] Play-installed local import, cloud processing, comparison, export, playback
      notification, sign-out, and deletion are checked with disposable data.
- [ ] Arabic/RTL, TalkBack, font scaling, permission denial, offline recovery,
      background playback, and update recovery work on the Play artifact.
- [ ] Android Auto Desktop Head Unit verifies signed-out/update guidance, library,
      playback, reconnection, and account switching if Auto stays enabled.
- [ ] Real phone screenshots and the mediaPlayback demonstration video are captured.
- [ ] Data Safety, App access, deletion URL, FGS, ads, audience/rating, countries,
      signing, and track declarations are saved in Console.
- [ ] Applicable closed testing and Play pre-launch checks are completed.

Only mark a box after retaining the actual result. Build and JVM tests do not
replace these device, operational, or Play Console checks. No production accounts
or media were created for this pack.
