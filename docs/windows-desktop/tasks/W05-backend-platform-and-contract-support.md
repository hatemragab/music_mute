# W05 — Add Windows platform and consumer-profile backend support

- Status: code-complete / Windows pending.
- Code dependencies: [W01](W01-inventory-and-build-foundation.md), [W02](W02-shared-core-and-contracts.md).
- Accepted scope points: P10, P11, P19, P26, P27.
- Execution phase: A — implement now once authorized; native checks later.
- Evidence: [original W05 checks](../evidence/W05-backend-platform.md), [final W05/W32 receiving-source and requirement matrix](../evidence/W05-W32-final-source-closure-2026-10-10.md).

A dependency's pending Windows checks do not block this task's code work. Implement real native source now, test portable behavior on the Mac, and retain native checks for W34.

## Existing behavior and design consequence

Auth/device platform types now include Windows compatibly with native mobile,
macOS and web. Windows fleet qualification and consumer-profile targeting retain
existing permission/model/recipe fences. Numeric account-policy gates, signed
consumer app/catalog updates and mobile store release fields remain separate
authorities; none is a shortcut into another principal or publisher.

## Read before editing

- [backend/AGENTS.md](../../../backend/AGENTS.md)
- [backend/src/auth/auth.types.ts](../../../backend/src/auth/auth.types.ts)
- [backend/src/auth/auth.decorators.ts](../../../backend/src/auth/auth.decorators.ts)
- [backend/src/auth/desktop-google-token-exchange.service.ts](../../../backend/src/auth/desktop-google-token-exchange.service.ts)
- [backend/src/worker-fleet/enrollment/worker-enrollment.service.ts](../../../backend/src/worker-fleet/enrollment/worker-enrollment.service.ts)
- [backend/src/worker-fleet/enrollment/user-worker-installation.controller.ts](../../../backend/src/worker-fleet/enrollment/user-worker-installation.controller.ts)
- [backend/src/releases/release.types.ts](../../../backend/src/releases/release.types.ts)
- [docs/realtime-processing-queue/AI-HANDOFF.md](../../../docs/realtime-processing-queue/AI-HANDOFF.md)

Also read [architecture](../ARCHITECTURE.md), [AI handoff](../AI-HANDOFF.md),
[validation](../VALIDATION.md), and the affected component instructions/manifests.

## Implementation checklist

- [x] Trace platform parsing through headers/DTOs, sessions/devices, policy, logging/redaction, realtime tickets and dashboard projections; add windows consistently with backward-compatible defaults for existing clients.
- [x] Define Windows consumer installation/runtime profile fields and capability reporting without relabeling legacy service releases. Preserve worker identity, qualification, admin permission and Google/auth-time fences.
- [x] Audit the existing desktop Google exchange for Windows loopback/public-client configuration. Reuse the route where compatible; keep secrets server-side and reject arbitrary caller-selected client IDs/redirects. List required public/private configuration changes without exposing or changing live secrets.
- [x] Extend desktop release/update capability contracts through the appropriate existing release infrastructure. Keep Android Play-only and iOS/store policies intact; do not resurrect direct APK behavior or require mobile distribution enums for Windows.
- [x] Update OpenAPI/client-contract, raw WebSocket protocol and generated artifacts wherever behavior changes. Follow the API guideline skill before editing contracts.
- [x] Add regression coverage for current macOS/mobile/web/legacy-worker clients and authorization fences; no production deployment or actual worker enrollment in this task.

## Code validation checklist

- [x] Run focused auth/device/policy/enrollment/release unit and isolated HTTP tests with windows and existing platforms.
- [x] Test invalid consumer/service-profile combinations, forged qualification, revoked permission, expired auth, mismatched OAuth redirect/client configuration and stale realtime identity.
- [x] Run affected backend type/lint/build/protocol checks and verify no mobile release-policy regression.

## Windows acceptance — deferred until W34

- [ ] Exercise real Windows Google/email session/device reporting against an authorized deployed backend.
- [ ] Verify native enrollment/report compatibility and consumer-specific update selection without changing legacy service installations.

## Detailed agent execution handoff

### Contract map and sequencing

The implemented Windows platform/profile foundation is the baseline, not permission to publish a release. Re-audit [auth platform types](../../../backend/src/auth/auth.types.ts), [device reporting](../../../backend/src/devices/dto/device-report.dto.ts), [desktop policy](../../../backend/src/app-policy/app-policy.schema.ts), [worker artifact selection](../../../backend/src/worker-fleet/enrollment/worker-installation-artifacts.service.ts), [OpenAPI](../../../backend/openapi.yaml) and [client contract](../../../docs/api/client-contract.md) together. Consumer identity is `platform: windows-amd64` with optional `installationProfile: windows-user`; the catalog key is `windows-amd64-user`. Missing profile preserves legacy behavior. Internal runtime profile and artifact target are different fields; never infer one from a filename or silently route a user package into the service installer.

The surrounding HTTP wire uses `installation_profile`; exact
`signed.metadata.installationProfile` remains camelCase for signature verification.
No casing conversion may alter the signed payload.

- [x] Before a follow-up API edit, enumerate every server DTO/schema, presenter, auth guard, realtime ticket/subscription, client parser and OpenAPI consumer affected by the added platform. Reuse existing route and case conventions; do not rename compatible worker camelCase fields solely to apply generic guidance.
- [x] Verify desktop access/minimum-build selection treats Windows separately while mobile release distribution remains unchanged. Keep Android Play-only, iOS/App Store and existing macOS behavior; `releases/release.types.ts` is not a Windows installer shortcut.
- [x] Preserve the fixed approved Google desktop exchange client. Windows may use its existing public packaged client/config, but callers cannot select an arbitrary client ID, audience or redirect destination. Document configuration names/prerequisites without reading secret values.
- [x] Require a genuine signed consumer catalog entry before artifacts/update grants are available. Test profile/platform/signature/sequence agreement and absent metadata. A missing release is unavailable, never a fabricated URL or service-profile fallback.
- [x] Map auth/device/policy principal scopes explicitly: app account token, installation credential, machine credential and administrator permission are not interchangeable. Worker approval remains a current server decision.

### Faults and code-only proof

Use isolated backend fixtures for Windows/macos/android/ios/web, unknown platform, missing profile, wrong consumer profile, malformed hardware architecture, unsupported OS build, wrong grant principal and owner A/B. Reuse [consumer profile tests](../../../backend/src/worker-fleet/enrollment/windows-consumer-profile.spec.ts), artifact service tests, device DTO tests and desktop Google exchange fixtures. Include report persistence and DTO/presenter round trips rather than only enum membership. Check duplicate request UUID with identical versus different body, stale report revision, revoked installation and consumer/service update crossover.

After authorized changes, run component `pnpm run typecheck`, focused `pnpm test -- <paths>`, lint/build and contract/protocol consistency checks. Use only test-owned Mongo/Redis and synthetic storage/auth. Historical 190 unit / 224 HTTP / 2 persistence results are a checkpoint, not proof that a subsequently dirty tree still passes. Preserve the separately documented stale account/public-page assertions rather than changing unrelated expectations to make Windows tests green.

### Deliverables and later proof

Deliver the exact compatible wire diff, source locations, error examples, absent-catalog behavior and an operator prerequisite checklist. W32 consumes the contract; W14/W23 consume auth/enrollment; W29 consumes signed update identity. W34 later verifies Windows 10 22H2 x64 / Windows 11 x64 device facts and authorized real account/enrollment/catalog behavior. This task must not deploy, change live approval, populate production artifact URLs or claim a published Windows build.

Official preflight refreshed 2026-10-09: [Zalando guidelines](https://opensource.zalando.com/restful-api-guidelines/) for API-first/OpenAPI, endpoint permissions, compatible extensions, method/idempotency semantics and secret-free errors. Apply portable requirements without adding Zalando-specific registries or replacing the repository's established full-snapshot protocol.

## Final desktop version-policy return

- [x] Distinguish numeric Windows account-policy minimum build from signed
      updater semantic app/runtime minimum versions. Define the final packaged
      build identity with W29/W31 and administration/projection with W32.
- [x] Preserve absent/unpublished-target blocking without fabricating an installer
      or reusing the Android/iOS store publisher or private worker artifact grants.

## Completion record

- Implementation files and review: auth platform constants; device DTO/schema; desktop policy schema/access/presenter/service; worker runtime profile and artifact/update DTO/controllers/service; OpenAPI and client/realtime contracts. Profile omission preserves legacy and consumer updates cannot switch to a service target.
- Commands/results and evidence: original 190 unit / 224 isolated HTTP / 2 owned Mongo persistence checks remain dated historical evidence. Current final audit passes 232 + 54 tests across 19 distinct backend unit files, 44 isolated HTTP cases across 7 files, full backend type/lint/format/build, and the dependent dashboard/Windows/product source slices. The final matrix records exact commands, scope and previous unrelated broad-suite fixture failures.
- Unrun native/toolchain checks: real Windows sign-in/session reporting, per-user enrollment and consumer update acceptance remain in W34.
- Remaining limitations and next task: no production catalog, OAuth provider, account approval or release configuration changed. W14/W15/W23/W29 now consume the actual contracts. W32 source/admin/product return is recorded in the final matrix; W31/W34 and separately authorized release actions still own actual provider/catalog/publisher/publication/deployment/native proof. Existing public-page fixture differences remain separately recorded, not rewritten for Windows.

Check completed items individually and update [TASKS](../TASKS.md) and
[PROGRESS](../PROGRESS.md). Use `code-complete / Windows pending` only when
the required source work and executable code checks are complete; unavailable
native compilation remains explicitly recorded. Do not claim a release from
fixture or source-only proof.
