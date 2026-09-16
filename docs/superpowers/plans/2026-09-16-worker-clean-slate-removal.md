# Worker Clean-Slate Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the existing worker-machine subsystem while preserving job
history and storage management behind one explicit temporary processing-unavailable
boundary.

**Architecture:** Install a single `ProcessingUnavailableService` at the four
mobile processing-start endpoints, then remove worker administration before
removing the tightly coupled worker execution/persistence core. Simplify backend
and dashboard contracts to retain only non-worker job, storage, usage,
notification, and administration behavior; delete the packaged worker and old
worker documentation last.

**Tech Stack:** NestJS 11, TypeScript 5.9, Mongoose 9, Vitest 4, Node test runner,
React 19, React Router 8, TanStack Query, Vite 8, Playwright.

**Spec:**
`docs/superpowers/specs/2026-09-16-worker-clean-slate-removal-design.md`

## Global Constraints

- Work only on `codex/worker-clean-slate`; do not push, merge, deploy, or modify
  infrastructure.
- Do not modify any file under `android/` or `ios/`.
- Preserve `backend/separate.py` byte-for-byte and do not import or execute it.
- Do not modify, migrate, drop, or rewrite MongoDB data or indexes; the user will
  clean local data manually.
- Delete legacy behavior rather than preserving runtime fallbacks, adapters,
  redirects, or deprecated routes.
- Preserve authenticated job list/detail, completed-result download, rename,
  cancel, delete, storage cleanup, usage, notification, and account-deletion
  behavior.
- `POST /jobs`, `POST /jobs/:id/retry`, `POST /jobs/:id/upload-url`, and
  `POST /jobs/:id/upload-complete` must return `503 PROCESSING_UNAVAILABLE`
  without a processing-state write.
- The literal `TODO(worker-redesign)` required by the approved spec is the only
  allowed worker-redesign marker; it is an intentional integration marker, not
  an unfinished plan item.
- Remove `/worker/**`, `/admin/workers/**`, `/workers`, and `/workers/:id`
  completely so they resolve as not found.
- Keep the current cleanup spec and this plan; delete prior worker/fleet/Z440
  plans and specifications.
- Use `3b5afc3b` as the protected-path comparison base for Android, iOS, and
  `backend/separate.py`.

---

## File Responsibility Map

### New backend boundary and tests

- `backend/src/processing/processing-unavailable.service.ts` — the only runtime
  boundary for processing-start operations during the redesign.
- `backend/src/processing/processing-unavailable.service.spec.ts` — canonical
  503 contract test.
- `backend/src/processing/processing.module.spec.ts` — module-composition test
  proving no worker controllers, providers, or exports remain.

### Delete completely

- `backend/src/worker/` — worker authentication, routes, DTOs, schemas,
  coordination, output, terminal, recovery, fleet migration, and unit tests.
- `backend/src/admin-workers/` — administrator worker API and tests.
- `backend/src/processing-queue/` — fair queue, capacity, cost, execution-usage
  persistence, and tests.
- `dashboard/src/features/workers/` — worker pages, dialogs, API, and badges.
- `dashboard/src/features/jobs/job-attempt-timeline.tsx` — worker attempt UI.
- `windows-worker/` — complete tracked legacy worker package.
- Worker-only backend operations and tests listed in Tasks 2 and 3.
- Prior worker/fleet/Z440 documentation listed in Task 5.

### Backend files that own the surviving boundary

- `backend/src/jobs/jobs.controller.ts`
- `backend/src/jobs/jobs.controller.spec.ts`
- `backend/src/processing/processing.module.ts`
- `backend/src/processing/processing-enabled.guard.ts`

### Backend files that must lose worker data and behavior

- `backend/src/app.module.ts`
- `backend/src/auth/auth.guard.ts`
- `backend/src/auth/auth.guard.spec.ts`
- `backend/src/config/environment.ts`
- `backend/src/config/processing-environment.spec.ts`
- `backend/src/jobs/job.schema.ts`
- `backend/src/jobs/job-schema.spec.ts`
- `backend/src/jobs/job.types.ts`
- `backend/src/jobs/job-state.ts`
- `backend/src/jobs/job-state.spec.ts`
- `backend/src/jobs/job-timing.ts`
- `backend/src/jobs/job-timing.spec.ts`
- `backend/src/jobs/jobs-query.service.ts`
- `backend/src/jobs/jobs-query.service.spec.ts`
- `backend/src/jobs/jobs.presenter.ts`
- `backend/src/jobs/jobs.presenter.spec.ts`
- `backend/src/jobs/job-actions.service.ts`
- `backend/src/jobs/job-actions.service.spec.ts`
- `backend/src/jobs/job-deletion.service.ts`
- `backend/src/jobs/job-errors.ts`
- `backend/src/job-errors/job-error.schema.ts`
- `backend/src/processing/processing-persistence.module.ts`
- `backend/src/processing/processing-startup.service.ts`
- `backend/src/processing/processing-maintenance.service.ts`
- `backend/src/processing/processing-maintenance.service.spec.ts`
- `backend/src/processing-usage/processing-usage.service.ts`
- `backend/src/storage/storage-transfers.service.ts`
- `backend/src/storage/storage-transfers.service.spec.ts`
- `backend/src/users/account-deletion-cleanup.service.ts`
- `backend/src/users/account-deletion-cleanup.service.spec.ts`
- `backend/src/notifications/notification-dispatcher.service.ts`
- `backend/src/notifications/notification-outbox.schema.ts`
- `backend/package.json`
- `backend/.env.local.example`
- `backend/.env.production.example`

### Backend administration files that must lose worker concepts

- `backend/src/admin/admin-access.schema.ts`
- `backend/src/admin/admin-permissions.ts`
- `backend/src/admin/admin-permissions.spec.ts`
- `backend/src/admin/admin.types.ts`
- `backend/src/admin/admin-audit.schema.ts`
- `backend/src/admin/admin-audit.service.ts`
- `backend/src/admin/admin-audit-query.ts`
- `backend/src/admin/admin-audit-query.spec.ts`
- `backend/src/admin-jobs/admin-jobs-query.ts`
- `backend/src/admin-jobs/admin-jobs-query.service.ts`
- `backend/src/admin-jobs/admin-jobs-query.service.spec.ts`
- `backend/src/admin-jobs/admin-jobs.presenter.ts`
- `backend/src/admin-jobs/admin-job-actions.service.ts`
- `backend/src/admin-jobs/admin-job-actions.service.spec.ts`
- `backend/src/admin-exports/admin-exports.service.ts`
- `backend/src/admin-exports/admin-exports.service.spec.ts`
- `backend/src/admin-observability/admin-overview.service.ts`
- `backend/src/admin-observability/admin-overview.service.spec.ts`
- `backend/src/admin-observability/health-sampler.service.ts`
- `backend/src/admin-observability/health-sampler.service.spec.ts`
- `backend/src/admin-observability/admin-alert.schema.ts`
- `backend/src/admin-observability/admin-alerts.service.spec.ts`
- `backend/src/admin-settings/admin-settings.controller.ts`
- `backend/src/admin-settings/admin-settings.module.ts`
- `backend/src/admin-settings/processing-settings.service.ts`
- `backend/src/admin-settings/processing-settings.service.spec.ts`
- `backend/src/admin-settings/processing-policy-v2.ts`
- `backend/src/admin-settings/processing-admission.service.ts`
- `backend/src/admin-settings/processing-admission.service.spec.ts`

### Dashboard files that must lose worker concepts

- `dashboard/src/api/contracts.ts`
- `dashboard/src/api/backend-contract-alignment.test.ts`
- `dashboard/src/app/router.tsx`
- `dashboard/src/app/app-shell.tsx`
- `dashboard/src/features/administrators/role-permissions.ts`
- `dashboard/src/features/jobs/jobs-api.ts`
- `dashboard/src/features/jobs/jobs-page.tsx`
- `dashboard/src/features/jobs/job-detail-page.tsx`
- `dashboard/src/features/jobs/queue-summary-panel.tsx`
- `dashboard/src/features/jobs/queue-summary-panel.test.tsx`
- `dashboard/src/features/overview/overview-page.tsx`
- `dashboard/src/features/overview/overview-cards.tsx`
- `dashboard/src/features/settings/settings-api.ts`
- `dashboard/src/features/settings/processing-policy-editor.tsx`
- `dashboard/src/features/settings/processing-policy-summary.tsx`
- `dashboard/src/features/settings/processing-policy-summary.test.tsx`
- `dashboard/src/features/settings/processing-policy-validation.ts`
- `dashboard/src/features/settings/processing-policy-validation.test.ts`
- `dashboard/src/features/health/system-health-page.tsx`
- `dashboard/src/features/activity/activity-log-page.tsx`
- `dashboard/src/features/activity/audit-event-detail.tsx`
- `dashboard/src/test/dashboard-fixtures.ts`
- Dashboard E2E files listed in Task 4.

---

### Task 1: Install the Temporary Processing-Unavailable Boundary

**Files:**

- Create: `backend/src/processing/processing-unavailable.service.ts`
- Create: `backend/src/processing/processing-unavailable.service.spec.ts`
- Modify: `backend/src/jobs/jobs.controller.ts`
- Modify: `backend/src/jobs/jobs.controller.spec.ts`
- Modify: `backend/src/processing/processing.module.ts`

**Interfaces:**

- Produces: `ProcessingUnavailableService.reject(): never`.
- Consumes: the existing `jobError('PROCESSING_UNAVAILABLE')` error contract.
- Preserves: existing route paths, DTO parsing types, rate-limit metadata, and
  `RequireProcessingAccess` metadata on create/retry/upload routes.

- [ ] **Step 1: Write the failing service and controller tests**

Add the canonical exception test:

```ts
import { describe, expect, it } from "vitest";
import { ProcessingUnavailableService } from "./processing-unavailable.service.js";

describe("ProcessingUnavailableService", () => {
  it("returns the stable redesign boundary error", () => {
    const service = new ProcessingUnavailableService();
    try {
      service.reject();
      throw new Error("expected reject() to throw");
    } catch (error) {
      expect(error).toMatchObject({ status: 503 });
      expect((error as { getResponse(): unknown }).getResponse()).toMatchObject(
        {
          code: "PROCESSING_UNAVAILABLE",
          message: "New audio processing work is unavailable",
        },
      );
    }
  });
});
```

Extend `jobs.controller.spec.ts` with a controller whose query, action,
metadata, and deletion collaborators are inert. Assert that `create`, `retry`,
`renew`, and `confirm` each throw `PROCESSING_UNAVAILABLE`, while `list`,
`detail`, `download`, `rename`, `cancel`, and `delete` still delegate to their
existing collaborator.

- [ ] **Step 2: Run the focused tests and verify the new import fails**

Run:

```bash
cd backend
npx vitest run src/processing/processing-unavailable.service.spec.ts src/jobs/jobs.controller.spec.ts
```

Expected: FAIL because `processing-unavailable.service.ts` does not exist and
the controller still delegates processing-start operations to worker-era
services.

- [ ] **Step 3: Implement the single boundary service**

Create:

```ts
import { Injectable } from "@nestjs/common";
import { jobError } from "../jobs/job-errors.js";

@Injectable()
export class ProcessingUnavailableService {
  reject(): never {
    // TODO(worker-redesign): replace this boundary with the approved executor.
    throw jobError("PROCESSING_UNAVAILABLE");
  }
}
```

- [ ] **Step 4: Re-scope `JobsController`**

Remove the class-level `@UseGuards(ProcessingEnabledGuard)` and the
`JobsService` constructor dependency. Inject `ProcessingUnavailableService` and
make only the four processing-start methods call `this.unavailable.reject()`:

```ts
create(@Req() _req: AuthRequest, @Body() _dto: CreateJobDto) {
  return this.unavailable.reject();
}

retry(
  @Req() _req: AuthRequest,
  @Param('id') _id: string,
  @Body() _dto: RetryJobDto,
) {
  return this.unavailable.reject();
}

renew(
  @Req() _req: AuthRequest,
  @Param('id') _id: string,
  @Body(EmptyBodyPipe) _body: unknown,
) {
  return this.unavailable.reject();
}

confirm(
  @Req() _req: AuthRequest,
  @Param('id') _id: string,
  @Body(EmptyBodyPipe) _body: unknown,
) {
  return this.unavailable.reject();
}
```

Keep the existing rate-limit and access decorators. Register
`ProcessingUnavailableService` in `AudioProcessingModule`. Do not alter the
`ProcessingEnabledGuard` use on push-registration routes in this task.

- [ ] **Step 5: Run focused tests and type checking**

Run:

```bash
cd backend
npx vitest run src/processing/processing-unavailable.service.spec.ts src/jobs/jobs.controller.spec.ts
npm run typecheck
```

Expected: both Vitest files pass and TypeScript exits 0.

- [ ] **Step 6: Review the diff for a single marker and no mobile changes**

Run:

```bash
git diff --check
rg -n "TODO\(worker-redesign\)" backend/src
git diff --name-only 3b5afc3b -- android ios backend/separate.py
```

Expected: one marker in `processing-unavailable.service.ts`; the protected-path
diff is empty.

- [ ] **Step 7: Commit the boundary**

```bash
git add backend/src/processing/processing-unavailable.service.ts \
  backend/src/processing/processing-unavailable.service.spec.ts \
  backend/src/jobs/jobs.controller.ts \
  backend/src/jobs/jobs.controller.spec.ts \
  backend/src/processing/processing.module.ts
git commit -m "refactor(api): isolate unavailable processing boundary"
```

---

### Task 2: Remove Worker Administration and Cross-Cutting Admin Concepts

**Files:**

- Delete: `backend/src/admin-workers/`
- Delete: `backend/test/admin-workers.e2e-spec.ts`
- Delete: `backend/test/admin-workers.integration.mjs`
- Delete: `backend/test/admin-fleet.integration.mjs`
- Modify: all backend administration files listed in the responsibility map.
- Modify: `backend/src/app.module.ts`
- Modify: `backend/test/fixtures/dashboard-contracts/routes.json`
- Modify: `backend/test/fixtures/dashboard-contracts/workflow.json`
- Modify: backend admin E2E/integration tests that enumerate roles, permissions,
  overview fields, alert kinds, job filters, or CSV headers.

**Interfaces:**

- Produces administrator roles: `owner`, `release_manager`, `support`, `viewer`.
- Removes permissions: `workers.read`, `workers.manage`, `workers.recover`.
- Removes admin worker routes and worker-specific job/overview/health/export
  fields while leaving the worker protocol temporarily intact for Task 3.

- [ ] **Step 1: Change permission tests first**

Update `admin-permissions.spec.ts` to enforce the exact clean role and
permission sets:

```ts
expect(ADMIN_ROLES).toEqual(["owner", "release_manager", "support", "viewer"]);
expect(PERMISSIONS).not.toEqual(
  expect.arrayContaining(["workers.read", "workers.manage", "workers.recover"]),
);
expect(Object.keys(ROLE_PERMISSIONS)).not.toContain("worker_manager");
```

Update admin jobs/overview/exports/alerts tests so expected responses contain
no `workerId`, attempts, workers-online card, `worker_offline` alert, stopped
worker evidence, or worker CSV column.

- [ ] **Step 2: Run focused tests and verify they fail against current contracts**

Run:

```bash
cd backend
npx vitest run \
  src/admin/admin-permissions.spec.ts \
  src/admin-jobs/admin-jobs-query.service.spec.ts \
  src/admin-exports/admin-exports.service.spec.ts \
  src/admin-observability/admin-overview.service.spec.ts \
  src/admin-observability/health-sampler.service.spec.ts \
  src/admin-observability/admin-alerts.service.spec.ts
```

Expected: FAIL on the worker role, permissions, fields, metrics, and alerts.

- [ ] **Step 3: Remove the admin worker module and permission surface**

Delete `backend/src/admin-workers/` and remove `AdminWorkersModule` from
`AppModule`. Remove `worker_manager` and the three worker permissions from
`admin.types.ts`, `admin-access.schema.ts`, and `admin-permissions.ts`. Keep the
remaining permission order stable and update owner/support/viewer descriptions
without introducing a replacement worker role.

Remove every `/admin/workers` entry from the dashboard contract route/workflow
fixtures and their runtime setup. Old route probes must now expect the normal
404 if explicitly tested; they must not be represented as supported contracts.

- [ ] **Step 4: Remove worker fields from surviving admin services**

Implement these exact contract changes:

- Admin job query accepts no `workerId` filter and returns no worker ID,
  attempt timeline, recovery-required flag, active attempt, session, generation,
  or lease.
- Admin job action retains cancel; retry calls the shared unavailable boundary
  and returns `PROCESSING_UNAVAILABLE` without creating a job.
- Overview returns job/user/storage/release statistics without a `workers`
  object or worker-derived capacity estimate.
- Health sampling does not query `audio_worker_control`, does not emit
  `worker_offline`, and retains MongoDB, Redis, storage, notifications, and other
  non-worker health signals.
- CSV job exports remove `workerId` and attempt joins while retaining job ID,
  user ID, status, timestamps, elapsed time, and safe error code.
- Audit schemas and presenters remove worker lifecycle actions and stopped-worker
  evidence while retaining generic operation IDs, actor, reason, target, result,
  and revision evidence.

Use explicit response objects rather than assigning worker fields to `undefined`.

- [ ] **Step 5: Detach worker qualification/capacity from admin contracts**

Remove `GET/PUT /admin/settings/processing-v2` from
`AdminSettingsController`. Stop `ProcessingSettingsService.publicPolicy()` from
reading or presenting queue policy, qualification, qualified worker IDs, worker
capacity, queue estimates, or worker-cost fields. Keep
`GET/PUT /admin/settings/processing` and the public `/processing-policy` route;
the public policy always advertises `acceptNewJobs: false` during the redesign
and retains the basic maintenance message and conservative media limits from
`processing_settings`.

Do not delete `QueuePolicyService`, its schema/DTOs, or qualification helpers in
this task: the still-present worker execution core imports them. Leave their
module providers/exports in place but unreachable from HTTP. Task 3 deletes
those classes in the same compile-safe change as their final consumers.

- [ ] **Step 6: Update backend admin tests and fixtures**

Remove worker roles from every parameterized role list in admin E2E tests.
Rewrite `admin-settings.e2e-spec.ts` to assert that
`/admin/settings/processing-v2` is absent and `/processing-policy` reports
`acceptNewJobs: false`. Update dashboard-contract fixtures to match the reduced
responses and permissions.

- [ ] **Step 7: Run focused administration validation**

Run:

```bash
cd backend
npx vitest run \
  src/admin/admin-permissions.spec.ts \
  src/admin/admin-audit-query.spec.ts \
  src/admin-jobs/admin-jobs-query.service.spec.ts \
  src/admin-jobs/admin-job-actions.service.spec.ts \
  src/admin-exports/admin-exports.service.spec.ts \
  src/admin-observability/admin-overview.service.spec.ts \
  src/admin-observability/health-sampler.service.spec.ts \
  src/admin-observability/admin-alerts.service.spec.ts \
  src/admin-settings/processing-settings.service.spec.ts
npx vitest run --config ./vitest.config.e2e.ts test/admin-settings.e2e-spec.ts
npm run typecheck
```

Expected: focused tests pass and TypeScript exits 0.

- [ ] **Step 8: Commit the administrator cleanup**

```bash
git add backend/src backend/test
git commit -m "refactor(api): remove worker administration surface"
```

Before committing, inspect `git diff --cached --name-only` and unstage any file
outside the Task 2 backend scope.

---

### Task 3: Remove Worker Execution, Persistence, Queue, and Recovery

**Files:**

- Create: `backend/src/processing/processing.module.spec.ts`
- Delete: `backend/src/worker/`
- Delete: `backend/src/processing-queue/`
- Delete: `backend/src/jobs/job-attempt.schema.ts`
- Delete: `backend/src/jobs/job-receipt.schema.ts`
- Delete: `backend/src/jobs/queue-counter.schema.ts`
- Delete: `backend/src/jobs/jobs.service.ts`
- Delete: `backend/src/jobs/enqueue.service.ts`
- Delete: `backend/src/admin-settings/dto/processing-qualification.dto.ts`
- Delete: `backend/src/admin-settings/dto/queue-policy.dto.ts`
- Delete: `backend/src/admin-settings/processing-admission.service.ts`
- Delete: `backend/src/admin-settings/processing-admission.service.spec.ts`
- Delete: `backend/src/admin-settings/processing-policy-v2.ts`
- Delete: `backend/src/admin-settings/processing-qualification.ts`
- Delete: `backend/src/admin-settings/processing-qualification.spec.ts`
- Delete: `backend/src/admin-settings/queue-policy.schema.ts`
- Delete: `backend/src/admin-settings/queue-policy.service.ts`
- Delete: `backend/src/admin-settings/queue-policy.spec.ts`
- Delete: `backend/src/operations/worker-fleet-audit.ts`
- Delete: `backend/src/operations/worker-fleet-migrate.ts`
- Delete: `backend/src/operations/worker-fleet-migrate.spec.ts`
- Delete: worker-only backend tests named below.
- Modify: backend processing/job/config/storage/notification/account-cleanup
  files listed in the responsibility map.

**Interfaces:**

- Produces a worker-free `AudioProcessingModule` with user job history, usage,
  notifications, client errors, storage cleanup, and account cleanup only.
- Produces `PROCESSING_MODELS` without `WorkerRegistration`, `WorkerControl`,
  `JobAttempt`, `JobReceipt`, `QueueCounter`, `ProcessingQueuePolicy`, or
  `QueueExecutionUsage`.
- Preserves internal notification-outbox leases; those are not worker leases.

- [ ] **Step 1: Write failing persistence and module-composition tests**

Add `processing.module.spec.ts` using Nest module metadata:

```ts
import { MODULE_METADATA } from "@nestjs/common/constants";
import { describe, expect, it } from "vitest";
import { AudioProcessingModule } from "./processing.module.js";
import { PROCESSING_MODELS } from "./processing-persistence.module.js";

const names = (key: string) =>
  (Reflect.getMetadata(key, AudioProcessingModule) ?? []).map(
    (value: { name?: string }) => value.name,
  );

describe("worker-free processing composition", () => {
  it("registers no worker controller, provider, guard, or export", () => {
    for (const key of [
      MODULE_METADATA.CONTROLLERS,
      MODULE_METADATA.PROVIDERS,
      MODULE_METADATA.EXPORTS,
    ]) {
      expect(names(key).filter((name: string) => /Worker/.test(name))).toEqual(
        [],
      );
    }
  });

  it("registers no worker protocol persistence models", () => {
    expect(PROCESSING_MODELS.map(({ name }) => name)).not.toEqual(
      expect.arrayContaining([
        "WorkerRegistration",
        "WorkerControl",
        "JobAttempt",
        "JobReceipt",
        "QueueCounter",
        "ProcessingQueuePolicy",
        "QueueExecutionUsage",
      ]),
    );
  });
});
```

Update `job-schema.spec.ts` to assert that `workerId`, `attemptId`, `sessionId`,
`generation`, `leaseExpiresAt`, and `outputReservation` are absent and no index
contains `workerId` or represents the worker claim FIFO.

- [ ] **Step 2: Run focused tests and verify they fail**

Run:

```bash
cd backend
npx vitest run \
  src/processing/processing.module.spec.ts \
  src/jobs/job-schema.spec.ts \
  src/jobs/jobs.presenter.spec.ts \
  src/users/account-deletion-cleanup.service.spec.ts
```

Expected: FAIL because worker providers, models, fields, and cleanup queries are
still present.

- [ ] **Step 3: Delete the worker protocol and queue implementation**

Delete the directories/files listed for this task. Remove from
`AudioProcessingModule`:

- `WorkerController`;
- `WorkerAuthGuard` and its `APP_GUARD` registration;
- every worker registry, identity, claim, coordinator, output, terminal, and
  recovery provider;
- worker exports;
- `JobsService` and `EnqueueService`.

Keep controllers/services for processing usage, jobs, push registration, client
errors, job metadata/deletion/query, account cleanup, storage cleanup, and
notifications.

Delete the worker-era queue policy, qualification, admission, and v2 policy
files listed for this task. Remove their providers, imports, and exports from
`AdminSettingsModule` and all final consumers. Keep the basic
`ProcessingSettingsService`, `ProcessingSettings`, and
`ProcessingAdmissionFence` used by surviving settings serialization and public
maintenance policy.

- [ ] **Step 4: Reduce persistence to surviving models**

Make `PROCESSING_MODELS` contain only the actual surviving schemas:

```ts
export const PROCESSING_MODELS = [
  {
    name: ProcessingAdmissionFence.name,
    schema: ProcessingAdmissionFenceSchema,
  },
  { name: ProcessingUsageLedger.name, schema: ProcessingUsageLedgerSchema },
  { name: ClientError.name, schema: ClientErrorSchema },
  { name: Job.name, schema: JobSchema },
  { name: JobError.name, schema: JobErrorSchema },
  { name: NotificationOutbox.name, schema: NotificationOutboxSchema },
  { name: PushInstallation.name, schema: PushInstallationSchema },
  { name: NotificationDelivery.name, schema: NotificationDeliverySchema },
];
```

Do not add cleanup/drop calls for removed collections.

- [ ] **Step 5: Remove worker ownership from job contracts**

Remove from `Job`, its TypeScript types, presenter, query service, state helpers,
and tests:

- worker, attempt, session, generation, and execution lease fields;
- output reservation and attempt-specific output keys;
- `workerAvailable`;
- fair-queue order/index logic used only for claims;
- attempt timing/recovery calculations.

Keep job status strings and historical timing/output fields used by mobile and
dashboard history. Keep finalized `inputObject` and `outputObject`; completed
downloads continue to use them. `JobsQueryService` must no longer inject or call
`WorkerRegistryService`.

Remove retry creation from `JobActionsService`; cancellation remains and must not
consult worker control. Remove the create/upload service path entirely because
Task 1 now terminates those requests before a state write.

After the last worker-era consumers are gone, remove
`PROCESSING_CAPACITY_UNAVAILABLE`, `WORKER_RECOVERY_REQUIRED`, `STALE_ATTEMPT`,
and other error codes used only by the deleted execution protocol.

- [ ] **Step 6: Remove worker coupling from surviving services**

Apply these exact reductions:

- `AuthGuard` handles public, Firebase user, and administrator routes only; remove
  `WorkerOnly` metadata and worker request bypasses.
- `ProcessingMaintenanceService` runs storage and notification maintenance only;
  remove worker expiry/recovery sweeps.
- `ProcessingUsageService` reads retained usage ledger/reservations without
  joining attempts or execution usage.
- `StorageTransfersService` retains owner/admin input and finalized output
  downloads; remove worker input/output upload grants and attempt selectors.
- `AccountDeletionCleanupService` deletes retained jobs, errors, usage,
  notification, client-error, and storage state without reading
  `audio_worker_control`, `audio_job_attempts`, or `audio_job_receipts`.
- `JobErrorSchema` keeps generic/notification history but drops attempt,
  generation, interruption-only classification, and worker exit evidence.
- Notification dispatch keeps its own `leaseExpiresAt` delivery lease and removes
  only job-attempt/generation assumptions.

- [ ] **Step 7: Remove worker configuration and package scripts**

Remove all worker-only settings from `environment.ts`, safe environment examples,
test fixtures, and dashboard isolated-backend environments, including:

- `PROCESSING_WORKER_KEY_SHA256`
- `PROCESSING_WORKER_AUTH_MODE`
- `PROCESSING_WORKER_MAX_WAITERS`
- `PROCESSING_LEASE_SECONDS`
- worker-output limits that have no surviving storage consumer

Retain `PROCESSING_URL_SECONDS` where completed input/output presigned downloads
still consume it. Remove `worker:fleet:audit`, `worker:fleet:migrate`, and
`test:worker-migration:integration` from `backend/package.json`. Rewrite
`test:processing:integration` to include only surviving processing persistence,
usage, history, cancel/delete, storage, push-registration, and notification
tests.

- [ ] **Step 8: Delete worker-only backend tests and update shared tests**

Delete:

- `backend/test/worker-auth.e2e-spec.ts`
- `backend/test/worker-claim.e2e-spec.ts`
- `backend/test/worker-claim-intent.integration.mjs`
- `backend/test/worker-claim-wait.integration.mjs`
- `backend/test/worker-coordinator.integration.mjs`
- `backend/test/worker-migration.integration.mjs`
- `backend/test/worker-output.integration.mjs`
- `backend/test/worker-races.integration.mjs`
- `backend/test/worker-recovery.integration.mjs`
- `backend/test/audio-processing-fixture.integration.mjs`
- `backend/test/audio-processing.integration.mjs`
- `backend/test/jobs-service.integration.mjs`
- `backend/test/helpers/audio-processing-fixture.mjs`

Update rather than delete tests for processing persistence, usage, job history,
cancel/delete, storage, notifications, push registration, account deletion, and
the dashboard contract. Add assertions that the four processing-start controller
methods throw before invoking any model/service double.

- [ ] **Step 9: Run backend formatting and focused validation**

Run:

```bash
cd backend
npm run format
npx vitest run \
  src/processing/processing-unavailable.service.spec.ts \
  src/processing/processing.module.spec.ts \
  src/jobs/jobs.controller.spec.ts \
  src/jobs/job-schema.spec.ts \
  src/jobs/jobs-query.service.spec.ts \
  src/jobs/jobs.presenter.spec.ts \
  src/jobs/job-actions.service.spec.ts \
  src/processing/processing-maintenance.service.spec.ts \
  src/processing-usage/processing-allowance.spec.ts \
  src/storage/storage-transfers.service.spec.ts \
  src/users/account-deletion-cleanup.service.spec.ts \
  src/auth/auth.guard.spec.ts
npm run typecheck
npm run build
```

Expected: formatter exits 0, focused tests pass, TypeScript exits 0, and Nest
build exits 0.

- [ ] **Step 10: Run the worker-surface source gate**

Run from the repository root:

```bash
rg -n "Controller\('worker'\)|admin/workers|audio_workers|audio_worker_control|audio_job_attempts|audio_job_receipts|PROCESSING_WORKER|worker_manager|workers\.(read|manage|recover)" \
  backend/src backend/test backend/package.json backend/.env.local.example \
  backend/.env.production.example
```

Expected: no matches. Separately verify exactly one approved redesign marker:

```bash
rg -n "TODO\(worker-redesign\)" backend/src
```

- [ ] **Step 11: Commit the worker execution removal**

```bash
git add backend/src backend/test backend/package.json \
  backend/.env.local.example backend/.env.production.example
git commit -m "refactor(api): remove worker execution subsystem"
```

Inspect staged paths before committing; do not stage `backend/separate.py` or
the unrelated repository-root artifacts.

---

### Task 4: Remove Worker Dashboard Routes and Contracts

**Files:**

- Delete: `dashboard/src/features/workers/`
- Delete: `dashboard/src/features/jobs/job-attempt-timeline.tsx`
- Modify: all dashboard files listed in the responsibility map.
- Modify: `dashboard/e2e/permissions.spec.ts`
- Modify: `dashboard/e2e/full-dashboard.spec.ts`
- Modify: `dashboard/e2e/backend-contract.spec.ts`
- Modify: `dashboard/e2e/processing-policy-contract.spec.ts`
- Delete: `dashboard/e2e/processing-policy-v2.spec.ts`
- Modify: `dashboard/e2e/helpers/isolated-backend.mjs`

**Interfaces:**

- Consumes the reduced backend roles, permissions, job, overview, health,
  settings, audit, and export contracts from Tasks 2 and 3.
- Produces no `/workers` route, workers navigation item, worker API request, or
  worker-specific contract field.

- [ ] **Step 1: Update dashboard contract tests first**

In `backend-contract-alignment.test.ts` and relevant component tests, assert:

```ts
expect(ADMIN_ROLES).not.toContain("worker_manager");
expect(
  PERMISSIONS.filter((permission) => permission.startsWith("workers.")),
).toEqual([]);
expect(NAV_ITEMS.map((item) => item.to)).not.toContain("/workers");
```

If `NAV_ITEMS` remains module-private, assert the rendered navigation instead of
exporting it only for tests. Update fixtures so job details have no `workerId` or
attempts, overview has no `workers`, health has no worker status, and settings
have no qualification/capacity object.

- [ ] **Step 2: Run the focused dashboard tests and verify they fail**

Run:

```bash
cd dashboard
npm test -- \
  src/api/backend-contract-alignment.test.ts \
  src/features/jobs/queue-summary-panel.test.tsx \
  src/features/settings/processing-policy-summary.test.tsx \
  src/features/settings/processing-policy-validation.test.ts
```

Expected: FAIL on worker roles, routes, fields, and policy controls.

- [ ] **Step 3: Delete worker pages and routing**

Delete the worker feature directory and job attempt timeline. Remove worker lazy
imports and both route elements from `router.tsx`; remove the Workers navigation
item and icon from `app-shell.tsx`. Do not add redirects or a replacement page.

- [ ] **Step 4: Reduce dashboard contracts and role descriptions**

Remove:

- `worker_manager` and all `workers.*` permissions;
- worker summary/detail/action/key/recovery types;
- worker/attempt fields from job types and query filters;
- workers metrics from overview types;
- worker health and offline alert types;
- qualification/capacity/worker-cost fields from processing settings;
- worker audit evidence and CSV filter/header expectations.

Update `role-permissions.ts` so remaining role permissions exactly match the
backend. Do not map old worker managers to another role in frontend code.

- [ ] **Step 5: Simplify surviving pages**

- Jobs list/detail show status, owner, media, timestamps, safe error, actions,
  and finalized media only.
- Overview cards omit workers-online and capacity estimates.
- Settings retain basic processing availability/message/media-limit and user
  allowance controls but remove the v2 worker qualification editor.
- Health omits worker state/offline alert presentation.
- Activity shows only surviving audit details.
- Fixtures and isolated backend expose no `/admin/workers` handler.

- [ ] **Step 6: Update E2E expectations**

Change permission navigation lists so none includes Workers. Add a direct-route
assertion that `/workers` renders the dashboard not-found result and verify no
request to `/api/v1/admin/workers` occurs. Remove worker management and processing
qualification flows from full-dashboard tests while retaining jobs, users,
settings, health, activity, releases, and administrators coverage.

- [ ] **Step 7: Run dashboard formatting and validation**

Run:

```bash
cd dashboard
npm run format
npm run lint
npm run typecheck
npm test
npm run build
```

Expected: all commands exit 0.

- [ ] **Step 8: Run the dashboard source gate**

Run:

```bash
rg -n "features/workers|admin/workers|/workers|worker_manager|workers\.(read|manage|recover)|workerId|workerAvailable|qualifiedWorker|worker capacity" \
  dashboard/src dashboard/e2e
```

Expected: no worker-machine matches. A filename such as
`apk-hash.worker.ts` is a browser Web Worker and must remain; do not delete it.

- [ ] **Step 9: Commit the dashboard cleanup**

```bash
git add dashboard/src dashboard/e2e
git commit -m "refactor(dashboard): remove worker operations UI"
```

---

### Task 5: Delete the Packaged Worker and Rewrite Documentation

**Files:**

- Delete: `windows-worker/`
- Delete: `backend/docs/worker-fleet.md`
- Delete: `docs/superpowers/plans/2026-09-10-multi-machine-workers.md`
- Delete: `docs/superpowers/plans/2026-09-10-windows-worker.md`
- Delete: `docs/superpowers/plans/2026-09-10-z440-native-validation.md`
- Delete: `docs/superpowers/plans/2026-09-10-z440-reliability-performance.md`
- Delete: `docs/superpowers/specs/2026-09-10-multi-machine-workers-design.md`
- Delete: `docs/superpowers/specs/2026-09-11-portable-windows-worker-design.md`
- Delete: `docs/tasks/full-dashboard/backend/B04-fleet-ownership-foundation.md`
- Delete: `docs/tasks/full-dashboard/backend/B05-worker-admin-controls.md`
- Delete: `docs/tasks/full-dashboard/dashboard/D04-workers-list-detail.md`
- Delete: `docs/tasks/full-dashboard/dashboard/D05-worker-management-dialogs.md`
- Delete: `docs/tasks/media-input-and-queue/worker/README.md`
- Delete: `docs/tasks/media-input-and-queue/evidence/worker.md`
- Delete: `docs/tasks/media-input-and-queue/evidence/worker-execution.md`
- Modify: `README.md`
- Modify: `CONTRIBUTING.md`
- Modify: `backend/README.md`
- Modify: `dashboard/README.md`
- Modify: shared backend/docs and docs/task files that still describe a current
  worker, worker route, worker collection, worker role, fleet, or Z440 flow.
- Preserve: the approved cleanup spec and this implementation plan.

**Interfaces:**

- Produces repository documentation that accurately states new processing is
  temporarily unavailable while history and completed-result management remain.
- Preserves the remote reference branch; no local archive copy is created.

- [ ] **Step 1: Record the tracked deletion scope**

Run:

```bash
git ls-files windows-worker
```

Save the output in the command log for review; do not include the three unrelated
untracked diagnostic artifacts.

- [ ] **Step 2: Delete the legacy package and dedicated documents**

Delete the exact paths listed for this task. Do not delete
`backend/separate.py`, the cleanup spec, or this plan.

- [ ] **Step 3: Rewrite top-level component documentation**

Update the root architecture and component tables so they contain Android, iOS,
API, dashboard, MongoDB, Redis, and S3 only. Replace instructions to configure a
Windows worker with a short temporary-state statement:

```md
New audio processing is temporarily unavailable while the worker architecture is
being redesigned. Existing job history and completed-result access remain in the
API and native apps.
```

Update backend and dashboard READMEs similarly. Remove worker environment keys,
fleet migration commands, worker-management routes, worker roles, qualification,
and worker validation claims. Do not describe the remote reference branch as a
supported runtime.

- [ ] **Step 4: Repair shared docs instead of deleting non-worker guidance**

In audio-processing, account-deletion, dashboard, media-input, validation, and
store-readiness documents, remove worker-specific procedures and stale links but
retain user auth, job history, downloads, cancellation, deletion, storage,
notifications, media rights, and mobile guidance. Remove references to deleted
task files from parent READMEs and execution trackers.

- [ ] **Step 5: Run documentation and tracking gates**

Run:

```bash
test -z "$(git ls-files windows-worker)"
test -f backend/separate.py
test -f docs/superpowers/specs/2026-09-16-worker-clean-slate-removal-design.md
test -f docs/superpowers/plans/2026-09-16-worker-clean-slate-removal.md
rg -n "Windows worker|worker fleet|Z440|/worker/|admin/workers|audio_workers|audio_worker_control|worker_manager|workers\.(read|manage|recover)" \
  README.md CONTRIBUTING.md backend/README.md dashboard/README.md backend/docs docs \
  --glob '!docs/superpowers/specs/2026-09-16-worker-clean-slate-removal-design.md' \
  --glob '!docs/superpowers/plans/2026-09-16-worker-clean-slate-removal.md'
```

Expected: no tracked worker package; required preserved files exist; no stale
current-runtime worker claims remain. Historical mentions necessary to explain
the cleanup must be confined to the approved spec and plan.

- [ ] **Step 6: Format documentation and review links**

Run:

```bash
cd backend
npx --no-install prettier --write \
  ../README.md ../CONTRIBUTING.md README.md ../dashboard/README.md \
  ../docs/superpowers/specs/2026-09-16-worker-clean-slate-removal-design.md \
  ../docs/superpowers/plans/2026-09-16-worker-clean-slate-removal.md
```

Use `rg` to find links to each deleted document and remove or redirect them to
the cleanup spec.

- [ ] **Step 7: Commit package and documentation removal**

```bash
git add windows-worker README.md CONTRIBUTING.md backend/README.md \
  dashboard/README.md backend/docs docs
git commit -m "chore(worker): remove legacy package and documentation"
```

---

### Task 6: Full Verification and Cleanup-Branch Handoff

**Files:**

- Review: all changes since `3b5afc3b`.
- Do not create or edit implementation files unless a verification failure is
  traced to this cleanup.

**Interfaces:**

- Produces a verified local cleanup branch suitable as the base of
  `codex/worker-redesign`.
- Does not push, merge, deploy, modify a database, or create the redesign branch
  before the cleanup review is complete.

- [ ] **Step 1: Run the full backend verification through context-mode**

Run from `backend/`:

```bash
npm run verify
```

Expected: formatter check, lint, typecheck, secret scan, unit tests, E2E tests,
and build all exit 0. Capture the final counts and any skipped tests.

- [ ] **Step 2: Run surviving isolated backend integration suites**

Run only against test-owned local services:

```bash
cd backend
npm run test:integration
npm run test:processing:integration
npm run test:dashboard:integration
```

Expected: all commands exit 0 when `mongod` and `redis-server` prerequisites are
available. If a prerequisite is unavailable, record the exact blocker; do not
substitute real or production services.

- [ ] **Step 3: Run the full dashboard verification**

Run from `dashboard/`:

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:deployment
npm run build
```

Run `npm run test:e2e` only when its documented local MongoDB, Redis, and Chrome
prerequisites are available. Record whether it ran and its exact result.

- [ ] **Step 4: Prove protected paths are unchanged**

Run:

```bash
git diff --exit-code 3b5afc3b -- android ios backend/separate.py
```

Expected: exit 0 and no output.

- [ ] **Step 5: Prove the removed route and persistence surface is absent**

Run:

```bash
test -z "$(git ls-files windows-worker)"
rg -n "Controller\('worker'\)|admin/workers|features/workers|audio_workers|audio_worker_control|audio_job_attempts|audio_job_receipts|PROCESSING_WORKER|worker_manager|workers\.(read|manage|recover)" \
  backend/src backend/test backend/package.json dashboard/src dashboard/e2e
```

Expected: no tracked worker package and no matches.

- [ ] **Step 6: Prove the temporary boundary is singular and explicit**

Run:

```bash
rg -n "TODO\(worker-redesign\)" backend/src
rg -n "PROCESSING_UNAVAILABLE" \
  backend/src/processing/processing-unavailable.service.ts \
  backend/src/processing/processing-unavailable.service.spec.ts \
  backend/src/jobs/jobs.controller.spec.ts
```

Expected: exactly one redesign marker and tests covering the canonical error.

- [ ] **Step 7: Review the complete diff and worktree**

Run:

```bash
git diff --check 3b5afc3b..HEAD
git diff --stat 3b5afc3b..HEAD
git status --short
git log --oneline --decorate 3b5afc3b..HEAD
```

Confirm the only untracked files are the pre-existing diagnostic artifacts:

- `bundled-yt-dlp`
- `old-extractor-test.webm`
- `youtube-diagnostic.webm`

- [ ] **Step 8: Stop for cleanup review before creating the rebuild branch**

Report the commits, deletions, surviving API behavior, test results, integration
prerequisites, protected-path proof, and remaining risks. After the user accepts
the completed cleanup, create and check out `codex/worker-redesign` from the
verified cleanup HEAD. Do not merge the old reference branch into it.
