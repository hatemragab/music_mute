# W28 composed accessibility and simple defaults source audit

Date: 2026-10-09. Validation: portable TypeScript, jsdom React, temporary files
and source build on the Mac. No Electron/browser process, Windows API, screen
reader, GPU, signed installer or live service was exercised.

## Source changes and reviewed behavior

All existing `ModalDialog` callers were reviewed in Account, Library,
preferences, Storage, outbox, updates, Worker Advanced and diagnostics. Their
safe Keep/Cancel action now carries `data-dialog-initial-focus`; every such
action is disabled while its dialog is busy. The shared
[`dialog.tsx`](../../../windows-desktop/src/renderer/dialog.tsx) honors that
marker, traps focus, blocks busy dismissal and returns focus to an enabled,
connected invoker or the logical route heading. It also handles removal of a
focused control and a busy dialog with no enabled controls.

The focus policy follows the current [W3C modal dialog
pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/): focus the safe
choice for an irreversible action and select a logical return target when the
invoker is no longer available. Headless focus assertions do not establish
Windows Narrator or native `<dialog>` behavior.

An actual DOM `KeyboardEvent` regression found that Ctrl+Plus normalization
spread the event into a plain object, losing its non-enumerable `key` property.
[`shortcuts.ts`](../../../windows-desktop/src/renderer/shortcuts.ts) now forwards
the explicit event fields. The regression continues to use the real App keyboard
listener and DOM events, rather than the plain-object shortcut parser fixture.

The simple-defaults review covers the later composed source:

| Surface                    | Source behavior                                                                                                                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker                     | Basic enrollment and saved intent controls remain outside a closed-by-default Advanced disclosure. Technical report filters, identities, capacity and maintenance controls are inside it.                                 |
| Personal processing/player | Processing options and extra playback controls start collapsed. Ordinary states use human-readable progress and error labels.                                                                                             |
| Account/Library            | Forms and repeated row actions have accessible labels; user titles are bidi-isolated. Destructive actions have named confirmations. Technical/device details use disclosures.                                             |
| Diagnostics                | Basic tool checks have readable labels; sanitized report JSON stays behind a details disclosure.                                                                                                                          |
| Storage/updates/outbox     | The 2 GB voice limit, pending-save states, explicit cleanup/install choices and safe confirmations are visible without raw paths, hashes or capability values. Missing runtime/model and recovery states remain explicit. |

The Worker disclosure test checks its closed `open` state and the technical
controls' containment. jsdom does not model real closed-disclosure visibility,
CSS clipping or screen-reader announcement; those remain Windows acceptance.

## Named shortcuts

[`shortcuts.test.ts`](../../../windows-desktop/tests/shortcuts.test.ts) checks
every catalog chord and its Arabic label, size clamping, editable/repeat/meta
suppression and focused-button Space. Existing
[`desktop-shortcuts.test.tsx`](../../../windows-desktop/tests/desktop-shortcuts.test.tsx)
checks actual App dispatch for New Voice, Library, seek, mute, Stop, readiness,
System text reset and suppression while a picker/modal/editable control owns the
action. New
[`w28-shortcut-dispatch.test.tsx`](../../../windows-desktop/tests/w28-shortcut-dispatch.test.tsx)
adds actual route dispatch and heading focus for Home/Account/Prepare/Diagnostics,
play/pause, Next, voice/original, favorite, volume, larger/smaller and global Space.
Text changes preserve the independent preference values.

## Clear Offline Voices production binding

Read-only inspection of
[`main.ts`](../../../windows-desktop/src/main/main.ts) confirms Storage CLEANUP
retires only the desktop playback capability and awaits `player.stop()` before
the real controller command. That branch does not stop Chrome playback. The
storage controller receives the same `library.pins` authority used by the real
Library/media consumers, plus actual consuming-process and owned-tree proof
ports; it is not a separate unprotected cache.

[`storage/controller.ts`](../../../windows-desktop/src/main/storage/controller.ts)
serializes cleanup with cache writers/pins, recovers only eligible partial writes,
checks current reservations, inventories owned files and uses exact file
fingerprints for deletion. The `voices` plan selects eligible, unpinned voice
entries only. Models, runtime, diagnostics, originals, pending outbox copies,
unmanaged files and source/export files are outside that plan. Unpinned cache
copies of account voice jobs can be evicted; protected or currently used copies
remain, and the account job itself is retained. Successful mutation refreshes
the local Library instead of leaving a stale availability label.

Existing real temporary-file fixtures exercise all consuming pin purposes
(playback, export, outbox, processing, download, sync, update), eligible deletion,
open-file deferral, conservative uncertain ownership and unavailable/corrupt
settings. New
[`w28-storage-clear.test.ts`](../../../windows-desktop/tests/w28-storage-clear.test.ts)
uses a pre-aborted cleanup signal and verifies eligible audio, models and
diagnostic files remain, with no success receipt. The composed Storage dialog
also verifies Keep/Escape cancellation issues no cleanup command.

## Assets and renderer boundary

`npm run build` completed. Built files were compared byte-for-byte to their
reviewed source inputs:

| Built file                               |  Bytes | SHA-256                                                            |
| ---------------------------------------- | -----: | ------------------------------------------------------------------ |
| `dist/renderer/fonts/NotoSansArabic.ttf` | 844676 | `63111b5b2e074dd48cc67692e0a2726d86ee94c1c37fe8598257b7b4e87e869e` |
| `dist/licenses/noto_sans_arabic_ofl.txt` |   4381 | `df5143cdf3380169f2d03bf6d2cd243e85621fd097e608c3607cf7f9c9884ae6` |
| `dist/licenses/google_branding.txt`      |    467 | `535cd12ab60ac96018e17b3258321f8fb304dd0c62a66e57adb942b6fc1962ed` |
| `dist/licenses/electron_mit.txt`         |   1096 | `5154e165bd6c2cc0cfbcd8916498c7abab0497923bafcd5cb07673fe8480087d` |

The Noto notice contains the SIL OFL 1.1 and the font copyright. The Google
notice is attribution and branding guidance; it does not assert an open-source
logo license or completed OAuth/branding approval. The recognizable multicolor G
is present beside the account Google action. The packaging allowlist in
[`packaging/config.cjs`](../../../windows-desktop/packaging/config.cjs) includes
`dist/renderer/**/*` and `dist/licenses/**/*`; this is source/build proof, not a
signed installer inspection.

The renderer CSP permits local script/style/font resources, local/data images
and the owned loopback media transport. `connect-src 'none'`, `default-src 'none'`,
`base-uri 'none'` and `frame-ancestors 'none'` preserve the trusted-process
boundary. Two built renderer/preload dependency-boundary fixtures passed.

## Executed checks

- At 22:36:07, the focused 18-file slice passed **149 tests**: the three new W28
  files plus dialog, static accessibility, both existing shortcut suites,
  storage controller/local deletion/view, localization, preferences, player,
  account, Worker Advanced, diagnostics, outbox and Library view tests.
- At 22:36:17, `npx vitest run tests/update-ui.test.tsx` passed **4 tests**.
  Combined focused coverage: **153 tests in 19 files**.
- `npm run typecheck` passed after the new test/source edits.
- Scoped `oxlint --deny-warnings` passed on the eight caller source files and
  three new test files, **11 files with zero warnings/errors**.
- Scoped Prettier check passed on the same 11 files.
- `npm run build` and `npm run test:package-fixtures` passed; the latter ran
  **two built package-boundary fixtures**.
- Intermediate regressions were resolved before this checkpoint: the actual
  Ctrl+Plus event failure was a source bug; the old localization fixture's
  Confirm-first expectation was updated to retain safe Keep focus across live
  language/theme changes. A Home route test now starts on Settings to exercise a
  real route transition rather than assuming focus changes on the same route.

## Deferred proof

All W34 Windows rows remain open: Narrator announcement and reading order, real
keyboard delivery, native dialog/picker focus, high contrast, 100–200%+ DPI,
resizing/clipping, system theme changes, Arabic shaping/font rendering, persisted
preferences across a real reinstall/update, actual Chrome pin coexistence and
the signed installer asset audit. Portable/source evidence closes the source
review only.
