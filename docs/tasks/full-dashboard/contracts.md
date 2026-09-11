# Dashboard API contract and shared conventions

Status: proposed contract for backend-first implementation. Read [scope](scope.md) first. Routes below are relative to `/api/v1`. Names introduced here are targets, not assertions that routes already exist. Existing mobile/worker routes and error envelopes remain compatible.

## HTTP, identities, concurrency and pagination

All `/admin/*` requests require verified Firebase Google identity and a current enabled `admin_access` record. Admin identity does not require a provisioned mobile profile/device. Verify revocation/disabled identity using the existing Firebase verification path; normalize and bind verified email to UID through a trusted lookup, never a browser email claim. Worker bearer credentials cannot authenticate as administrators. Use no-store on all admin responses.

Permission changes, credential issuance/rotation/revocation, stopped recovery, release publication/withdrawal, processing suspension, settings changes and media grants require Google reauthentication with `authTimeSec` at most 300 seconds old. Ordinary list/read requests need a valid current session. Return 403 `ADMIN_REAUTH_REQUIRED` for stale authentication without replaying the mutation automatically.

Lists accept `limit` integer 1–100 (default 25) and opaque `cursor`, with {items, nextCursor, asOf}. Cursors encode validated filter/sort scope and a stable unique tiebreaker; no raw Mongo queries, regular expressions or arbitrary sort names. Mismatched cursor/filter returns 400. List `asOf` means observation time unless an endpoint explicitly promises a frozen dataset. Dates are ISO UTC; UI sends explicit from/to instants and displays chosen timezone (default browser timezone). Use [from,to) intervals, default last 7 days, maximum 90 days for statistics/exports.

Common administrative error body: {code, message, requestId, details?}. Details are field errors or safe current revision/status, never database traces, tokens, media titles, object keys or signed URLs. Adapter must preserve existing non-admin errors unchanged.

- 400 INVALID_REQUEST / INVALID_CURSOR / INVALID_DATE_RANGE.
- 401 UNAUTHENTICATED.
- 403 ADMIN_ACCESS_DENIED / ADMIN_REAUTH_REQUIRED / PERMISSION_DENIED.
- 404 RESOURCE_NOT_FOUND for authorized lookups of absent/deleted records.
- 409 REVISION_CONFLICT / OPERATION_IN_PROGRESS / JOB_STATE_CONFLICT / LAST_OWNER_REQUIRED / WORKER_NOT_IDLE / RECOVERY_PROOF_REQUIRED.
- 410 MEDIA_UNAVAILABLE for authorized media whose pinned object no longer exists.
- 413 UPLOAD_TOO_LARGE; 422 APK_REJECTED / INVALID_UPDATE_POLICY / NEW_INPUT_REQUIRED.
- 429 RATE_LIMITED with Retry-After; 503 DEPENDENCY_UNAVAILABLE with safe dependency label.

Revisioned writes carry integer `expectedRevision` >=0, UUID `operationId`, and trimmed non-secret `reason` of 1–500 characters where shown below. Bound body sizes centrally (ordinary admin JSON <=64 KiB). Concurrency uses matched revisions plus transactions, not frontend button disabling. Critical writes and their audit events commit atomically. If audit persistence fails, fail the write.

Non-secret mutation receipts keyed by actor+route+operationId support safe read-back at `GET /admin/operations/:operationId` (actor or owner only). Response {operationId,status: pending|succeeded|failed,resourceId,revision?,code?}; no key/media URL in receipt. Same ID+different normalized body returns 409. Never automatically replay key issuance. A lost key response requires inspecting the worker and explicitly rotating while idle with a new operationId.

Use the existing Redis rate limiter, with configurable centrally validated admin ceilings: reads 120/minute per UID, ordinary writes 30/minute, media grants 20/minute, key/recovery operations 5/minute and exports 5/hour. Preserve stricter application/global limits. Count rejected authenticated requests consistently; errors never expose role membership to anonymous clients.

## Shared read models

- AdminSession: {uid, verifiedEmail, role, permissions:string[], accessRevision, authTimeSec, serverTime}.
- AdminAccess: {uid, verifiedEmail, role, active, revision, createdAt, updatedAt}; owner list only.
- WorkerSummary: {id,label,state: enabled|draining|revoked,online:boolean,lastSeenAt:null|ISO,activeJobId:null|string,activeAttemptId:null|string,recoveryRequired:boolean,revision}. Online is recent authenticated activity within the documented lease/liveness threshold; offline alone never means stopped. Detail adds protocolVersion, slot state, bounded recent events and exact assignment selectors. No raw keys or digests.
- JobSummary: {id,userId,status,workerId:null|string,createdAt,queuedAt:null|ISO,startedAt:null|ISO,finishedAt:null|ISO,elapsedSeconds:null|number,queuePosition:null|number,revision,lastError:null|{code,message}}. Queue position is observed eligible jobs ahead +1, nullable outside queued state. WorkerId may be null for legacy history. Detail adds retryOfJobId:null|string, stageTimings:[{stage,startedAt:null|ISO,finishedAt:null|ISO,durationSeconds:null|number}], declaredDurationSeconds:null|number, measuredDurationSeconds:null|number, and media:{inputAvailable:boolean,resultAvailable:boolean}. Attempts are separately paginated. User email/name requires users.read; media names appear only with media.read.
- AttemptSummary: {id,jobId,workerId:null|string,sessionId,generation,outcome:ready|failed|cancelled|interrupted|null,startedAt,processingStartedAt:null|ISO,processingEndedAt:null|ISO,processingElapsedApproximate:boolean,endedAt:null|ISO,interruptedAt:null|ISO,replacementAttemptId:null|string,localDataDeletedAt:null|ISO,recoveryRequired:boolean}. Map id to persisted attemptId, not Mongo internal _id. Preserve actual outcome and timestamp fields from job-attempt.schema.ts; null outcome is not proof that a process is running, and terminal job status is not stopped-process proof. recoveryRequired derives from the still-reserved control. Worker detail assignment is null or {jobId,attemptId,sessionId,generation,leaseExpiresAt}; its slotState is idle|active|recovery_required. No credential material appears in these models.
- UserSummary: {id,email:null|string,displayName,status: active|disabled|deleting,processingSuspended:boolean,createdAt,updatedAt,revision}. Detail adds processing counts, recent job IDs and suspension reason/actor/time. Do not invent last-login/device/IP analytics.
- MediaGrant: {url,expiresAt,bytes,contentType,filename}; temporary URL only in this one no-store response, never a list, audit record, operation receipt or browser persistence.
- ProcessingSettings: {revision,acceptNewJobs,maintenanceMessageEn,maintenanceMessageAr:null|string,maxInputBytesExclusive,maxDurationSecondsExclusive,maxActiveJobsPerUser:null|integer,updatedAt}. Public presenter is additive and excludes administrator identity/reason.
- ReleaseSummary: {id,platform:android|ios,source:direct_apk|google_play|app_store,versionName,buildNumber,changelogEn,storeUrl:null|string,state:draft|published|withdrawn,artifactState:null|awaiting_upload|verifying|verified|rejected,revision,createdAt,publishedAt:null|ISO}. Detail adds bytes, checksum, signer fingerprint, safe rejection code and publisher to authorized release readers; never object keys.
- AuditEvent: {id,actorUid,action,resourceType,resourceId,operationId,reason:null|string,at,previousRevision:null|number,nextRevision:null|number,outcome,stopEvidence?:{attestation,stoppedAt,jobId,attemptId,sessionId,generation},exportMetadata?:{dataset:jobs|overview,from,to,rowCount}}. stopEvidence is present only for stopped worker recovery. exportMetadata is present only for CSV export events, with UTC interval and rowCount from 0 to 10000; CSV bodies are never retained. No media names, email changes as payload dumps, secret hashes, presigned URLs or raw request bodies.
- HealthSnapshot: {asOf,components:[{name:api|mongodb|redis|storage|workers,status:healthy|degraded|unavailable|unknown,checkedAt:null|ISO,code:null|string}],activeAlertCount}. API responses distinguish not checked from healthy.
- Alert: {id,type,severity:warning|critical,resourceId:null|string,state:active|resolved,firstSeenAt,lastSeenAt,resolvedAt:null|ISO,acknowledgedAt:null|ISO,acknowledgedBy:null|string,revision,message}. Acknowledgment does not clear the underlying problem.

## Access and audit routes

| Route                              | Request                                                          | Response / permission                                                              |
| ---------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| GET /admin/session                 | none                                                             | AdminSession; admission only                                                       |
| GET /admin/access                  | limit,cursor,active?                                             | Page<AdminAccess>; admin.access.manage                                             |
| POST /admin/access                 | verifiedEmail,role,operationId,reason                            | Resolve existing verified Google UID; AdminAccess; admin.access.manage, fresh auth |
| PATCH /admin/access/:uid           | role?,active?,expectedRevision,operationId,reason                | AdminAccess; owner; at least one changed field, atomic last-owner invariant        |
| GET /admin/operations/:operationId | none                                                             | safe receipt; actor or owner                                                       |
| GET /admin/audit                   | from,to,actorUid?,action?,resourceType?,resourceId?,limit,cursor | Page<AuditEvent>; audit.read                                                       |

No hard-delete administrator endpoint. An explicit dry-run/apply CLI bootstrap privately supplies the first Google owner identity; it refuses to overwrite populated access records and is never run automatically. Owner suspension in Firebase triggers access denial; trusted recovery must preserve the last-owner boundary.

## Worker routes

| Route                                   | Request                                                                                         | Response                                                                  |
| --------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| GET /admin/workers                      | state?,online?,limit,cursor                                                                     | Page<WorkerSummary>; workers.read                                         |
| GET /admin/workers/:id                  | none                                                                                            | worker detail; workers.read                                               |
| POST /admin/workers                     | id,label,operationId,reason                                                                     | {worker,rawKey}; workers.manage, fresh auth; return key once              |
| PATCH /admin/workers/:id                | label,expectedRevision,operationId,reason                                                       | WorkerSummary; workers.manage                                             |
| POST /admin/workers/:id/drain           | expectedRevision,operationId,reason                                                             | WorkerSummary; workers.manage                                             |
| POST /admin/workers/:id/enable          | expectedRevision,operationId,reason                                                             | WorkerSummary; workers.manage; revoked cannot enable                      |
| POST /admin/workers/:id/rotate-key      | expectedRevision,operationId,reason                                                             | {worker,rawKey}; workers.manage, fresh auth; idle only                    |
| POST /admin/workers/:id/revoke          | expectedRevision,operationId,reason,emergency:boolean                                           | WorkerSummary; workers.manage, fresh auth; active requires emergency=true |
| POST /admin/workers/:id/release-stopped | expectedRevision,operationId,reason,jobId,attemptId,sessionId,generation,stoppedAt,stopEvidence | WorkerSummary; workers.recover, fresh auth                                |

Worker id is lowercase [a-z0-9-], 1–64 characters; label 1–100. Key is generated with crypto.randomBytes(32).toString('hex'); store its SHA-256 only. Registration requires unique identity/hash; normal UI has no digest import or reveal. Existing key import is confined to trusted migration. stopEvidence is a 20–1000 character non-secret operator attestation identifying observed process termination; UI cannot infer it from heartbeat. Reject future stoppedAt and stale assignment/generation; evidence is audit-visible but never executable. Revoked registrations stay revoked; reactivation requires a new registration, not recycled credentials.

Backend fleet contract also includes authenticated `POST /worker/identity` returning {workerId,state,protocolVersion:2}; existing worker endpoints receive authority from authenticated worker identity. Implement compatibility/migration gates from the fleet design; no live migration in this task package.

## Jobs, users and audio

| Route                                    | Request                                                 | Response / permission                                                 |
| ---------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------- |
| GET /admin/jobs                          | status?,userId?,workerId?,jobId?,from?,to?,limit,cursor | Page<JobSummary>; jobs.read                                           |
| GET /admin/jobs/:id                      | none                                                    | job detail; jobs.read                                                 |
| GET /admin/jobs/:id/attempts             | limit,cursor                                            | Page<attempt>; jobs.read                                              |
| POST /admin/jobs/:id/cancel              | expectedRevision,operationId,reason                     | {jobId,status,revision}; jobs.manage                                  |
| POST /admin/jobs/:id/retry               | expectedRevision,operationId,reason                     | {sourceJobId,newJobId,status:queued}; jobs.manage                     |
| GET /admin/users                         | query?,status?,processingSuspended?,limit,cursor        | Page<UserSummary>; users.read                                         |
| GET /admin/users/:id                     | none                                                    | user detail; users.read                                               |
| POST /admin/users/:id/suspend-processing | expectedRevision,operationId,reason                     | UserSummary; users.processing.manage, fresh auth                      |
| POST /admin/users/:id/resume-processing  | expectedRevision,operationId,reason                     | UserSummary; same checks; cannot reactivate disabled/deleting account |
| POST /admin/jobs/:id/media-grants        | asset:input                                             | result,purpose:play                                                   | download,reason,operationId | MediaGrant; media.read + jobs.read, fresh auth |

Search query trimmed 2–100 characters; exact UID/email and escaped anchored display-name prefix only, indexed where supported; never arbitrary regex. Cancellation reuses the existing state machine with a separately authorized admin actor, never impersonated user credentials. Retry reuses admission and existing input/error eligibility; deleting/disabled/suspended users and closed admission prevent retry.

Media grants expire after 300 seconds. Only verified pinned input versions and verified published result versions are eligible. Recheck owner deletion fences and object availability immediately before issuing; return no grant during deleting/deleted state. Sign only the stored object version. Set inline disposition for play and attachment for download with sanitized filename; support browser range requests via S3 GET. No S3 list, arbitrary object path, media proxy or bucket-public toggle. Audit grant issuance, not an unsupported claim of actual playback/download completion. Already issued URLs remain usable until expiration; deleting data or revoking users cannot promise instant S3 URL revocation. Browser playback starts only from a tap. No automatic retry of grant mutations after an uncertain response.

## Processing settings

GET /admin/settings/processing returns ProcessingSettings (settings.read).
PUT /admin/settings/processing accepts all editable ProcessingSettings fields excluding revision/updatedAt, plus expectedRevision,operationId,reason (settings.manage, fresh auth).

Validation: booleans actual booleans; English message 1–1000 characters when admissions closed, optional/empty when open; Arabic null or <=1000 characters. Bytes exclusive integer 2..30,000,000; duration exclusive finite number >0 and <=600; maxActiveJobsPerUser null or integer 1..100. Null initial cap preserves prior behavior. Public rate-limited no-store GET /processing-policy returns {schemaVersion:1,revision,acceptNewJobs,messageEn,messageAr,limits:{maxInputBytesExclusive,maxDurationSecondsExclusive,maxActiveJobsPerUser},checkedAt}. It contains no administrator identity or personal suspension state. Admission readiness may deny work even when the configured switch is on; existing readiness remains authoritative and must not be presented as overridden by this policy. Keep legacy policy shapes unchanged. Mobile-specific UI consumption stays outside this dashboard package.

## Releases and update policy

Reuse public types and decisions from the existing update design; the route names below standardize the admin frontend. Do not implement a second policy authority.

- GET /admin/releases?platform=&source=&state=&limit=&cursor= -> Page<ReleaseSummary> (releases.read).
- GET /admin/releases/proposal?platform=&source= -> {platform,source,current:{versionName,buildNumber},suggested:{versionName,buildNumber}} (releases.read). Current is channel-specific and cannot be lower than the maintained platform app floor.
- POST /admin/releases -> draft (releases.manage). Body platform,source,versionName,buildNumber,changelogEn,storeUrl:null|string,operationId,reason. Validate permitted source/platform pairs, one to three numeric version components without leading zeroes, build integer 1..2147483647, changelogEn 1–10,000 characters and HTTPS store allowlist/expected app identity. Both version and build must be newer than the current channel floor. Direct APK has no arbitrary URL.
- GET /admin/releases/:id -> detail (releases.read).
- PATCH /admin/releases/:id -> draft detail (releases.manage). Body versionName?,buildNumber?,changelogEn?,storeUrl?,expectedRevision,operationId,reason; reject published mutation, version/build downgrades, and artifact-identity changes after verified upload.
- POST /admin/releases/:id/uploads -> {uploadId,grant:{url,fields,expiresAt},expectedBytes,expectedSha256} (releases.manage). Body bytes,sha256Hex,expectedRevision,operationId. Direct draft only, 1..268435456 bytes; unique server-generated key. Never send Firebase bearer to S3.
- POST /admin/releases/:id/uploads/:uploadId/complete -> {artifactState:verifying|verified|rejected,code?} (releases.manage). Body operationId. Repeated completion is safe; only one bounded verification lease inspects the pinned version.
- GET /admin/releases/:id/uploads/:uploadId -> {artifactState,code?,checkedAt} (releases.read).
- GET /admin/update-policy -> {revision,android:{minimumBuild,directReleaseId,storeReleaseId,source},ios:{minimumBuild,storeReleaseId}} (releases.read).
- POST /admin/update-policy/preview -> {currentRevision,valid,errors,examples:[{platform,distribution,installedBuild,decision,targetBuild}]} (releases.read). Body complete proposed policy selection; no state writes or download URL.
- POST /admin/releases/:id/publish -> {release,policyRevision,operationId} (releases.manage, fresh auth). Body expectedRevision (policy), expectedReleaseRevision, policy (complete selection), operationId,reason,storeAvailabilityConfirmed:boolean. Require explicit operator store availability attestation for selected store targets; URL syntax alone is not store rollout proof.
- POST /admin/releases/:id/withdraw -> {release,policyRevision,operationId} (same permission/fresh auth). Body expectedRevision,expectedReleaseRevision,replacementPolicy,operationId,reason. Replacement policy must be valid for every active channel. Withdrawal changes selection/minimum explicitly; never downgrades installed apps or deletes artifacts.

Public GET /app-updates/policy?platform=&distribution= returns the existing design's UpdatePolicySnapshot; POST /app-updates/releases/:id/download returns its ReleaseDownloadGrant. Public endpoints are rate-limited, no-store, unauthenticated and expose no admin identity. Artifact uploads/downloads remain private S3. Changelog is plain text; never render uploaded HTML.

## Statistics, health, alerts and exports

- GET /admin/overview?from=&to=&bucket=day -> {asOf,from,to,counts:{submitted,completed,failed,cancelled,processingActiveUsers},queue:{waiting,processing,oldestWaitSeconds},timings:{meanQueueWaitSeconds,meanProcessingSeconds,sampleCount},workers:{online,total},series:[{start,submitted,completed,failed,cancelled}],releaseSummary?}. overview.read. releaseSummary requires releases.read; no personal fields.
- Metrics: submitted by createdAt, completed/failed/cancelled by finishedAt and actual terminal status, processingActiveUsers = distinct user IDs submitting within interval. Queue metrics represent current state at asOf. Timings use only valid persisted start/end pairs; null when unavailable, never zero-fill historical missing timing.
- GET /admin/health -> HealthSnapshot (health.read); use bounded cached checks and existing readiness services. No configuration values, private hostnames, raw URLs or credentials.
- GET /admin/alerts?state=&severity=&limit=&cursor= -> Page<Alert> (health.read).
- POST /admin/alerts/:id/acknowledge -> Alert (alerts.manage). Body expectedRevision,operationId,reason.
- Alert defaults: enabled worker lacking heartbeat beyond lease/liveness threshold; interrupted/expired active slot requiring recovery; rejected APK verification; failed dependency probe. Deduplicate per type+resource. Active condition cannot be manually resolved. Bound sampling interval to 30 seconds and probes to 2 seconds with single-flight cache; startup unknown is not failure.
- GET /admin/exports/jobs.csv and GET /admin/exports/overview.csv take the corresponding page filters/date range (exports.read plus jobs.read/overview.read), not arbitrary field lists. Return text/csv UTF-8 attachment with server timestamp, documented fixed headers, max 10,000 rows; respond 422 EXPORT_TOO_LARGE before output begins if cap exceeded. No silent truncation or background export queue.
- CSV snapshots use a bounded read/snapshot approach appropriate to the existing MongoDB version; first gather the capped authorized projection, then emit. Escape quotes/newlines; neutralize cells beginning =,+,-,@,TAB,CR to prevent spreadsheet formulas. Export excludes emails, names, media, keys and URLs. Record actor, filter interval and row count in a metadata-only audit event.

## Local verification contracts

Use Vitest unit tests beside source, Nest HTTP tests under backend/test/*.e2e-spec.ts, and compiled-node integrations using existing isolated-service helpers. New integration entrypoints must invoke those helpers and reject non-local service targets. Browser tests use owned fixtures and Firebase doubles/emulators, not real user recordings/accounts.

Every task records commands, observed output, source paths, remaining limits and the tested revision. Future fixture service names such as api, fixtures, signInAs in example snippets describe local test-harness interfaces to create in B01/D01; they are not production APIs.
