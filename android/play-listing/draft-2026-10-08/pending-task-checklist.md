# MusicMute Play draft checklist

Updated 2026-10-08 for the latest task: fill the existing MusicMute app and prepare a **Play AAB 1.0.0/build20 draft**. Do not send app changes for review, start a rollout or publish. This scope supersedes this folder's earlier no-bundle instruction. The root task owns Chrome, Console saves, private contact/access values and artifact upload. This checklist records preparation evidence, not Console completion.

## Confirmed preparation

- [x] Source now declares version `1.0.0`, code `20`, target SDK `36` and a Play flavor. This is source proof; the uploaded artifact still needs independent read-back.
- [x] The public [privacy page](https://api.music-mute.com/privacy) was retrieved successfully and includes retained IP-derived location and estimated coordinates.
- [x] The public [deletion page](https://api.music-mute.com/delete-account) was retrieved successfully and includes external, ownership-verified request instructions and private-media cleanup scope. Mailbox receipt/operation was not tested.
- [x] Ads **No**, Advertising ID **No**, health features **None**, financial features **None**, government app **No**, and news app **No** are supported by the current audio-utility source and dependencies. Reconcile permissions with the uploaded AAB.
- [x] Account access is restricted; email/password and Google OAuth are supported. The owner provided contact/access values privately to root. None are recorded in this checklist or the form draft.
- [x] Source-backed collection and analytics purposes are recorded in `app-content-draft.json`. App interactions and installation/device records have first-party analytics uses even without an analytics SDK.

## Console work and evidence still to record

- [ ] Read back app identity, default/localized listing copy, category **Music & Audio**, public contact, privacy/deletion URLs, graphics and screenshot ordering from the existing Console app.
- [ ] Verify the exact draft AAB is `com.hatem.musicmute`, version `1.0.0`, code `20`, Play flavor, target SDK `36`; inspect its merged permissions and any Console artifact errors. Do not treat source version changes as upload proof.
- [ ] Save the source-backed ads, access, Advertising ID, health, financial, news and government declarations and read back each saved result.
- [ ] Verify the reviewer account can repeatedly sign in and access a rights-cleared sample without private setup, OTP, device approval or an unexplained country restriction. Keep values only in the private Console instructions.
- [ ] Enter genuine screenshots of this Android release. An illustration, another platform's screenshot or a generated UI is not Android execution evidence.
- [ ] Complete the IARC questions against their actual wording and inspect the calculated regional results; do not pre-claim a certificate or age rating.
- [ ] Review the target-audience draft recommendation **18 and over**. Current design is a general audio/account utility with no child-directed content, but the owner's intended audience was not explicitly stated. No source feature requires a mandatory minor-access restriction. Google's target audience is separate from an IARC suitability rating. [Audience guidance](https://support.google.com/googleplay/android-developer/answer/9867159).
- [ ] Reconcile provisional Data Safety choices, including precise-location classification, Sentry and remaining provider roles, before any app review submission. Save draft evidence and choices without claiming a completed independent privacy assessment.
- [ ] Complete the media-playback foreground-service declaration and supply a reachable, genuine feature demonstration video.
- [ ] Verify Android Auto requirements if the submitted bundle includes the declared car audio surface; no car/device testing was performed by this audit.
- [ ] Inspect Publishing overview and release state at the end. Keep the release unpublished and do not select **Send changes for review**, **Start rollout**, or **Publish**.

## IARC answer guide

Select **All other app types** for the music/audio utility. The supplied UI/artwork/copy contains no violence, sexual content/nudity, profanity, horror, gambling, drugs, tobacco or alcohol; answer **No** where the question is specifically about that supplied content. Do not extend those answers to arbitrary user-selected/imported audio. Final wording and calculated ratings remain a Console check. [Rating guidance](https://support.google.com/googleplay/android-developer/answer/9859655).

| Question scope                                                           | Source-backed answer                                       | Boundary                                                                                                                                                                                      |
| ------------------------------------------------------------------------ | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chat, social interaction or direct exchange between MusicMute users      | **No**                                                     | No in-app recipient/chat/profile/comment/public upload feed exists. Private cloud processing is account-owned work.                                                                           |
| Public user-media catalog/feed                                           | **No**                                                     | A reusable processing cache of already-public source media is not a browsable user-upload catalog.                                                                                            |
| Sharing a user's location with other users                               | **No**                                                     | Retained IP-derived location is account/device information, not public social location sharing.                                                                                               |
| Digital purchases, gambling or real-money prizes                         | **No**                                                     | No purchase/billing/gambling feature is implemented in this native release.                                                                                                                   |
| Whether MusicMute **natively** permits user interaction/content exchange | **No**                                                     | Listening tools delegates audio export to Android's chooser and a secondary app. Google's specific questionnaire guidance excludes secondary-app sharing from this native-interaction answer. |
| Accessible online content not initially bundled                          | **Yes if it covers URL imports/downloaded playable audio** | URL import capability is policy-gated. A hidden control in one country or session does not prove global absence; follow-up content questions need the form's exact scope.                     |

Evidence: [share chooser](/Users/hatemragap/work_spaces/music_remover/android/app/src/main/java/com/hatem/musicmute/ui/player/ListeningToolsSheet.kt:123), [audio ACTION_SEND](/Users/hatemragap/work_spaces/music_remover/android/app/src/main/java/com/hatem/musicmute/playback/LocalAudioTools.kt:163), [native URL policy](/Users/hatemragap/work_spaces/music_remover/android/app/src/main/java/com/hatem/musicmute/processing/ProcessingMediaPolicy.kt:20), [presentation-only server visibility](/Users/hatemragap/work_spaces/music_remover/backend/src/admin-settings/account-policy.service.ts:75), [account-owned import read](/Users/hatemragap/work_spaces/music_remover/backend/src/url-imports/imports.service.ts:535).

The exact current native-interaction question is therefore **No**, including the implemented `ACTION_SEND` export. The explicit rule is to consider native services and exclude sharing accomplished through secondary apps. [Official online-interaction/content-exchange questionnaire guidance](https://support.google.com/googleplay/android-developer/answer/7021383?hl=en), publicly retrieved October 8, 2026. Private cloud processing does not add a user-to-user service.

The Data Safety category **Other user-generated content** covers selected URLs/recovery explanations. It does not imply public UGC/social functionality. Source separation extracts vocals from supplied audio; it is not a chatbot, prompt-to-image generator or voice impersonation feature. Treat any AI form according to its actual wording. [Current generative-content scope](https://support.google.com/googleplay/android-developer/answer/14094294).

## Data Safety decisions

Keep **Collected**, required/optional and purpose choices from the JSON. Retained records are **not ephemeral**. Known Firebase Auth/Messaging and Cloudflare R2 customer-content processing have public standard service-provider support; deliberate audio export has a clear user-initiated sharing action. These facts do not by themselves establish every recipient's role or an overall no-sharing declaration. [Google's collection, sharing and exceptions](https://support.google.com/googleplay/android-developer/answer/10787469).

For an editable conservative draft, the JSON recommends **Crash logs + Diagnostics: Collected and Shared; Analytics** while the Sentry exception remains unverified. This acknowledges confirmed transfer to a diagnostic vendor and does not claim independent identifiable-data use. Standard [Sentry terms](https://sentry.io/terms/) limit ordinary Service Data use to providing/maintaining/improving the customer's service, allow additional uses for non-identifying data and customer-authorized other data, and prohibit Personal Data submission absent a DPA. [DPA acceptance](https://www.sentry.help/en/articles/13965008-how-do-i-sign-your-data-processing-addendum) and organization settings were not inspected. Exception/anonymous-data conclusions still require actual evidence.

**Approximate location** is confirmed retained collection. **Precise location** remains unresolved because the code stores IP-derived coordinates without an accuracy area. The JSON includes a broader provisional Collected choice if root needs a conservative draft, clearly separated from a verified physical-area classification. Do not describe the estimate as GPS or assert precise location is absent merely because GPS permissions are absent. See the existing `privacy-audit.md` for public accuracy evidence.

Eligible in-app private-job deletion can remove some data without deleting the account; no dedicated external data-only deletion URL or executed data-only request was verified. Do not fabricate an external flow if the optional form asks for one. Account deletion retains the documented 15-day recovery period and separately retained shared public-link media.

## Foreground service and car surface

Declare **mediaPlayback → Media playback** only. The source removes WorkManager's foreground service and does not declare `dataSync`, `mediaProcessing`, microphone, location or special-use FGS types. Full-screen intent is absent. The feature description and impact text are in the JSON.

A real video should show a user opening an eligible Library result, pressing Play, leaving the app or locking the screen while audio continues, then using the media notification controls to pause/resume. This is a requested recording sequence, not proof that it was run. Google requires a video link demonstrating how the feature is triggered. [FGS declaration guidance](https://support.google.com/googleplay/android-developer/answer/13392821).

The manifest's MediaLibraryService and car metadata establish source integration only. Do not claim actual Android Auto host quality, reviewer access, video or screenshot proof without recording the corresponding check.

## Existing image inventory — read-only follow-up

No verified current raw Android phone screenshot was found in the reviewed tracked or ignored image paths; no device/emulator was run.

- `landing_page/public/screenshots/musicmute-app-showcase.png` is a **2030 × 2002** historical composite containing Home/link import and Player views. Its displayed controls match source capabilities, but the screenshot's exact release, current native policy and media rights are not established. The Home view shows a Link tab, while current native visibility can be file-only. It is a historical product reference, not verified build20 screenshot proof. The landing page separately shows its two device regions using SVG view boxes in `landing_page/src/App.tsx`.
- `docs/home-import-designs/all-four.png`, `job-cards.png` and `job-cards-delete.png` are design/mockup references, not captured Android release screens.
- `artifacts/android-0.1.10-mandatory-published.png`, `artifacts/r2-rollout/android-r2-published-policy.jpg`, `android14-r2-published-policy.jpg` and `dashboard/test-results/link-import-visibility/android-published.png` are wide publication/policy evidence, not native phone listing captures. Dated validation documents identify the relevant dashboard publication proofs.
- The listing asset directory contains the icon and English/Arabic feature graphics explicitly labeled as artwork, not screenshots. Browser, iOS and Chrome-extension images are not Android phone evidence.

Google permits stylized screenshots, so a composite is not automatically invalid merely for being styled. The material must still depict the actual app experience. No suitable current release/provenance verification was found for this composite. [Official preview guidance](https://support.google.com/googleplay/android-developer/answer/9866151?hl=en).

The truthful next captures remain the existing `screenshot-captions.json` shot list: Home/file import, prepared audio/rights review, Player comparison, Library, and Listening tools. Those screens are implemented; their current Android images still need a genuine capture.

## Validation performed here

Source and public-document reads; successful public privacy/deletion page retrieval; JSON parsing and scope/credential-absence checks. Targeted Prettier formatting and its check passed for both owned files. No builds, device tests, Console operations, messages, artifact uploads or publication were performed by this audit. Other workers' edits were preserved. Only `app-content-draft.json` and this new checklist were changed for this follow-up.
