# B06 local implementation report

Date: 2026-09-14. Status: local implementation and relevant checks complete;
ready for independent review. Development only. No commit, push, deploy,
production operation, real dotenv access, migration, backfill, old-client decoder,
compatibility adapter, real database reset, or existing worker journal change.

## Result

There is one registered, installation-bound protocol-3 worker path. Authentication
resolves the current digest and registry state, then requires the matching approved
installation owner. Missing identity or job/attempt ownership cannot create a
singleton or infer an owner. Setup-token expiry does not invalidate permanent
worker authority. Revoked credentials fail authentication. Draining and floor-held
workers retain owned heartbeat, cancellation, finish, cleanup and reconciliation.
Media-policy version 2 remains distinct from worker protocol 3.

Manual raw-key enrollment is absent from controller, service and DTO. Actual B02
pairing creates test workers; idle audited rotation and both digest reservations
remain. Runtime/qualification/boot admission is never bypassed in production or by
a test-only switch. Fresh control revisions must exist; worker/admin writes no
longer initialize missing historical revisions.

Availability and overview exclude mismatched installation ownership. A focused
compiled regression first demonstrated that a live control with a mismatched
installation still appeared available, then passed after the binding checks.

## B06 substantive file inventory

This checkout contains uncommitted prerequisite work. The following inventory
identifies B06 changes; it does not attribute entire B01/B02/B04/B05/W01 files or
the complete branch diff to B06. Paths in this section are relative to `backend/`.

| Files                                                                                                                                                                                                                                                                                                                                                                   | B06 responsibility                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/worker/worker-routes.ts`, `worker-auth.guard.ts`, `worker-registry.service.ts`                                                                                                                                                                                                                                                                                     | Remove mode/default identity/environment credential paths; add explicit installation identity and approved binding checks; reject missing owner; bind availability; remove missing control-revision accommodation.                                                       |
| `src/worker/worker-registration.schema.ts`                                                                                                                                                                                                                                                                                                                              | Require installation ID for new registrations.                                                                                                                                                                                                                           |
| `src/worker/worker-coordinator.service.ts`, `worker-claim-wait.service.ts`, `worker-terminal.service.ts`                                                                                                                                                                                                                                                                | Remove singleton startup, missing-identity waiter key, ownerless cleanup success and null-owner cleanup selector.                                                                                                                                                        |
| `src/jobs/jobs-query.service.ts`, `src/admin-observability/admin-overview.service.ts`, `src/processing-queue/fair-queue.service.ts`                                                                                                                                                                                                                                     | Remove mode-dependent job visibility, singleton aggregation and unused default worker-ID argument; use actual installation-bound fleet visibility.                                                                                                                       |
| `src/config/environment.ts`, `.env.local.example`, `.env.production.example`, `package.json`                                                                                                                                                                                                                                                                            | Remove old configuration keys/default/enabling rule and migration commands; preserve waiter limits and safe examples.                                                                                                                                                    |
| `src/admin-workers/admin-workers.controller.ts`, `admin-workers.service.ts`, `dto/admin-worker.dto.ts`                                                                                                                                                                                                                                                                  | Retire manual enrollment; preserve rotation/reservations and lifecycle fencing; use protocol 3 in detail; require matching persisted management revision.                                                                                                                |
| `src/worker-installations/installation-pairing.service.ts`                                                                                                                                                                                                                                                                                                              | Remove obsolete auth-mode check from approval only; B02 pairing implementation remains authoritative.                                                                                                                                                                    |
| `src/operations/worker-fleet-audit.ts`, `src/worker/worker-fleet-audit.ts`                                                                                                                                                                                                                                                                                              | Retain only read-only current-schema integrity checks; remove digest import comparison, singleton owner defaults, rollback/backfill/cutover decisions. Empty fresh fleet is consistent.                                                                                  |
| `src/app.module.ts`                                                                                                                                                                                                                                                                                                                                                     | Root integration repair: register AuthModule before worker feature modules that import AdminModule, so AuthGuard populates identity before AdminGuard. No auth bypass.                                                                                                   |
| `scripts/check-tracked-secrets.mjs`, `scripts/check-tracked-secrets.test.mjs`                                                                                                                                                                                                                                                                                           | Skip ENOENT for intentionally deleted tracked files; preserve other filesystem failures and detection of extant credential content. W01's deleted `separate.py` previously stopped verify.                                                                               |
| `test/helpers/paired-worker-fixture.mjs` (new), `test/helpers/audio-processing-fixture.mjs`                                                                                                                                                                                                                                                                             | Shared actual registration, qualification report, code issue, audited pairing approval, credential authentication and permanent readiness. Synthetic approved release/profile/service evidence only.                                                                     |
| `test/worker-fleet-only.integration.mjs` (new)                                                                                                                                                                                                                                                                                                                          | Real application rejection of environment-only/unregistered credentials, protocol 2, mismatched installation, missing identity/owner, and revoked credentials; no fallback slot or ownership mutation.                                                                   |
| `test/worker-coordinator.integration.mjs`, `worker-claim-wait.integration.mjs`, `worker-claim-intent.integration.mjs`, `worker-output.integration.mjs`, `worker-recovery.integration.mjs`, `worker-races.integration.mjs`, `jobs-cancel.integration.mjs`, `audio-processing-fixture.integration.mjs`                                                                    | Replace old singleton fixtures with fresh paired/qualified identities and explicit dynamic ownership; preserve original lifecycle/race assertions.                                                                                                                       |
| `test/admin-workers.integration.mjs`, `admin-fleet.integration.mjs`, `worker-installations.integration.mjs`                                                                                                                                                                                                                                                             | Preserve all management/rotation/claim/recovery/output races; replace manual enrollment assertions with route absence; preserve rotation reservations; add missing-revision rejection and empty-fleet integrity checks. Twenty-machine claim concurrency remains tested. |
| `test/admin-overview.integration.mjs`, `admin-job-actions.integration.mjs`, `account-deletion.integration.mjs`                                                                                                                                                                                                                                                          | Fresh explicit worker ownership for overview, upload/cancellation races and local-cleanup acknowledgement. Retry FIFO fixture now queues another user's job so it respects the existing per-user active limit. No limit was weakened.                                    |
| `test/worker-runtime.integration.mjs`, `worker-readiness.integration.mjs`, `worker-rollouts.integration.mjs`                                                                                                                                                                                                                                                            | Root conversion of low-level boundary fixtures to explicit current installation IDs and approved installation ownership; existing readiness/rollout assertions retained.                                                                                                 |
| `test/helpers/dashboard-runtime.mjs`, `test/dashboard-contract.integration.mjs`, `test/dashboard-curl.integration.mjs`                                                                                                                                                                                                                                                  | Actual paired worker in native workflow, dynamic IDs, retired-route assertion, removal of obsolete mode flags.                                                                                                                                                           |
| `test/dashboard-contract.e2e-spec.ts`, `test/fixtures/dashboard-contracts/routes.json`, `workflow.json`                                                                                                                                                                                                                                                                 | Remove manual route; add 17 previously missing B02/B04 authorization inventory routes; refresh synthetic normalized observed workflow responses, replacing old protocol-2/manual-registration snapshots.                                                                 |
| `test/helpers/auth-fixtures.ts`, `test/helpers/admin-harness.ts`, `test/worker-auth.e2e-spec.ts`, `test/worker-claim.e2e-spec.ts`, `test/admin-workers.e2e-spec.ts`                                                                                                                                                                                                     | Update isolated DI/model/identity fixtures and route absence assertions, retaining auth, waiter and admin security tests.                                                                                                                                                |
| `src/config/worker-fleet-environment.spec.ts`, `processing-environment.spec.ts`                                                                                                                                                                                                                                                                                         | New configuration behavior without an environment credential or mode default.                                                                                                                                                                                            |
| `src/worker/worker-fleet-only.spec.ts` (new), `worker-auth.guard.spec.ts`, `worker-fleet-auth.spec.ts`, `worker-identity.service.spec.ts`, `worker-registry.service.spec.ts`, `worker-claim-wait.service.spec.ts`, `worker-fleet-wait.spec.ts`, `worker.controller.spec.ts`, `worker-runtime.service.spec.ts`; `src/admin-observability/admin-overview.service.spec.ts` | Explicit installation identities, required schema binding, strict fallback rejection and retained waiter/controller/runtime cases.                                                                                                                                       |
| `README.md`, `docs/worker-fleet.md`, `docs/operations/audio-processing.md`, `docs/dashboard-api.md`                                                                                                                                                                                                                                                                     | Replace operational migration/manual-enrollment instructions with pairing, protocol 3, integrity-only audit and separately authorized idle development sequence.                                                                                                         |

Root also removed one obsolete mode assignment from
`dashboard/e2e/helpers/isolated-backend.mjs`; `node --check` passed. This is syntax
proof only, not dashboard browser E2E proof. No Android, iOS, shared-worker or
installer implementation was changed by B06. Prettier formatted backend task and
prerequisite files as required by verification; their non-B06 implementations are
outside this report's authorship inventory.

## Deletion and reference inventory

Deleted outright:

- `backend/src/operations/worker-fleet-migrate.ts`
- `backend/src/operations/worker-fleet-migrate.spec.ts`
- `backend/src/worker/worker-fleet-migration.ts`
- `backend/test/worker-migration.integration.mjs`

Removed package scripts: `worker:fleet:migrate` and
`test:worker-migration:integration`. There is no renamed converter. The retained
`worker:fleet:audit` command is read-only and reports current-schema inconsistencies;
it neither imports keys nor changes records/indexes nor makes rollback decisions.

The active-source/config/test/script scan found no migration entry point,
`WORKER_ID` singleton constant, missing-owner fallback, or mode discriminator.
The two remaining retired configuration-name mentions are deliberate negative
tests: `worker-fleet-environment.spec.ts` checks the default is absent, and
`worker-fleet-only.integration.mjs` proves an environment-only digest cannot
authenticate. Protocol-2 mentions in worker runtime tests are rejection cases.
Historical task/evidence prose is preserved as history rather than executable
instructions. Unrelated media-policy/account history terminology is unchanged.

## Validation and failure resolution

All native commands use helper-owned temporary local MongoDB replica sets and
Redis processes. They do not connect to configured development/production services.
Commands below run from `backend/` unless noted.

- Red fallback test: `npm test -- src/worker/worker-fleet-only.spec.ts` initially
  failed 3 of 5 cases because missing identity/owner became the singleton.
- `npm run format`; `npm run verify` — passed: formatting, lint, typecheck,
  tracked-secret scan plus **4/4 scanner tests**, **115 unit files / 873 tests**,
  **25 E2E files / 164 tests**, and clean Nest build. Log `/tmp/b06-verify2.log`.
- `npm run test:processing:integration` — **21/21 passed**, exit 0. All seven
  B05 processing fixture failures resolved. Log `/tmp/b06-processing-final.log`.
- `node --test --test-timeout=60000 test/worker-fleet-only.integration.mjs test/admin-fleet.integration.mjs test/admin-workers.integration.mjs test/admin-overview.integration.mjs test/worker-installations.integration.mjs test/worker-readiness.integration.mjs`
  — **28/28 passed** before the final missing-revision and empty-fleet assertions.
  Log `/tmp/b06-core-final.log`.
- Final changed-case run:
  `node --test --test-timeout=60000 test/admin-workers.integration.mjs test/admin-job-actions.integration.mjs test/account-deletion.integration.mjs test/worker-fleet-only.integration.mjs`
  — admin-workers **14/14 including parent**, account deletion **1/1**, fleet-only
  **1/1** passed. The combined command reported 24/26 because admin-job-actions'
  old retry fixture violated the active-user limit. After fixing that fixture,
  `node --test test/admin-job-actions.integration.mjs` passed **10/10**, exit 0.
  Logs `/tmp/b06-final-affected.log`, `/tmp/b06-admin-job-final.log`.
- Root: `node --test test/worker-runtime.integration.mjs test/worker-readiness.integration.mjs test/worker-rollouts.integration.mjs`
  — **3/3 passed** after explicit installation fixture conversion. Root scoped
  dashboard-contract E2E — **75/75 passed**, also included in full verify above.
- `DASHBOARD_CAPTURE_CONTRACTS=1 node --test test/dashboard-contract.integration.mjs`
  — **1/1 passed**, **36 requests / 13 audited events**, native AppModule workflow
  plus plain compiled main readiness. Snapshot output is synthetic and normalizes
  IDs, timestamps and one-time keys. Log `/tmp/b06-dashboard-capture.log`.
- The scanner regression first failed with ENOENT on a deleted tracked fixture,
  then passed while still detecting a separate extant synthetic secret. Other
  filesystem errors remain fatal. Initial verify's unrelated W01 deletion failure
  is therefore resolved, not suppressed globally.
- The final empty-fleet audit regression first failed `false !== true`, proving
  the removed nonempty-fleet gate was still a conversion-era condition. After its
  removal, `npm run format:check`, `npm run lint`, `npm run typecheck`,
  `npm run build`, and `node --test test/admin-fleet.integration.mjs` all passed;
  the compiled audit/fleet suite reported **11/11**, exit 0. Logs
  `/tmp/b06-final-checks.log`, `/tmp/b06-audit-final.log`. The broader verify run
  above preceded only this final audit-gate removal and fixture/snapshot updates;
  unchanged unit/security suites were not needlessly repeated.
- `git diff --check -- backend` passed. A filesystem/package JSON check after the
  normal clean build found **zero deleted migration compiled remnants**, **zero
  executable migration package references**, and `dist/main.js` present. Repeated
  normal Nest builds use `deleteOutDir: true`; no manual dist cleanup was used.

Initial intermediate failures were stale fixture identities, missing B02/B04 test
DI/route inventory, the above active-user fixture, or explicitly described red
regressions. No production qualification/authentication gate was weakened to turn
them green. Existing Mongoose `validateSync` deprecation warnings remain.

## Development and review limits

Old development records may be incompatible. Keep databases and ownership journals
intact; manually re-enroll through the current installer against fresh development
state, or obtain separate authorization for a disposable reset. No converter or
reset is supplied or executed. The documented later V03 sequence requires verified
idle/stopped ownership, matching backend/worker releases, pairing/readiness and
end-to-end lifecycle checks.

D01 still owns removal of the dashboard's old manual-registration form and final
pairing UI. This intermediate checkout is not deployable until that integration
is complete. B03 event ingestion, native installers/secret stores/GPU/service
reboot proof, artifact signing/publication and live S3/production behavior are
outside B06. The shared fixture uses synthetic persisted approved release/profile
metadata and service observations, not actual native qualification evidence.

Independent review is required before B06 is marked complete. Review the named B06
responsibilities above rather than attributing the whole uncommitted prerequisite
diff to this task.
