# Dashboard API

This is the implemented backend handoff for the React + TypeScript + Vite administrator dashboard. Paths are relative to `/api/v1`. Send the current Firebase ID token as `Authorization: Bearer <token>`. Every `/admin/*` response is `Cache-Control: no-store` and requires an enabled administrator record whose UID and normalized verified Google email still match Firebase.

The dashboard must treat server permissions, revisions and lifecycle state as authoritative. Mutations marked **fresh** require Google authentication no more than 300 seconds old and return `403 ADMIN_REAUTH_REQUIRED` when stale.

## Shared wire rules

Pages return `{items,nextCursor,asOf}`. `limit` is 1–100 and defaults to 25. A `cursor` is opaque and bound to the filters that created it. Date ranges are UTC ISO instants, use `[from,to)`, default to seven days where applicable, and cannot exceed 90 days.

Revisioned writes require nonnegative integer `expectedRevision`, UUID v4 `operationId`, and a trimmed `reason` of 1–500 characters unless stated otherwise. Critical state and audit writes commit atomically. Reusing an operation ID with a different normalized request conflicts. A lost response can be inspected through the operation endpoint; secret keys and signed URLs never appear in receipts.

Administrative errors are JSON:

```json
{
  "code": "REVISION_CONFLICT",
  "message": "Revision conflict",
  "requestId": "uuid"
}
```

`details` is optional and safe. Codes/statuses are: `400 INVALID_REQUEST`, `INVALID_CURSOR`, `INVALID_DATE_RANGE`; `401 UNAUTHENTICATED`; `403 ADMIN_ACCESS_DENIED`, `ADMIN_REAUTH_REQUIRED`, `PERMISSION_DENIED`; `404 RESOURCE_NOT_FOUND`; `409 REVISION_CONFLICT`, `OPERATION_IN_PROGRESS`, `JOB_STATE_CONFLICT`, `LAST_OWNER_REQUIRED`, `WORKER_NOT_IDLE`, `RECOVERY_PROOF_REQUIRED`; `410 MEDIA_UNAVAILABLE`; `413 UPLOAD_TOO_LARGE`; `422 INVALID_UPDATE_POLICY`, `EXPORT_TOO_LARGE`; `429 RATE_LIMITED`; and `503 DEPENDENCY_UNAVAILABLE`.

## Session, access, operations and audit

| Method and path                      | Query/body                                                                                | Success               | Authority             |
| ------------------------------------ | ----------------------------------------------------------------------------------------- | --------------------- | --------------------- |
| `GET /admin/session`                 | none                                                                                      | `AdminSession`        | admitted admin        |
| `GET /admin/access`                  | `active?`, `limit?`, `cursor?`                                                            | page of `AdminAccess` | `admin.access.manage` |
| `POST /admin/access`                 | `verifiedEmail`, `role`, `operationId`, `reason`                                          | `AdminAccess`         | same, fresh           |
| `PATCH /admin/access/:uid`           | `role?`, `active?`, `expectedRevision`, `operationId`, `reason`                           | `AdminAccess`         | same, fresh           |
| `GET /admin/operations/:operationId` | owner may add `actorUid`                                                                  | `OperationReceipt`    | actor or owner        |
| `GET /admin/audit`                   | `from`, `to`, `actorUid?`, `action?`, `resourceType?`, `resourceId?`, `limit?`, `cursor?` | page of `AuditEvent`  | `audit.read`          |

`AdminSession` is `{uid,verifiedEmail,role,permissions,accessRevision,authTimeSec,serverTime}`. `AdminAccess` is `{uid,verifiedEmail,role,active,revision,createdAt,updatedAt}`. Roles are `owner`, `release_manager`, `worker_manager`, `support`, and `viewer`. At least one active owner is preserved; no hard-delete route exists.

`OperationReceipt` is `{operationId,status:"pending"|"succeeded"|"failed",resourceId,revision?,code?}`. Key issuance is never replayed. `AuditEvent` is `{id,actorUid,action,resourceType,resourceId,operationId,reason,at,previousRevision,nextRevision,outcome,stopEvidence?}`; stopped-recovery evidence includes `{attestation,stoppedAt,jobId,attemptId,sessionId,generation}`.

## Workers

| Method and path                           | Query/body                                                                                                          | Success                           | Authority                |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ------------------------ |
| `GET /admin/workers`                      | `state?`, `online?`, `limit?`, `cursor?`                                                                            | page of `WorkerSummary`           | `workers.read`           |
| `GET /admin/workers/:id`                  | none                                                                                                                | worker detail                     | `workers.read`           |
| `POST /admin/workers`                     | `id`, `label`, `operationId`, `reason`                                                                              | `{worker,rawKey}` once            | `workers.manage`, fresh  |
| `PATCH /admin/workers/:id`                | `label`, `expectedRevision`, `operationId`, `reason`                                                                | `WorkerSummary`                   | `workers.manage`         |
| `POST /admin/workers/:id/drain`           | common revisioned body                                                                                              | `WorkerSummary`                   | `workers.manage`         |
| `POST /admin/workers/:id/enable`          | common revisioned body                                                                                              | `WorkerSummary`                   | `workers.manage`         |
| `POST /admin/workers/:id/rotate-key`      | common revisioned body                                                                                              | `{worker,rawKey}` once; idle only | `workers.manage`, fresh  |
| `POST /admin/workers/:id/revoke`          | common body plus boolean `emergency`                                                                                | `WorkerSummary`                   | `workers.manage`, fresh  |
| `POST /admin/workers/:id/release-stopped` | common body plus `jobId`, UUID `attemptId`, UUID `sessionId`, integer `generation`, ISO `stoppedAt`, `stopEvidence` | `WorkerSummary`                   | `workers.recover`, fresh |

Worker IDs are lowercase `[a-z0-9-]`, length 1–64; labels are 1–100 characters. `stopEvidence` is 20–1000 characters and must attest that the exact external process stopped. Heartbeat loss is insufficient.

`WorkerSummary` is `{id,label,state,online,lastSeenAt,activeJobId,activeAttemptId,recoveryRequired,revision}`. Detail adds `protocolVersion:2`, `slotState`, `assignment:null|{jobId,attemptId,sessionId,generation,leaseExpiresAt}`, and bounded `recentEvents`. No key digest is returned.

## Jobs, users and media

| Method and path                                     | Query/body                                                                       | Success                                  | Authority                            |
| --------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------ |
| `GET /admin/jobs`                                   | `status?`, `userId?`, `workerId?`, `jobId?`, `from?`, `to?`, `limit?`, `cursor?` | page of `JobSummary`                     | `jobs.read`                          |
| `GET /admin/jobs/:id`                               | none                                                                             | job detail                               | `jobs.read`                          |
| `GET /admin/jobs/:id/attempts`                      | `limit?`, `cursor?`                                                              | page of `AttemptSummary`                 | `jobs.read`                          |
| `POST /admin/jobs/:id/cancel`                       | common revisioned body                                                           | `{jobId,status,revision}`                | `jobs.manage`                        |
| `POST /admin/jobs/:id/retry`                        | common revisioned body                                                           | `{sourceJobId,newJobId,status:"queued"}` | `jobs.manage`                        |
| `GET /admin/users`                                  | `query?`, `status?`, `processingSuspended?`, `limit?`, `cursor?`                 | page of `UserSummary`                    | `users.read`                         |
| `GET /admin/users/:id`                              | none                                                                             | user detail                              | `users.read`                         |
| `POST /admin/users/:id/suspend-processing`          | common revisioned body                                                           | `UserSummary`                            | `users.processing.manage`, fresh     |
| `POST /admin/users/:id/resume-processing`           | common revisioned body                                                           | `UserSummary`                            | same, fresh                          |
| `GET /admin/account-recovery-requests`              | `status?`, `limit?`, `cursor?`                                                   | page of `AccountRecoveryRequest`         | `users.account-recovery.manage`      |
| `GET /admin/account-recovery-requests/summary`      | none                                                                             | active pending count and oldest request  | same                                 |
| `GET /admin/account-recovery-requests/:id`          | none                                                                             | `AccountRecoveryRequest`                 | same                                 |
| `POST /admin/account-recovery-requests/:id/approve` | common revisioned body                                                           | approved request and restored user state | same, fresh                          |
| `POST /admin/account-recovery-requests/:id/reject`  | common revisioned body                                                           | rejected request                         | same, fresh                          |
| `POST /admin/jobs/:id/media-grants`                 | `asset:"input"                                                                   | "result"`, `purpose:"play"               | "download"`, `operationId`, `reason` | `MediaGrant` | `jobs.read` + `media.read`, fresh |

`JobSummary` is `{id,userId,status,workerId,createdAt,queuedAt,startedAt,finishedAt,elapsedSeconds,queuePosition,revision,lastError}`. Actors with `media.read` also receive the safe display name and the canonical YouTube `sourceUrl` when one was recorded. Detail adds `retryOfJobId`, `stageTimings`, declared/measured duration, and `{inputAvailable,resultAvailable}`. `AttemptSummary` preserves attempt/session/generation/outcome and processing/interruption/replacement/local-deletion timestamps, plus approximation/duration/recovery fields.

`UserSummary` is `{id,email,displayName,status,processingSuspended,createdAt,updatedAt,revision}`. Detail adds `processingCounts`, `recentJobIds`, `suspension:{reason,actorUid,at}`, and the scheduled deletion/recovery deadline when present. Search is 2–100 trimmed characters and supports exact UID/email or escaped display-name prefix.

The recovery list defaults to active `pending` requests and also supports
`approved`, `rejected`, `expired`, and `all`. A stored pending request past its
deadline is presented under `expired` and is excluded from the summary count.
`AccountRecoveryRequest` includes request/review state, the user's optional reason,
deadline, revision, and safe user identity fields. Approve/reject bodies use the
common revision fields and require a nonblank review reason. Both decisions are
audited operation-receipt mutations; approval also atomically restores the user and
identity fence. The dashboard polls the summary only while visible and renders a
high-priority count badge when `pendingCount > 0`.

`MediaGrant` is `{url,expiresAt,bytes,contentType,filename}` and expires after 300 seconds. It signs the stored object version. Already issued S3 URLs can remain usable until expiry; later suspension, deletion or policy change cannot promise instant URL revocation. Never persist grant URLs in dashboard storage.

## Processing settings

`GET /admin/settings/processing` returns `ProcessingSettings` with `settings.read`. `PUT /admin/settings/processing` requires `settings.manage`, fresh auth, all editable settings, and the common revisioned fields.

The shape is `{revision,acceptNewJobs,maintenanceMessageEn,maintenanceMessageAr,maxInputBytesExclusive,maxDurationSecondsExclusive,maxActiveJobsPerUser,updatedAt}`. Bytes are integer 2–30,000,000; duration is finite, positive and at most 600; the cap is null or integer 1–100. English maintenance text is required when admission closes. Public no-store `GET /processing-policy` contains no administrator identity.

## Releases and update policy

| Method and path                                       | Query/body                                                                                                     | Success                                                                                   | Authority                |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------ |
| `GET /admin/releases`                                 | `platform?`, `source?`, `state?`, `limit?`, `cursor?`                                                          | page of `ReleaseSummary`                                                                  | `releases.read`          |
| `GET /admin/releases/proposal`                        | `platform`, `source`                                                                                           | `{platform,source,current:{versionName,buildNumber},suggested:{versionName,buildNumber}}` | `releases.read`          |
| `GET /admin/releases/:id`                             | none                                                                                                           | release detail                                                                            | `releases.read`          |
| `POST /admin/releases`                                | `platform`, `source`, `versionName`, `buildNumber`, `changelogEn`, `storeUrl`, `operationId`, `reason`         | draft detail                                                                              | `releases.manage`        |
| `PATCH /admin/releases/:id`                           | editable fields plus common revision fields                                                                    | draft detail                                                                              | `releases.manage`        |
| `POST /admin/releases/:id/uploads`                    | `bytes`, `sha256Hex`, `expectedRevision`, `operationId`                                                        | `{uploadId,grant:{method:"PUT",url,headers,expiresAt},expectedBytes,expectedSha256}`      | `releases.manage`, fresh |
| `POST /admin/releases/:id/uploads/:uploadId/complete` | `operationId`                                                                                                  | `{artifactState,code?}`                                                                   | `releases.manage`, fresh |
| `GET /admin/releases/:id/uploads/:uploadId`           | none                                                                                                           | `{artifactState,code?,checkedAt}`                                                         | `releases.read`          |
| `GET /admin/update-policy`                            | none                                                                                                           | complete current policy                                                                   | `releases.read`          |
| `POST /admin/update-policy/preview`                   | complete proposed policy                                                                                       | `{currentRevision,valid,errors,examples}`                                                 | `releases.read`          |
| `POST /admin/releases/:id/publish`                    | `expectedRevision`, `expectedReleaseRevision`, `policy`, `operationId`, `reason`, `storeAvailabilityConfirmed` | `{release,policyRevision,operationId}`                                                    | `releases.manage`, fresh |
| `POST /admin/releases/:id/withdraw`                   | `expectedRevision`, `expectedReleaseRevision`, `replacementPolicy`, `operationId`, `reason`                    | same                                                                                      | `releases.manage`, fresh |

`ReleaseSummary` is `{id,platform,source,versionName,buildNumber,changelogEn,storeUrl,state,artifactState,revision,createdAt,publishedAt}`. Detail adds bytes, checksum, signer fingerprint, safe rejection code and publisher; object keys are excluded. Direct APK uploads are 1–268,435,456 bytes with lowercase 64-character SHA-256.

Release versions are one to three numeric components without leading zeroes (for example, `1`, `1.2`, or `1.2.3`). The proposal is channel-specific and uses the greater of the maintained platform floor (`APP_ANDROID_CURRENT_VERSION_NAME`/`APP_ANDROID_CURRENT_BUILD_NUMBER` or the iOS equivalents) and existing release records. Its suggested values remain editable, but creating a release—or changing a draft's version/build identity—requires both the semantic version and integer build number to advance. The backend rechecks those invariants in the write transaction; the dashboard check is only immediate operator feedback.

Update policy is `{revision,android:{minimumBuild,directReleaseId,storeReleaseId,source},ios:{minimumBuild,storeReleaseId}}`. Preview examples are `{platform,distribution,installedBuild,decision,targetBuild}`. Withdrawal requires a valid replacement and neither deletes artifacts nor downgrades installed apps. Public APK grants are version-pinned, expire after `APP_RELEASE_DOWNLOAD_SECONDS` (300 seconds by default), and the grant/redirect routes allow 10 requests per minute per IP. Render changelog as plain text.

## Overview, health, alerts and exports

| Method and path                      | Query/body                                    | Success                     | Authority                        |
| ------------------------------------ | --------------------------------------------- | --------------------------- | -------------------------------- |
| `GET /admin/overview`                | `from?`, `to?`, `bucket=day`                  | `OverviewSnapshot`          | `overview.read`                  |
| `GET /admin/health`                  | none                                          | `HealthSnapshot`            | `health.read`                    |
| `GET /admin/alerts`                  | `state?`, `severity?`, `limit?`, `cursor?`    | page of `Alert`             | `health.read`                    |
| `POST /admin/alerts/:id/acknowledge` | common revisioned body                        | active acknowledged `Alert` | `alerts.manage`                  |
| `GET /admin/exports/jobs.csv`        | job filters and dates; no limit/cursor        | UTF-8 CSV                   | `exports.read` + `jobs.read`     |
| `GET /admin/exports/overview.csv`    | `from?`, `to?`, `bucket=day`; no limit/cursor | UTF-8 CSV                   | `exports.read` + `overview.read` |

`OverviewSnapshot` is `{asOf,from,to,counts,queue,timings,workers,series,releaseSummary?}`. `timings` contains `{meanQueueWaitSeconds,meanProcessingSeconds,sampleCount:{queueWait,processing}}`; missing timing is null. `releaseSummary` appears only with `releases.read`.

`HealthSnapshot` is `{asOf,components,activeAlertCount}`. Components are `{name:"api"|"mongodb"|"redis"|"storage"|"workers",status:"healthy"|"degraded"|"unavailable"|"unknown",checkedAt,code}`. Startup is unknown; probes are bounded to two seconds and samples are single-flight/cached for 30 seconds. Output excludes private connection details.

`Alert` is `{id,type,severity,resourceId,state,firstSeenAt,lastSeenAt,resolvedAt,acknowledgedAt,acknowledgedBy,revision,message}`. Acknowledgment never resolves a condition or frees a worker slot. Recovery resolves the history row; recurrence creates a new unacknowledged episode.

Jobs CSV headers are `id,userId,status,workerId,createdAt,queuedAt,startedAt,finishedAt,elapsedSeconds,errorCode`. Overview headers are `bucketStart,submitted,completed,failed,cancelled`. Both cap at 10,000 rows, neutralize formula prefixes, and exclude email, names, media, keys and URLs. Each export audits metadata `{dataset,from,to,rowCount}`; metadata and operation ID are not emitted in the CSV.
