# W27 — Complete Windows behavior in the shared Chrome extension

- Status: code-complete / Windows pending; platform guidance, discovery, privacy and copied-report corrections have receiving and whole shared-source proof.
- Code dependencies: [W13](W13-cloud-mode-and-processing-policy.md), [W18](W18-player-and-playback-queue.md), [W21](W21-verified-cache-and-community-reuse.md), [W26](W26-chrome-native-host-and-registration.md).
- Accepted scope points: P09, P17, P23, P24.
- Execution phase: A — implement now once authorized; native checks later.
- Evidence: [named-command/source closure](../evidence/W02-W27-2026-10-09-closure.md), [browser core historical checks](../evidence/W27-browser-core.md) and [Root production bindings](../evidence/W04-W18-W27-production-bindings.md); the coherent combined source checkpoint is recorded; Windows checks remain open.

This task document does not itself authorize implementation. Honor the latest user phase instruction; after source work is authorized, run portable shared-extension code checks first and defer real Windows Chrome/YouTube acceptance until W34.

## Existing behavior and design consequence

The extension should remain a shared client of the desktop authority. Windows differences belong in capability/status and native adapters; playback synchronization and product controls remain common.

## Read before editing

- [chrome-extension/src/extension/static/manifest.json](../../../chrome-extension/src/extension/static/manifest.json)
- [chrome-extension/src/shared/providers.ts](../../../chrome-extension/src/shared/providers.ts)
- [chrome-extension/src/companion/browser-processing-bridge.ts](../../../chrome-extension/src/companion/browser-processing-bridge.ts)
- [chrome-extension/src/companion/browser-cloud-provider.ts](../../../chrome-extension/src/companion/browser-cloud-provider.ts)
- [chrome-extension/src/companion/local-sync-client.ts](../../../chrome-extension/src/companion/local-sync-client.ts)
- [chrome-extension/README.md](../../../chrome-extension/README.md)

Also read [architecture](../ARCHITECTURE.md), [AI handoff](../AI-HANDOFF.md),
[validation](../VALIDATION.md), and the affected component instructions/manifests.

For the sequential execution order, checkbox rules and current partial-source gaps, read [execution plan](../EXECUTION-PLAN.md), [feature acceptance](../FEATURE-ACCEPTANCE.md) and [resume gaps](../RESUME-GAPS.md).

## Implementation checklist

- [x] Enable the Windows provider only after validated host capability/Prepare readiness, with platform-appropriate installation/repair guidance and no unverified direct download link. The G04 return now passes actual HELLO-aware Windows/unknown/Mac guidance, popup setup, reviewed discovery links, privacy and bounded copied-report receivers; see [the final shared return](../evidence/W27-platform-guidance-and-privacy-2026-10-10.md).
- [x] Preserve original/voice switching, play/pause/seek/rate synchronization, active-video identity, drift correction and trim=false. Reject stale media/page generations and mismatched source/timeline reuse.
- [x] Preserve the established duration boundary: manual eligible processing accepts up to 1,200 seconds inclusive; automatic initiation requires duration strictly below the saved 1–20 minute limit, default 20. Preserve an existing shorter limit and saved auto-start-off setting. Do not make extra extraction/HTTP duration requests when the current loaded-video eligibility contract supplies duration.
- [x] Keep automatic initiation local-only and respect the app's saved mode, account/cloud policy and concise progress/transparency. Do not add a second browser login or token store.
- [x] Preserve manual `ONLINE_MUSICMUTE` START through the trusted native account import/provider path and synchronized full-timeline vocals. Keep the explicit cloud-to-app handoff as an additional review action, not a replacement for saved-cloud manual Start.
- [x] Port appearance, English/Arabic/automatic language, saved 0–80% dialog transparency and source/processing controls through the existing shared UI. Preserve waveform/timeline, reduced motion, original mute preference and Stop-versus-close behavior.
- [x] Handle YouTube SPA navigation, source/video changes, page reload, background tab/service-worker/offscreen recovery and native host disconnect without duplicated jobs or continued playback from the old page.
- [x] Preserve one audible tab, ad boundaries, public non-live watch-video eligibility and current multiple-language/described-track refusal. Stop/original selection suppresses repeated automatic attempts for the same visit; same-video player replacement preserves the valid session.
- [x] Keep permission/host scope minimal and protect browser sender/origin paths. Prepare extension package/static checks now; browser UI/live YouTube acceptance waits for Windows.

## Code validation checklist

- [x] Run shared extension unit/contract/headless tests for Windows/Mac capability branches, duration at/below/above the boundary and local/cloud auto-start. After G04, whole shared regression passed 2,329 tests with four existing skips/83 files at 02:37:23, with whole TypeScript, lint224 and formatting; source-builder fixtures are included. Earlier passes remain dated history.
- [x] Replay video generation, SPA/reload/background/disconnect sequences with fake browser/media/native APIs; assert stale audio and duplicate work are stopped.
- [x] Build the shared extension and verify one identity/manifest, token-free messages and unchanged Mac provider contracts.

## Windows acceptance — deferred until W34

- [ ] Test the same extension in real Windows Chrome with fresh and cached YouTube processing, manual/automatic boundaries and synchronized listening.
- [ ] Verify SPA/reload/background/reconnect recovery, mode/policy presentation, English/Arabic and later Mac native regression where applicable.

## Detailed AI-agent handoff — reviewed 2026-10-09

### Current source and deferred acceptance

The current audited implementation in [browser-platform helper](../../../chrome-extension/src/shared/browser-platform.ts), [shared protocol](../../../chrome-extension/src/shared/protocol.ts), [background service worker](../../../chrome-extension/src/extension/background.ts) and the Windows account bridge now include Windows provider and manual cloud routing source. Root sole-authority/guest/cold-cloud media, reuse/publication and headless lifetime now have production call sites and portable checks in [binding evidence](../evidence/W04-W18-W27-production-bindings.md). The earlier focused failure and typing correction were revalidated; installer/resources and real Windows acceptance remain open. Read [current gaps](../RESUME-GAPS.md) for separately owned work. The complete named-command/lifetime ledger and coherent combined source checkpoint below supersede earlier partial-source notes; installed acceptance remains open.

Read the existing [content UI](../../../chrome-extension/src/extension/content.ts), [popup](../../../chrome-extension/src/extension/popup.ts), [provider contracts](../../../chrome-extension/src/shared/providers.ts), [app handoff parser](../../../chrome-extension/src/shared/app-handoff.ts), [Windows browser service](../../../windows-desktop/src/main/browser/service.ts) and real guest reuse/storage adapters. Extend these paths instead of building a second Windows extension or importing a Node-only provider into browser code.

### Source-backed manual cloud parity

The [macOS README](../../../chrome-extension/README.md), lines 48–63, and [saved processing selection](../../../chrome-extension/docs/processing-selection.md), lines 8–24 and 49–63, describe direct manual Start under the app's saved cloud selection plus a separate app-review handoff. Manual Start uses the signed-in app account's allowance without a mandatory GUI handoff or extra per-video Chrome confirmation. Selecting cloud does not authorize automatic billed work; account/mode changes require a fresh manual Start.

The existing implementation confirms this distinction:

- [BrowserProcessingBridge](../../../chrome-extension/src/companion/browser-processing-bridge.ts), lines 42–76, reads saved mode and obtains a native-only session bound to UID/session generation. Its Mac executable/Keychain transport is platform-specific; Windows must adapt the trusted DPAPI/native authority rather than copy those paths.
- [Native host](../../../chrome-extension/src/companion/host.ts), lines 440–457, 565–618 and 643–674, constructs the cloud provider, exposes only a negotiated opaque scope, checks current native mode/account against HELLO and dispatches cloud START to its own JobManager.
- [BrowserCloudProvider](../../../chrome-extension/src/companion/browser-cloud-provider.ts), lines 64–109 and 143–193, validates the native account/session, submits canonical YouTube intake, verifies current scope and full timeline, validates/hash-copies vocals, and keeps tokens outside Chrome.
- [Background Start](../../../chrome-extension/src/extension/background.ts), lines 1695–1738, selects `ONLINE_MUSICMUTE`, refuses automatic cloud initiation, binds the confirmation scope and sends the existing three-field native START payload. [Content manual Start](../../../chrome-extension/src/extension/content.ts), lines 787–807, completes that scope handshake after the existing manual click; it does not open an additional per-video confirmation dialog.
- [CloudProcessingProvider.startYouTube](../../../chrome-extension/src/companion/cloud-provider.ts), lines 155–170, currently uses `/media-imports` with `trim_enabled: false`. The older `/imports/youtube` example in the processing-selection document is not the current route to copy; trace the existing API client/current backend contract rather than add or invent a new endpoint.

Local app/Chrome processing remains guest-capable with null captured account scope. A manual cloud request instead captures the current authorized native account/generation internally for that request; the browser cannot select a UID, bearer token, account owner or quota override. Both paths preserve full-timeline playback and the same source/page/peer fences.

### Ordered implementation/review sequence

- [x] Build a Mac-versus-Windows parity table for each public command/capability, content/popup control, preference and recovery path. Include installation guidance, Prepare, progress/cancel, cached reuse, publication/consent, diagnostics/check, budget and playback, with the concrete native adapter for every claimed feature.
- [x] Use a browser-safe host-platform/local-provider helper throughout shared UI/background logic. Validate Windows `win32/x64` and real Ready capabilities before selecting `LOCAL_WINDOWS`; preserve existing Mac HELLO and the legacy page local-intent command. Unsupported/unprepared hosts must not become available from static provider constants.
- [x] Keep the existing manifest/key/store ID and minimal permission/origin scope. Windows executables and registration belong in W26/W31 packaging; browser files remain one shared source and build.
- [x] Read the app's existing DPAPI `processing_mode` through the trusted session authority. Expose only bounded local/cloud selection and a token-free opaque processing scope; never create a browser Firebase token store or reuse a Mac-specific Keychain/account adapter on Windows.
- [x] Preserve the native-only scope of `linkImportVisible`/global-user-country hiding. It changes the desktop source picker; Chrome controls, handoff and processing bridge remain unaffected. Correct untested browser visibility projection/discovery without removing Windows labels or cloud allowance/account checks. See [the scope contract](../../link-import-ui/USER-EXCLUSIONS.md).
- [x] Implement Windows manual `ONLINE_MUSICMUTE` START as parity with the existing native cloud provider: resolve the app's saved cloud mode for each new request, bind the manual action/current HELLO processing scope and original page/peer, and capture the authorized native account/generation. Use the existing account import/client flow and monthly allowance policy without a mandatory app handoff or extra per-video Chrome dialog. Never submit cloud work from auto-start, Prepare, account refresh or reconnect.
- [x] Adapt the native account/session bridge using existing Windows account authority and DPAPI refresh logic. Keep ephemeral session/bearer material inside trusted native processes; expose only bounded provider selection/opaque scope/safe job state/media grants. Revalidate mode and account generation before submission and before/after refresh, completion transfer and publication; sign-out or A→B changes fence old work and require a fresh Start.
- [x] Reuse the current canonical YouTube import flow with `trim_enabled: false` and raw WebSocket full-snapshot completion. Server admission/allowance remains authoritative. Cloud must not require local YouTube extraction, FFmpeg/AAC conversion, source upload, DirectML model readiness or a local GPU lease. Reject ambiguous intake without automatic repetition or provider fallback, cancel only a known authorized remote job, and validate declared source/recipe/duration/hash before protected loopback playback.
- [x] Keep the separate explicit `musicmute-local://cloud` app-review handoff. Allow only video ID and finite eligible duration; no UID, bearer token, rights or billing-confirmation parameters. This action prefills native review without automatically submitting, and it does not replace the saved-cloud manual START/provider route.
- [x] Preserve duration rules exactly: manual ≤1,200 seconds; automatic strictly below the saved 1–20 minute limit, default 20. Existing shorter limits and saved off remain intact. Reuse current loaded-video eligibility/duration; do not add extraction, HTTP or YouTube probe requests just to decide eligibility.
- [x] Wire fresh local processing and verified guest/community reuse to the same full-timeline/model/recipe/source contracts. Cache reuse must compare video identity, duration/timeline, model/recipe and trusted artifact binding. Publication/consent and budget/diagnostics capabilities must use existing real paths or remain explicitly unavailable.
- [x] Complete cache-only local reconnect/reload/service-worker recovery: query a matching existing local job/result and rebind safe media without START, redownload or repeated inference. Local guest browser owners remain null-account scope even when the desktop is signed in. Preserve the existing cloud READY reload refusal and native account/generation fences; reconnect may observe only an already authorized known cloud job and never initiate/rebill cloud work.
- [x] Preserve page/video/frame/generation fences through SPA navigation, player replacement, reload, ads, source changes and native reconnect. A source mismatch revokes old media; same-video player replacement may preserve a valid session. Stop/original selection suppresses auto attempts for that visit.
- [x] Preserve one audible tab, original/voice selection, original mute preference, play/pause/seek/rate synchronization, drift correction, waveform/full timeline and `trim=false`. Close versus Stop remains explicit; no stale old-video voice continues after navigation.
- [x] Finish platform-appropriate popup/content guidance and shared English/Arabic/automatic language, RTL, reduced motion and saved 0–80% transparency. Preserve preferences across extension/platform upgrades; link only reviewed public product destinations, without invented installer URLs.
- [x] Harden bounded disconnect/backoff, listener cleanup and durable state against MV3 service-worker loss/offscreen recovery. Save the minimum safe state rather than relying on background globals or forcing the worker alive indefinitely.

### Required fixture matrix

| Cases                                                                         | Assertions                                                                                                               |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Mac Ready / Windows Ready / Windows Setup needed / unknown host               | Correct local provider/guidance; no unverified feature capability                                                        |
| 1,199.99 / 1,200 / 1,200.01 seconds; saved 5-minute limit and auto off        | Inclusive manual, exclusive auto, old preferences preserved                                                              |
| Saved cloud + signed-in current account + manual Start                        | Existing ONLINE provider/import route runs under native allowance/scope; no mandatory app handoff or extra Chrome dialog |
| Saved cloud + automatic/reconnect/Prepare, or signed-out/changed account      | No new billed import; stale mode/scope is rejected and requires a fresh manual Start                                     |
| App saved cloud/local; native policy false/unknown/account switch             | Native picker obeys policy; Chrome controls/handoff and accepted work remain unchanged                                   |
| Separate explicit cloud handoff                                               | Prefill native review without automatic submission; direct manual cloud capability remains available                     |
| Local READY cache exists but host owner restarted                             | Restore exact matching local media without START or a new job; cloud READY reload remains fenced                         |
| Model/recipe/timeline/source mismatch                                         | Refuse reuse and revoke stale playback rather than silently retiming                                                     |
| A→B SPA, same-video replacement, reload, ad, background tab and native crash  | No stale audio/duplicate work; audible-tab and suppression rules persist                                                 |
| Scope changes while progress/media events arrive                              | Drop stale generation; keep local guest scope null and cloud scope native-captured; expose no credentials                |
| Cloud full-timeline result, mismatched source/hash/duration, ambiguous intake | Validate before media grant; reject mismatch; never automatically reimport, switch provider or rebill                    |
| English/Arabic, transparency limits, reduced motion and keyboard focus        | Shared UI parity and accessible localized labels on both platforms                                                       |

### Code-only validation and deliverables

- [x] Add meaningful platform/HELLO capability and background lifecycle fixtures with fake browser/native/media APIs. Preserve existing Mac regression fixtures; do not make tests pass by declaring missing Windows capabilities available.
- [x] Add manual cloud parity fixtures covering saved mode/HELLO scope handshake, native account refresh/generation/installation fences, quota denial, manual versus automatic intent, existing import/full-snapshot completion, ambiguous response/no retry, bounded known-job cancellation and validated vocal grant publication. Assert no browser token store, local acquisition/model/GPU precondition or compulsory handoff is introduced.
- [x] Run the existing duration/auto/eligibility/playback/generation tests, then full shared extension unit/contract/headless checks, typecheck, lint/format and build from `chrome-extension/`.
- [x] Audit the built manifest identity, permission/origin allowlists, browser-safe dependencies and token-free messages. Build success is not a Windows host/YouTube or Chrome store publication result.
- [x] Deliver the parity table with source path, command/capability, saved state, failure UI and corresponding fixture/native test for each feature. Explicitly record any still-unimplemented bridge in W26/W27 instead of silently reducing parity.

### Deferred Windows and Mac native regression

- [ ] Use the same shared extension package/ID in real Windows Chrome. Test fresh/cached local processing, manual/auto edges, synchronized listening, SPA/ads/reload/offscreen/background/reconnect and host repair.
- [ ] Test real Windows manual saved-cloud Start through the native signed-in account/provider, allowance admission, realtime completion and synchronized validated vocals, including changed-account/quota/cancel failures. Separately verify explicit handoff opens native review without automatic submission. Native hiding leaves Chrome controls/bridge unchanged; automatic/reconnect paths never submit billed work.
- [ ] Exercise guest cache/community consent/diagnostics/check/budget only where the source advertises a functioning bridge, and capture actual behavior for each capability.
- [ ] Record later Mac native regression separately. Passing browser fakes or Windows acceptance cannot establish the installed Mac host/account/playback behavior.

### Primary references and their consequence

- [MV3 service-worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle): workers may terminate and lose globals; use durable safe state and bounded reconnect rather than assuming continuous memory.
- [Chrome native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging): validate sender/origin and expect host-port disconnect; shared identity does not remove platform-specific host registration.

## Required production binding and ownership closure

- [x] Compose the existing account authority/bridge in main using the same
      AccountController, usage and realtime as the UI. Cold Chrome and GUI startup
      converge on one authority; no second token refresh owner.
- [x] Supply approved app/helper hash, size and publisher pins; validate exact
      SID/logon/PID/birth/signed parent and atomically claim expiring one-use
      tickets. Reject duplicate JSON keys and concurrent ticket replay.
- [x] Bind cloud transfers to verified job/grant identity, bytes/hash/full timeline
      without local Prepare/tools/GPU. Bind origin/owner/account-generation media
      grants to actual Library pins and await teardown before retirement.
- [x] Bind guest cache-only recovery to no-network lookup. Negotiated Windows
      STATUS metadata must preserve legacy Mac empty-STATUS grammar. Cache misses
      cannot START, acquire originals, infer or rebill.
- [x] Prove publication ownership through the trusted session: exact owner,
      original browser peer/birth, job, video/source and sealed pair. Same-parent
      identity or guessed UUID is insufficient. Release the exact voice hash only
      after the first validated playback acknowledgement.
- [x] Retain headless authority while accepted work/media/replies exist; personal
      Quit closes personal UI/work. Reap crashed peers by exact identity, drain
      operations/pins, then retire after bounded verified idle.
- [x] Test cold Cloud without Prepare, repeated GUI/Chrome starts, UI Quit during
      transfer/playback, A→B fencing, HELLO versus cache-only calls and reply races.
- [x] Test Mac/Windows false/unknown/changed native visibility: Chrome controls
      and accepted work remain unchanged while the native picker hides.

## Final explicit CHECK/cache/event composition return

- [x] Root Main binds [createWindowsBrowserToolkit](../../../windows-desktop/src/main/browser/toolkit-factory.ts) with actual sealed account-app `pin.sha256`, existing full runtime inspector/shared Storage admission, eligible voices cleanup and existing sanitized diagnostics sink; tracks actual toolkit activity and awaited disposal in headless/update/shutdown fences. Public CHECK uses a dedicated same-class Doctor, never reaps active UI Doctor, and reports components without minting Ready/inference qualification. Portable factory/private/service tests pass and the actual Main call site/activity/disposal plus retryable retained cleanup are reviewed in the ledger. Final combined source checks follow all owners' freeze.

## Completion record

- Source: all nine Chrome command receivers, shared platform/provider/page lifecycle, sole native account/manual cloud/guest reuse/publication/media/cold routing and new explicit toolkit ports/owned fixed offline child; see [the complete command and authority matrix](../evidence/W02-W27-2026-10-09-closure.md).
- Code checks: shared 2306 passed/4 skipped/79 files at 23:48:04 plus typecheck/lint 218/build/format; Desktop55 focused tests/7 files plus tsc/scoped lint/build/2 boundaries. Historical core/Root whole-suite checkpoints are labelled as historical rather than reused over new code.
- Final G04 return: 294/9 receiving and packaging tests, 109/4 hostile-report tests, and whole shared regression 2,329 passed/four existing skips/83 files at 02:37:23; whole TypeScript/lint224/format passed. Desktop staged-assets/Setup/Fleet receiving passed 64/9, with source build and two boundaries. Counts overlap; see [current evidence](../evidence/W27-platform-guidance-and-privacy-2026-10-10.md).
- Unrun: actual Windows host/Chrome/YouTube/GPU/account/R2/audio/UI and installed Mac regression; no release acceptance.
- Combined source return: Root passed 1,764 tests / 205 files at 00:21:56, whole tsc/lint 484/format/build and 2 boundaries. All native acceptance rows remain unchecked.

Check completed items individually and update [TASKS](../TASKS.md) and
[PROGRESS](../PROGRESS.md). Use `code-complete / Windows pending` only when
the required source work and executable code checks are complete; unavailable
native compilation remains explicitly recorded. Do not claim a release from
fixture or source-only proof.

## Coherent source return — 2026-10-10

- [x] Record Root's actual Main/toolkit/activity/positive cleanup/shutdown retry
      composition and the 00:21:56 whole Desktop source checkpoint: 1,764 tests /
      205 files, whole tsc, lint 484, full format, source build and 2 boundaries.
      Shared extension source independently passed 2,306 tests with 4 existing
      skips / 79 files plus typecheck/lint 218/build/format at 23:48:04.
- [ ] Run W34 native/installed/Chrome/GPU/audio acceptance and separately required
      installed Mac regression. Source counts do not establish those results.

See the [complete command and lifetime ledger](../evidence/W02-W27-2026-10-09-closure.md#combined-source-checkpoint-received--2026-10-10-002156-cairo).
Historical source failures and pre-change counts remain dated, not promoted.
