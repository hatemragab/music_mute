# Backend API task index

> Backend implementation and its B18 local handoff gate are complete. Live provider, hosted, Windows-machine and mobile-device proof remains separate.

**Goal:** Deliver every backend API required by the approved dashboard before starting frontend work.\
**Architecture:** Existing NestJS API and shared domain services, no new audio processing server.\
**Tech Stack:** NestJS, TypeScript ESM, MongoDB/Mongoose, Firebase, S3, Redis, Vitest.\
**Spec:** [Approved scope](../scope.md), [API contracts](../contracts.md), [Execution rules](../README.md).

Execute B01 through B18 in the listed order. Dependencies identify hard gates; this index does not authorize parallel agents or bypass the order. B18 is the required frontend handoff gate.

| Task                                            | Deliverable                                                      | Depends on                                                           | Status      |
| ----------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------- | ----------- |
| [B01](B01-admin-identity-permissions.md)        | Administrator identity, permissions and HTTP foundation          | None                                                                 | COMPLETE |
| [B02](B02-audit-operation-receipts.md)          | Atomic audit events and safe operation receipts                  | B01                                                                  | COMPLETE |
| [B03](B03-administrator-access-management.md)   | Owner bootstrap and administrator access management              | B01, B02                                                             | COMPLETE |
| [B04](B04-fleet-ownership-foundation.md)        | Worker registry and per-machine lifecycle authority              | B01, B02                                                             | COMPLETE |
| [B05](B05-worker-admin-controls.md)             | Worker administration, one-time keys and stopped recovery        | B03, B04                                                             | COMPLETE |
| [B06](B06-processing-settings-admission.md)     | Editable processing settings and admission fences                | B02                                                                  | COMPLETE |
| [B07](B07-user-search-processing-suspension.md) | User search and processing-only suspension                       | B03, B06                                                             | COMPLETE |
| [B08](B08-job-search-detail-attempts.md)        | Job search, queue view and attempt history                       | B04, B07                                                             | COMPLETE |
| [B09](B09-admin-job-cancel-retry.md)            | Administrator cancellation and eligible retries                  | B02, B06, B07, B08                                                   | COMPLETE |
| [B10](B10-private-media-access.md)              | Audited playback and download grants for user media              | B02, B07, B08                                                        | COMPLETE |
| [B11](B11-release-model-public-policy.md)       | Release records and compatible public update policy              | B01, B02                                                             | COMPLETE |
| [B12](B12-apk-upload-verification.md)           | Private APK upload and bounded binary verification               | B11                                                                  | COMPLETE |
| [B13](B13-publish-withdraw-update-policy.md)    | Release preview, atomic publication, withdrawal and download     | B02, B11, B12                                                        | COMPLETE |
| [B14](B14-outdated-client-admission.md)         | Enforce update requirements on new processing submissions        | B06, B09, B13                                                        | COMPLETE |
| [B15](B15-overview-statistics.md)               | Overview metrics and bounded date-range aggregates               | B05, B08, B11                                                        | COMPLETE |
| [B16](B16-health-dashboard-alerts.md)           | System health and persistent dashboard alerts                    | B02, B05, B12                                                        | COMPLETE |
| [B17](B17-csv-exports.md)                       | Bounded safe CSV exports for jobs and statistics                 | B02, B08, B15                                                        | COMPLETE |
| [B18](B18-backend-contract-handoff-gate.md)     | Backend integration, API documentation and frontend handoff gate | B03, B05, B06, B07, B08, B09, B10, B11, B12, B13, B14, B15, B16, B17 | COMPLETE |

## Progress record

- [x] Read shared scope/contracts and applicable repository instructions before execution.
- [x] Record implemented source, validation commands/results and remaining validation limits in the execution and local-validation records.
- [x] Complete B18 with a frozen 44-route permission inventory and 32-response fixture contract before D01.
- [ ] No hosting, deployment, production data changes, source commit or push without a separate user request.
