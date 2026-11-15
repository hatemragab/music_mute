# W32 — Complete dashboard and cross-product Windows integration

- Status: code-complete / Windows pending.
- Code dependencies: [W05](W05-backend-platform-and-contract-support.md), [W15](W15-usage-policy-and-realtime.md), [W23](W23-worker-onboarding-and-eligibility.md), [W31](W31-installer-signing-and-distribution.md).
- Accepted scope points: P11, P19, P26, P29.
- Execution phase: A — implement now once authorized; native checks later.
- Evidence: [historical dashboard/backend checks](../evidence/W32-dashboard-windows-source.md), [final W05/W32 receiving-source, authority and requirement matrix](../evidence/W05-W32-final-source-closure-2026-10-10.md). Real release/native acceptance remains open.

A dependency's pending Windows checks do not block this task's code work. Implement real native source now, test portable behavior on the Mac, and retain native checks for W34.

## Existing behavior and design consequence

Windows platform, device, enrollment and release visibility must be consistent across backend/admin/product surfaces. Existing mobile Play-only changes and Mac release behavior are unrelated contracts to preserve.

## Read before editing

- [dashboard/README.md](../../../dashboard/README.md)
- [dashboard/package.json](../../../dashboard/package.json)
- [backend/src/releases/release.types.ts](../../../backend/src/releases/release.types.ts)
- [backend/src/worker-fleet/enrollment/worker-enrollment.service.ts](../../../backend/src/worker-fleet/enrollment/worker-enrollment.service.ts)
- [docs/api/client-contract.md](../../../docs/api/client-contract.md)
- [docs/realtime-processing-queue/AI-HANDOFF.md](../../../docs/realtime-processing-queue/AI-HANDOFF.md)
- [web-client/README.md](../../../web-client/README.md)

Also read [architecture](../ARCHITECTURE.md), [AI handoff](../AI-HANDOFF.md),
[validation](../VALIDATION.md), and the affected component instructions/manifests.

## Implementation checklist

- [x] Add Windows labels/filters/details to relevant device, policy, worker qualification/installation and release views with truthful consumer/service-profile distinction.
- [x] Keep enrollment administration and worker permissions restricted to authorized administrators; show selected GPU/qualification facts from trusted reports rather than browser claims.
- [x] Wire Windows release/update configuration through the implemented backend contract, including app/runtime separation and minimum support metadata. Preserve Android Play-only, iOS and macOS policies.
- [x] Use existing raw WebSocket full-snapshot flows on live dashboard screens. Do not add Refresh controls, polling or automatic status refetches.
- [x] Update centralized product discovery/download presentation only where Windows destinations can be supplied from verified release metadata. Before publication, display an honest unavailable/coming-later state rather than an invented URL.
- [x] Update relevant documentation/API examples and add compatibility tests across Windows/macOS/mobile/web/legacy-worker clients. Avoid unrelated UI redesign or exposing private storage/provider links.
- [x] Prepare deployment/configuration prerequisites as a release checklist; do not deploy or alter live flags while implementing.

## Code validation checklist

- [x] Run backend/dashboard focused unit/contract tests for platforms, permissions, release targets and realtime owner/generation fences.
- [x] Run affected type/lint/build checks and translation tests; verify no Android direct-APK behavior returns.
- [x] Test absent/unpublished release metadata and centralized link sanitization, including no credential/tracking parameters.

## Windows acceptance — deferred until W34

- [ ] Verify Windows device/enrollment/update visibility with an authorized real backend/dashboard and actual Windows client.
- [ ] Confirm existing products still receive correct policy/update behavior after an explicitly authorized deployment.

## Detailed agent execution handoff

### Existing product boundaries

Read [dashboard workers](../../../dashboard/src/features/workers/worker-fleet-page.tsx), [worker details](../../../dashboard/src/features/workers/worker-machine-page.tsx), [worker types/API](../../../dashboard/src/features/workers/worker-types.ts), [user registration control](../../../dashboard/src/features/users/worker-registration-section.tsx), [release API/UI](../../../dashboard/src/features/releases/releases-api.ts), [backend release types](../../../backend/src/releases/release.types.ts), [desktop policy schema](../../../backend/src/app-policy/app-policy.schema.ts), [consumer artifact catalog](../../../backend/src/worker-fleet/enrollment/worker-installation-artifacts.service.ts) and [central web product links](../../../web-client/src/product-links.ts). Mobile store distribution, desktop account policy, fleet runtime artifacts and Windows app installer/update metadata are different authorities.

W05 platform/profile contracts can precede packaging. W32 may prepare labels/contracts and absent-target behavior before W31, but cannot close a Windows Download/update journey until genuine signed release metadata and the final W31 publisher/package identity exist. W15 supplies real dashboard/account snapshot semantics; W23 supplies actual enrollment facts. Finish source/contract fixtures first, then return after W29/W31 metadata is fixed; publication/deployment/live flag changes remain separately authorized operations.

- [x] Inventory every platform filter/label/device table, desktop policy editor/preview, installation/qualification details, worker group/machine/capacity/approval and release/update surface. Add Windows with x64/minimum support facts from the approved support matrix. Preserve old/unknown enum fallback without silently converting it into a consumer profile.
- [x] Present `windows-amd64` + `windows-user` as the per-user consumer; omitted Windows profile remains legacy/service compatibility. Distinguish source-reported local GPU evidence, backend qualification outcome and administrator approval. Client strings/benchmarks cannot grant enrollment or capacity.
- [x] Reuse existing administrator guards/permissions/revision/operation-ID fences. No end-user desktop field or platform change grants dashboard permission. One-time invitation/credentials/grants remain protected and are not exported into general tables/CSV/debug views.
- [x] Trace final Windows app/runtime/model/tool metadata through W29/W31 and the implemented backend catalog, with signed profile/sequence/hash/publisher and actual support requirements. Missing or unpublished metadata must produce unavailable/coming-later state. Do not invent a direct installer, worker ZIP-as-app download, new mobile distribution or unsupported update endpoint.
- [x] Preserve Android Play-only required/optional update rules, existing iOS/macOS/native/web contracts and legacy worker omitted-profile behavior. Windows changes must not re-enable direct APK delivery or redesign mobile release selection. Review the full platform DTO/presenter/client chain when extending a shared field.
- [x] Keep raw WebSocket full-snapshot subscriptions on live dashboard screens. Platform filters and cursor pages are scoped subscriptions; delayed response, permission change and filter switch cannot repopulate old data. Do not introduce interval GET, automatic refetch or Refresh controls to make Windows rows appear.
- [x] Centralize Windows discovery in existing product destination/config modules. Only a genuine verified release may supply a direct public installer destination; authenticated private worker artifact/R2 grants never become public product links. Before publication show a truthful unavailable/coming-later state. Preserve HTTPS/no credentials/no tracking/safe external navigation, English/Arabic/RTL and accessible labels.
- [x] Add user-facing Windows/account/worker/version/requirements copy consistently without a UI redesign. Distinguish a configured release, uploaded object, signed installer, published destination, installed client and tested live update in status/evidence.
- [x] Write deployment prerequisites: genuine consumer artifact catalog and signed app metadata, approved OAuth/public config, backend/dashboard compatible schema/version, permissions/CORS/origins, publisher/trust pins and absent-metadata behavior. Record variable names and required operator actions only; do not read secrets or modify production flags/catalogs now.

### Compatibility and failure matrix

Test windows/macos/android/ios/web/legacy/missing/unknown profile through DTO, persistence, presenter, dashboard parser, labels and safe fallback. Include unauthorized admin, wrong installation/machine principal, revoked registration, stale report/operation revision, source-only PASS versus backend approval, pending/active/deleted worker, missing installed GPU evidence and consumer/service artifact crossover.

Test signed release/profile/sequence/hash/publisher mismatch, absent/unpublished/withdrawn target, required minimum build without an available valid target, bad/credential/tracking/expired-grant URL and centralized product link consistency. Assert mobile Play-only policy and no direct-APK behavior regress. Device/customer-reported Windows metadata is not proof of actual architecture/GPU; display server validation status separately.

Use existing worker API/status/registration tests, release-policy tests and backend Windows profile/artifact tests. Add focused dashboard/headless UI and translation/RTL tests for Windows fields; do not fabricate a downloaded/installed Windows app fixture as publication proof. Run backend `pnpm` focused tests/typecheck/lint/build, dashboard `npm` focused tests/typecheck/lint/build and relevant contract/protocol checks after authorized source edits. Existing dirty unrelated Android/default-public-page test differences must be reported rather than rewritten.

### Deliverables and final closure

Deliver complete Windows surface inventory, compatible DTO/OpenAPI/client examples where needed, dashboard labels/filters/details and safe role/qualification distinctions, final app/runtime release-policy routing, centralized validated destinations, absent-target fixtures and operator deployment checklist. Leave final packaging/publication/live verification unchecked until its prerequisites exist and are actually exercised. W34 later verifies a connected actual Windows client against an explicitly authorized backend/dashboard, real enrollment/update visibility and existing-product compatibility after any separately authorized deployment.

## Version-policy and distribution integration return

The final source return includes actual desktop policy administration/live gates,
sealed numeric build identity, independent signed app/catalog activation and rebound
Prepare, Windows/legacy dashboard projections and EN/AR pending public discovery.
The requirement matrix maps every source row to its actual entry/authority and
meaningful fixture. Genuine signing/publication/deployment/Windows acceptance
remains separately unchecked; no installer URL or release input was invented.

- [x] Define final packaged numeric build identity for desktop account
      `minimumBuild` separately from signed updater semantic app/runtime minima.
      Preserve missing-target behavior; never invent an available version.
- [x] Plan the actual approved desktop policy administration and installer
      publication metadata path. Mobile `/admin/update-policy`, authenticated
      worker ZIP/grants and Mac Sparkle are not interchangeable Windows publishers.
- [x] Bind final W29/W31 metadata to source/admin/product projections and absent/
      unpublished cases; keep deployment/publication/live flags separately gated.
- [x] Revalidate partial W32 evidence after dependent changes, including full
      required component checks and format checks. All real Windows/live checks
      remain open even though the focused dashboard/backend source slice passed.

## Completion record

- [x] Implement independent desktop `GET/PATCH /admin/update-policy/desktop`,
      fresh administrator permissions, transactional operation/revision fences,
      optional bounded gates and OpenAPI/client/security route inventory. Preserve
      mobile publisher and app/runtime/model distribution authorities.
- [x] Bind the separate dashboard review/form with permissions, bounds/clear,
      frozen confirmation, fresh Google auth, conflict readback and receipt recovery.
- [x] Push compatible public `app_policy` through the existing owner full snapshot
      and shared feed; fence independent revisions, delayed checkouts and old-owner
      streams while preserving no-polling/legacy semantics.
- [x] Run affected backend/dashboard/Windows portable tests/types/lint/format/build
      and compiled owned loopback realtime integration. See dated W32 evidence.
- [x] Bind W29/W31 source metadata and configured/unavailable/required projections
      through actual loaders, signed trust, numeric policy and centralized pending
      product views; test real receiving source with synthetic approved inputs.
- [ ] Supply genuine W29/W31 publisher/feed/catalog and public release inputs;
      prove published/downloaded availability, authorized deployment and actual
      supported Windows client. Source is not live proof.

- Implementation files and review: independent backend desktop-policy service/controller/full-snapshot feed, compatible auth/device/enrollment/artifact contracts; dashboard device/worker/profile/registration/policy views; Windows sealed numeric build and signed app/catalog loader; centralized web/landing/desktop destinations. Final gap added only an EN/AR Windows pending card and actual App server-rendered fixtures, plus a Windows device-view regression.
- Commands/results and evidence: current backend 286 tests across 19 distinct unit files plus 44 isolated HTTP cases/7 files and full types/lint/format/build; dashboard 49 tests/7 files plus full types/lint/format/build; Windows 114 cases/7 actual files plus correct usage/realtime/contract slice 65/5; landing 15/3 plus full types/lint/format/build; web canonical Downloads test 1/1. Exact results and historical checkpoints are in the final matrix; no live/device proof is inferred.
- Unrun native/toolchain checks: actual Win10 22H2/Win11 x64 account/GPU/Chrome/admin/installer/update/signature visibility, authorized deployment and old-product live compatibility; all remain W34/release acceptance.
- Remaining limitations and next task: supply genuine approved provider/catalog/publisher/feed/package inputs, complete W31/W34, then separately authorize publication/deployment. The source pending/unavailable states are complete; no public Windows target or current backend/provider availability was verified.

Check completed items individually and update [TASKS](../TASKS.md) and
[PROGRESS](../PROGRESS.md). Use `code-complete / Windows pending` only when
the required source work and executable code checks are complete; unavailable
native compilation remains explicitly recorded. Do not claim a release from
fixture or source-only proof.
