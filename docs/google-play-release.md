# Google Play release guide

This is the repository-owned submission checklist for `com.hatem.musicmute`.
It describes source behavior and the values that should be copied into Play
Console. It does not prove that the backend was deployed, a mailbox is monitored,
Play App Signing is configured, or a declaration was saved in Play Console.

Last reviewed against Google Play guidance: **2026-09-27**.

## Public release resources

| Play field           | Production value                            |
| -------------------- | ------------------------------------------- |
| Privacy policy       | `https://api.music-mute.com/privacy`        |
| Account deletion URL | `https://api.music-mute.com/delete-account` |
| Support website      | `https://api.music-mute.com/support`        |
| Support email        | `hatemragapdev@gmail.com`                   |
| Policy metadata      | `https://api.music-mute.com/public-policy`  |

The privacy, deletion, and support pages are static server-rendered HTML with no
scripts, analytics, advertising trackers, public account lookup, or deletion
mutation. The deletion page lets a user initiate a support-assisted request without
the app. Support verifies ownership before using the authenticated deletion
workflow. Optional backend environment overrides are bounded and escaped; absent
overrides use the checked-in defaults.

Before submission, verify every URL from an unauthenticated network and send a
sanitized test message to the support address. Rendering a `mailto:` link does not
prove mailbox delivery or monitoring.

## Recommended submission order

1. Complete Android developer identity and package registration for
   `com.hatem.musicmute`.
2. Deploy the backend containing the current public resources and verify HTTP 200,
   HTTPS, content, security headers, and mailbox delivery.
3. In Play Console App Integrity, copy the **app-signing** SHA-1 and SHA-256 into
   the Firebase Android app. The upload certificate is not a substitute for the
   Play app-signing certificate.
4. Build a new Play AAB. Inspect its `BuildConfig` and merged manifest; never upload
   an older bundle containing empty policy URLs.
5. Upload to Internal testing. Install the Play-signed artifact and test sign-in,
   local import, permitted link import, processing, foreground notifications,
   playback/export, sign-out, and account deletion with disposable data.
6. Complete App content declarations, Data Safety, App access, content rating,
   target audience, ads, and foreground-service declarations.
7. Run Play pre-review checks and the pre-launch report. Resolve critical issues,
   then submit one complete change set instead of repeatedly editing a pending
   review.

## Data Safety draft

Reconcile this draft with the exact Play form and current provider contracts. The
declaration covers data transmitted off the device by the app, backend, and bundled
SDKs—not only fields directly entered by the user.

| Play data category           | Current source behavior                                                                   | Primary purposes                                                                   |
| ---------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Name                         | Firebase profile name when supplied                                                       | Account management, app functionality                                              |
| Email address                | Firebase/account email when available                                                     | Authentication, account management, support, deletion verification                 |
| User IDs                     | Firebase UID and internal account references                                              | Authentication, security, account-scoped storage                                   |
| Audio files                  | Prepared input audio, retained prepared original, and voice-only result                   | Core processing, playback, export, history                                         |
| Other user-generated content | Source URL, filename/title/metadata, optional recovery reason, processing history         | Core functionality, account history, support                                       |
| Device or other IDs          | Installation UUID, Firebase installation/messaging identifiers, push token                | Sessions, security, notifications, diagnostics                                     |
| App interactions             | Import, job, playback/export, account and policy actions represented in service records   | App functionality, security, usage limits                                          |
| Crash logs and diagnostics   | Privacy-filtered Sentry and first-party client/worker diagnostics                         | Reliability, troubleshooting, security                                             |
| Approximate location         | No device location permission or location feature; network/providers process IP addresses | Network delivery, security, fraud prevention; confirm Play/provider interpretation |

- The original source video is not uploaded; local preparation uploads audio. Do
  not declare uploaded photos/videos unless this behavior changes.
- Release clients use HTTPS and private media uses authenticated, short-lived
  grants, so **data encrypted in transit** should be declared yes after Play-signed
  traffic is verified.
- **Users can request deletion** should be declared yes only after both the in-app
  flow and external page are live and verified.
- Source inspection found no advertising SDK or ad behavior. The ads declaration
  should be **No** unless another distribution/runtime configuration adds ads.
- Firebase, hosting, database, object storage, and Sentry are service providers.
  Determine whether each transfer qualifies for Play's service-provider exception
  from the actual contract and purpose before answering the sharing questions.
- Retention must match the live policy: an exact 15-day recovery period, permanent
  cleanup afterward, a 24-hour pseudonymous replay fence, user/provider-controlled
  exported copies, and restricted infrastructure logs/backups aging out under
  their configured lifecycle.

## App access instructions template

Store reviewer credentials only in Play Console, never in this repository.

```text
MusicMute requires authentication.

Username/email: <dedicated reusable reviewer account>
Password: <stored only in Play Console>

No OTP, device approval, location restriction, or expiring invitation is required.
The account is email verified and has processing allowance. A completed sample job
is already available in Library so playback and export can be reviewed even if a
new processing job is still queued.

Review steps:
1. Sign in with the credentials above.
2. Open Library and select the prepared review job.
3. Play Voice and Original, then use Save to device if requested.
4. To test a new job, open Home, select a rights-cleared audio sample, review it,
   confirm that you have permission, and submit processing.
5. Open Account to see Privacy policy, Account deletion help, and Delete account.

Support contact during review: hatemragapdev@gmail.com
```

Before submission, confirm the credentials remain reusable from a clean
Play-installed build and that the backend, worker, allowance, test media, and
completed sample stay available for the full review window.

## Foreground-service declarations

The merged Play manifest declares only `mediaPlayback` for audible playback. It
does not request `FOREGROUND_SERVICE_DATA_SYNC`, and it explicitly removes
WorkManager's foreground service. Declare only the type present in the uploaded
bundle. If transfer execution changes in the future, re-audit the merged manifest
and runtime before adding another declaration.

### `mediaPlayback`

Suggested description:

> MusicMute uses a media-playback foreground service while the user listens to a
> prepared original or voice-only result. Android's media notification displays the
> active session and playback controls. The service stops when playback is stopped
> and is necessary for expected background audio playback.

Evidence video should show starting playback from a completed job, the media
notification and controls, background playback, and stopping the session.

## Store listing draft

- **App name:** MusicMute
- **Short description:** Remove background music from audio and keep the voice.
- **Category suggestion:** Music & Audio

Suggested full description:

> MusicMute separates voice from background music in audio you own or have
> permission to process. Import local audio or a supported public link, review the
> prepared media, and explicitly confirm your rights before cloud processing.
>
> Keep a private processing library, follow live job progress, compare the prepared
> original with the voice-only result, and play or export your files. Account,
> privacy, support, and deletion controls are available from the app.
>
> Processing availability and limits depend on current service capacity and account
> policy. MusicMute does not grant rights to download or process third-party media.

Required listing evidence still has to be captured from the released UI:

- 512×512 Play icon, maximum 1 MB.
- 1024×500 feature graphic.
- At least two accurate phone screenshots; four high-quality screenshots are
  preferred. Do not use another device or fabricated processing result as runtime
  proof.
- English listing text and an Arabic localization if the Arabic UI is promoted.
- No unsupported performance, availability, copyright, privacy, or “free/unlimited”
  claims.

## Console-only gates

These cannot be completed by source changes:

- Developer identity, contact, and package registration status.
- Play App Signing enrollment and Firebase registration of the Play signing key.
- App category, target audience, content rating, ads, and News declarations.
- Saved Data Safety answers and account deletion URL.
- Saved foreground-service declarations and uploaded demonstration videos.
- Reviewer credentials and instructions.
- Listing assets/screenshots and production countries/tracks.
- Conditional closed-test requirement for eligible newer personal accounts.
- Policy status, pre-review checks, pre-launch report, and final review outcome.

Official references:

- [Prepare an app for review](https://support.google.com/googleplay/android-developer/answer/9859455)
- [App access requirements](https://support.google.com/googleplay/android-developer/answer/15748846)
- [User Data and privacy policy](https://support.google.com/googleplay/android-developer/answer/10144311)
- [Account deletion](https://support.google.com/googleplay/android-developer/answer/13327111)
- [Data Safety](https://support.google.com/googleplay/android-developer/answer/10787469)
- [Foreground service declarations](https://support.google.com/googleplay/android-developer/answer/13392821)
- [Store listing assets](https://support.google.com/googleplay/android-developer/answer/9866151)
