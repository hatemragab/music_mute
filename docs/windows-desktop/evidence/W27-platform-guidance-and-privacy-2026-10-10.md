# W27 shared platform guidance, discovery and privacy return

Reviewed 2026-10-10 on macOS arm64 with installed Node tooling. Source, real
temporary source builds/hashes and synthetic DOM/Chrome transports only. No
browser, Electron, native helper, device, profile, account, model, GPU, network
transfer, installation, release publication or Windows execution was used.

## Receiving behavior

[Popup](../../../chrome-extension/src/extension/popup.ts) passes its actual
`MM_STATUS` HELLO into [guidance](../../../chrome-extension/src/extension/error-guidance.ts).
[Content](../../../chrome-extension/src/extension/content.ts) captures the existing
one-shot status reply and uses the same
[strict local-platform boundary](../../../chrome-extension/src/shared/browser-platform.ts).
Only `darwin/arm64` selects existing Mac language; only `win32/x64` selects
Windows preparation language. Null/unknown/unsupported replies use neutral text;
Windows ARM is never relabeled Apple Silicon. This does not add polling or change
start/cancel/playback/account/cloud authority. Existing manual cloud submission,
separate native review handoff, cooldown/retry behavior and original-sound
restoration remain unchanged.

The pure guidance API's omitted-host default preserves older Mac callers.
Actual browser callers explicitly supply HELLO or null.
[Copied reports](../../../chrome-extension/src/extension/local-error-report.ts)
now pass that same context for current and historical errors; existing bounded
redaction remains. No Windows report directs users to Prepare my Mac. The later
sanitizer return reuses the exact existing native Diagnostics code inventory in
[browser-safe shared codes](../../../chrome-extension/src/shared/diagnostic-codes.ts).
Native Diagnostics imports the same inventory unchanged. Current/history unknown
values become `UNKNOWN_ERROR`; wire code validation stays compatible. At most
fifty records and six fixed own data fields are examined; accessor/hostile proxy/
string-conversion values cannot inject private text or invoke getters. Known Mac/
Windows code guidance remains. No arbitrary uppercase code is copied verbatim.

[Centralized destinations](../../../chrome-extension/src/shared/product-links.ts)
retain the current Mac companion release only for verified Mac context. Windows,
unknown and initial disconnected popup use the reviewed
`https://music-mute.com/#downloads` page and localized **View MusicMute Downloads**.
This is discovery, not a Windows-installer availability claim. `_blank` and
`noopener noreferrer` remain. Static popup fallback is neutral before discovery;
actual Mac received replies preserve the original Mac setup text and destination.

[Privacy](../../../chrome-extension/src/extension/static/privacy.html) and the
[Arabic catalog](../../../chrome-extension/src/extension/translations.ts) now name
the desktop app and both guest stores: macOS Keychain, or Windows current-user
DPAPI-protected storage. The Windows assertion is backed by the existing
[guest credential adapter](../../../windows-desktop/src/main/reuse/guest-credentials.ts)
and current-user `CryptProtectData` native vault. Mac uses the existing
[guest credential store](../../../chrome-extension/src/companion/guest-credentials.ts).
Collection, guest/account/worker boundaries, private R2 grants, release after
actual playback, account-private files, permanent accepted shared results and
no automatic cloud/diagnostic submission promises were preserved. Backend/public
policies and data flows were not edited.

## Executed checks

- `npm test -- tests/i18n.test.ts tests/privacy-disclosure.test.ts
tests/popup-platform.test.ts tests/error-guidance-platform.test.ts
tests/error-guidance.test.ts tests/content-ad-mute.test.ts
tests/product-links.test.ts tests/extension-build.test.ts
tests/chrome-package.test.ts`: **294 passed / 9 files, 02:27:56**.
  Actual imported popup/content/privacy receivers cover Windows/Mac/null/unsupported
  replies, EN/AR and disposal; no native/browser effects. Pure current/historical
  report fixtures and cooldown contexts retain existing flags/semantics. Genuine
  shared source builds and static packaging regressions are included.
- Whole Chrome TypeScript passed. Scoped lint on fourteen changed/relevant files
  passed with zero warnings/errors; scoped formatting passed.
- Whole Chrome `npm test`, **02:28:40**: **2327 passed, 1 failed, 4 skipped /
  83 files**. Sole failure is the unchanged
  `tests/app-setup.test.ts:1262–1270` total-budget/backoff timing fixture (two calls
  versus one, with an unawaited assertion warning). It is outside this return;
  whole Chrome regression is not claimed green.
- Windows actual newly staged shared assets plus Setup/trust/export/shell/
  navigation: **89 passed / 11 files, 02:27:56**. Subsequent actual built-preload→
  production Main ingress→React fixture, Setup/localization/accessibility and
  exact export receiver/fault tests: **56 passed / 7 files, 02:28:40**.
  Counts overlap and are not additive.
- Whole Desktop TypeScript/lint (**510 files**, zero warnings/errors), source
  build and both renderer/preload boundaries passed at this snapshot.

Initial privacy-edit validation found two catalog/static-text mismatches. They
were corrected before the passing receiver/catalog/fallback checks. No failed
intermediate check is represented as success.

### Final sanitizer and whole shared checkpoint

- Shared whole `npm test`: **2329 passed, 4 existing skips / 83 files,
  02:37:23**, 35.82 seconds. Whole Chrome TypeScript, full formatting and full lint
  (**224 files**, zero warnings/errors) passed. The genuine shared source builder/
  default/Store fixtures are included; no Mac native/Swift build was run.
- The earlier backoff failure was investigated. `vi.waitFor` advances fake time
  while real async partial-file cleanup finishes; fixed `29,999ms after observer`
  was not `29,999ms after actual retry registration`. The
  [fixture](../../../chrome-extension/tests/app-setup.test.ts) now anchors its
  before/at boundary to the actually registered 30-second retry and asserts one
  original 20-minute budget. Spy teardown precedes `useRealTimers`, preventing a
  restored fake timer from contaminating subsequent real-time cases. Production
  cap/deadline/retry behavior was unchanged; no timeout increase hides a failure.
- [Hostile copied-report cases](../../../chrome-extension/tests/error-guidance.test.ts),
  current/known Mac/Windows projection and native diagnostics/identity:
  **109 passed / 4 files, 02:37:01**. Uppercase secret-shaped unknown code, object
  coercion, array/field getters and throwing proxy history cannot enter export;
  fifty-row bound/redaction remain and existing wire acceptance is unchanged.
- One initial new sanitizer assertion expected a title in a message-only report.
  It was corrected to the actual known repair message before the final whole
  pass. The intermediate full run also exposed timer-spy teardown contamination;
  the corrected whole pass above supersedes those failed snapshots.
- Latest whole Desktop TypeScript passed; Fleet receiving plus actual fresh
  extension stage/Setup/trust return: **64 passed / 9 files, 02:37:56**. These
  counts overlap earlier receiving checks, not additional Windows proof.

## Deferred

- [ ] Current supported Windows/macOS actual Chrome reply/control/copy/report,
      extension reload and private native pipe behavior.
- [ ] Windows signed package, standard-user installer, actual DPAPI/ACL/Job/GPU,
      Chrome/HKCU/protocol/folder/clipboard/Explorer and real model error.
- [ ] Approved public Windows artifact/Store/release inputs and publication.
- [x] Whole shared Chrome backoff fixture correction, safe copied-code projection
      and whole unit/headless/type/lint/format regression at the final checkpoint.
- [ ] Final whole Windows source regression after all separately owned returns.

The [full shared extension/Setup producer return](W01-G01-shared-extension-setup-source-2026-10-10.md)
and [actual receiving graph](W04-W26-setup-export-receiving-2026-10-10.md) are separate
from native proof. Existing official Zalando compatibility/sanitized-error
preflight applies; no endpoint, raw command shape or processing authority changed.
