# Dashboard implementation tasks

**Status: not started; plan approval required. Backend B06 must pass its contract handoff first.** Read [scope](../scope.md) and [contracts](../contracts.md). Extend the existing React/TypeScript dashboard and current permissions/audit/revision patterns. Do not create a competing dashboard, backend foundation, or hosting task.

## D01 — Processing policy, queue limits, and readiness editor

**Depends on:** B06, R02. **Consumes/produces:** C1/C3/C6 settings contracts through existing processing settings APIs and operation receipts.

**Modify:** `dashboard/src/features/settings/{processing-settings-form.tsx,processing-settings-page.tsx,processing-settings-form.test.ts,settings-api.ts}`, `dashboard/src/api/contracts.ts`, and `dashboard/README.md`.

**Create:** `dashboard/src/features/settings/processing-policy-summary.tsx`, its `.test.tsx`, and `dashboard/e2e/processing-policy-v2.spec.ts`.

- [ ] Write form/API tests for legacy settings, v2 inclusive limits, 30-minute and 100 MB display, 60-minute rolling allowance, one unfinished job, evidence unavailable, changed revision, forbidden role, and failed save.
- [ ] Extend the existing form with duration, prepared bytes, account allowance/window, active count, bounded source preparation values, global outstanding count/audio/estimated-work budgets, short/long threshold, aging threshold, and admission toggles. Present minutes/MB clearly; submit exact seconds/bytes without rounding away boundaries.
- [ ] Explain that source file size, prepared upload bytes, audio duration, estimated worker time, and actual execution are different quantities. Show the current evidence revision and capability ceiling alongside configured policy. Settings cannot authorize unsupported slots or disabled format evidence.
- [ ] Retain reason dialog, operation ID, expectedRevision, fresh authentication, unsaved-change protection, server read-back, and conflict/error handling. An optimistic form value is not proof of applied backend policy.
- [ ] Allow pausing new submissions and admission of new long jobs; explain that accepted jobs retain their snapshots. Keep emergency job cancellation in existing explicit job actions. Never silently cancel/reorder accepted work from a settings save.
- [ ] Show unavailable/stale benchmark inputs and readiness blockers. Do not prefill missing capacity data with zero or let a UI-only toggle bypass backend validation.

**Required UI assertions:** entering `30` minutes sends `1800`; entering `100` decimal MB sends `100000000`; a settings-read-only role cannot submit; a revision conflict preserves the user's draft and offers refreshed server state; missing benchmark evidence prevents enabling expanded long jobs.

**Validation (dashboard cwd):** `npm test -- src/features/settings/processing-settings-form.test.ts src/features/settings/processing-policy-summary.test.tsx`; `npm run test:e2e -- e2e/processing-policy-v2.spec.ts` using fixtures; `npm run typecheck`.

**Acceptance:** all accepted policy knobs are reviewable and truly backed by B06 enforcement. No live settings are changed to demonstrate the UI.

## D02 — Queue workload, worker readiness, and safe actions

**Depends on:** B06, D01. **Consumes/produces:** C6 queue summary/job/worker fields; C3 cost/selection explanation.

**Modify:** `dashboard/src/features/jobs/jobs-page.tsx` and existing job API adapters, `dashboard/src/features/overview/{overview-page.tsx,overview-cards.tsx,overview-api.ts}`, `dashboard/src/features/workers/{worker-detail-page.tsx,workers-api.ts}`, `dashboard/src/features/health/system-health-page.tsx`, and `dashboard/src/api/contracts.ts`.

**Create:** `dashboard/src/features/jobs/{queue-summary-panel.tsx,queue-summary-panel.test.tsx,queue-summary-api.ts}` and `dashboard/e2e/queue-workload.spec.ts`. Mount this panel in the existing Jobs page; do not create a duplicate route.

- [ ] Test empty/busy/offline queues, one-slot long-job wait, stale estimates, pending recovery, partial metric failure, and permissions. Preserve existing filters/pagination.
- [ ] Display queued count/audio minutes, all outstanding reserved workload, oldest wait, estimated work/range with freshness, short/long distribution, and recent failures/rejections. Label declared versus measured values.
- [ ] Show source category, input duration/bytes, actual processing versus queue time, and safe scheduler explanation per job. Do not expose another account's private media or presigned URLs in metrics.
- [ ] Extend worker detail with verified capability limits, safe registered slots, active assignment, last evidence time, and actual performance. Missing sensor readings are unavailable. Do not add a concurrency control or broad GPU telemetry project under this task.
- [ ] Reuse existing cancellation/recovery/drain actions with permissions and revision/receipt handling. A requested cancel remains pending until backend confirmation; stale heartbeat never renders the worker slot as safely reusable.
- [ ] Show “estimated” waiting ranges and the running-long-job limitation without promising fixed queue positions. Hook overload/stall indicators into existing health surfaces rather than introducing duplicate alerts.

**Required UI assertion:** queue `jobCount=2` with 60 seconds and 1800 seconds displays 31 minutes of audio, not “2 minutes”; a nullable estimated wait renders unavailable, not 0; `cancel_requested` remains active/pending until confirmed.

**Validation:** `npm test -- src/features/jobs/queue-summary-panel.test.tsx`; `npm run test:e2e -- e2e/queue-workload.spec.ts`; `npm run typecheck`.

**Acceptance:** administrators can see workload and operational limits clearly, with evidence boundaries and existing safe actions intact.

## D03 — Account usage and expiring administrator exceptions

**Depends on:** B06, D01. **Consumes/produces:** C2/C6 usage, expiring allowance overrides, and existing suspend/resume flow.

**Modify:** `dashboard/src/features/users/{user-detail-page.tsx,users-page.tsx,processing-suspension-dialog.tsx}`, existing user API adapters, `dashboard/src/api/contracts.ts`, and related fixtures.

**Create:** `dashboard/src/features/users/{processing-usage-panel.tsx,processing-usage-panel.test.tsx,processing-allowance-dialog.tsx,processing-allowance-dialog.test.tsx}`, `dashboard/e2e/processing-allowance.spec.ts`.

- [ ] Test used/reserved/remaining minutes, next/multiple replenishments, unresolved settlement, exception expiry/revocation, read-only users, stale revisions, and recovery from rejected saves.
- [ ] Add allowance/attempt/rejection/cancellation summaries to existing account detail; show status and expiry without raw filenames, URLs, or unrestricted ledger dumps.
- [ ] Add temporary allowance-increase action with mandatory expiry, reason, bounded amount, operation ID, expectedRevision, fresh auth, and server-confirmed receipt. Clearly state that account exceptions cannot bypass 30-minute/byte/global safety ceilings or active-job count.
- [ ] Add optional expiry to existing processing suspension action and show effective expiry/server status. Do not automatically resume an account on the client when a timer reaches zero; refresh authoritative state.
- [ ] Show changes in existing audit history with actor, reason, before/after values, and expiry. Ordinary exception revocation preserves accepted reservations.

**Validation (dashboard cwd):**

```sh
npm test -- src/features/users/processing-usage-panel.test.tsx src/features/users/processing-allowance-dialog.test.tsx
npm run test:e2e -- e2e/processing-allowance.spec.ts
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

**Acceptance:** complete backend-connected usage/exception controls, role-safe mutations, and audited read-back in fixture/isolated checks; no production writes or deployment claims.
