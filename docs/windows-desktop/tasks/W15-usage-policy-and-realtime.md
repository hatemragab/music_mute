# W15 — Implement account usage, policy and realtime state

- Status: code-complete / Windows pending (production source and portable checks complete; native/live acceptance deferred).
- Code dependencies: [W13](W13-cloud-mode-and-processing-policy.md), [W14](W14-complete-account-experience.md).
- Accepted scope points: P11, P26.
- Execution phase: A source implementation and portable checks; W34 native/live acceptance remains deferred.
- Evidence: [W15 source and fixture checks](../evidence/W15-usage-realtime-core.md).

Checked implementation/code rows refer to actual production entry/source and meaningful portable tests in the [final closure matrix](../evidence/W14-W15-W20-W21-final-source-closure-2026-10-10.md). A dependency's pending Windows proof does not block source work. Every real Windows/live/release acceptance row below remains unchecked.

## Existing behavior and design consequence

Usage and policy are backend-authoritative. Existing raw WebSocket full snapshots provide live state, including reconnect/authorization fencing; the Windows port must not add periodic status reads.

## Read before editing

- [chrome-extension/src/companion/account-api.ts](../../../chrome-extension/src/companion/account-api.ts)
- [chrome-extension/src/companion/account-realtime.ts](../../../chrome-extension/src/companion/account-realtime.ts)
- [chrome-extension/macos/DesktopAccountState.swift](../../../chrome-extension/macos/DesktopAccountState.swift)
- [docs/realtime-processing-queue/PROTOCOL.md](../../../docs/realtime-processing-queue/PROTOCOL.md)
- [docs/realtime-processing-queue/AI-HANDOFF.md](../../../docs/realtime-processing-queue/AI-HANDOFF.md)

Also read [architecture](../ARCHITECTURE.md), [AI handoff](../AI-HANDOFF.md),
[validation](../VALIDATION.md), and the affected component instructions/manifests.

## Implementation checklist

- [x] Show concise usage percentage, actual used/limit/remaining quantities and reset information with clear loading/unavailable/stale states. Do not expose internal pricing/recipe accounting.
- [x] Port desktop processing access and link-import visibility rules with global/user/country precedence. Keep authentication readiness separate from Library synchronization readiness.
- [x] Subscribe to existing full-snapshot channels for account/jobs/imports as required; handle ticket expiry, reconnect, sequence/generation changes and initial-snapshot readiness.
- [x] Preserve per-job queue rank among eligible waiting jobs in the same recipe; hide stale ranks on disconnect and never present rank as an ETA or account-wide queue position.
- [x] Bound local cached policy/usage data and invalidate it on owner change. Commands must apply the current authority checks, not trust stale UI percentages.
- [x] Report safe connection/recovery and separate Library readiness while keeping local admission independent of quota. Reuse existing reconnect/backoff; no parallel sockets or timer-driven HTTP refresh.

## Code validation checklist

- [x] Replay full-snapshot fixtures with disconnect/reconnect, stale/foreign snapshots, expired tickets, revoked permissions and delayed initial state.
- [x] Test usage arithmetic/formatting/reset boundaries, unavailable policy and old-account cache invalidation.
- [x] Verify queue-rank eligibility and stale hiding; inspect that no forbidden status polling or Refresh control was introduced.

## Windows acceptance — deferred until W34

- [ ] Verify real reconnect/auth-expiry behavior and current usage/policy/queue presentation on Windows.
- [ ] Check local processing remains usable during account/backend outages.

## Detailed agent execution handoff

### Foundation dependency versus completion

The W13 dependency is **protocol/interface readiness**, not a prerequisite completed cloud product. Build this task against W14's trusted account scope/authorization and existing shared transport first. Bind real usage, desktop policy, worker registration and account snapshots, then return to W13 to close authenticated submission/result composition. Do not implement recurring HTTP status reads to bypass an unresolved dependency. Completion needs the actual main consumers and safe recovery/usage presentation, not an injected socket fixture alone.

Source map: [UserRealtimeController](../../../windows-desktop/src/main/realtime/user-realtime.ts), [account usage](../../../windows-desktop/src/main/usage/account-usage.ts), [usage presentation](../../../windows-desktop/src/main/usage/presentation.ts), [queue rank](../../../windows-desktop/src/main/usage/queue-rank.ts), [shared raw transport](../../../chrome-extension/src/companion/account-realtime.ts) and [protocol](../../realtime-processing-queue/PROTOCOL.md).

- [x] Start one account-owned raw socket with the existing HTTP ticket command; use actual account scope and trusted bearer. Share it among usage, Library, cloud and enrollment watchers rather than making one socket per screen.
- [x] Register only supported full-snapshot resources and exact parameters. Apply snapshot only when UID/generation, subscription identity and sequence are current. Replace collections with the authoritative full snapshot; don't splice an obsolete partial update into a new generation.
- [x] On disconnect immediately mark rank/current policy unavailable as required, reconnect with existing bounded backoff, renew ticket when needed and resubscribe for fresh initial snapshots. Distinguish connected transport from each resource's initial-snapshot readiness.
- [x] Propagate realtime processing-policy/worker-registration and optional compatible `app_policy` on the existing policy full snapshot, plus explicit `/app-policy` bootstrap checkout. Separate global app-policy revisions/checkout epochs from processing revisions. Cached A permission cannot enable B; no new socket resource or polling.
- [x] Format usage/remaining/reset information with bounded integer arithmetic and localized units; handle zero allowance, over-limit, unknown denominator, unavailable data and reset timestamps without NaN, overflow or made-up percentages. Keep pricing/recipe internals out of the product UI.
- [x] Keep queue rank per eligible waiting job in the same recipe. Hide stale/ineligible/processing/cancelled rank, never infer ETA or account-wide position. Authentication can be ready while Library is still loading.
- [x] Bind scope cleanup, reconnect/recovery UI and W13 mode commands. Stopping a cloud subscription lease must not close unrelated account watches; signing out closes the entire old-owner transport and cached presentation.

### Tests and proof

Replay duplicate/decreasing sequences, old subscription frames, A→B→A with a new generation, late ticket/fetch/close callback, expired ticket, revocation, malformed oversized snapshot, server error, stalled first snapshot and reconnect subscription recovery. Test Cloud/Library simultaneous leases and one releasing during another's wait. Include usage arithmetic near large integer/reset boundaries and rank disappearing immediately on stale transport. Assert no interval GET/status polling, automatic refetch or Refresh control appears in migrated consumers.

After changes run `tests/realtime-controller.test.ts`, `tests/usage-controller.test.ts`, account receiver and shared transport/provider regressions; then strict typecheck/source build and scoped lint/format. Deliver the channel/parameter/owner matrix and a composed account→transport→policy/usage→cloud fixture. W34 later proves real Windows ticket/auth expiry, dropped network/reconnect and correct user policy/usage/rank against an authorized backend; local processing remains available during optional account outages.

## Explicit policy channels and transport recovery

| Existing authority                 | Resource/read and consumer                                                                                                                                                                                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Processing/link-import policy      | Realtime `policy` full snapshots plus explicit bootstrap/guest checkout; native UI visibility/processing presentation, with Chrome excluded from native hiding.                                                                                                    |
| Verification/platform account gate | Existing `/app-policy` explicit bootstrap plus optional compatible `app_policy` in the established `policy` full snapshot; AccountController verification/numeric minimum build, separate global revision/checkout epoch fences. No new resource or timer polling. |
| Usage/Library/jobs                 | Existing owner-bound raw WebSocket resources; usage allowance, sync readiness and current job/rank full snapshots remain independent.                                                                                                                              |

- [x] Replace ambiguous live-app-policy assumptions with this explicit channel/
      route/consumer inventory and current-source contracts before wiring.
- [x] Support public signed-out policy without Firebase/account configuration
      through approved backend origin. Separate guest/installation/owner caches.
- [x] Test late bootstrap HTTP losing to newer socket snapshot, lower revision
      rejection for one owner and a different owner's lower revision acceptance.
- [x] Test sequence gap → resync → fresh readiness, ping/pong and ready/idle
      watchdogs; terminal authorization rejection stops reconnect and updates
      account UI while guest local work remains available. Rate-limit/service
      failures use existing bounded retry behavior.
- [x] Show actual used/limit seconds, remaining seconds, percentage and reset date
      with an accessible spoken equivalent; percentage alone is insufficient.

## Completion record

### Presentation and retirement continuation — 2026-10-09

`UsagePanel` uses the central English/Arabic catalog, safe shared formatter and
readonly quantities/status/reset/RTL. `createGuestPolicy` uses only the existing
sealed public backend origin and explicit public checkout, with no bearer,
Firebase dependency, guest socket or retry/poll loop. Main's guest fallback is
limited to absent validated account configuration; runtime/session rejection
does not silently downgrade a current account to guest.

Terminal realtime callbacks carry the captured UID/generation to
`AccountController.receiveAuthorizationRejection`. It retires the exact account
scope immediately, holds real persistence activity until settlement and preserves
only existing pending-deletion recovery semantics. W14's null Host scope/listener
fences occur before slow/failed DPAPI writes; old retirement cannot revoke B.
See [current source evidence](../evidence/W15-usage-realtime-core.md#presentation-guest-policy-and-terminal-account-retirement).

- [x] Final Main composition audit: consumer scope fences start before unrelated
      history/media teardown awaits; missing policy hides native link controls,
      Chrome keeps its separate visibility rules, and guest fallback is not an
      account-error recovery path. Genuine Windows/backend behavior remains W34.

- Implementation files and review: trusted realtime/usage modules, safe shared view contracts, account public-policy receiver and compatible shared transport resource validation.
- Commands/results and evidence: historical 52 account/realtime/usage, 134 Desktop and 11 shared transport checks remain dated evidence; the final matrix records current production composition/guest/bootstrap/snapshot/quantity/owner proof and later strict checks.
- Unrun native/toolchain checks: all real Windows/account/backend acceptance remains deferred to W34.
- Remaining limitations and next task: Main/Home/Account/Chrome now bind actual scope/checkout/usage/recovery/mode ports; genuine Windows/backend account/policy/queue behavior remains W34. W13 production cloud uses these same authorities, without a dependency cycle or extra socket/poll.

## Final source closure

- [x] Review every implementation/code/detailed/policy-channel/recovery/presentation/final-ordering row against actual Main, shared transport, guest config, AccountController and consumers in the final matrix.
- [x] Preserve account-error versus configuration-absent guest behavior, global policy revision versus account generation, actual used/limit/remaining/reset and eligible per-recipe rank. Source closure does not claim live backend policy or Windows transport.

Check completed items individually and update [TASKS](../TASKS.md) and
[PROGRESS](../PROGRESS.md). Use `code-complete / Windows pending` only when
the required source work and executable code checks are complete; unavailable
native compilation remains explicitly recorded. Do not claim a release from
fixture or source-only proof.
