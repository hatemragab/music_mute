# MusicMute remaining Play setup

October 8, 2026 follow-up. Root controls Console. Keep build20 unpublished; do not submit for review or start a rollout.

## Current evidence

Root freshly confirmed **7 of 11** setup tasks completed after the owner completed Sign-in details. This supersedes the older 6/11 and unsaved-access statements in `CONSOLE-STATUS.md`. It proves the Console entry was completed, **not** that the reviewer can sign in and use the app. No credential values are recorded here.

The subsequently inspected [target-audience screenshot](/Users/hatemragap/work_spaces/music_remover/artifacts/google-play-console-2026-10-08/target-audience-saved.png) displays **18 and over** and a **Change saved** confirmation. Final dashboard count and Publishing overview still belong to root's live read-back.

## Audience

The reviewed native Home, Player, Library and account screens implement a general audio-processing/listening utility. The listing copy and supplied brand artwork contain no child-directed characters, lessons, games or rewards. **Not primarily child-focused** is supported; **18 and over** remains the reasonable adult-target draft now saved in Console. This selection is not an IARC rating or proof of the owner's intended audience research.

Do not add younger groups solely to maximize availability. Google requires the app to be designed for every selected group. Selecting 18+ does not automatically require restricting minor access. Its mandatory restriction categories are gambling, core dating, random stranger connections and anonymous communication; none appears in this reviewed app. [Audience guidance](https://support.google.com/googleplay/android-developer/answer/9867159?hl=en), [restriction policy](https://support.google.com/googleplay/android-developer/answer/16302250).

## Listing text and images

The English and Arabic drafts describe file import, cloud processing, original/voice comparison and account Library, with measured result/availability wording. Their claims match [Home](/Users/hatemragap/work_spaces/music_remover/android/app/src/main/java/com/hatem/musicmute/ui/home/HomeScreen.kt:54), [Player](/Users/hatemragap/work_spaces/music_remover/android/app/src/main/java/com/hatem/musicmute/ui/player/FullPlayer.kt:80), [Library](/Users/hatemragap/work_spaces/music_remover/android/app/src/main/java/com/hatem/musicmute/ui/library/LibraryScreen.kt:133) and [Listening tools](/Users/hatemragap/work_spaces/music_remover/android/app/src/main/java/com/hatem/musicmute/ui/player/ListeningToolsSheet.kt:73). These are source checks, not Android execution proof.

| Locale  | Title | Short description | Full description |
| ------- | ----: | ----------------: | ---------------: |
| English |     9 |                56 |             1813 |
| Arabic  |     9 |                52 |             1577 |

Counts exclude the final newline. All fit [Google's 30/80/4000 limits](https://support.google.com/googleplay/android-developer/answer/9859152?hl=en). Root's status record reports both localizations, icon and localized feature graphics saved as drafts; this audit did not reopen Console. The icon is 512 × 512 with fully opaque alpha; both feature graphics are 1024 × 500 RGB. These are artwork, not app screenshots.

**Two genuine Android screenshots remain missing for this phone listing.** Google's minimum is two screenshots across supported device types. Use JPEG or 24-bit PNG without alpha; each dimension must be 320–3840 pixels and the longest side at most twice the shortest. Four 1080 × 1920 portrait app captures are recommended for recommendation formats, rather than required for the basic minimum. Images must show the actual experience; styling does not justify invented UI. [Preview rules](https://support.google.com/googleplay/android-developer/answer/9866151).

Use Home/file import and Player original/voice comparison as the first two captures, with a rights-cleared sample and no personal data. Optional follow-ups are prepared audio review, Library and Listening tools from `screenshot-captions.json`. The historical landing composite has no verified current-release/media provenance. Standing device instructions permit only the specified iPhone simulator; this follow-up did not start an Android device/emulator or substitute another platform's screenshots.

## Root's remaining steps

- Complete the IARC questionnaire after the pending action-time Terms acceptance; inspect calculated ratings. Native user interaction is **No** under the official secondary-app sharing exception already documented in `pending-task-checklist.md`. The **Online Content** answer is also **No** for the actual featured/promoted-content question, under the correction below.
- After audience completion, inspect and save the existing **14-type Data Safety draft**; retain the provisional precise-location and diagnostic-sharing boundaries and blank optional external data-only deletion answer.
- Add the genuine Android captures when an Android target is explicitly authorized, then read back both listings and the dashboard count.
- Keep reviewer runtime access and Google's deletion-URL 403 unresolved until independently verified. Console access instructions alone do not settle either.
- Preserve the unpublished draft and confirm no review submission, rollout or publication in Publishing overview. Separate FGS demonstration/car-quality evidence remains in the existing checklist if required by the uploaded release.

## IARC Online Content correction

**No** applies to the live question about content featured or promoted by the app that is not in its initial download. Google's specific [Online Content guide](https://support.google.com/googleplay/android-developer/answer/11070055?hl=en) excludes media users import themselves; a podcast player without supplied content is its example of no Online Content.

Home displays user tasks/recent jobs, [Library](/Users/hatemragap/work_spaces/music_remover/android/app/src/main/java/com/hatem/musicmute/library/DefaultLibraryRepository.kt:55) and the [car catalog](/Users/hatemragap/work_spaces/music_remover/android/app/src/main/java/com/hatem/musicmute/playback/PlaybackLibraryCallback.kt:139) read account-owned results, and [SupportedAudioSites](/Users/hatemragap/work_spaces/music_remover/android/app/src/main/java/com/hatem/musicmute/processing/SupportedAudioSites.kt:7) is only a provider-name/URL-rules list. No app-curated or promoted media catalog was found. User-selected URL imports remain policy-gated source functionality; this answer does not depend on hiding that capability. Voice source separation does not add a synthetic-content generator.

This supersedes the earlier **Yes** recommendation in `pending-task-checklist.md` and the earlier JSON note. It does not certify imported media as rated, rights-cleared or moderated. Root alone enters and verifies the Console answer and calculated rating.

Validation: six copy lengths and PNG dimensions/modes/opacity checked; current official Google pages retrieved; native source and saved audience screenshot inspected. No device test, login test, external UI action or production change was performed by this audit.
