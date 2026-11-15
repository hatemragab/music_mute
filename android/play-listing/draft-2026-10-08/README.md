# MusicMute draft store listing

Prepared on **October 8, 2026** for the owner's request to create a draft app in
the currently open Google Play account, save listing text, artwork and truthful
app declarations, and leave the app unpublished. **Do not upload an AAB or APK,
submit for review, or publish.** These files alone do not establish any saved
Play Console state.

This folder adds reviewable copy without replacing the earlier listing pack.
English and Arabic describe Android's cloud processing and current file import
flow. Link import is omitted because its presentation depends on the current
native policy and selected countries. There are no guarantees of complete music
removal, processing speed, unlimited allowance, universal platform support, or
offline processing.

## Fields to copy

| File in each language folder | English length | Arabic length | Play limit |
| ---------------------------- | -------------- | ------------- | ---------- |
| `title.txt`                  | 9              | 9             | 30         |
| `short-description.txt`      | 56             | 52            | 80         |
| `full-description.txt`       | 1813           | 1577          | 4000       |

Counts include spaces and description line breaks, exclude only the final file
newline, and were checked with Python. Each short description is one line with
normal sentence casing and no terminal period. The Arabic localization uses
natural Arabic text; keep the brand name `MusicMute` and let Play handle the
right-to-left display.

`store-settings.json` contains nonsecret app fields. Use **App** as the type and
**Music & Audio** as the category. Tags are predefined Console values. Choose only
tags actually offered that clearly describe voice separation/audio editing and
the audio player. The JSON lists tag intents, not verified selectable labels.
There is no need to fill all five available tag slots. Do not advertise Karaoke,
radio, video editing, unlimited access, or unverified accessibility compatibility.

## Public resources checked live

| Console field            | Value                                       | October 8 network result                                                  |
| ------------------------ | ------------------------------------------- | ------------------------------------------------------------------------- |
| Support email            | `hatemragapdev@gmail.com`                   | Published in policy metadata and public support HTML                      |
| Support website          | `https://api.music-mute.com/support`        | HTTP 200; contact and privacy/deletion navigation visible                 |
| Privacy policy           | `https://api.music-mute.com/privacy`        | HTTP 200; MusicMute policy HTML                                           |
| Account deletion URL     | `https://api.music-mute.com/delete-account` | HTTP 200; external ownership-verified request instructions                |
| Optional product website | `https://www.music-mute.com/`               | HTTP 200; MusicMute public landing page                                   |
| Policy metadata          | `https://api.music-mute.com/public-policy`  | HTTP 200; policy version `2026-10-08`, app and developer name `MusicMute` |

The apex `https://music-mute.com/` did not resolve during this check. Use the live
support page for the listing's website field; the `www` landing page is an
optional product destination. No public support telephone was found, so the
optional phone field is left empty. Public email/HTML proof does not establish
mailbox monitoring or receipt; no message was sent.

The deletion page explains the exact 15-day recovery period, subsequent cleanup,
and retained private shared public-link media. Do not replace the live policy
with promises of immediate erasure or zero third-party processing. The required
Data Safety and other declarations are covered separately by the
[release guide](../../../docs/google-play-release.md); this copy does not answer
or certify them.

## Artwork and screenshots

`screenshot-captions.json` provides English/Arabic captions and alt text of at most
140 characters, along with actual Android screens to capture. Its feature graphic
text is suitable for the existing MusicMute identity. Brand artwork may be
generated. Phone screenshots must show the actual Android UI, using rights-cleared
audio and no personal information. A synthetic screen, another platform's screen,
or an illustration of controls cannot establish a real Android screenshot.

The planned phone screens are Home/file import, prepared audio review, Player
comparison, Library and Listening tools. Screenshots are separate evidence and
are not present in this copy folder. Android execution is outside the authorized
device scope; no Android simulator or device test was run for this draft.

## Source and current rules

Claims were checked against [the Android README](../../README.md),
[Home](../../app/src/main/java/com/hatem/musicmute/ui/home/HomeScreen.kt),
[Player](../../app/src/main/java/com/hatem/musicmute/ui/player/FullPlayer.kt),
[Listening tools](../../app/src/main/java/com/hatem/musicmute/ui/player/ListeningToolsSheet.kt)
and [Library](../../app/src/main/java/com/hatem/musicmute/ui/library/LibraryScreen.kt).
File input prepares audio before rights confirmation and cloud submission;
completed results have original/voice comparison, playback tools, saving,
sharing and renaming. These are source-backed facts, not Play-installed runtime
proof.

Official Google guidance retrieved October 8, 2026:

- [Create and set up an app](https://support.google.com/googleplay/android-developer/answer/9859152):
  name/description limits and public support contact fields.
- [Preview assets](https://support.google.com/googleplay/android-developer/answer/9866151):
  icon, feature graphic, screenshots and accurate app presentation.
- [Categories and tags](https://support.google.com/googleplay/android-developer/answer/9859673):
  relevant category and at most five predefined tags.

Local checks: UTF-8 files read successfully; all six copy lengths are within
limits; both JSON documents parse; short descriptions contain no line breaks;
every supplied image alt text is at most 140 characters. No build, device test,
bundle upload, review submission or publication is part of these file checks.
