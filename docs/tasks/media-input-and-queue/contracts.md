# Shared contracts and accounting design

**Status: proposed implementation design for review.** These names define the common interfaces for the task files. TypeScript below is contract notation inside documentation, not implemented code. Reuse existing DTO/request/receipt structures around these additions.

## C1. Versioned policy

Extend existing `GET /api/v1/processing-policy` with a validated `schemaVersion=2` query. Omitted/version 1 continues returning its current shape and capability-clamped exclusive limits. Reject unknown versions safely. No private account usage appears in this public endpoint.

```ts
type InputSource = 'audio_file' | 'video_file' | 'youtube';
type EvidenceStatus = 'verified' | 'unavailable' | 'stale';
interface ProcessingPolicyV2 {
  schemaVersion: 2;
  revision: number;
  acceptNewJobs: boolean;
  acceptLongJobs: boolean;
  checkedAt: string;
  messageEn: string;
  messageAr: string | null;
  limits: {
    maxDurationSeconds: number; // 1800, inclusive
    maxPreparedAudioBytes: number; // 100000000, inclusive; evidence-gated
    maxActiveJobsPerUser: number; // 1
    allowanceAudioSeconds: number; // 3600
    allowanceWindowSeconds: number; // 86400
    maxLocalSourceBytes: number | null; // R01 evidence; null = expansion unavailable
    longJobThresholdSeconds: number; // R02 evidence
    maxSourceDownloadBytes: number | null; // R01 evidence
    maxPreparationSeconds: number | null; // R01 evidence
    maxSourceDownloadSeconds: number | null; // R01 evidence
  };
  preparationProfile: {
    id: string;
    preserveCompatibleAudio: true;
    fallbackConversion: {
      outputContentType: 'audio/mp4';
      codec: 'aac-lc';
      targetBitrate: 256000;
    };
    compatibilityRevision: string;
  };
}
```

Null measurement-dependent values disable the corresponding expanded flow; they never mean unlimited or zero. Existing legacy flows retain safe old behavior until explicit local readiness configuration. Clients distinguish capability/readiness from network failure and never make a guessed larger allowance. The fallback conversion profile does not force already compatible MP3/OGG/other audio to become M4A; copied audio keeps its real supported declaration.

`POST /api/v1/jobs` keeps its existing input declaration/hash/idempotency contract and accepts optional `{ policyVersion: 2, preparationProfileId: string, source: InputSource }` metadata. Omission is the legacy route through old physical ceilings. Source is descriptive only; all origins consume the same account budget. Unknown profile/version fails before signing an upload.

Add versioned snapshot data to the existing `AdmissionSnapshot`, preserving version 1 records and fallback behavior. Snapshot the accepted media/output limits, allowance policy revision, preparation profile, source, queue cost model revision, and creation time. Never expand old reservations automatically. Policy updates do not erase v2 fields when an old dashboard sends a v1-shaped PUT: reject incompatible updates with a safe conflict code and require a refreshed capable editor.

## C2. Account allowance and reservation lifecycle

New owner-only `GET /api/v1/processing-usage` is authenticated and `no-store`:

```ts
interface ProcessingUsage {
  policyRevision: number;
  allowanceAudioSeconds: number;
  usedAudioSeconds: number;
  reservedAudioSeconds: number;
  remainingAudioSeconds: number;
  activeJobs: number;
  maxActiveJobs: number;
  nextReplenishmentAt: string | null;
  replenishments: Array<{ at: string; audioSeconds: number }>;
  availability: 'available' | 'busy' | 'paused' | 'unavailable';
  checkedAt: string;
}
```

Replenishments are bounded and paginated/aggregated if necessary; a rolling allowance has multiple expirations, not one midnight reset. Server UTC is authoritative. Round declared/measured audio duration up to whole seconds for allowance accounting, while applying the physical 1800-second limit to the measured presentation duration itself.

Create `ProcessingUsageLedger` and `ProcessingUsageService` under `backend/src/processing-usage/`, with per-job unique settlement keys and transactionally fenced owner updates. Method contracts:

```ts
reserveForJob(jobId: string, userId: string, audioSeconds: number, session: ClientSession): Promise<void>;
reconcileMeasured(jobId: string, measuredAudioSeconds: number, session: ClientSession): Promise<void>;
settleJob(jobId: string, outcome: UsageOutcome, session: ClientSession): Promise<void>;
readUsage(userId: string): Promise<ProcessingUsage>;
type UsageOutcome =
  | { kind: 'ready'; measuredAudioSeconds: number; processingStartedAt: Date }
  | { kind: 'cancelled_before_processing' }
  | { kind: 'service_failure' }
  | { kind: 'cancelled_during_processing'; executionSeconds: number;
      measuredAudioSeconds: number; processingStartedAt: Date; costModelRevision: string }
  | { kind: 'invalid_input' };
```

Accounting rules:

- Reserve declared audio seconds atomically with job admission and global workload capacity; never charge an idempotent replay twice. No reservation exists for a client-only availability read.
- Reserved allowance remains held while the job is unfinished, even across the rolling-window boundary. A stale upload reservation expires by a bounded server policy; a valid queue wait does not silently expire as an upload.
- On measured validation, replace the declaration reservation with measured seconds within the same transaction. If the file exceeds the accepted physical cap or increased reservation would exceed its accepted account/global budget, reject before the separator starts. Understatement cannot buy expensive execution.
- On successful completion, replace the hold with measured audio usage anchored at `processingStartedAt`. It expires 86,400 seconds after that anchor; do not hold successful older work beyond its rolling window.
- Cancel before processing: release the hold. Service-caused failure: release/refund allowance, but keep separate attempt counters. Invalid input: release media allowance and retain invalid-attempt counters.
- User cancellation after processing starts: debit `min(measuredAudioSeconds, max(1, ceil(executionSeconds / referenceProcessingSecondsPerAudioSecond)))`, using the accepted benchmark revision. This is an explicitly labeled audio-equivalent debit, not a claim of exact audio segments completed. Count actual separator execution only; exclude waiting, upload, offline, and validation. If no trusted timing or model is available, keep settlement pending until recovery proves an outcome; do not invent zero or double-debit.
- A cancelled attempt that already completed separation consumes the full measured duration. Retried successful jobs count media once, while recent scheduler consumption includes all actual attempts.
- Account usage and global ledgers must settle atomically with terminal state transitions, including admin cancellation, account deletion, expiration, retries, and recovery. Deleting visible history cannot restore allowance or reset abuse counters. Apply bounded retention compatible with existing account deletion policy without retaining private source names/URLs.
- Use existing auth/access guards and account fences. Separate server-side rolling attempt limits cover reservation creation, invalid media, download-related API requests, cancellations, and automatic retries. Their exact limits are recorded by R02; logical request retries do not create new jobs. IP throttles supplement account controls and do not replace them.

## C3. Global capacity and fair selection

Create `QueueCapacityService` and `FairQueueService` under `backend/src/processing-queue/`; consume MongoDB sessions from existing admission/claim transactions.

```ts
interface QueueCostModel {
  revision: string;
  evidenceStatus: EvidenceStatus;
  referenceProcessingSecondsPerAudioSecond: number;
  fixedJobOverheadSeconds: number;
  measuredAt: string;
}
interface QueuePolicy {
  maxOutstandingJobs: number;
  maxOutstandingAudioSeconds: number;
  maxOutstandingEstimatedWorkerSeconds: number;
  longJobThresholdSeconds: number;
  agingThresholdSeconds: number;
  acceptLongJobs: boolean;
  costModelRevision: string;
}
estimateCost(audioSeconds: number, model: QueueCostModel): number;
reserveCapacity(jobId: string, audioSeconds: number, session: ClientSession): Promise<void>;
selectNextEligible(workerId: string, now: Date, session: ClientSession): Promise<Job | null>;
```

Cost includes measured validation/transfer overhead and conservative separation time. Admission counts uploading reservations, queued jobs, active attempts, and unresolved recovery in outstanding totals; also expose queued-only totals separately. Reconcile reservations on actual bytes/duration, and settle once on terminal outcomes. A durable capacity fence prevents different accounts racing beyond the global ceiling.

Scheduling is non-preemptive and has no source-specific priority. At each claim, filter ownership, account access, cancellation, worker capability, and policy eligibility first. Among jobs waiting longer than `agingThresholdSeconds`, choose the oldest eligible job (queue-order tie-break). Otherwise prefer the account with the lowest rolling actual worker-seconds, then the lowest estimated job cost, then original queue order. All attempt execution contributes to recent usage, including cancelled/retried work. Enforce one running job per owner even for grandfathered accounts with multiple accepted jobs.

This ordering provides a concrete first version of user fairness and shorter-job preference with aging. Test adversarial continuous arrivals and bounded query performance. Store/index required scheduling counters; do not scan all history or sort the entire collection in application memory per claim. Aging bounds starvation among eligible finite work, not completion time when workers are offline.

`acceptLongJobs=false` applies to new admissions. Already accepted long jobs remain eligible according to their snapshot; emergency cancellation/draining is explicit. Do not silently strand accepted jobs through ordinary edits. A capacity/model revision change does not invalidate accepted jobs; re-estimate their remaining load for telemetry and reject new work if new ceilings are already exceeded.

## C4. Worker agreement and measurements

Extend the current authenticated worker identity/claim agreement additively with versioned capability evidence. Unknown/old workers stay eligible only for jobs within their existing verified ceilings. A capability claim alone does not authorize more simultaneous slots; registry-side verified ceilings are authoritative and capabilities are snapshotted/fenced on assignment.

```ts
interface ProcessingAssignmentLimits {
  policyVersion: 1 | 2;
  maxDurationSeconds: number;
  durationInclusive: boolean;
  maxInputBytes: number;
  inputBytesInclusive: boolean;
  maxOutputBytes: number;
  outputBytesInclusive: boolean;
  probeTimeoutSeconds: number;
  processingTimeoutSeconds: number;
  costModelRevision: string | null;
}
interface AttemptExecutionEvidence {
  eventId: string;
  separatorExecutionSeconds: number;
  processingStartedAt: string;
  measuredAudioSeconds: number;
  stoppedConfirmed: boolean;
}
```

Place these additions inside the existing assignment/event envelopes, keeping selector `{jobId, attemptId, sessionId, generation}` and deduplication. The worker applies the stricter intersection of accepted job limits and its verified capabilities. Backend validates finite timing, monotonic cumulative execution, lease/attempt identity, and server-observed bounds. Missing stop confirmation never unlocks a slot or proves a refund outcome.

Probe duration with bounded decoding and sample/presentation timing, not container metadata alone. Exclude documented codec priming/padding when available; do not broadly add tolerance allowing real content beyond 1,800 seconds. Always reject actual video tracks in uploaded prepared audio. Malformed input must be stopped by size, stream count, probe time, decode duration, and process limits before AI execution.

## C5. Local preparation contract

Both native implementations expose equivalent responsibilities within their current preparers:

```text
inspectSource(sourceHandle, policy) -> SourceInspection
  container, defaultAudioTrackId, presentationDuration, originalBytes,
  audioCodec, channels, sampleRate, canCopy, canConvert
prepareAudio(sourceHandle, inspection, policy, operationId, ownerId, cancellation)
  -> PreparedInput(existing immutable file + declaration + source/profile metadata)
```

Inspecting video need not decode its image stream; unsupported video image encoding alone is not a reason to reject extractable supported audio. Track selection honors the default, not the first stream index. Support a single track when no selection metadata exists; reject ambiguous multi-track input instead of inventing a default.

Direct upload is used only when the existing audio is supported and within the prepared byte ceiling. Otherwise copy/remux the chosen track where possible; transcode if required for compatibility or size. Use atomic temporary-file completion, checksum after the final file is produced, bounded streams, and owner/operation-scoped storage. Never rename an unsupported format to fake compatibility. Do not upload partial exports.

Phases are `inspecting`, `preparing_audio`, `downloading_source`, and existing upload/server phases. Backend job states remain unchanged; these phases belong to local presentation. Persist the source permission/bookmark and checkpoint necessary for safe restart, or explicitly require reselection when a provider grant is lost. No unbounded persistent copy of original video for convenience.

YouTube preflight requires a single-video URL and trustworthy finite duration; known `list` playlist context is rejected with guidance to paste the individual video URL. Do not silently take one playlist item. Fetch audio only, enforce metadata and streamed-byte bounds independently, cancel when limits are crossed, then inspect actual downloaded audio. Unknown length does not mean unlimited. New adapters must retain existing rights consent/disclosure and avoid logging URLs, titles, or tokens.

## C6. Admin and user-facing outcomes

Extend existing audited settings operations, user suspend/resume operations, job cancellation/recovery, and worker detail. New authenticated routes:

| Route under `/api/v1` | Permission / purpose |
| --- | --- |
| `GET /processing-usage` | Owner authentication; private usage and availability |
| `GET /admin/jobs/queue-summary` | `jobs.read`; bounded capacity/fairness snapshot; register before `:id` |
| `GET /admin/users/:id/processing-usage` | `users.read`; account ledger summary |
| `PUT /admin/users/:id/processing-allowance` | `users.processing.manage`, fresh auth; expiring allowance increase |
| `POST /admin/users/:id/clear-processing-allowance` | Same write permission/fresh auth; audited revocation |

All mutations use existing operation ID, expected revision, reason, auth freshness, and receipt/audit conventions. Reuse existing suspend/resume endpoints, adding optional expiry for temporary suspension without undoing a later explicit suspension. Allowance override includes `allowanceAudioSeconds`, mandatory `expiresAt`, and bounded values; it cannot change duration/byte limits, active-job count, worker capacity, or global admission. Expiry must be enforced at request/claim time even if cleanup is delayed. Revoking an exception preserves accepted reservations.

Extend existing job/user/worker presenters with input source, declared versus measured duration/bytes, queued time, actual execution, allowance settlement state, queue selection explanation, capability/readiness status, and nullable estimated wait range. Exclude signed media URLs and internal failure text. Public queue details never expose another account's identity or usage.

Add stable safe problem codes following existing envelope conventions: `MEDIA_TOO_LONG`, `MEDIA_TOO_LARGE`, `MEDIA_NO_AUDIO`, `MEDIA_DEFAULT_TRACK_UNAVAILABLE`, `MEDIA_UNSUPPORTED`, `MEDIA_DURATION_UNKNOWN`, `YOUTUBE_PLAYLIST_UNSUPPORTED`, `YOUTUBE_LIVE_UNSUPPORTED`, `PROCESSING_ALLOWANCE_EXHAUSTED`, `PROCESSING_QUEUE_FULL`, `PROCESSING_POLICY_INCOMPATIBLE`, and `PROCESSING_CAPACITY_UNAVAILABLE`. Retain existing `PROCESSING_LIMIT_REACHED` for unfinished-job admission. Return `retryAfterSeconds` only when grounded; add `nextReplenishmentAt` for allowance exhaustion. Do not automatically spin on quota/full-queue rejection.
