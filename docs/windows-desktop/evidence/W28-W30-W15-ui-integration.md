# Preferences, account usage and Chrome diagnostics integration

Date: 2026-10-09, Africa/Cairo. These are source and headless/temporary-fixture
checks on the development Mac. No Windows executable, installed app, GPU model,
Chrome browser, OAuth account, Explorer, WinRT UI or production service was tested.

## Production source changes

- Main connects the personal diagnostic journal to the bounded Chrome reporter,
  protected current-SID report registry and actual storage writer admission.
  Chrome receives a sanitized bounded summary and opaque receipt, never the
  private report path. Personal Show report routes known Chrome receipts through
  exact file/hash/birth verification without a failed-verification fallback.
- Reporter initialization is deduplicated and counts as real lifetime/update
  activity. A reporter startup failure leaves the personal journal/Doctor/export
  usable. An explicit later Chrome diagnostic command may retry initialization;
  there is no retry timer, account requirement, model inference or fleet command.
  Quit closes reporter intake before awaiting browser/command teardown and waits
  for initialization and admitted file work before closing the Host.
- Desktop personal submission passes its captured guest/account authority through
  the real session client. Account-scope acknowledgement restarts only the owned
  event subscription; stale acknowledgements cannot reconnect another scope.
  Guest intake remains guest-owned across sign-in. See the separate W12 evidence
  for controller/private-wire fault coverage.
- Home and Account render the existing usage snapshot: used/allowed/remaining
  time, percentage, reset date, stale/loading/unavailable state and separate
  connection/Library readiness. Presentation cannot authorize cloud work and
  offers no status polling or Refresh action.
- Main connects exact-generation realtime authorization rejection to the account
  controller. Missing Firebase configuration can still resolve guest policy from
  an approved packaged HTTPS backend origin and the isolated guest cache. A
  rejected configured account cannot downgrade to a guest checkout.
- Unknown or denied native link policy hides native link intake/handoff controls.
  Existing selected-file local work remains usable. This is UI visibility; shared
  Chrome controls and accepted processing are outside that hiding policy.
- Prepare exposes readonly Check readiness. Personal stages use translated human
  labels and named progress. Action errors retain source keys, so language changes
  retranslate visible errors without replacing the selected file or form draft.
- Custom sleep accepts whole 1–720 minute values, including Arabic/Persian digits,
  through the existing bounded sleep command. Invalid/exponent/fractional values
  cannot start a timer. Player/queue/bookmark titles have bidi isolation.
- Keyboard actions honor pending UI commands, editable fields, repeat suppression,
  focused Space and open modals. Recovery navigation stays available while
  processing is fenced; Quit follows the trusted active-installer/settlement flag.
  Automatic storage inspection waits until safe intake and runs once on mount.

## Preference authorities

| Preference                                                                                                  | Existing owner                                                                       |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Theme, accent, language, text size, default source, expansion, last-page restore, playback rate/volume/mute | Validated DPAPI desktop preferences; restored through Main                           |
| Last selected route                                                                                         | Existing section store, gated by restore-last-page preference                        |
| Local/cloud processing selection                                                                            | Existing cloud-mode vault authority shared with Chrome                               |
| Bookmarks and silence-skip preference                                                                       | Existing owner/track listening store                                                 |
| Current queue, AB endpoints, active timer and playback intent                                               | Ephemeral playback/listening authority; never capabilities in preference persistence |
| Offline budget                                                                                              | Existing shared storage budget/pins; draft is renderer-local until acknowledged      |
| Automatic update discovery                                                                                  | Existing updater preference; does not authorize installation                         |

## Checks actually run

- 20:35:51: affected diagnostic/report/storage/personal/session/UI slice,
  **77 tests passed in 15 files**.
- 20:38:50: full desktop suite, **1,265 tests passed in 162 files**, 31.16 seconds.
  TypeScript, full lint (416 files, no warnings/errors) and source build passed
  for that checkpoint. Two bundle-boundary fixtures passed afterward.
- The full format check initially reported the account controller and localization
  test; their owners formatted those files. Its final result is recorded in the
  progress ledger after completion, rather than inferred from formatting edits.
- 20:43:56: later headless UI subset, **36 tests passed in nine files**: catalog
  completeness/placeholders and all six Arabic plural categories, open-modal
  language/theme/focus preservation, custom sleep/drafts, actual app keyboard
  dispatch and busy suppression, native visibility/file-work preservation,
  readiness, stages, storage and recovery navigation.
- Arabic numeric expectations follow the runtime's Intl numbering system; the
  fixture does not assume every Arabic locale/runtime chooses Eastern digits.
- Root `git diff --check` passed; untracked documentation is checked separately
  for local links, formatting and whitespace.
- The subsequent full format check passed. At 20:47:06, the later playback/
  listening/UI slice passed **69 tests in six files**, including immediate
  account player/queue retirement while accounting teardown is blocked. Main
  starts all scope fences before awaiting any unrelated consumer cleanup.

The full-suite result precedes later account-retirement, volatile readiness
witness and DirectML serialization work. It is not silently extended to those
changes; their owners and the next combined checkpoint provide their evidence.

## Remaining boundaries

Continue the full task/93-journey source audit. W14 immediate scope retirement,
W07/W09 reboot-sensitive qualification and per-session DirectML serialization,
and W03/W31 native sharing/trust/installer closure have separate work/evidence.
Keep native accessibility, DPI/theme/fonts, Windows compiler/CTest/NSIS, actual
GPU/driver execution, Chrome/OAuth/audio/sharing and installed update/logoff
acceptance unchecked in W34. No commit, push, publication, deployment, enrollment
or real-user data deletion occurred.

Internal IPC compatibility/security review reused the
[official Zalando guidelines](https://opensource.zalando.com/restful-api-guidelines/)
preflight: preserve compatible contracts, validate inputs and avoid sensitive
error/event payloads (portable rules 106, 109, 177 and 200). This continuation
adds no REST route or parallel realtime transport.
