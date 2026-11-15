# W04 — Build the desktop shell and safe UI bridge

- Status: code-complete / Windows acceptance pending; native export/Setup/preflight receiving paths are bound and portably checked.
- Code dependencies: [W02](W02-shared-core-and-contracts.md), [W03](W03-windows-native-security-adapters.md).
- Accepted scope points: P01, P04, P25, P28.
- Execution phase: A — implement now once authorized; native checks later.
- Evidence: [final receiving-source/authority/requirement matrix](../evidence/W04-final-shell-source-closure-2026-10-10.md); [historical production checkpoint](../evidence/W04-W18-W27-production-bindings.md).

A dependency's pending Windows checks do not block this task's code work. Implement real native source now, test portable behavior on the Mac, and retain native checks for W34.

## Existing behavior and design consequence

React can reuse product styling and selected presentation patterns, but the Windows desktop needs its own packaged shell, native authority and local workflows. The browser app is not a substitute desktop UI.

## Read before editing

- [chrome-extension/macos/MusicMuteLocal.swift](../../../chrome-extension/macos/MusicMuteLocal.swift)
- [chrome-extension/macos/DesktopWorkspace.swift](../../../chrome-extension/macos/DesktopWorkspace.swift)
- [chrome-extension/macos/DesktopPreferences.swift](../../../chrome-extension/macos/DesktopPreferences.swift)
- [web-client/README.md](../../../web-client/README.md)

Also read [architecture](../ARCHITECTURE.md), [AI handoff](../AI-HANDOFF.md),
[validation](../VALIDATION.md), and the affected component instructions/manifests.

## Implementation checklist

- [x] Build Home, Library, Account, Setup, Worker, Diagnostics and Settings navigation with loading/empty/error states, persistent section selection and clear preparation status. Show signed-out local actions and direct email/Google account entry.
- [x] Load only packaged application assets with sandbox/context isolation, no renderer Node integration, a restrictive content security policy and a narrow typed preload API. Validate sender frame/origin and every argument in main.
- [x] Route file selection, drag/drop and export through trusted capabilities. Do not expose general filesystem, shell, arbitrary URL opening or worker-admin access to the renderer. Signed Main output preflight and exact created-file discard/ACK are bound in the later receiving checkpoint; unknown cleanup remains retained.
- [x] Implement single-instance window activation and safe handling of external navigation. Centralize reviewed product links and use the recognizable Google G with localized accessible text.
- [x] Define close-window versus quit-personal-app behavior and active-personal-work confirmation. Keep the session agent/fleet independent, and do not stop Chrome-owned work because the UI closes.
- [x] Keep tray support optional and nonessential to operation. Display a clear background-work state through the main UI without creating a tray-only dependency.

## Code validation checklist

- [x] Use headless component and reducer tests for navigation, signed-out Home, Setup routing and close/quit decisions without launching Electron.
- [x] Test sender validation, blocked navigation/window creation, unknown IPC methods, unsafe external links and revoked file capabilities. The later [receiving checkpoint](../evidence/W04-W26-setup-export-receiving-2026-10-10.md) passed the broader 182/23 source slice; actual Electron/Win32 enforcement remains below.
- [x] Inspect built renderer/preload bundles for unintended native/server imports and verify secret-free public configuration.

## Windows acceptance — deferred until W34

- [ ] Run packaged UI, single-instance activation, drag/drop, system dialogs, focus and close/quit behavior on Windows.
- [ ] Verify background worker/Chrome operation while the UI is closed and actual Electron sandbox/navigation enforcement.

## Detailed execution plan

1. Compose the trusted main services once per application lifetime and expose
   bounded snapshots through the narrow preload. Each service owns its commands,
   cancellation, subscriptions and cleanup; renderer navigation is not authority.
2. Render Home, Library, Account, Setup, Worker, Diagnostics and Settings with
   truthful initial/loading/empty/error/recovery states. A failed factory must
   produce a visible recoverable state, never an indefinitely opening screen.
3. Keep selected inputs opaque and identity-bound. File selection and rights
   confirmation are separate; changing a file clears confirmation. Export uses a
   trusted destination action and preserves existing files unless explicitly chosen.
4. Give every account-derived async operation its captured UID/generation. On an
   owner change, revoke account media and snapshots; guest local data remains guest.
5. Handle single-instance activation and the public Chrome cloud URI with strict
   parsing. Receiving a public video ID opens review only; it cannot submit a paid
   request, assert rights, choose an account or execute a command.
6. Make close-window, personal quit and explicit Worker Stop separate actions.
   Personal quit waits for its own cleanup without terminating the session fleet
   or Chrome-owned work. Avoid shutdown callbacks that await themselves.
7. Audit subscriptions and pending-operation sets: close/abort/await operations
   in an order that prevents use-after-close of the native helper or vault.

## Composition closure checklist

- [x] Bind real account/usage/Library/history/player/cloud services and recoverable
      failures; verify canonical cloud selection survives missing public config.
- [x] Bind outbox/completion watchers, reuse/publication and storage admission to
      the same artifact pins; do not create separate cleanup authorities.
- [x] Bind worker controls to the verified session agent and its revisioned events,
      with saved fleet intent independent of the personal account controller.
- [x] Bind update, diagnostics and cross-product navigation to narrow IPC methods;
      final UI completeness is required even when core controller tests pass.
- [x] Await in-flight transfers, analysis, exports and state writes during personal
      quit; distinguish abort requested from verified child-tree exit.

## Specific code-only fixtures

| Scenario                                              | Required result                                                              |
| ----------------------------------------------------- | ---------------------------------------------------------------------------- |
| Sender from an iframe, foreign origin or stale window | IPC rejected before side effects.                                            |
| Preparation/service factory throws                    | Localized visible failure and bounded retry; no endless loading.             |
| Sign out during account download/playback             | Account capability revoked, guest content retained, no wrong-owner mutation. |
| Cloud mode saved but config unavailable               | Show blocked cloud mode; do not silently start local work.                   |
| Cloud handoff while app closed/already open           | One public review card; no automatic submission or rights confirmation.      |
| Quit during analysis/export/update callback           | Exact owned cleanup completes without deadlock or forged success.            |
| Renderer requests arbitrary file/URL/shell/worker key | Request refused by typed validation and allowlists.                          |

## Deliverables to review

Main composition/lifetime graph, validated preload contracts, every route's states,
file/export/navigation capabilities, close/quit tests and source bundle audits.
Actual dialogs, protocol registration, Electron enforcement and UI rendering await
W34; headless component tests do not close them.

## Initialization and shutdown integration return

- [x] Track factory initialization as well as IPC/transfers/dialogs/persistence;
      a late-created service cannot escape teardown after Quit starts.
- [x] Seal commands, abort owned work, await operations/pin releases, flush final
      durable writes, then close latest actual native resources. Quit must not
      await its own pending-operation entry.
- [x] Ignore late dialogs after window/owner replacement or shutdown; never create
      destination/input capabilities from stale consent.
- [x] Separate personal UI Quit from whole-authority shutdown. Preserve accepted
      Chrome account services and independent fleet; reopen the same generation.
- [x] Test Quit during initialization, rejected factory recovery, export/write
      failure, late dialog, guest/account pins and repeated headless/UI entry.

Source binding/portable verification checkpoint: [main/player/browser evidence](../evidence/W04-W18-W27-production-bindings.md). Native and remaining feature gates stay open.

## Completion record

- Implementation files and review: Actual Main/preload/React seven-route composition, closed bridge/current sender, navigation-intent coordinator, coalesced/fenced Quit and retained owner cleanup are implemented and source-tested. The later receiving checkpoint binds native signed destination preflight, exact created-file discard/certificate/ACK and real helper-exit retention, plus complete extension/Setup actions. Native-owner source review passed; exact current matrices distinguish portable proof from unrun Win32 behavior.
- Commands/results and evidence: Historical checks remain dated. The later receiving return passed 109/9 and the broader shell/bridge/security/UI slice 182/23; added preflight/export/bridge checks passed 108/seven files at 02:22:32. Whole TypeScript/lint509, owned formatting, source build and two boundaries passed. Counts overlap and do not replace the final W33 full regression. No Windows/Electron/dialog execution is inferred; exact commands and proof boundaries are in the receiving checkpoint.
- Unrun native/toolchain checks: actual supported Windows package/sandbox/URI/file/dialog/focus, current-SID/native peer/ACL/DPAPI/Job/GPU and continuing Chrome/fleet/logon; W34 and real release inputs remain unchecked.
- Remaining limitations and next task: the signed preflight/discard/certificate/ACK receiving return is bound and code-checked. Node path checks and synthetic native transport are not Windows replacement-race proof. Actual W31/W34 and separately authorized provider/backend/release proof remain pending; source completion does not claim installation, signing or public availability. Final combined regression and adjacent feature-specific cleanup audits remain W33/owning tasks.

Check completed items individually and update [TASKS](../TASKS.md) and
[PROGRESS](../PROGRESS.md). Use `code-complete / Windows pending` only when
the required source work and executable code checks are complete; unavailable
native compilation remains explicitly recorded. Do not claim a release from
fixture or source-only proof.
