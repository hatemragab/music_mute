# W14 — Implement the complete account and authentication experience

- Status: code-complete / Windows pending (production source and portable checks complete; native/live acceptance deferred).
- Code dependencies: [W03](W03-windows-native-security-adapters.md), [W04](W04-electron-shell-and-navigation.md), [W05](W05-backend-platform-and-contract-support.md).
- Accepted scope points: P10, P28.
- Execution phase: A source implementation and portable checks; W34 native/live acceptance remains deferred.
- Evidence: [W14 trusted account implementation](../evidence/W14-account-core.md).

Checked implementation/code rows refer to actual production entry/source and meaningful portable tests in the [final closure matrix](../evidence/W14-W15-W20-W21-final-source-closure-2026-10-10.md). A dependency's pending Windows proof does not block source work. Every real Windows/live/release acceptance row below remains unchecked.

## Existing behavior and design consequence

The Mac app already has native account workflows and session fences. Copying the web client's storage model would expose desktop refresh credentials and lose native OAuth/worker separation.

## Read before editing

- [chrome-extension/macos/DesktopAuth.swift](../../../chrome-extension/macos/DesktopAuth.swift)
- [chrome-extension/macos/DesktopAccountView.swift](../../../chrome-extension/macos/DesktopAccountView.swift)
- [chrome-extension/macos/DesktopAccountState.swift](../../../chrome-extension/macos/DesktopAccountState.swift)
- [chrome-extension/src/companion/account-state.ts](../../../chrome-extension/src/companion/account-state.ts)
- [backend/src/auth/desktop-google-token-exchange.service.ts](../../../backend/src/auth/desktop-google-token-exchange.service.ts)
- [backend/src/auth/logout.service.ts](../../../backend/src/auth/logout.service.ts)

Also read [architecture](../ARCHITECTURE.md), [AI handoff](../AI-HANDOFF.md),
[validation](../VALIDATION.md), and the affected component instructions/manifests.

## Implementation checklist

- [x] Implement Google sign-in via the system browser, PKCE/state and a bounded loopback callback, using the approved existing backend exchange. Handle timeout/cancel/duplicate callback/wrong state and keep client secrets backend-only.
- [x] Implement email sign-in/sign-up, verification and resend cooldown, password reset, reauthentication and session restore with the same backend/Firebase semantics as macOS.
- [x] Implement linked sign-in methods, account profile/status, current and other devices, logout, logout all devices, deletion and available recovery flows. Preserve confirmation and server-authoritative eligibility for destructive account actions.
- [x] Persist secrets only through the trusted Windows vault and restore them through the main/account broker. Renderer receives safe account presentation data; no refresh/ID token in browser storage, logs or exported diagnostics.
- [x] Fence asynchronous auth, realtime, downloads, playback grants and outboxes on every owner/session-generation change. Clear old account views immediately while retaining account-free local Library/work.
- [x] Handle revoked/expired credentials, offline restoration, temporary vault unavailability, reconnect and partially completed deletion without a sign-in loop or local-processing lockout.
- [x] Keep fleet enrollment credentials separate: MusicMute account signout/logout-all does not silently rewrite or remove a separately enrolled worker unless existing backend policy explicitly revokes it.

## Code validation checklist

- [x] Test all auth reducers and API adapters with fixtures including cooldown timing, wrong/duplicate OAuth state, loopback timeout, vault failure and revoked sessions.
- [x] Test account A→B switches during login, sync, downloads and realtime; assert no old-owner data/token escapes or resurrected session.
- [x] Headless-test forms/accessibility labels and confirmation/error states; do not perform real OAuth/account deletion now.

## Windows acceptance — deferred until W34

- [ ] Run real Google/email/verification/reset/restore/link/device/logout flows on Windows and verify current-user vault behavior.
- [ ] With designated test accounts and authorization, verify account deletion/recovery and account switching while local playback/fleet work remain correctly scoped.

## Detailed agent execution handoff

### Existing authority and production binding

Reuse [AccountController](../../../windows-desktop/src/main/account/account-controller.ts), [OAuth loopback](../../../windows-desktop/src/main/account/google-oauth.ts), [trusted transport](../../../windows-desktop/src/main/account/transport.ts), [HostContext](../../../windows-desktop/src/main/host-context.ts) and the macOS [DesktopAuth](../../../chrome-extension/macos/DesktopAuth.swift)/[Account view](../../../chrome-extension/macos/DesktopAccountView.swift). `AccountView` and typed commands cross the renderer boundary; authorization/session tokens remain in main/native DPAPI. Distinguish Firebase identity, backend session readiness, Library synchronization and fleet registration.

- [x] Audit every command/form against macOS: Google browser sign-in/reauth/link, email signup/sign-in, verification/cooldown, password reset, linked methods, profile/access, devices, current logout/logout-all, deletion and only the existing recovery semantics. Use recognizable localized Google branding; do not invent account merge or deletion-cancel endpoints.
- [x] Bind approved public packaged config, current-SID vault and system browser to main. A missing/unavailable helper/config is explicit; do not replace DPAPI with browser localStorage or a plaintext token file. Passwords may be transient trusted form input, never snapshot/event/diagnostic fields.
- [x] Complete owner-generation propagation into W15 socket/usage, W13 cloud, W16 downloads/playback capabilities, W20 saves and W27 Chrome. Capture original scope before work, abort/fence old generations, clear old views promptly, and retain account-free Windows-user Library and guest work.
- [x] Restore/reconnect once through existing refresh/lookup/backend readiness semantics. Coalesce refresh, distinguish invalid/revoked credential from offline/vault failure, and avoid a repeated sign-in/deletion loop. `dispose` cancels transport/browser work without deleting a valid credential.
- [x] Bind destructive confirmation to the exact account/action. Reauthentication must prove the same UID and current provider/auth-time; refreshing a token alone does not make an old login recent. Preserve a durable sign-out/deletion state so late writes cannot resurrect credentials.
- [x] Keep fleet DPAPI credential namespace and saved intent independent of app logout. Account registration permission controls new enrollment, not an implicit rewrite of an already enrolled worker.

### Invariants and faults

OAuth is a single bounded system-browser/loopback exchange: PKCE S256, unpredictable state, exact callback, one use, timeout/cancel, and listener closure. Test wrong/duplicate state/code, callback after cancellation, malformed/duplicate query, bind failure, browser failure, code exchange outage and A→B during lookup/save. Backend validates the fixed audience/client; a caller-selected client ID is not allowed. Never log callback query/code, bearer, refresh token or transient password.

Test storage read/write/clear failures before and after uncertain credential persistence, expired refresh token, network loss with stored account, deletion pending/deleted, logout-all receipt loss, linked Google method on an email-authenticated session, foreign device/account replies, verification resend rate-limit and reset cooldown at exact boundaries. Test each downstream late callback with the actual production owner-fence adapter rather than only the account reducer.

Portable commands after changes: account controller/OAuth tests, headless account forms, scoped lint/format, `npm run typecheck` and source build. Existing account-core evidence stays checked; the final matrix now maps cross-feature A→B to actual Main fences, cloud/Library/media/outbox/realtime/browser code and meaningful portable faults. That source closure does not substitute for W34 account/native acceptance.

Deliver source/command/view ownership map, public config prerequisites, a secret-field audit and per-flow test evidence. W34 later performs real Google/email/device/logout/link/deletion/recovery with designated accounts on Windows; no live account operation is part of code fixtures.

Official sources refreshed 2026-10-09: [Google installed-app OAuth](https://developers.google.com/identity/protocols/oauth2/native-app) and [Firebase Auth REST](https://firebase.google.com/docs/reference/rest/auth). Check supported browser/loopback exchange and existing refresh/link/email REST semantics against these sources before changing the auth protocol.

## Installation recovery, provider privacy and device semantics

- [x] Preserve one installation UUID through account changes/updates; advance
      metadata revision only when metadata changes. Recover DEVICE_REPORT_CONFLICT
      with prospective owner bearer, bounded device pagination, durable
      `max(local, server)+1` and one retry; cancellation cannot persist stale auth.
- [x] Test corrupt/exhausted revision, repeated cursor, wrong platform, owner
      change and cancelled retry against existing backend/device contracts.
- [x] Password reset gives the same success copy for registered/unknown emails;
      unlink-last-supported-provider is rejected in command authority as well as
      disabled UI. Preserve recent-auth/provider recovery behavior.
- [x] Identify This Windows PC and label other-device Hide from history accurately.
      Hiding history is not remote session revocation or worker removal; test
      these distinct actions/confirmations and owner scopes.

## Completion record

### Immediate retirement source checkpoint — 2026-10-09

- [x] On terminal owner-bound realtime rejection, retire only the exact current
      UID/generation and preserve only existing pending-deletion recovery. Old A
      cannot revoke B; no remote logout or fleet/guest credential mutation.
- [x] Publish null Host/consumer scope synchronously before slow/failing durable
      tombstone/vault/recovery writes. Retain FIFO secret/tombstone cleanup and
      actual busy/shutdown barriers until settlement. Deferred failure and A→B
      tests verify immediate Host/usage/Library fence ports and no late null event
      after B acceptance.
- [x] Finish actual Main cross-consumer ordering audit: start Library/realtime/
      outbox/media fences before unrelated history or uncertain teardown awaits.
      Module fixtures do not close the end-to-end source composition by themselves.

See [retirement source evidence](../evidence/W15-usage-realtime-core.md#presentation-guest-policy-and-terminal-account-retirement).

- Implementation files and review: trusted account/OAuth/transport, paired reviewed-account/session contracts, actual AccountPanel/Main ingress, immediate all-consumer Host fan-out and DPAPI FIFO retirement; W15/W20/W27 use the real account-generation fences.
- Commands/results and evidence: historical 28 account/OAuth and 71/11 Desktop checks remain dated evidence. The final matrix records 312/35 source/composition fixtures plus strict type/lint/build/boundary checks, including new device-repair and reviewed-owner cases.
- Unrun native/toolchain checks: real Windows DPAPI/system browser/Firebase accounts and the W34 login/deletion/recovery matrix remain pending.
- Remaining limitations and next task: actual Windows DPAPI/browser/accounts and authorized live operations remain W34. Signed-in account authority stays distinct from existing fleet registration and account-free local work. No live account/approval/deletion was exercised.

## Final exact-account and consumer-retirement closure

- [x] Capture safe reviewed account ID and session generation at destructive modal open. Main requires both on renderer delete/logout-all/unlink; Controller rejects A→B and same A/new-generation consent before any reauth/network/vault effect. Trusted internal omission remains compatible; absent UI review offers no confirmation.
- [x] Start every current Host consumer fence synchronously even if one listener throws; await all actual cleanup and expose only a fixed transition error. New/reentrant B publication cannot be followed by old A/null fan-out.
- [x] Test foreign-platform/corrupt/exhausted revision, repeated cursor and canceled prospective A device repair after B; no guessed revision, stale bearer retry or old credential write occurs.
- [x] Audit every implementation/code/detailed/device/provider/ordering/deliverable row against the final entry/source/proof/native matrix; all actual Windows/live rows remain open.

Check completed items individually and update [TASKS](../TASKS.md) and
[PROGRESS](../PROGRESS.md). Use `code-complete / Windows pending` only when
the required source work and executable code checks are complete; unavailable
native compilation remains explicitly recorded. Do not claim a release from
fixture or source-only proof.
