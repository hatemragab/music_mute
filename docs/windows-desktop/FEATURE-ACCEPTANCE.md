# Feature acceptance inventory

This expands the 30 agreed scope points into concrete user journeys. It is a
future verification checklist: these boxes are intentionally unchecked and do not
replace earlier task-level source evidence. Run code simulations during authorized
implementation; defer installed/Windows/browser/live observations to W34.

For the current [Store route](store/MSIX-MIGRATION.md), executable prerequisites
and GUI/Worker code updates come from their independent Store packages. Prepare
verifies installed code and downloads/qualifies model data. Earlier archive/
website-installer wording is historical; it does not authorize executing a
downloaded runtime ZIP or bypassing Store trust. Feature, quality, cancellation,
data-retention and independent-worker outcomes remain required.

For every applicable journey, cover initial/loading/empty/success/error, offline
or lost connection, cancellation/retry, restart recovery and account-owner changes.
Privacy or unsupported states must be visible without exposing secrets or claiming
a capability that the current installation lacks.

## P01 — Desktop shell

Owner tasks: [W01](tasks/W01-inventory-and-build-foundation.md), [W02](tasks/W02-shared-core-and-contracts.md), [W04](tasks/W04-electron-shell-and-navigation.md). Behavior reference: [MusicMuteLocal.swift](../../chrome-extension/macos/MusicMuteLocal.swift).

- [ ] Navigate between Home, Library, Account, Setup, Worker, Diagnostics and Settings; preserve intended last-section behavior.
- [ ] Open signed-out Home with immediate local import plus direct email and Google entry.
- [ ] Load packaged UI only; keep shell/navigation errors visible and renderer authority narrow.

## P02 — Shared architecture

Owner tasks: [W02](tasks/W02-shared-core-and-contracts.md), [W03](tasks/W03-windows-native-security-adapters.md). Behavior reference: [desktop-protocol.ts](../../chrome-extension/src/shared/desktop-protocol.ts).

- [ ] Build shared domain and protocol code from source once, with explicit Mac and Windows adapters.
- [ ] Keep renderer, browser and trusted native/session contracts separate and validated.
- [ ] Preserve the legacy Windows machine-service and existing Mac behavior while adding the consumer profile.

## P03 — Windows and GPU support

Owner tasks: [W01](tasks/W01-inventory-and-build-foundation.md), [W07](tasks/W07-directml-selection-and-qualification.md), [W34](tasks/W34-connected-windows-acceptance.md). Behavior reference: [provider_adapter.py](../../worker/engine/musicmute_engine/provider_adapter.py).

- [ ] Accept native x64 Windows 10 22H2/build 19045 and Windows 11; refuse earlier Windows, x86 and ARM/emulated hosts.
- [ ] Automatically discover and qualify a physical DirectML GPU with the actual model; never silently infer on CPU.
- [ ] Explain unsupported, busy, device-lost and requalification states without an unmeasured VRAM/support promise.

## P04 — Home and imports

Owner tasks: [W04](tasks/W04-electron-shell-and-navigation.md), [W12](tasks/W12-local-files-and-youtube-processing.md). Behavior reference: [DesktopMediaViews.swift](../../chrome-extension/macos/DesktopMediaViews.swift).

- [ ] Choose/drop supported local audio and audio from supported video; preserve source files and show safe metadata.
- [ ] Review a public YouTube link with explicit rights and saved mode, progress/cancel/retry and the existing 20-minute ceiling.
- [ ] Immediately show preparing playback after submission; changing input clears prior rights confirmation.

## P05 — Automatic Prepare

Owner tasks: [W08](tasks/W08-automatic-prepare-and-repair.md), [W09](tasks/W09-startup-and-readiness-receipts.md). Behavior reference: [app-setup.ts](../../chrome-extension/src/companion/app-setup.ts).

- [ ] Detect absent or stale prerequisites, route to Setup and attempt automatic preparation once with clear stages.
- [ ] Show download/verify/extract/model/qualification/registration progress and disk-space failures.
- [ ] Cancel/retry/repair and recover interruptions with bounded attempts; never label metadata presence alone Ready.

## P06 — Bundled prerequisites

Owner tasks: [W06](tasks/W06-runtime-and-model-package-layout.md), [W08](tasks/W08-automatic-prepare-and-repair.md), [W31](tasks/W31-installer-signing-and-distribution.md). Behavior reference: [setup-updates.md](../../chrome-extension/docs/setup-updates.md).

- [ ] Install pinned Node/Python/FFmpeg/acquisition/model dependencies without user terminal/admin/developer tools.
- [ ] Verify immutable download hashes, size and signed metadata before extraction/activation; resume only the same exact artifact.
- [ ] Preserve runtime/model across normal app replacement; a packaged preseed is distinct from fresh network proof.

## P07 — Fast startup

Owner tasks: [W09](tasks/W09-startup-and-readiness-receipts.md), [W29](tasks/W29-app-runtime-and-model-updates.md). Behavior reference: [ProcessBridge.swift](../../chrome-extension/macos/ProcessBridge.swift).

- [ ] Use authenticated cheap readiness receipts bound to host/runtime/model/GPU identity.
- [ ] Invalidate on update/driver/identity/unsafe-path changes and interrupted setup; explicit repair does full verification.
- [ ] Fast status does not itself authorize inference or claim measured startup speed.

## P08 — Signed-out local use

Owner tasks: [W12](tasks/W12-local-files-and-youtube-processing.md). Behavior reference: [local-provider.ts](../../chrome-extension/src/companion/local-provider.ts).

- [ ] Prepare and process files locally without an account; YouTube network acquisition may still need network.
- [ ] Play/export valid guest artifacts offline and keep guest ownership across app account switches.
- [ ] Local selection stays local if account/cloud/shared services are unavailable.

## P09 — Local/cloud authority

Owner tasks: [W13](tasks/W13-cloud-mode-and-processing-policy.md), [W27](tasks/W27-shared-extension-feature-parity.md). Behavior reference: [browser-processing-bridge.ts](../../chrome-extension/src/companion/browser-processing-bridge.ts).

- [ ] Persist a single explicit desktop processing selection and recheck it at submission.
- [ ] Cloud requires current account/quota/policy and native rights review for native intake; Chrome manual Start uses its existing native scope handshake without an extra per-video dialog. No automatic CPU/cloud fallback.
- [ ] Chrome automatic processing remains local; saved cloud mode requires deliberate manual Start through the trusted account/cloud provider and synchronized browser result. The separate public cloud handoff opens desktop review without paid submission.

## P10 — Complete account

Owner tasks: [W14](tasks/W14-complete-account-experience.md). Behavior reference: [DesktopAccountView.swift](../../chrome-extension/macos/DesktopAccountView.swift).

- [ ] Google browser OAuth, email sign-in/sign-up, reset, email verification/recheck and resend cooldown.
- [ ] Restore/reconnect securely; linked methods, add/unlink email where permitted and recent-authentication checks.
- [ ] Device history/hide, sign out here/everywhere, account deletion/recovery and truthful recovery deadline states.

## P11 — Usage and policy

Owner tasks: [W15](tasks/W15-usage-policy-and-realtime.md), [W32](tasks/W32-dashboard-and-cross-product-integration.md). Behavior reference: [account-realtime.ts](../../chrome-extension/src/companion/account-realtime.ts).

- [ ] Show used/limit seconds, percentage/remaining/reset with accessible text; distinguish authentication from Library/sync connectivity.
- [ ] Apply full-snapshot policy and native-only link-import visibility without cancellation; Chrome controls/processing remain unchanged by native hiding.
- [ ] Reconnect/gap recovery and stale-state handling use existing WebSockets; no status polling.

## P12 — Complete Library

Owner tasks: [W16](tasks/W16-complete-library-and-metadata.md). Behavior reference: [DesktopMediaViews.swift](../../chrome-extension/macos/DesktopMediaViews.swift).

- [ ] Merge guest local and authorized account entries with titles, sanitized thumbnails, durations, source and availability.
- [ ] All/Most Played/starred, search, existing sorts and All/Offline/Online/Removed filters; visible count and pagination.
- [ ] Star/unstar, hide/restore, rename and authorized account deletion with confirmations and owner fences.
- [ ] Keep offline, play original/voice, export and native share; unavailable copies must not pretend to be playable.

## P13 — Listening history

Owner tasks: [W17](tasks/W17-listening-history-and-counts.md). Behavior reference: [DesktopListening.swift](../../chrome-extension/macos/DesktopListening.swift).

- [ ] Count genuine playback starts and eligible repeat/AB sessions once; do not count seeks, buffers or source switches twice.
- [ ] Use device/installation/owner-scoped history and alias reconciliation for local/account references.
- [ ] Expose clear/recovery for corrupt/future history without stopping valid local playback.

## P14 — Player and queue

Owner tasks: [W18](tasks/W18-player-and-playback-queue.md). Behavior reference: [DesktopMediaViews.swift](../../chrome-extension/macos/DesktopMediaViews.swift).

- [ ] Play/pause/stop/restart/seek, rate, volume and mute with last-audible-volume restoration.
- [ ] Direct original playback and exact original/voice comparison, repeat/shuffle and visible-order queue; valid trimmed voice plays standalone without a comparison map.
- [ ] Play next/add/play/remove/move up/clear queue; Now Playing and Up Next show friendly titles/artwork.
- [ ] Preparing/error/retry/cancel/empty states and duplicate Next/ended protection preserve reliable playback.

## P15 — Advanced listening

Owner tasks: [W19](tasks/W19-advanced-listening-features.md). Behavior reference: [DesktopListening.swift](../../chrome-extension/macos/DesktopListening.swift).

- [ ] Sleep timer presets/custom/cancel with Mac different-track cancellation; AB start/end/clear and bookmarks add/go/remove with saved owner/media coordinate scope.
- [ ] Silence skip toggle/settings use bounded owned CPU analysis and do not mutate the original artifact.
- [ ] Trimmed voice uses validated retained-sample maps; seeking, markers and original/voice switches never use guessed proportional timing.

## P16 — Background saving

Owner tasks: [W20](tasks/W20-background-account-saving-and-outbox.md). Behavior reference: [sync-outbox.ts](../../chrome-extension/src/companion/sync-outbox.ts).

- [ ] Capture immutable original/result pairs with the submission account identity before automatic saving.
- [ ] Durable progress/retry/auth-required/discard state survives restart and runs independently of playback.
- [ ] Account A work never becomes account B work; guest work requires an explicit new save-to-account action.

## P17 — Verified reuse

Owner tasks: [W21](tasks/W21-verified-cache-and-community-reuse.md). Behavior reference: [youtube-community-provider.ts](../../chrome-extension/src/companion/youtube-community-provider.ts).

- [ ] Try exact local, authorized account and guest community reuse before fresh separation.
- [ ] Validate source/model/recipe/hash/timeline/duration and publication receipts; titles alone never establish equivalence.
- [ ] Optional service failure remains bounded; private files and trimmed full-timeline-incompatible results are not shared publications.

## P18 — Storage

Owner tasks: [W22](tasks/W22-storage-budget-and-cleanup.md). Behavior reference: [cache-budget.ts](../../chrome-extension/src/companion/cache-budget.ts).

- [ ] Use 2 GB default whole-decimal-GB offline-voice budget and bounded 256 MiB pending originals.
- [ ] Show voices/originals/runtime/model/outbox/temporary categories and low-space/deferred-cleanup states.
- [ ] LRU and explicit clear preserve active consumers, sync/update/rollback pins, source files and credentials; report observed reclaimed bytes.

## P19 — Worker onboarding

Owner tasks: [W23](tasks/W23-worker-onboarding-and-eligibility.md). Behavior reference: [DesktopWorker.swift](../../chrome-extension/macos/DesktopWorker.swift).

- [ ] Keep guest local Prepare distinct from fleet participation requiring Google plus administrator eligibility.
- [ ] Qualify real approved runtime/model/fixture and preserve recoverable registration states; no fake enrollment.
- [ ] Expose not-eligible/needs-Google/not-approved/setup/retry/registered states with simple actionable controls.

## P20 — Worker controls

Owner tasks: [W24](tasks/W24-worker-controls-and-saved-intent.md). Behavior reference: [DesktopWorkerView.swift](../../chrome-extension/macos/DesktopWorkerView.swift).

- [ ] Start/pause/drain/resume/stop/restart with explicit local saved intent and backend eligibility reconciliation.
- [ ] Closing the app or logging out of MusicMute does not silently stop the approved fleet worker.
- [ ] Run only in the logged-in Windows session, no admin/service requirement; logout ends owned processes.

## P21 — Worker Advanced

Owner tasks: [W25](tasks/W25-worker-advanced-maintenance.md). Behavior reference: [DesktopWorkerView.swift](../../chrome-extension/macos/DesktopWorkerView.swift).

- [ ] Jobs/history/details, recipe/since filters, filtered logs, health/doctor/full integrity and diagnostics export.
- [ ] Capacity and file benchmarks, recipe/group-size settings and optional owned input/report/audio outputs.
- [ ] App-managed/catalog signed update/check/recover, reviewed force controls, revoke/unpair, uninstall and separately confirmed purge.
- [ ] No benchmark or local preference alone authorizes extra workers or bypasses backend capacity policy.

## P22 — GPU coordination

Owner tasks: [W11](tasks/W11-gpu-admission-and-handover.md), [W25](tasks/W25-worker-advanced-maintenance.md). Behavior reference: [personal-admission.ts](../../worker/src/runtime/personal-admission.ts).

- [ ] Coordinate app personal, Chrome, qualification/benchmark and approved fleet inference through one physical-GPU authority.
- [ ] Finish accepted fleet work before ordinary handover and keep intent separate from temporary yielding.
- [ ] Handle duplicate/stale owners, PID reuse, keeper/consumer death and cross-session contention without premature lease release.

## P23 — Shared Chrome

Owner tasks: [W26](tasks/W26-chrome-native-host-and-registration.md), [W27](tasks/W27-shared-extension-feature-parity.md). Behavior reference: [background.ts](../../chrome-extension/src/extension/background.ts).

- [ ] Use one extension identity and Windows HKCU native registration/repair with fixed signed launchers.
- [ ] Preserve waveform/control, voice/original synchronization, auto duration/disable, transparency/mode and language settings.
- [ ] Recover SPA navigation, page reload, background suspension, host loss and UI closed; validate origin/generation/media capabilities.

## P24 — Preferences/accessibility

Owner tasks: [W28](tasks/W28-preferences-localization-and-accessibility.md). Behavior reference: [DesktopPreferences.swift](../../chrome-extension/macos/DesktopPreferences.swift).

- [ ] System/light/dark, supported accents, text sizes, Automatic/English/Arabic and complete RTL.
- [ ] Default source/mode, player expansion, last-section restoration, listening and automatic update preferences.
- [ ] Windows keyboard/focus/dialog/live-region semantics, responsive scaling, high contrast and reduced motion.

## P25 — Windows lifecycle

Owner tasks: [W04](tasks/W04-electron-shell-and-navigation.md), [W10](tasks/W10-per-user-agent-and-worker-lifetime.md), [W24](tasks/W24-worker-controls-and-saved-intent.md). Behavior reference: [MusicMuteLocal.swift](../../chrome-extension/macos/MusicMuteLocal.swift).

- [ ] Distinguish window close, personal quit, worker Stop, account logout and OS logout.
- [ ] Confirm active personal Prepare/work where needed, wait verified cleanup and preserve Chrome/fleet consumers.
- [ ] Single-instance activation and on-demand session startup work without a tray-only dependency.

## P26 — Backend/dashboard

Owner tasks: [W05](tasks/W05-backend-platform-and-contract-support.md), [W32](tasks/W32-dashboard-and-cross-product-integration.md). Behavior reference: [openapi.yaml](../../backend/openapi.yaml).

- [ ] Windows platform/device/profile/version contracts and approved enrollment work compatibly with existing clients.
- [ ] Dashboard policy/approval/machine/release presentation identifies the consumer profile truthfully.
- [ ] Use existing raw WebSocket full snapshots and compatible HTTP commands/grants; no unrelated mobile/storage-provider changes.

## P27 — Independent updates

Owner tasks: [W29](tasks/W29-app-runtime-and-model-updates.md). Behavior reference: [DesktopUpdater.swift](../../chrome-extension/macos/DesktopUpdater.swift).

- [ ] Distinguish app/runtime/model identities, automatic discovery and explicit install.
- [ ] Verify signed metadata, pinned artifact/publisher trust, replay/version bounds and active-consumer maintenance.
- [ ] Drain accepted work, preserve local/account/outbox/worker state, qualify activation and recover/rollback without old/new authority overlap.

## P28 — Security/diagnostics

Owner tasks: [W03](tasks/W03-windows-native-security-adapters.md), [W30](tasks/W30-diagnostics-and-security-review.md). Behavior reference: [UIJournal.swift](../../chrome-extension/macos/UIJournal.swift).

- [ ] Current-user ACL/vault, sandboxed renderer, validated IPC/pipe peers, fixed child roles and private media grants.
- [ ] Local bounded redacted diagnostics with inspect/export/clear; no new personal remote telemetry.
- [ ] Audit account/fleet separation, OAuth, archives, updater, browser origins and cleanup with negative tests.

## P29 — Distribution

Owner tasks: [W31](tasks/W31-installer-signing-and-distribution.md). Behavior reference: [RELEASING.md](../../worker/RELEASING.md).

- [ ] Website-first signed per-user x64 installer and signed helper inventories with no admin/developer-tool dependency.
- [ ] Preserve runtime/model/data on ordinary replacement; remove only owned registration/startup on normal uninstall.
- [ ] Approved release metadata/URLs/licenses and immutable hashes are required; Store/publication remain separate actions.

## P30 — Acceptance evidence

Owner tasks: [W33](tasks/W33-code-completion-and-native-test-harness.md), [W34](tasks/W34-connected-windows-acceptance.md). Behavior reference: [VALIDATION.md](../../docs/windows-desktop/VALIDATION.md).

- [ ] Finish implementation and available code checks before waiting for the Windows machine.
- [ ] Prepare named native acceptance for OS/GPU/security/Prepare/media/account/Chrome/worker/update/uninstall/accessibility/performance.
- [ ] Mark each native item only after an actual observation on a recorded target/artifact; missing second-OS/GPU coverage stays open.

## Completion rule

W33 checks these journeys against actual production composition and records code
evidence. W34 checks the installed journeys on the supplied Windows target. A
passing fake/native adapter, older macOS installation or legacy Windows service
is not evidence that the new consumer app satisfies a journey.
