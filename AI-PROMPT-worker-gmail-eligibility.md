# Task: approve automatic Mac worker registration from the dashboard

Google sign-in authorizes the first worker registration. After registration, the worker belongs to the machine and runs independently of the MusicMute account session.

The intended flow: a person signs into MusicMute Local with Google, an administrator sees their account in the dashboard and enables **Allow this account to register worker machines**, and the open Mac app automatically registers and starts that Mac. The machine appears on the Workers page and can take jobs under existing fleet rules. No person handles a pairing code.

After registration, signing out, switching accounts, closing the app, disabling registration permission, or disabling/deleting the registering account does not stop, uninstall, reassign, or revoke the machine. Administrators manage registered machines from Workers. The person can use existing local worker controls.

Implement this in `/Users/hatemragap/work_spaces/music_remover`. Do not commit, push, deploy, publish, or touch production data. Do not read or print dotenv values, Firebase Admin keys, enrollment secrets, or connection strings.

## Read before editing

- Root `AGENTS.md`, `README.md`, and `CLAUDE.md`
- `dashboard/README.md`, its manifest, and any nested `AGENTS.md`
- `backend/README.md`, `backend/AGENTS.md`, and its manifest
- `backend/src/config/` and safe env examples before adding a setting; this task should not need a new env key
- `docs/api/client-contract.md` and `backend/openapi.yaml` before adding a route
- `docs/realtime-processing-queue/AI-HANDOFF.md` and `PROTOCOL.md` before connecting approval updates
- `chrome-extension/AGENTS.md`, `README.md`, its manifest, and `docs/macos-worker-integration.md`
- `chrome-extension/docs/setup-updates.md` for the personal-runtime/fleet-worker boundary

Search existing source and tests before adding helpers. Reuse the existing account, realtime, enrollment, and machine-control architecture.

## Product rules

1. Installing the app or signing in does not by itself register a worker. Every account's registration permission defaults to false, including old documents with no field.
2. The administrator approves the account on user detail. Before registration, this is an account entry, not a registered machine. Do not add a pending-machine approval system.
3. One approved account may register multiple Macs. Each gets its own existing backend-generated machine identity and credential. Email is not the machine identity; do not add hardware fingerprinting.
4. An open, connected Mac app receives approval and starts registration automatically, without another click, reopening the Worker screen, or signing in again. If closed/offline, it checks when next opened and connected. Do not promise installation while the app is closed.
5. First registration installs and starts the worker. Existing qualification, readiness, machine status, policy, slot, and scheduler rules still determine whether it can take a job. Approval does not bypass qualification or guarantee an immediate job.
6. After registration, the machine uses its own credential. Account sessions and registration permission are no longer worker-lifecycle or claim conditions.
7. Turning the account flag off blocks new registrations only. Existing machines are paused, drained, or revoked from Workers. Do not add an account-wide worker kill switch.
8. Registered workers keep running after app sign-out or quit. The existing LaunchAgent starts them at the next login of that macOS user, subject to macOS background-item permission and existing worker rules. This is a per-macOS-user installation, not a system-wide daemon.
9. Personal “On this Mac” playback, Prepare, and signed-out local processing remain independent of worker registration.

## Existing worker boundaries

Personal playback uses `~/Library/Application Support/MusicMuteLocal/`. The fleet worker uses `~/Library/Application Support/MusicMuteWorker/` and its per-user LaunchAgent. Preserve the existing shared GPU admission rule.

The Mac app uses the bundled controller, not global npm `mw`. `chrome-extension/scripts/build.mjs` bundles `worker/src/cli/app-control.ts` into `Contents/Resources/worker/controller.js`. `DesktopWorker.swift` launches it with bundled Node and JSONL protocol version 1, one command per process.

The existing `install` schema requires `label` and accepts optional `group_id`, `enrollment_code`, and `new_code`. Keep the schema and credential exchange unchanged. Remove human-facing pairing controls, not the private command parameter.

Preserve these behaviors:

- launchd runs the installed release's `cli/main.js run --config ...`, independently of the GUI bundle.
- The plist has `RunAtLoad: true` and `KeepAlive.SuccessfulExit: false`.
- Keep the support shim at `MusicMuteWorker/bin/mw`. Do not mention Terminal or `mw` in app UI.
- `stop` ends the current service session but leaves the login plist. It does not remove registration.
- `uninstall` without `purge` drains and removes the service/plist while preserving data. It is not a sign-out handler.
- `unpair` revokes the machine credential after backend confirmation. It is not an account-switch handler.
- `install` is not an idempotent status check: it can reject an already active installation. Distinguish installed, preserved-but-uninstalled, interrupted, and fresh setup.
- The installer writes the secret to a private `enrollment.credential` recovery file and removes it after successful finalization. Preserve recovery. “Memory-only” below applies to Swift, not an invented promise about the unchanged installer.

Do not edit `worker/src/**`, `worker/tests/**`, or `worker/package.json`. This includes CLI, enrollment client, runtime, platform installers, JSONL protocol, supervisor, and plist writer. Do not rewrite these in Swift.

## Backend

### Registration permission

Add `workerRegistrationAllowed` to the existing user schema: required Boolean, default false. Missing means false. Do not call it `workerEligible`: this is registration permission, not ongoing worker eligibility.

Do not migrate all users or add another user collection. Declare necessary schema/index changes through registered Mongoose models. Add no index without a shipped query requiring it.

Expose the saved value in both `GET /admin/users/:id` and authenticated `GET /users/me`. Update the shared user presenter and Mac decoding without breaking other clients. Use the normal snake_case HTTP serializer: `worker_registration_allowed`.

Add an audited admin mutation following the existing account-restriction pattern:

- permission `users.worker-registration.manage`
- owner and support receive it; viewer and release manager do not
- recent reauthentication, operation ID, expected revision, and required reason
- existing audit/operation receipts record actor and reason
- reject changes for disabled, deleting, or purging accounts
- changing the flag never updates existing machine statuses, credentials, login items, or claims

Do not reuse `workers.enroll` for this switch. Preserve existing backend enrollment APIs and permission strings for compatibility; remove their human pairing UI.

### Automatic approval delivery

Use the existing authenticated raw WebSocket transport and full-snapshot subscriptions to deliver registration-permission changes. Add a small user-scoped resource such as `worker_registration` if no existing resource fits. Its snapshot reports permission only, never a credential.

Follow the existing resource registry, authorization, collection invalidation, reconnect/resync, and session-generation patterns. A change to `users` invalidates the snapshot. Users observe only their own permission. Update realtime protocol documentation and tests.

Keep the subscription in app account/session coordination, not only the Worker view. Enabling the flag while the app is running and connected must trigger first registration even when another screen is visible. Reconnect receives current state. Reuse the existing session transport; do not create another socket stack.

Use the account response for initial state as appropriate. No timer-driven HTTP polling, Refresh button, or extra background service. Failed checks may offer Retry. Once this Mac is registered, account updates must not register it again or change its lifecycle.

### Silent enrollment credential

Add an authenticated user command, suggested path `POST /users/me/worker-installation`, using the Firebase bearer already sent by `DesktopAuth.api`.

Authorize only when:

- the caller acts for their own user, not an arbitrary supplied user ID or admin impersonation
- `workerRegistrationAllowed === true`
- user status is `active`
- the verified current sign-in provider is `google.com`

Use the verified session provider already exposed by the backend. A linked `providerIds` entry alone does not prove this session used Google. Do not restrict addresses to `@gmail.com`; Google Workspace sign-in qualifies.

Reuse the existing one-use enrollment mechanism. Return the credential and expiry once through the normal wire serializer. Store only its digest in the invitation record. Do not call the admin invitation HTTP route or fabricate an admin actor.

Record `registeredByUserId` on user-created invitations and carry it through enrollment to the machine as informational provenance only. The creator identity is the actual user. Existing invitations/machines keep null provenance. Never attach an existing machine to whoever next signs in or replace provenance after account switching.

Before accepting a new user-originated exchange/activation, recheck the registering account's permission and active status. Coordinate activation with permission changes through existing transaction/fencing patterns so an in-flight new registration cannot bypass permission removal. Preserve legacy invitation behavior and idempotent replies for machines already activated. After activation, this account check no longer applies to that machine.

Rate-limit issuance with the existing Redis limiter. Do not impose one machine per account. Inspect local installation state first: reading status, reopening, reconnecting, or using an already registered Mac must not issue another credential. Serialize setup locally so duplicate events cannot launch overlapping installers.

Resume interrupted installation through existing controller recovery and pending enrollment state. Do not overwrite it with another account's identity or mint a new secret on every retry. If a replacement credential is genuinely required, use the existing supported replacement path after current registration authorization, with no visible code field. Report accurate errors and avoid automatic retry loops.

### Independent machines

Do not add `ownerEligibilityBlocked`, account-based claim checks, account-based uninstall, or account-deletion cascades into registered machines. `registeredByUserId` is an audit reference, not authorization or a required live-account dependency. A missing/deleted registering account must not invalidate the machine credential.

Preserve existing pending/active/paused/draining/revoked statuses, runtime configuration, actual transactional claim enforcement, leases, and pause/drain/revoke semantics. Registration approval never reactivates a paused, draining, or revoked machine.

Update `docs/api/client-contract.md`, `backend/openapi.yaml`, and realtime documentation for the new field, commands, and subscription. Use root-mounted routes and existing snake_case wire format. Do not version the API or add a scheduler.

## Dashboard

On `dashboard/src/features/users/user-detail-page.tsx`, add one switch:

- label: **Allow this account to register worker machines**
- helper: **When this person signs in with Google in MusicMute Local, an open and connected Mac app automatically registers and starts its worker. Turning this off prevents new registrations. Manage machines already registered from Workers.**
- show the saved value, default false
- changes use existing reason-dialog, reauthentication, revision, and operation-receipt patterns
- disabled/deleting/purging accounts cannot change it; explain registration is unavailable without misrepresenting the saved value
- `users.read` can see it; only `users.worker-registration.manage` can change it
- show existing provider information if available, but allow approval before Google sign-in; the registration route enforces the actual session provider

Reuse existing account synchronization to make the person visible in Users. Do not claim the machine is in Workers before enrollment creates it.

Remove Enrollment, `WorkerEnrollmentDialog`, its obsolete UI tests, `worker-enrollment-credential`, “Create invitation,” “Create replacement,” and invitation empty-state instructions. Keep Machines and Policy, status filters, capacity policy, logs, and existing machine controls. Keep machine revocation accessible; if absent from the UI, expose the existing backend revocation operation in machine detail rather than adding account-based revocation.

Identify machines in rows/details. Registration provenance may be informational context, not a gate. Describe the fleet page as managing registered machines. No dashboard screen may display/copy an enrollment secret.

Update `dashboard/src/api/contracts.ts`, `dashboard/src/features/administrators/role-permissions.ts`, `dashboard/src/test/dashboard-fixtures.ts`, and `dashboard/src/api/backend-contract-alignment.test.ts`. Keep the existing English dashboard visual language.

## macOS app

Keep `DesktopWorker` and the bundled controller. Connect registration to existing account/session coordination. Do not shell out to global Node or `mw`.

Remove the pairing setup from `DesktopWorkerView.swift`: “Adopt or pair this Mac,” instructions to pair separately from sign-in, Inspect/Move/Recover setup buttons, label/group/code fields, replacement-code toggle, “Pair and install worker,” and Terminal hints. Remove obsolete localization keys and related pairing error instructions; keep safe error codes and supported retry/help actions.

Inspect local worker state before account permission:

| State                                                         | UI and action                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No registered worker, signed out                              | Show existing Google sign-in and explain administrator approval is needed for first registration. Do not install.                                                                                                                                                       |
| No registered worker, non-Google session                      | Ask the person to use Google for registration. Do not install.                                                                                                                                                                                                          |
| No registered worker, permission false                        | Show “Waiting for administrator approval.” Subscribe for approval; do not install.                                                                                                                                                                                      |
| No registered worker, permission unknown/failed               | Show “Could not check worker registration permission” with Retry. A network failure is not approval.                                                                                                                                                                    |
| Fresh setup, approved active Google session                   | Automatically request the secret, send it only as private `install.enrollment_code`, then ensure startup with `start` and `wait_ready: true`. Release the Swift secret reference after success/failure.                                                                 |
| Interrupted installation                                      | Use existing controller recovery/retry. Do not start another enrollment or expose the secret. Show the actual error if recovery cannot proceed.                                                                                                                         |
| Registered and installed                                      | Show machine status and local controls regardless of account session/permission. No repeated install, new credential, or provenance change.                                                                                                                             |
| Registered data preserved after explicit uninstall            | Show registration is preserved but service is uninstalled. An explicit local Start may restore it with `install` using `label` only, then start. No new account approval or credential; backend machine revocation still applies. Account events must not undo removal. |
| Machine paused/draining/revoked/unhealthy or blocked by macOS | Show accurate machine state and supported actions. Account approval does not override it or silently replace the machine.                                                                                                                                               |

Use a simple label such as `MusicMute Mac`, within the existing 120 UTF-16 limit. Do not require typing a label/group or use email as the machine identifier.

Fence asynchronous pre-install account reads and credential responses against sign-out/account switching: stale results must not start fresh setup for the wrong session. Once handed to the controller, do not tear installation down merely because the GUI signs out; server activation still enforces registration permission. Activated machines are independent of later account events.

For existing installations, sign-out, account switching, permission changes, account disablement/deletion, window closure/hiding, and app quit must not send `stop`, `uninstall`, or `unpair`. This includes legacy code-enrolled machines: no reassignment, deletion, or forced adoption. Preserve local management boundaries for installations not yet managed by the app.

Keep Start, Pause, Drain, Resume, Stop, Restart, and “Open macOS background settings” governed by machine/local installation state, not account permission. Respect Stop: opening a screen, signing in, or receiving approval must not restart an already registered stopped worker. Stop still leaves the login item for the next macOS login. Do not silently reinstall an explicitly removed service.

Show clear copy before and after setup: **This worker keeps running after you sign out or close MusicMute Local. You can stop it on this Mac, or an administrator can disable it from Workers.** Explain that Stop ends processing for this session and the worker may start again at macOS login. Do not describe backend pause/revocation as removal of the Mac's login item.

Add new states and copy to both `en.lproj/Localizable.strings` and `ar.lproj/Localizable.strings`, preserving RTL and accessible Google branding. Do not expose registration permission in the Chrome panel or change personal runtime, Prepare, URL imports, or guest downloads.

Use the existing single LaunchAgent. No second login item, cron, `SMAppService` registration, background poller, or Swift supervisor. macOS background-item permission remains required.

## Credential and data handling

- Swift holds the secret only for the private controller call. No persistence in preferences, app state, UI, diagnostics, or logs, including install JSONL parameters.
- The installer's existing private recovery file is explicitly allowed. Do not remove crash recovery or promise no process writes a secret to disk.
- Admin screens never receive the new user-route secret. Never log request bodies, Firebase tokens, secrets, or digest comparisons.
- Provenance is server-fixed and cannot be supplied/reassigned by clients. It never becomes authorization after activation.
- Existing null-provenance machines keep their identities and controls.
- Do not add email addresses or credentials to diagnostics. Preserve privacy/retention boundaries.

## Tests and validation

Replace obsolete pairing UI assertions and add meaningful tests. Do not weaken existing security, lifecycle, or recovery coverage.

Backend:

- missing/false registration permission blocks issuance; true + active Google session permits it
- password/Apple sessions with linked Google are rejected; Google Workspace sign-in qualifies
- admin roles, reason, reauthentication, revisions, audit, and replay follow existing patterns
- approval snapshots reach only the intended user and update/reconnect without HTTP polling
- permission removal before activation prevents new registration, including concurrent activation
- multiple Macs register with distinct machine identities through one approved account
- flag removal, disabling/deleting/removing the registering account do not alter an activated machine's credential, status, or claim authorization
- actual claim rules, pause/drain/revoke behavior, activation replay, and legacy machines remain intact
- provenance is correct and secrets do not appear in logs

Dashboard:

- no Enrollment tab, invitation dialog, credential display, or code-creation action
- switch defaults off; owner/support can change it with a reason; viewer/release manager cannot
- helper distinguishes new registrations from existing machines
- permission/contract fixtures match new field and mutation
- machine controls remain independent of the registering account

macOS:

- sign-in alone does not install; approval while another screen is visible starts first setup
- opening/reconnecting catches approval received while closed/offline
- duplicate events cause one installation; stale account responses cannot start fresh setup
- installed/stopped machines receive no new install or secret request
- explicit restoration uses label only; interrupted setup uses existing recovery
- sign-out, account switching, flag removal, account unavailability, and quit never stop/uninstall/unpair registered machines
- screen/account events do not undo Stop or explicit service removal
- unknown permission does not authorize fresh setup; failures show accurate retry state
- approval does not override machine pause/revocation
- secret handling, English/Arabic, accessibility, and signed-out personal playback remain correct

Run affected formatters, linters, type checks, focused tests, and builds per component instructions. Use isolated local fixtures for realtime/enrollment integration; never production Atlas, R2, or real accounts. Browser-check switch/reason flow, roles, machine page, and narrow viewport against local fixtures. Fixtures are not live enrollment or admin-login proof.

Do not package a DMG or install a LaunchAgent on the developer machine as proof. Keep tests in allowed backend/dashboard/companion locations; `worker/src/**`, `worker/tests/**`, and `worker/package.json` must have no changes from this task. Report exact commands and that installed-Mac registration/login remains unverified unless separately authorized and executed.

## Acceptance

- Google sign-in makes the person visible in dashboard Users through the existing account flow.
- The administrator enables **Allow this account to register worker machines**.
- The open, connected Mac app automatically registers/starts a fresh worker without another action or visible code; a closed/offline app does so when next opened and connected.
- The machine appears in Workers with its own identity and takes jobs only under existing fleet conditions.
- App quit, sign-out, account switching, and later disabling/deleting the registering account do not stop/remove the registered worker.
- Turning registration permission off blocks new registrations only; existing machines are managed through Workers and local controls.
- One account may register multiple Macs. Existing Macs are never re-registered/reassigned on account change.
- Existing launchd behavior, Stop semantics, machine revocation, and legacy installations remain intact.
- No dashboard/Mac UI exposes a pairing code, invitation, or Terminal worker command.
- Personal “On this Mac” playback still works signed out.

## Out of scope

- Continuous account ownership enforcement, account-based claim fencing/removal, or worker revocation during account deletion
- Separate machine-approval queues, physical-device fingerprints, or new supervisors/schedulers
- `AI-PROMPT-reload-cached-vocals.md` and `AI-PROMPT-guest-po-token-prepare.md`
- Guest YouTube acquisition, cookies, PO tokens, Deno, or yt-dlp changes
- Windows port; preserve existing Windows worker support
- Removing `cli/main.js`, the `mw` package bin, or `bin/mw`
- Version bumps, DMG packaging, installed-service changes, deployment, or publication
