# MusicMute App Updates Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Authorize dashboard administrators, verify APKs in private S3, publish consistent update policies, and preserve running media jobs.

**Architecture:** Extend existing policy storage and reuse Firebase/S3 infrastructure. Keep release management in a new cohesive `releases` module and administrator access in an `admin` module. Publication uses the existing MongoDB replica-set transaction support; binary inspection is a bounded request operation, not a media worker job.

**Tech Stack:** Existing NestJS, TypeScript ESM, Mongoose, AWS SDK, Firebase Admin, Vitest and isolated MongoDB/Redis integration helpers; trusted Android APK inspection executables.

**Spec:** [Design and contracts](../specs/2026-09-10-app-updates-design.md).

## Global Constraints

- Read `backend/AGENTS.md`, `backend/README.md`, `backend/docs/auth-api.md`, and current affected source before edits.
- Preserve legacy clients, strict validation and email-verification settings. Do not trust a browser-reported version, signer, role, S3 key or email identity.
- Changelog **English only**; platform-wide minimum enforced server-side; submitted jobs continue.
- Google allowlist starts with the privately supplied owner identity and is expandable. No personal email or credentials in source/fixtures.
- Uploads stay private/version-pinned; no cloud configuration/deletion or production writes without explicit authorization.
- No new audio worker/BullMQ queue. Do not alter the Z440 lease/cancellation protocol.
- Plans only in the current turn; no implementation or commits. Execution follows the master plan's device and authorization constraints.

---

## File structure and interfaces

New `admin/`: `admin.module.ts`, `admin.guard.ts`, `admin.decorators.ts`, `admin-allowlist.schema.ts`, `admin-allowlist.service.ts`, `admin.controller.ts`, `dto/admin-account.dto.ts`.

New `releases/`: `releases.module.ts`, `release.types.ts`, `release.schema.ts`, `release-upload.schema.ts`, `release-audit.schema.ts`, `release-policy.ts`, `release-policy.service.ts`, `release-storage.service.ts`, `apk-verifier.service.ts`, `release-upload.service.ts`, `release-publication.service.ts`, `releases.controller.ts`, `app-updates.controller.ts`, `release-errors.ts`, and narrow DTO files for draft/upload/publication.

Existing modules own Firebase verification, legacy policy persistence, storage client, guards and bootstrap. Import those providers; do not construct competing Firebase/S3 singletons.

Define in `release.types.ts` the exact spec types plus:

```ts
interface UploadReservationInput { bytes: number; sha256Hex: string }
interface ApkInspection {
  packageName: string; versionName: string; buildNumber: number;
  minimumSdk: number; debuggable: boolean; signerSha256Hex: string;
}
interface PublicationInput {
  minimumBuild: number | null; source: UpdateSource;
  expectedRevision: number; availabilityConfirmed: boolean;
}
interface AdminActor { uid: string; email: string }
```

`UpdateSource`, `UpdatePolicySnapshot`, `ReleaseTarget`, `ReleaseDownloadGrant` and `UpdateDecision` are copied exactly from the spec. `decideUpdate(installedBuild: number, snapshot: UpdatePolicySnapshot): UpdateDecision` is pure and exported by `release-policy.ts`. These contracts are fixed across subsystem plans.

## Task UPD-B01: Google admission and expandable allowlist

**Files:** Create the `admin/` files above and `admin.guard.spec.ts`, `admin-allowlist.service.spec.ts`, `backend/test/admin.e2e-spec.ts`. Modify `backend/src/auth/{auth.guard,auth.decorators,auth-request}.ts`, `backend/src/app.module.ts`, `backend/src/operations/{cli,operations-cli.module}.ts`; create `backend/src/operations/admin-command.ts` and its spec.

**Interfaces:** `AdminAllowlistService.authorize(uid: string, verifiedEmail: string): Promise<AdminActor>`; `add(email: string, expectedRevision: number, actor: AdminActor)`; `remove(uid: string, expectedRevision: number, actor: AdminActor)`; explicit `bootstrap(email: string, apply: boolean)`. All returns are typed snapshots with a revision; mutation revisions are server-controlled.

- [ ] Add guard tests before implementation: missing/expired/revoked token -> 401; ordinary signed-in app user -> 403; unverified email or non-Google provider -> 403; approved Google user -> success even without mobile installation/profile bootstrap.
- [ ] Extend the fixture in `admin.guard.spec.ts` with an injected Firebase verifier and real allowlist-service fake. Verify revocation checks are requested and allowlist lookup runs on every request, including after account removal.
- [ ] Add service tests for UID/email mismatch, case normalization without Gmail dot/plus rewriting, missing Google account, concurrent additions, stale revision, duplicate UID and last-admin removal. No client input may choose an arbitrary UID instead of server Firebase resolution.
- [ ] Implement admin-route metadata in `AuthGuard`: skip only the mobile-profile/device prerequisites for verified admin routes; execute a dedicated `AdminGuard` that reuses Firebase session verification, provider/email checks and allowlist membership. Do not reuse `@Public()` to bypass authentication. Keep account disable/revocation behavior intact.
- [ ] Add protected session/list/add/remove controllers and strict DTO limits: normalized email <=254 characters, integer expected revision, bounded lists; expose no allowlist through a public endpoint.
- [ ] Implement explicit private-email bootstrap through the operations CLI, including dry-run and apply. Refuse implicit startup seeding and refuse overwriting an existing list. Additions/removals use atomic revision checks; log only actor IDs/action, not tokens.

```ts
// Observable behavior in the service spec, using its injected fake store/Firebase directory.
await expect(service.remove('only-admin', 1, actor))
  .rejects.toMatchObject({ code: 'LAST_ADMIN_REQUIRED' });
await expect(service.authorize('ordinary-user', 'user@example.invalid'))
  .rejects.toMatchObject({ status: 403 });
```

- [ ] Run `npm test -- src/admin src/operations/admin-command.spec.ts` then `npm run test:e2e -- test/admin.e2e-spec.ts` from `backend/`. Implement until the new expectations pass; run the existing auth guard tests after shared guard changes.

**Acceptance:** Only allowlisted, current verified Google identities enter; dashboard access requires no mobile bootstrap; expanding/removing the list is enforced server-side and cannot remove the last admin.

## Task UPD-B02: Release records and compatible public policy

**Files:** Create release types/schemas, `release-policy.ts`, `release-policy.service.ts`, `app-updates.controller.ts`, corresponding `*.spec.ts`, and `backend/test/app-updates.e2e-spec.ts`. Modify `backend/src/app-policy/{app-policy.schema,access-policy,app-policy.presenter,app-policy.service}.ts` and their tests.

**Interfaces:** `ReleasePolicyService.snapshot(platform: Platform, distribution: Distribution): Promise<UpdatePolicySnapshot>`; pure `decideUpdate` defined above. Existing `presentPolicy` keeps the old public shape; stored `releaseSelection` is optional for legacy records.

- [ ] Write pure decision tests first, using the exact snapshot from the shared design and these boundaries:

```ts
expect(decideUpdate(9, snapshot)).toBe('required');
expect(decideUpdate(10, snapshot)).toBe('optional');
expect(decideUpdate(12, snapshot)).toBe('none');
expect(decideUpdate(13, snapshot)).toBe('none');
```

- [ ] Test legacy records without release selections, exact legacy JSON output, preserved `requireVerifiedEmail`, invalid integer builds, unknown platform/source combinations and inconsistent minimum/target. Add 400 tests for bad public query parameters and `no-store` header tests.
- [ ] Add release/upload/audit schemas with explicit indexes: unique `(platform, source, buildNumber)`, unique upload ID, policy revision conflict protection and bounded creation pagination. Published release metadata is immutable. Do not use TTL deletion for release objects or records.
- [ ] Extend stored-policy validation to accept the documented optional selection and reject unknown fields. Implement the old-field-only presenter explicitly rather than spreading platform storage into public responses.
- [ ] Implement public snapshot resolution, selecting Play for Play distributions regardless of direct preference, iOS App Store only, and configured source for direct distributions. Apply the feature-disabled/legacy-restriction behavior from the spec.
- [ ] Add `GET /app-updates/policy`, with public rate limiting and no auth dependency. Return no S3 keys, admin identity or signed download URLs.
- [ ] Run `npm test -- src/app-policy src/releases/release-policy.spec.ts src/releases/release-policy.service.spec.ts` and `npm run test:e2e -- test/app-updates.e2e-spec.ts`. Run legacy auth/session tests to prove compatibility.

**Acceptance:** Existing clients parse unchanged responses; new clients can check without login; policy selection and decision boundaries are deterministic.

## Task UPD-B03: Direct S3 upload and trustworthy APK inspection

**Files:** Create `release-storage.service.ts`, `apk-verifier.service.ts`, `release-upload.service.ts`, `dto/upload-release.dto.ts`, their specs, and `backend/test/release-artifacts.integration.mjs`. Reuse `backend/src/infrastructure/storage.module.ts` and `backend/src/storage/storage-preflight.service.ts`; add release-specific config validation in `backend/src/config/environment.ts` with dedicated tests.

**Interfaces:** `ReleaseUploadService.reserve(releaseId: string, input: UploadReservationInput, actor: AdminActor)` returns `{uploadId,url,fields,expiresAt}`. `confirm(releaseId: string, uploadId: string, actor: AdminActor)` returns the draft with artifact state. `ApkVerifierService.inspect(path: string, signal: AbortSignal): Promise<ApkInspection>`. The verifier path is always a service-created temporary file, never an API parameter.

- [ ] Write reservation tests for size 0, size >268435456, malformed SHA-256, non-draft release, store-only release and unauthorized caller. Expected success includes server-generated key and exact S3 size/checksum POST conditions.
- [ ] Add verification failure cases: absent object, re-uploaded key with different VersionId, mismatched checksum, wrong package, debug flag, unapproved signer, unsupported minimum SDK, parser failure and subprocess timeout. Every failure must leave the release unpublished.
- [ ] Implement private presigned POST and pinning using the existing `StorageClient`. Never use media upload ownership fields or media-object cleanup for release artifacts. Canonical hash on the wire is lowercase hexadecimal; convert to S3 base64 only inside the storage adapter.
- [ ] Stream the pinned object with byte/time limits into a private temporary directory. Calculate SHA-256 independently. Use `execFile`/`spawn` with fixed executable and argument arrays for `apksigner verify --verbose --print-certs` and `aapt2 dump badging`; bound output and reject ambiguous/multiple signer output unless explicitly supported by validated lineage code.
- [ ] Implement inspection parsing and enforce `com.hatem.musicmute`, increasing channel build numbers, approved signer, release/debug status, and SDK compatibility. The operator-provided display version must match APK metadata; correct the draft from verified metadata rather than accepting a conflicting value.
- [ ] Claim verification by CAS, include a deadline, and return safe 409 `VERIFICATION_IN_PROGRESS` for duplicates. Successful confirmation is idempotent. On timeout/error terminate inspection children, release/expire only this verification lease and clean temporary bytes. Do not touch media worker leases.

```ts
expect(verified.artifact.versionId).toBe(uploadedVersionId);
expect(verified.artifact.sha256Hex).toBe(expectedSha256Hex);
await expect(confirmWrongSigner()).rejects.toMatchObject({ code: 'APK_SIGNER_REJECTED' });
expect(await readReleaseState()).toBe('draft');
```

Define `confirmWrongSigner()` and `readReleaseState()` as fixture helpers in `release-upload.service.spec.ts`, wrapping the real service with fake object storage/inspection. They must not bypass the service state machine.

- [ ] Run `npm test -- src/releases/release-storage.service.spec.ts src/releases/apk-verifier.service.spec.ts src/releases/release-upload.service.spec.ts` then `npm run build && node --test test/release-artifacts.integration.mjs`. Integration uses locally generated non-production APK fixtures and isolated services; no real signing keys or media.

**Acceptance:** An uploaded file becomes publishable only after independently verified bytes, package/build and signature identity. A overwritten S3 key cannot replace the pinned artifact.

## Task UPD-B04: Preview, publication, withdrawal and download grants

**Files:** Create `release-publication.service.ts`, `releases.controller.ts`, `dto/{create-release,publish-release,withdraw-release}.dto.ts`, `release-errors.ts`, specs, and `backend/test/release-publication.integration.mjs`. Modify `app-updates.controller.ts`, `backend/src/operations/policy-command.ts`, and its tests.

**Interfaces:** `preview(releaseId: string, input: PublicationInput, actor: AdminActor)` returns validated proposed policy and affected installation count; `publish(...)` returns new revision; `withdraw(releaseId, replacementReleaseId, minimumBuild, expectedRevision, actor)` returns new revision. `downloadGrant(releaseId: string): Promise<ReleaseDownloadGrant>` issues only a currently selected verified APK.

- [ ] Write tests for unpublished/unverified APK, missing English changelog, invalid HTTPS/store host, source/platform mismatch, minimum >target, unavailable alternate channel, stale revision and accidental lowering of minimum through ordinary publish. English changelog is plain text, 1–10000 characters; render/store it without executable HTML.
- [ ] Add the publication transaction tests: failure between release selection and audit must roll back; two competing publications at the same revision yield one winner; repeated same publication cannot double-increment. Preview never writes.
- [ ] Implement immutable published release content, platform selection update and legacy fields in one transaction. Require explicit availability confirmation for store publication; a private draft is not proof of store availability. Require verified source targets for every activated channel before raising a common minimum.
- [ ] Implement withdrawal/replacement transaction. With null replacement require null minimum and disabled prompts; never downgrade installed apps or delete artifacts. Keep audit records with actor UID/revision only.
- [ ] Reject version-field changes through the old CLI while release management is enabled (`POLICY_MANAGED_BY_RELEASES`); allow email-policy patches while preserving stored selections. Add an explicit conversion command for a restricted legacy policy before feature enablement.
- [ ] Issue refreshable S3 grants for only the active verified object version, with `no-store`; deny unpublished/withdrawn release IDs. Add stable public landing route for legacy APK `downloadUrl` that retrieves a new grant instead of storing an expired URL.

```ts
const results = await Promise.allSettled([
  service.publish(releaseA, { ...input, expectedRevision: 4 }, actor),
  service.publish(releaseB, { ...input, expectedRevision: 4 }, actor),
]);
expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
expect((await policies.current()).revision).toBe(5);
```

- [ ] Run `npm test -- src/releases src/operations/policy-command.spec.ts` then `npm run build && node --test test/release-publication.integration.mjs` against an isolated replica set.

**Acceptance:** Users see a coherent policy/target; an administrator cannot force unavailable or unverified updates; withdrawal is a newer audited revision; S3 links remain temporary and refreshable.

## Task UPD-B05: Reject outdated processing without cancelling submitted work

**Files:** Modify `backend/src/app-policy/{access-policy,processing-access.guard}.ts` only where needed, `backend/src/jobs/jobs.controller.ts`, and associated specs. Create `backend/test/update-processing.integration.mjs`. Read `backend/src/worker/` and existing job action tests before touching shared behavior.

**Interfaces:** Preserve `evaluateProcessingAccess` and `APP_UPDATE_REQUIRED`. Fresh policy changes affect guarded create/retry/renew/confirm requests. Worker heartbeat/completion and already-submitted job status/results are not reclassified as new submissions.

- [ ] Write HTTP tests: below-minimum installation cannot create, retry, renew upload URL or confirm upload; current build succeeds. Derive platform/build from the authenticated owned installation, not arbitrary request body or unsigned headers.
- [ ] Add a race test for publishing during upload: bytes already sent to S3 do not imply submission permission; confirmation after publication is rejected. A job confirmed before the update remains submitted and finishes normally.
- [ ] Add integration proof for a submitted/claimed job: publish a higher minimum, complete the normal worker flow, retain output/history, and access after device metadata reports the upgraded build.
- [ ] Keep auth/bootstrap/policy/update-download paths reachable so blocked clients can recover. Do not attach a blanket processing guard to worker routes or job completion/read paths.
- [ ] If validation reveals bypasses, change only the relevant route guards and return the existing typed error. A blocked media request should trigger the native update coordinator through its error adapter.

```text
create@build9 after minimum10        => 403 APP_UPDATE_REQUIRED
upload-complete@build9 after publish => 403 APP_UPDATE_REQUIRED
worker completes previously queued  => normal success; output retained
device syncs build12                 => new submissions allowed
```

- [ ] Run affected policy/controller tests, then `npm run build && node --test test/update-processing.integration.mjs`, then the existing processing integration suite.

**Acceptance:** Backend restrictions cannot be bypassed by hiding the mobile dialog. Publishing never cancels a submitted job or discards its results.

## Task UPD-B06: Verifier runtime, configuration and operations guide

**Files:** Modify `backend/Dockerfile`, `backend/scripts/package-caprover.mjs`, `backend/src/config/environment.ts`, safe example environment files only, `backend/README.md`, `backend/docs/auth-api.md`, `backend/docs/auth-operations.md`. Create `backend/scripts/install-apk-verifier.sh`, `backend/docs/app-updates-api.md`, `backend/docs/app-updates-operations.md`, and runtime/config tests.

**Interfaces:** New runtime keys: `APP_UPDATES_ENABLED`, `APP_RELEASE_MAX_BYTES`, `APP_RELEASE_UPLOAD_SECONDS`, `APP_RELEASE_DOWNLOAD_SECONDS`, `APP_RELEASE_SIGNER_SHA256`, `APK_AAPT2_PATH`, `APK_APKSIGNER_PATH`, `DASHBOARD_PUBLIC_ORIGIN`, `ADMIN_BOOTSTRAP_EMAIL`. The bootstrap email is read only by the explicit operations command. Example files use placeholders, never the owner email or credentials.

- [ ] Add config tests for disabled feature preserving startup, enabled missing signer/tools failing clearly, invalid origins/durations, and exactly one signer digest or explicit comma-separated allowlist. Resolve tool executables from trusted configuration, never from upload contents.
- [ ] Validate a Linux verifier runtime locally. Prefer a pinned Debian Node 24 image plus compatible headless Java and checksum-pinned Android build-tools; current Alpine image cannot be assumed compatible with official binaries. Record the chosen exact image/tool versions and checksums in the setup script when implemented.
- [ ] Add a local fixture test that executes the packaged tools against a signed test APK and rejects a tampered APK. Readable executable paths alone do not prove runtime compatibility.
- [ ] Preserve existing port 80, non-root runtime, health behavior and CapRover archive shape. Pin downloads, keep SDK licenses/tooling documented, and scope writable temp space. No automatic SDK download at application startup.
- [ ] Document presigned upload CORS requirements, IAM key-prefix permissions, immutable version retention, publication/withdrawal flow, administrator additions/removals and private bootstrap operation. Do not modify live S3 or Firebase settings during implementation.
- [ ] Correct stale auth documentation stating no processing routes use the guard, with current route examples and compatibility notes. Document response limits, 409/403/503 errors and 90-second verification behavior.
- [ ] Run `npm run verify` and local runtime fixture checks. Record Docker unavailability separately if applicable. Defer dashboard asset packaging to V01 after D03.

**Acceptance:** The release API has a reproducible verifier runtime and complete operator/API documentation, with no production changes or secret exposure.
