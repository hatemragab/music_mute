# W04 desktop shell receiving-source closure

Reviewed 2026-10-10 on macOS arm64 with installed Node/component tooling.
This records source, real Node file/byte operations, crypto, headless React and
isolated transport fixtures. No Electron/browser/device app, real system dialog,
Win32 helper, GPU/model, registry/DPAPI/ACL, OAuth/R2/fleet, installer/signing or
publication was executed. Historical checkpoints remain historical.

Current return: W04 source/code is complete. The [later receiving checkpoint](W04-W26-setup-export-receiving-2026-10-10.md) binds signed destination preflight, exact created-export discard/certificate/ACK, actual helper-exit retention and complete Setup controls; native-owner source review passed. The older checkpoints below remain dated. Node before/after path checks and injected transport do not establish Windows replacement-race proof.

## Entry → authority → resource

[Main](../../../windows-desktop/src/main/main.ts) configures sealed packaged
resource trust before hidden modes/native/account entry. The current-SID account
gate precedes single-instance forwarding and Host initialization. Main creates
the actual account, realtime/usage, Prepare, personal, Library/pins, player/history,
cloud, outbox/completion/reuse/publication, worker/session, updater and diagnostics
factories. Recovery may retire/rebind runtime-owned services under their exact
maintenance transaction; navigation never becomes account or worker authority.

The packaged main frame uses [closed commands](../../../windows-desktop/src/shared/contracts.ts)
through [preload](../../../windows-desktop/src/preload/index.ts) and
[production ingress](../../../windows-desktop/src/main/desktop-ipc.ts).
Main checks the captured current sender/frame again before queued effects.
The renderer receives sanitized snapshots and opaque capabilities, not account/
machine tokens, arbitrary URLs, general filesystem/shell access or backend admin
credentials. [DesktopApp](../../../windows-desktop/src/renderer/app.tsx) mounts all
seven routes, live recovery/error states, localized direct account entry,
processing choice, listening and background activity. Read-only navigation remains
available during an owned recovery; processing intake stays fenced.

## Every implementation/code/plan row

Identifiers refer to task row order: implementation I1–I6, code validation V1–V3,
detailed steps D1–D7, composition C1–C5 and initialization/shutdown S1–S5.

| Requirements                                                                                                        | Receiving source / authority / resource invariant                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Meaningful portable proof                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Deferred Windows proof                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| I1, D2, V1 — Home/Library/Account/Setup/Worker/Diagnostics/Settings, signed-out entry, loading/empty/error/recovery | Actual DesktopApp seven-section dispatch, Main `initialization`/per-service unavailable snapshots; signed-out files/local reuse remain separate from account/cloud admission; email and multicolor Google entry route through the same closed Account command                                                                                                                                                                                                                                                                                                                                                                                      | [app](../../../windows-desktop/tests/app.test.tsx), [initialization failure](../../../windows-desktop/tests/initialization-failure-view.test.tsx), [recovery navigation](../../../windows-desktop/tests/recovery-navigation.test.tsx), [localization](../../../windows-desktop/tests/localization.test.tsx), account/Prepare/Library/Worker/Diagnostics/Settings panels; EN/AR failed factories do not open forever or invent retained audio                                                               | Actual packaged layout, focus, accessibility, system browser and supported Windows render                                                  |
| I1, D2 — persistent section and explicit navigation priority                                                        | [SectionStore](../../../windows-desktop/src/main/section-store.ts) reuses its serialized atomic writes; [NavigationIntentCoordinator](../../../windows-desktop/src/main/navigation-intent.ts) owns exact immutable explicit-intent tokens, independent of snapshot sequence. Main records NAVIGATE before write and checks token/current sender before publication; trusted handoff and selected-input Home are explicit intents. Automatic restore/default Home never wins over explicit intent                                                                                                                                                   | [navigation](../../../windows-desktop/tests/navigation-intent.test.ts)/[section store](../../../windows-desktop/tests/section-store.test.ts): unrelated updates, intent before/during read/write, real queued writes, superseded restore, synchronous reentrant publication, failed persistence, invalid section and restore-last-page default versus explicit selection                                                                                                                                   | Real per-user preferences across restart/replacement and disk faults                                                                       |
| I2, V2/V3, D1 — packaged isolation and narrow validated bridge                                                      | BrowserWindow sandbox/contextIsolation/webSecurity, nodeIntegration false; fixed packaged protocol/asset allowlist and restrictive CSP; denies permission requests, new windows and foreign navigation. Frozen typed preload exposes closed actions and removable snapshot subscription; actual ingress rejects unknown/extra fields and foreign/subframe/replaced sender before effects                                                                                                                                                                                                                                                           | [source-built preload → real ingress → actual React DOM](../../../windows-desktop/tests/desktop-ipc-transport.test.tsx), [security](../../../windows-desktop/tests/security.test.ts), [contracts](../../../windows-desktop/tests/contracts.test.ts), [renderer/preload build graph](../../../windows-desktop/scripts/build-boundaries.test.mjs); source inspection of actual BrowserWindow/CSP hooks, sealed package/config fixtures                                                                       | Actual Electron enforcement, ASAR/fuses/sandbox, system dialogs and native signed peer                                                     |
| I3, D3, V2 — input/drag/drop/export capabilities and rights separation                                              | Main uses captured window owner plus [FileCapabilities](../../../windows-desktop/src/main/file-capabilities.ts); preload derives a path only from an actual dropped File. Main validates safe media path, grants one-use identity/expiry-bound input, and rechecks owner after dialog/FD work. File selection does not assert rights. Output consent creates a new exclusive file, never a renderer-selected arbitrary path or overwrite                                                                                                                                                                                                           | [file capabilities](../../../windows-desktop/tests/file-capabilities.test.ts), contracts/ingress, personal/cloud confirmation fixtures; [save destinations](../../../windows-desktop/tests/save-destinations.test.ts), [real Library export](../../../windows-desktop/tests/library-export.test.ts)/[fault matrix](../../../windows-desktop/tests/library-export-fault-matrix.test.ts): wrong owner, expiry/replay, replacement, no source deletion/overwrite, exact bytes/hash and cancelled/late consent | Real native file/drop/Save dialogs, Windows path/reparse/birth/ACL semantics and actual streamed export                                    |
| I4, D5, V2 — single-instance/public URI/external navigation/Google mark                                             | Main account/native singleton and Electron activation restore the existing window. [forwarded entry parser](../../../windows-desktop/src/main/entry-mode.ts) catches malformed/mixed hidden modes before handoff; only UI forwarding activates. [public cloud handoff](../../../windows-desktop/src/main/browser/app-handoff.ts) validates token-free canonical video intent, opens review only, and never submits/chooses account/asserts rights. Product navigation uses fixed destination keys; GoogleMark is the existing multicolor vector/localized accessible action                                                                        | [forwarded modes](../../../windows-desktop/tests/forwarded-entry.test.ts)/[entry grammar](../../../windows-desktop/tests/entry-mode.test.ts), [shared URI compatibility](../../../windows-desktop/tests/windows-app-handoff.test.ts), closed link/contract tests and localization/accessible account fixtures                                                                                                                                                                                              | Actual second-instance/URI registration, signed native browser host, external browser and OAuth                                            |
| I5, D6, C5 — close window versus personal Quit versus Worker Stop                                                   | Main leaves window-all-closed inert; current-SID account/headless services and independent session fleet remain. [ShellLifecycle](../../../windows-desktop/src/main/shell-lifecycle.ts) coalesces Quit through actual cleanup completion, supports legacy void or async quit, and checks original owner before/after confirmation/cancel and before Quit. Main captures exact window/controller/owner/cleanup ports, maintains actual Quit activity, uses actual personal staging busy plus session busy, safe Keep default, and closes only captured current window after settle-all cleanup                                                      | [shell](../../../windows-desktop/tests/shell-lifecycle.test.ts)/[actual UI + ingress late cleanup](../../../windows-desktop/tests/shell-lifecycle-bridge.test.tsx): decline, legacy void, deferred success/failure, replaced window/controller, ownership switch during cancel and actual DesktopPersonal staging without any session event. [desktop personal](../../../windows-desktop/tests/desktop-personal.test.ts): exact own detach/cancel, guest/account capture and STOP_UNCONFIRMED remains busy | Actual dialog/close/quit/logon, protected role Job exit and independently continuing Chrome/fleet                                          |
| C5, D7, S2/S3/S5 — public-output writer/pin/FD lifetime and retained failure                                        | [TrustedSaveDestinations](../../../windows-desktop/src/main/save-destinations.ts) fences one owner synchronously, cancels its work, awaits actual admitted work/finally, then settles every captured exact cleanup. Direct choose, consumed grant writes, claimed streams and report reads are tracked. Main wraps [exportLibraryTrack](../../../windows-desktop/src/main/library/export.ts) in `runOwned` with captured Library/Host/account/window and passes `retainCleanup`; exact source-close is registered before reading, pin release requires positive source-close, all cleanup settles without replacing original fixed operation error | Save/export fixtures: held writer after grant consumed, actual direct export pin finally, raw destination, late dialog A→B, failed close/discard/claim/pin retry, synchronous discard fence, foreign name retained until original birth restored, two cleanups with fast failure plus held sibling, global close retry. Failed resources remain non-idle and reachable; no early successful retirement or path substitution                                                                                | Actual Windows descriptor/durable pin/NTFS failure and signed owner/Job proof; no simulated hardware ACK is claimed                        |
| D7/S5 — bounded completed history, subscriptions and barriers                                                       | Fully retired owner map entries collect only after work/resources/grants/claims/receipts disappear; still-held SaveOwner references retain retired identity weakly, and destination/claim closures keep their original retired state. Failed resources stay strongly reachable. [PendingOperations](../../../windows-desktop/src/main/pending-operations.ts) tracks initialization/commands and settle-all cleanup, with fixed error after every sibling; actual close callback captures controller/owner/playback generation rather than late globals                                                                                             | 300 completed window cycles keep owner history at zero with old consent still denied; retained failure survives 30 unrelated cycles then exact retry collects it. PendingOperations rejection/synchronous throw/held pin and late dialog fixtures; real ingress listener removal and account idle/reopen tests                                                                                                                                                                                             | Actual Electron window churn, file/handle faults, logout and native authority lifetime                                                     |
| I6, C3 — visible background state, optional tray and independent worker                                             | Main projects personal busy, Chrome owners and fleet phase from actual controllers/session events; DesktopApp displays status without any Tray dependency. Worker Stop targets the separate revisioned Session intent and accepted-job drain; personal Quit contains no fleet Stop or cloud server-job cancellation                                                                                                                                                                                                                                                                                                                                | App/worker/session/account-lifetime fixtures and [W23–W29 receiving-source matrix](W23-W24-W25-W29-final-source-closure-2026-10-09.md); source inspection of personal Quit/closed callback and actual background subscription                                                                                                                                                                                                                                                                              | Actual worker/Chrome while UI closed and Windows logout/sleep/resume                                                                       |
| D1/D4, C1/C2/C4 — complete composed consumers and account fences                                                    | Actual Main factories share Host/SID, one account/realtime authority, captured UID/generation, Library artifact/pin authority, durable completion/outbox/reuse/publication and fixed media/session/update/diagnostics ports. Account change synchronously fences consumers; guest state remains independent. No duplicated catalog/downloader or renderer permission shortcut                                                                                                                                                                                                                                                                      | [account/usage/saving/reuse matrix](W14-W15-W20-W21-final-source-closure-2026-10-10.md), [cloud composition](W13-composed-cloud-io-2026-10-09.md), [production integration](W04-W08-W09-W20-W27-integration-2026-10-10.md), actual account/cloud/browser/Library/player/outbox/reuse/worker/update/diagnostics fixtures; [unconfigured cloud](../../../windows-desktop/tests/unconfigured-cloud.test.ts) preserves saved ONLINE choice and denies fallback/paid consent                                    | Actual account/R2/Chrome/GPU/backend and native source operations                                                                          |
| S1/S2/S4/S5, D6/D7 — whole-authority shutdown, independent headless lifetime and retry                              | Actual Main [shutdown coordinator](../../../windows-desktop/src/main/shutdown/coordinator.ts) seals intake, issues cancellation before waiting admitted initialization/commands, re-reads late-created services, awaits descriptor/pin/durable cleanup, proves idle and releases exact captured gates/Host/helpers. Failure retains original authority and a shutdown-only recovery view. Closing command is outside its own pending barrier; accepted Chrome account work prevents idle retirement and reopening keeps generation                                                                                                                 | [shutdown coordinator](../../../windows-desktop/tests/shutdown-coordinator.test.ts), [shutdown UI](../../../windows-desktop/tests/shutdown-view.test.tsx), pending/save cleanup, [account lifetime](../../../windows-desktop/tests/account-lifetime.test.ts), actual Shell/ingress and retained owner fixtures: late factory, failed fence/barrier, failed resource/release retry, no deadlock/forged idle and no replacement owner                                                                        | Actual helper/controller crash, private pipe/native gate, Job Objects, signed peers and logout; portable fake observations remain explicit |

## Specific task scenarios and deliverables

- Foreign/iframe/stale-window requests and arbitrary file/URL/shell/worker-key
  injection: closed contracts plus production ingress/build-boundary fixtures.
- Failed preparation/service factory: actual EN/AR terminal/unavailable/recovery
  panels and shutdown late-created-service handling; no endless opening state.
- Sign-out during account media/download/playback: actual Main scope callbacks,
  immediate Host fan-out and cloud/Library/player/reuse owner-generation fixtures;
  guest content and independent fleet are retained.
- Saved ONLINE with unavailable config: actual unconfigured cloud controller,
  processing choice and guest policy; no silent local fallback or paid submission.
- Public handoff closed/open: strict existing shared URI parser and one review
  card; no automatic submission/rights/account choice. Forwarded hidden grammar
  failures return safely rather than throwing out of the Electron event.
- Quit during analysis/export/update: actual owner ports/barriers and independent
  account authority. Unknown cleanup stays retained; updater/Prepare callback
  settlement avoids self-await and only its exact recovery permission is exposed.

Deliverables are the receiving composition graph above, closed preload/snapshot
contract, seven route state inventory, capability/export/navigation ownership,
coalesced/fenced personal Quit, positive retained cleanup/retry, independent
headless/fleet lifetime and source bundle audit. Adjacent feature matrices provide
their detailed behavior proof; source existence alone did not close these rows.

## Root causes fixed in this return

1. Void/fire-and-forget personal Quit could resolve before cleanup and hide a late
   failure; the actual promise is now awaited through UI/IPC completion.
2. Old modal/controller state could cancel/close a replacement window; fences
   and captured ports are checked across confirmation, cancellation and cleanup.
3. Global snapshot sequence falsely suppressed saved navigation after unrelated
   updates; explicit intent now owns restoration and queued completion priority.
4. Malformed hidden second-instance arguments could escape event handling; the
   actual receiver classifies safely before public handoff/activation.
5. A delayed window-close cleanup could use newer controllers or release its
   barrier after one rejection; captured owners and settle-all cleanup are bound.
6. Retired save consent did not track raw destinations/consumed writes, marked
   discard complete too early and cached rejected releases forever; exact owner
   work/resources now fence, settle, retain failure and retry positive ACK.
7. Source descriptor/pin cleanup could disappear or override the original export
   failure; actual export registers both and keeps pin until confirmed FD close.
8. Retired window metadata could grow forever; positive histories now collect
   without reviving old consent, while failures remain retained.
9. Session busy could lag actual local staging; Quit uses actual controller busy
   and the composed fixture covers that interval before a session event exists.
10. Path-based export discard could remove a replacement between its last
    `lstat` and `unlink`. Production Node unlink is removed. The private adapter
    freezes the exclusive-created UUID/birth/full fingerprint after descriptor
    close and accepts only native completed proof. Pending/error/absent receiver
    retains cleanup; retries reuse the same immutable proof, and positive deletion
    with failed protected-receipt acknowledgment retries only that ACK callback.
    The later receiving checkpoint closes that source return with independent native-owner review; actual Windows execution remains unrun.

## Checks and proof boundary

Commands run from `windows-desktop/`; fake native/account/browser/domain ports
are explicit. Real filesystem tests use only test-owned temporary roots; no user
media, installed app or account/fleet state was changed.

- Focused shell/shutdown/ingress/input/navigation slice: **86 passed / 11 files**,
  00:45:35, before the later export-retirement return.
- Shell/actual UI ingress/navigation/SectionStore: **21 passed / 4 files**,
  00:49:55, before the later staging case.
- Save/direct-export/benchmark/lifecycle/navigation/ingress/shutdown/account
  lifetime/forwarded entry/recovery/initialization slice: **143 passed / 21 files**,
  01:21:32. This precedes the two bounded-history fixtures and staging fixture.
- Latest save/direct-export/shell/actual UI ingress/DesktopPersonal slice:
  **61 passed / 5 files**, 01:24:53, including positive-retirement collection,
  retained failures and actual staging confirmation. Counts overlap, not additive.
- Broader shell/save/export/receiving-source slice: **175 passed / 24 files**,
  01:31:56, before the native-only discard adapter return.
- Native-only adapter/save/direct-export fault slice: **40 passed / 3 files**,
  01:43:41. Covers absent receiver, pending acknowledgment, frozen repeated proof,
  lost positive deletion ACK followed by foreign replacement, external path
  disappearance refusal and retained protected-receipt ACK retry. Its Node
  receiver is explicitly synthetic, not a Windows HANDLE deletion implementation.
- Subsequent combined W04/Advanced slice: **98 passed / 12 files**, 01:45:38,
  plus TypeScript and lint (**499 files**, zero warnings/errors).
- Whole component TypeScript, lint (**496 files**, zero warnings/errors), format,
  source build and both renderer/preload bundle-boundary fixtures passed at their
  recorded current checks. Earlier lint warnings (unsafe-finally and unnecessary
  spread) were fixed; cleanup now settles outside finally while preserving the
  original error. One intermediate TSC RuntimeProof migration error belonged to
  the concurrently owned Prepare module and was fixed before the passing rerun.
- Scoped source/doc diff, formatter and local-reference checks are recorded at
  completion; later global full-suite evidence belongs to its actual checkpoint.

The final W04 change adds no REST endpoint, raw socket schema or public renderer
path/credential. Root public IPC stays closed and compatible. Existing private
resource APIs use strongly typed additive callbacks; HTTP method/naming rules do
not apply to internal owner cleanup. The required official API-guideline preflight
for earlier compatible wire changes remains linked in the adjacent evidence.

## Deferred — never inferred from headless proof

- [ ] Supported Win10 22H2 x64/Win11 x64 packaged routes, dialogs/drop/Save/focus,
      accessibility, single-instance/URI behavior and actual CSP/sandbox/ASAR/fuses.
- [ ] Current-SID DPAPI/ACL/file birth/reparse/descriptor/private-pipe enforcement,
      independent role Job cleanup, signer/peer and physical DirectML execution.
- [ ] Actual continuing shared Chrome/fleet while UI closes, retained account work,
      logout/sleep/relaunch, helper/handle faults, and real accepted export/transfer.
- [ ] Real provider/backend/R2/account/enrollment/release inputs and separately
      authorized native build/signing/installer/publication/deployment.

W04 source/code is complete at the later receiving checkpoint. Every Windows row above remains unchecked; final combined regression and adjacent source/native requirements stay in their owning tasks.
