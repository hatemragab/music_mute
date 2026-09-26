# Android listening comfort

This change is scoped to Android. iOS and the website client are unchanged.

## What changed

### Home

- The large wordmark is gone. Home opens with “Make room for your voice.”, one sentence about pasting a link or choosing a file, and the limit line (20 minutes, 50 MB).
- Home lists jobs that are still running, failed, or cancelled. A finished voice is a short “Voice ready” row with Play. More than one finished voice also offers Library.
- Play opens the player. The song then lives in Library.

### While you wait

- An active card uses listener language (“Removing the music”, “Sending your audio”) and says you can leave.
- If notifications are off, that card asks once to turn them on. “Not now” hides the ask for this visit.
- A paused worker is described as paused, with the audio kept, instead of “the processing computer is offline.”
- There is still no estimated time. The elapsed clock stays.

### Finished result

- Play, save, share, and offline stay on the result page.
- Job id, timings, and the step timeline are behind Details.

### Player

- Voice / Original uses the original-audio comparison that `main` already ships: the uploaded input stays in private storage, and switching keeps the same moment in the song. Save original exports that file. Older jobs that were never retained have no original.
- “Repeat this part” loops the next 15 seconds from the playhead. Tap again to stop. The loop is cleared when the track changes.

### Trust

- Library → Removed is a real filter. Hide from Library can be undone there.
- Settings → Usage shows remaining minutes and today’s remaining uploads when the account usage is loaded. It no longer shows infinity.
- Feedback, sponsored access, and terms rows that did nothing are gone.
- Account help opens Account. Privacy opens the configured privacy page when that URL is set.

## How to test

Build and install the `directDebug` variant, then sign in.

1. Home, with no jobs: one headline, the promise, the limits, the link field, and the two file buttons. No giant logo.
2. Start a file or link. The card should say what is happening in plain language and “You can leave.” If notifications are off, the ask appears above the card. Deny it, tap Not now, and confirm it does not immediately return.
3. When the job is ready, Home shows Voice ready and Play. The job card for that finished item is not in the working list. Play opens the player. Library contains the track.
4. Open the finished result from Library’s track menu → details. Play, save, and share are visible. Job id and the timeline appear only after Details.
5. In the player, tap Repeat this part and let it pass the end of the 15-second window. It should jump back. Tap Stop loop.
6. Voice / Original: a job that still has its retained input can switch, and the position should stay. Save original asks where to store that file. A job with no retained input shows that the original is unavailable.
7. Library: hide a track, open Removed, restore it.
8. Settings → Usage: connected account shows minutes and uploads left. Airplane mode after a fresh sign-in shows the connect message, not an infinity symbol.
9. Settings help rows: Account help opens Account. Privacy opens only when a privacy URL is configured. There is no dead Feedback or Sponsored row.

## Checks run

The Direct and Play debug APKs, lint checks, and JVM test suites passed locally. The Direct debug APK was installed and launched on the connected CPH2573, but the UI flows above were not exercised. Walk the list above before treating device behavior as verified.
