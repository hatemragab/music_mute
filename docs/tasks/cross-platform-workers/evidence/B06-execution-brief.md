# B06 execution brief

Use this inventory after B02, B05 and W01 complete their local review. The task is
direct removal in development, not a migration or compatibility project. No real
database reset, process stop, deployment, commit or push is authorized.

## Production paths observed during implementation

- `worker-routes.ts`: singleton `WORKER_ID = 'z440'` and the two-mode identity type.
- `worker-registry.service.ts`: configurable/default legacy mode, environment-key
  identity, missing-owner inference, legacy enabled state and singleton availability.
- `worker-auth.guard.ts`: environment-key fallback and singleton request identity.
- `worker-coordinator.service.ts`: legacy-only startup initialization.
- `worker-terminal.service.ts`: legacy owner handling.
- `worker-claim-wait.service.ts`: missing identity defaults to the singleton.
- `jobs/jobs-query.service.ts`: mode-dependent job/worker visibility.
- `admin-observability/admin-overview.service.ts`: singleton mode aggregation.
- `config/environment.ts`: auth-mode validation/default and environment-key rules.
- `operations/worker-fleet-migrate.ts`, `worker/worker-fleet-migration.ts`: obsolete
  conversion machinery, with associated package scripts and migration-only tests.

Paths above are relative to `backend/src/`. Recheck imports and the current code;
B05 and later tasks can change exact call signatures. Keep useful worker ID format
validation such as `WORKER_ID_PATTERN`. Do not blindly delete unrelated uses of the
word "legacy", including mobile release policy fixtures outside worker scope.

## Required final behavior

Every worker request uses an explicit registered identity and current permanent
credential digest. Ownerless jobs/events do not acquire a historical singleton
owner. Capacity, overview, claim wait, cancellation and recovery all use the same
fleet ownership rules. No environment flag selects another authentication path.
Do not keep a constant `mode: 'fleet'` property merely to avoid updating callers;
remove dead dispatch structure when it serves no remaining behavior.

Convert isolated integration fixtures to real new-schema registered, paired and
qualified identities as needed. Preserve meaningful race/recovery/fairness checks;
do not bypass B05 gates in a test-only mode or remove tests solely because the old
fixture can no longer claim. Delete tests whose only subject is the removed
migration or authentication fallback. B05's report identifies baseline fixtures
that need conversion.

B02's report adds ten failing nested lifecycle/race cases in
`backend/test/admin-workers.integration.mjs` (the failing parent makes the command
report eleven failures). Its creation/rotation privacy and admin-first rotation
cases passed. The failures use unqualified legacy claim fixtures; convert them to
new installation/runtime/qualification/boot evidence while retaining management
CAS, drain, stopped recovery, finish, revoke/output and rotation race coverage.

Remove the backend's normal manual raw-key creation endpoint in B06 as well. The
approved final onboarding path is B02 pairing; retaining a second enrollment route
would preserve a different end state. D01 removes the obsolete dashboard form in
its own scope, and this intermediate checkout is not deployable until that UI
integration is complete. Preserve audited idle credential rotation for an existing
paired worker. Convert B02's temporary manual-create coverage into a rejection/
route-absence assertion while retaining its permanent rotation reservation tests.
No manual registration compatibility endpoint or renamed replacement is needed.

The physical Z440 can enroll as a normal machine through the new installer. It
gets no special software identity or compatibility path. Document any necessary
manual re-enrollment without silently deleting old records or journals.

## Evidence

Run the task card's checks using isolated services. Record the final reference
scan, removed commands/configuration, converted fixture coverage and any remaining
new-schema integrity tool in `B06-report.md`. A source scan alone is not ownership
proof: exercise environment-only authentication rejection and explicit-owner
claim/recovery behavior through the real application.
