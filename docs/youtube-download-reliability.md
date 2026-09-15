# Android YouTube download reliability

The Android app uses `io.github.junkfood02.youtubedl-android:library:0.18.1`.
Its bundled yt-dlp is 2025.11.12. The library version and the installed Python
extractor version are separate. Changing debug/release mode does not update the
extractor or establish the cause of a failed download.

## Recovery implemented

- Before downloading, check the official yt-dlp stable release at most daily.
  Failed checks back off for six hours, persisted across app restarts.
- Download only from allowlisted GitHub HTTPS hosts with bounded redirects,
  response size and timeouts. Require the official asset SHA-256 digest.
- Preserve the previous extractor, install atomically, and run `--version` in
  the application's actual Python runtime. Restore the previous version if the
  runtime probe fails. A pending marker restores interrupted installations on
  the next use. Update outages leave the current extractor usable.
- Maintenance occurs outside the source transfer deadline. Downloads are
  serialized and separated by at least five seconds within the app process.
- HTTP 403/429, “try again later”, and format extraction failures receive the
  existing bounded WorkManager retry/backoff (three online retries). Private,
  removed and sign-in restricted videos remain terminal. Each worker attempt
  starts a fresh extraction; expiring signed stream URLs are not reused.
- A transfer deadline is a retryable network failure. A byte limit remains a
  media-size failure even after temporary files disappear.
- Download history stores only a safe diagnostic: stage, extractor version,
  and category. Native stderr, signed URLs and credentials are not stored in
  that diagnostic. The `YoutubeSource` log records version and update outcome.

## Limits and maintenance

No unofficial extractor can guarantee permanent YouTube compatibility. A new
YouTube challenge, account restriction, network/IP limit, or regional restriction
can still prevent a download. The runtime probe checks startup compatibility;
it does not prove that every video works. Updating yt-dlp does not update native
Python or QuickJS; those require testing and shipping a new app dependency.
The old bundled version remains the offline fallback for a fresh installation.

Before shipping, run both Android variant unit-test suites and lint, build the
release, and test actual downloads on the authorized physical device. Include
a public short video, an unavailable video, cancellation, and network recovery.
Do not claim a device pass from unit tests or a desktop yt-dlp download.

Upstream references:
- [Android wrapper usage and updater](https://github.com/yausername/youtubedl-android#usage)
- [yt-dlp update guidance](https://github.com/yt-dlp/yt-dlp#update)
- [YouTube errors and request pacing](https://github.com/yt-dlp/yt-dlp/wiki/Extractors#common-youtube-errors)
- [JavaScript runtime and EJS requirements](https://github.com/yt-dlp/yt-dlp/wiki/EJS)

Upstream recommends nightly for regular yt-dlp users. This app intentionally
uses stable releases automatically; adopting a nightly requires explicit
compatibility testing rather than silently following an untested channel.
