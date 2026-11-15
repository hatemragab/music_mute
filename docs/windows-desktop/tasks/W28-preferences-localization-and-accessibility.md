# W28 — Complete preferences, localization and accessibility parity

- Status: code-complete / Windows pending; final composed modal, keyboard, simple-defaults, asset and Storage source audit passed. Native acceptance remains pending.
- Code dependencies: [W04](W04-electron-shell-and-navigation.md), [W14](W14-complete-account-experience.md), [W16](W16-complete-library-and-metadata.md), [W19](W19-advanced-listening-features.md), [W25](W25-worker-advanced-maintenance.md), [W27](W27-shared-extension-feature-parity.md).
- Accepted scope points: P24, P25.
- Execution phase: A — implement now once authorized; native checks later.
- Evidence: [preferences and localization source checkpoint](../evidence/W28-preferences-source.md), [final composed accessibility audit](../evidence/W28-composed-accessibility-2026-10-09.md).

A dependency's pending Windows checks do not block future authorized code work. During implementation write real native source, test portable behavior on the Mac and retain native checks for W34. Current task preparation starts no implementation.

## Existing behavior and design consequence

Parity includes saved behavior and accessibility, not only translated labels. Windows keyboard conventions, high contrast and DPI behavior require native follow-up after code-level coverage.

## Read before editing

- [chrome-extension/macos/DesktopPreferences.swift](../../../chrome-extension/macos/DesktopPreferences.swift)
- [chrome-extension/macos/Resources/en.lproj/Localizable.strings](../../../chrome-extension/macos/Resources/en.lproj/Localizable.strings)
- [chrome-extension/macos/Resources/ar.lproj/Localizable.strings](../../../chrome-extension/macos/Resources/ar.lproj/Localizable.strings)
- [chrome-extension/macos/Resources/GoogleG.svg](../../../chrome-extension/macos/Resources/GoogleG.svg)
- [chrome-extension/macos/Tests/SettingsTests.swift](../../../chrome-extension/macos/Tests/SettingsTests.swift)

Also read [architecture](../ARCHITECTURE.md), [AI handoff](../AI-HANDOFF.md),
[validation](../VALIDATION.md), and the affected component instructions/manifests.

## Implementation checklist

- [x] Implement System/Light/Dark appearance, supported accents, text-size controls and safe preference defaults/migrations. Persist only intended settings, not transient capabilities or account secrets.
- [x] Implement Automatic/English/Arabic language selection, system/browser fallback where appropriate and full RTL for navigation, forms, Library, player, setup and Worker dialogs.
- [x] Port default source/mode, player expansion, last section and existing listening preferences. Keep shared extension versus desktop ownership explicit and avoid conflicting preference stores.
- [x] Implement Windows-appropriate keyboard shortcuts, focus order/restoration, accessible names/live progress, dialog escape handling and disabled-control explanations.
- [x] Support responsive layouts, high DPI/text scaling and high-contrast/reduced-motion settings without clipping controls or hiding account/setup errors. Use current licensed Arabic font assets where needed.
- [x] Centralize product destinations and readable error translations. Preserve recognizable Google branding and avoid implementation jargon in ordinary product flows.
- [x] Review all task UIs for simple defaults; technical logs, GPU IDs, capacity receipts and installation internals remain in Advanced. Final source review includes the later Worker, diagnostics, Storage, update and outbox views; real collapsed visibility/rendering remains W34.

## Code validation checklist

- [x] Run translation-key/plural/fallback completeness checks and headless component tests for RTL, focus, forms and keyboard actions.
- [x] Test preference migrations, corrupt values, account-independent settings and shared-mode authority.
- [x] Perform supported static headless accessibility checks without browser/Electron UI: fourteen composed English/Arabic route cases plus all later modal callers, named semantic controls/password labels and populated queue actions. The final audit covers safe initial focus, busy dismissal, Tab trapping and logical focus return; Windows accessibility scenarios remain open.

## Windows acceptance — deferred until W34

- [ ] Verify Windows screen reader/keyboard operation, high contrast, 100–200%+ scaling, resized windows and real Arabic text rendering.
- [ ] Review all major journeys in English/Arabic, system theme changes and persisted preferences after reinstall/update.

## Detailed execution plan

1. Inventory current macOS visual, import, playback, update and storage preferences.
   Give each one a single authority: desktop appearance/navigation, shared desktop
   processing mode, account-independent listening settings or extension settings.
2. Use versioned validated persistence. Serialize writes and retain corrupt/future
   data for explicit recovery; migration cannot overwrite an unknown schema or
   reset cloud mode to local. Theme/language changes do not revoke account data.
3. Translate every final task UI, including Worker Advanced, storage, diagnostics,
   updates, cloud review and system-dialog text. Translate reason codes through
   the catalog rather than saving already translated strings in durable state.
4. Use logical CSS layout and isolate user titles/URLs in bidi-safe elements.
   Forms retain readable LTR emails/URLs where appropriate. Cover all Arabic plural
   categories and interpolate through text rendering without HTML injection.
5. Define keyboard commands in one dispatcher. Ignore editable fields, repeated
   shortcuts and active modals; a space press on a focused button keeps its normal
   action. Restore dialog initiator focus and focus the new route heading.
6. Show why an action is disabled; announce meaningful progress/errors without
   announcing every playback time tick. Ordinary routes show simple labels;
   native identities and capacity receipts stay in Advanced.

## Final UI closure checklist

- [x] Translate all later-composed Worker/outbox/reuse/update/diagnostics views and
      native dialog labels; re-run translation coverage after their source lands.
- [x] Test switching language/theme while an error, confirmation and progress
      snapshot are visible; no stale-language durable strings remain.
- [x] Confirm default import source, cloud mode, expansion, last section, rate,
      volume/mute and listening settings have documented nonconflicting owners.
- [x] Check all icon buttons, forms, live regions, queue actions and destructive
      dialogs for accessible names, keyboard access and busy-state behavior.
- [x] Verify licensed font/Google assets are included in the source package allowlist and built output with notices,
      and production CSP permits only the necessary local asset types.
      Signed installer inspection and Windows font rendering remain W31/W34.

## Specific code-only fixtures

Preference partial migration, malformed values, unsupported future versions,
explicit reset with retained bad data, serialized writes and interrupted writes;
English/Arabic key and placeholder parity; zero/one/two/few/many/other counts;
RTL directions with long mixed-script titles; keyboard editing/modal exceptions;
modal focus trapping/restoration; meaningful disabled explanations; no unsafe
HTML interpolation or remote font import. Headless semantics and static CSS checks
are available now; Narrator, DPI, contrast and actual Arabic rendering wait for W34.

## Deliverables to review

Validated preference schema/controller/store, translated final views, shortcut and
focus policies, licensed assets, headless checks and the native accessibility
matrix. Existing preferences tests do not imply the later task UIs are complete.

## Named settings actions and shortcut parity

- [x] Centralize Windows chords for New Voice; Home/Library/Account/Setup/
      Diagnostics; play/pause, Next, seek ±10 seconds, voice/original, favorite,
      mute, volume ±, Stop, Check Readiness and text larger/smaller/System reset.
      Render the same dispatcher-backed shortcut list in Settings.
- [x] Test every action, editable/modal/repeat suppression and focused Space
      behavior. Actual Windows key delivery and Narrator remain W34.
- [x] Bind Storage draft/load/retry/save, whole-GB validation, Use Default (2 GB)
      and confirmed Clear Offline Voices to W22's real shared budget/pins. Drafts
      survive incoming snapshots; saving/clearing serialize with writers/pins.
- [x] Clear Offline Voices stops current app playback only; retain active Chrome/
      outbox pins, protected account media, model and diagnostics. Test eligible
      eviction, unavailable state and cancellation, no broad data purge.
      Main source inspection, real temporary-file/pin fixtures and a pre-aborted
      cleanup verify this portable boundary; actual Chrome/Windows coexistence
      remains W34.
- [x] Bind Automatically check for updates, Check for Updates and unconfigured/
      recovery states to W29. Discovery preference never automatically installs
      and does not create a parallel update store.
- [x] Preserve all current text sizes and Reset to System separately from whole
      preference reset. Theme/language/size changes retain mounted form/job/player
      state; real system scaling/licensed Arabic rendering remains W34.

## Completion record

- Implementation files and review: shared modal policy and all eight caller views;
  centralized shortcut dispatcher and three focused W28 regression files; real
  Main-to-Storage shared pins binding, simple defaults, CSP and asset allowlist.
- Commands/results and evidence: [final audit](../evidence/W28-composed-accessibility-2026-10-09.md)
  records 153 focused tests in 19 files, TypeScript, scoped lint/format, source
  build, copied asset byte equality and two built package-boundary fixtures.
- Unrun native/toolchain checks: every Windows acceptance row above, real
  Electron/Chrome/Narrator/DPI/native dialogs and signed installer asset proof.
- Remaining limitations and next task: W34 native accessibility/installation
  matrix. Headless semantics do not prove actual rendering or device operation.

Check completed items individually and update [TASKS](../TASKS.md) and
[PROGRESS](../PROGRESS.md). Use `code-complete / Windows pending` only when
the required source work and executable code checks are complete; unavailable
native compilation remains explicitly recorded. Do not claim a release from
fixture or source-only proof.

## Source continuation — 2026-10-09

See [current UI/account/Chrome evidence](../evidence/W28-W30-W15-ui-integration.md).
The 36-test/nine-file UI checkpoint includes all Arabic plural categories, live
language/theme changes with an open confirmation, drafts, actual keyboard
dispatch/busy suppression, translated stages and recovery navigation. Checked
implementation rows describe source behavior; native DPI/Narrator/Windows
rendering remain unchecked. The [final composed accessibility audit](../evidence/W28-composed-accessibility-2026-10-09.md)
supersedes the remaining source-audit gap: all later modal callers, simple
defaults, shortcut actions, Clear Offline Voices and built asset/CSP checks now
have source or executable portable evidence.
