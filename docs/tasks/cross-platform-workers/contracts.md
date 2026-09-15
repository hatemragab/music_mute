# Cross-platform worker contracts

**Status:** Proposed interfaces for implementation; none of these new routes or fields exists merely because this file names it.
**Authority:** [Design](../../superpowers/specs/2026-09-13-cross-platform-worker-fleet-design.md)
All API paths below are relative to the existing /api/v1 prefix unless explicitly stated otherwise. Use protocol version 3 directly. Existing selector semantics remain useful, but preserving old clients or converting old data is not required. No legacy decoder, migration, or backfill may be introduced.

## Common values and revisions

- IDs: installationId, operationId, eventId, rolloutId, groupId, releaseId are server-validated UUIDv4 strings, lowercase. Existing job IDs remain Mongo ObjectId hex.
- workerId keeps the existing lowercase letters/digits/hyphens contract; generate a stable random ID on approval rather than using a hostname or default z440.
- buildNumber: positive safe integer, increasing per release; versionName: bounded display string, never the sole ordering key.
- profileId: allowlisted release-profile identifier binding OS, architecture, provider, dependency-lock hash, model hash, minimum OS/driver, and approved media limits.
- All admin mutations consume operationId and expectedRevision; replay returns the same non-secret receipt. Reusing an operationId with different input is rejected.
- Worker controlRevision coordinates lifecycle changes. Preserve existing managementRevision semantics; telemetry and log traffic must not increment it.
- Server receivedAt is authoritative for liveness, expiry, and retention. Device occurredAt is informational.
- List pagination: opaque cursor, limit default 50, maximum 100. No unbounded fleet/log scans.
- Fresh admin authentication is required for pairing approval, credential actions, release publication, target/minimum-build changes, and stopped recovery.

## Signed distribution metadata

TUF target metadata uses `custom.musicmuteRelease` containing the complete exact
`ReleaseTarget`, including its UUID `releaseId`. The descriptor must match the
backend-selected target, and TUF target length/hash must match the artifact bytes
and digest. Reject missing, extra, or mismatched descriptor fields. Release IDs
are already signed in publication receipts and in `/releases/{releaseId}/...`
artifact paths; H01 obtains the release identity before signing metadata. The
client never treats a backend target as a substitute for verified TUF metadata.

## Installation sessions and pairing

Registration responses and authenticated installation status include `serverTime`
as an ISO UTC timestamp. Permanent workers receive the same field on every
`GET /worker/update-policy` response, including `none` and `hold`. This is a live
response timestamp, not persisted state or a policy revision. W03 uses these
no-store authenticated responses to establish a conservative clock offset before
first event transmission; accepted or uncertain event payloads remain immutable.

The native bootstrap generates a 32-byte random installationToken and saves it securely before network registration; it sends only SHA-256(UTF-8 token). Registration is idempotent only for the exact ID/digest binding. Unknown keys and oversized fields are rejected.

| Method and route                             | Auth                           | Request                                                    | Result                                                             |
| -------------------------------------------- | ------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------ |
| POST /worker-installations                   | Bounded public admission       | installationId, tokenSha256, installerBuild, os, arch      | installationId, tokenExpiresAt, eventLimits                        |
| POST /worker-installations/:id/events        | Installation bearer            | events batch                                               | acceptedEventIds, duplicateEventIds                                |
| GET /worker-installations/:id                | Installation bearer            | none                                                       | setupState, pairingState, assignedWorkerId or null, tokenExpiresAt |
| POST /worker-installations/:id/renew         | Existing installation bearer   | operationId                                                | tokenExpiresAt; bounded renewal while installation is active       |
| POST /worker-installations/:id/qualification | Installation bearer            | runtime, qualificationReport, serviceBindingSha256         | reportId, decision, reasonCodes                                    |
| POST /worker-installations/:id/pairing       | Installation bearer            | operationId, workerKeySha256, reportId                     | userCode, expiresAt                                                |
| GET /admin/worker-installations              | workers.read                   | filters and cursor                                         | safe pending-installation page                                     |
| GET /admin/worker-installations/:id          | workers.read                   | none                                                       | safe detail and readiness summary, no credential digests           |
| POST /admin/worker-installations/approve     | workers.manage plus fresh auth | operationId, expectedRevision, userCode, label             | workerId, receipt                                                  |
| POST /admin/worker-installations/:id/reject  | workers.manage                 | operationId, expectedRevision, reason                      | receipt                                                            |
| POST /worker/installation-ready              | Permanent worker bearer        | installationId, runtime, qualificationReportId, bootReport | accepted, canClaim, reasonCodes                                    |
| POST /worker/qualification                   | Permanent worker bearer        | runtime, qualificationReport, serviceBindingSha256         | reportId, decision, reasonCodes                                    |

Defaults: installation capability lifetime 24 hours; renew only before expiry and at most 7 days from session creation. Public registration rate limit 5 per IP/hour with existing global admission controls; return Retry-After. Expired sessions can restart setup reporting with a new ID while preserving local durable worker state. They cannot manufacture proof of an old assignment stopping.

Pairing codes: 10 random unambiguous Base32 characters displayed as two groups, 15-minute lifetime, one successful approval. Maximum five failed code attempts per administrator per 15 minutes, plus IP/global limits. Never put codes in URLs, analytics, remote logs, or list responses; display them only to the installer. Expiry requires an explicit local pairing retry, not endless automatic renewal.

Generate and save a distinct permanent 32-byte worker token locally before submitting workerKeySha256. The pairing request fixes that digest; approval cannot substitute another. Approval creates the existing registry/control binding transactionally, but canClaim remains false until permanent-auth readiness proves identity and qualification. Lost approval responses are recoverable through authenticated status without repeating approval or revealing secrets. Normal onboarding uses pairing, not the old manual raw-key registration form.

Installation tokens are restricted to their own session endpoints. They cannot authenticate /worker/*, fetch job media, read other sessions, or change registration. Unapproved reports are labelled as reported, not independently attested.

Paired workers submit later qualification reports through `POST /worker/qualification`
using their permanent credential and existing installation binding. This route
uses the same strict report body and storage authority with per-worker rate/count
budgets. It never renews an expired setup capability, creates another registration,
changes the installation binding or grants claim readiness. Runtime updates and
same-machine repair therefore remain possible after the setup token's seven-day
maximum lifetime. A successful report still needs permanent-auth readiness and
current claim-policy evaluation before new work is admitted.

## Runtime and qualification

`POST /worker/claim/recovery` accepts only `sessionId` and optional
`mediaPolicyVersion: 2` with permanent worker authentication. It discovers an
already owned live assignment after a lost claim response. An empty result is
HTTP 204 with `X-Worker-Reason: NO_OWNED_ASSIGNMENT`; it never waits, evaluates
fresh-job readiness, or selects/reserves queued work. Mismatched sessions and
stale ownership retain `WORKER_RECOVERY_REQUIRED` behavior. This cleanup route
remains available while processing is disabled, but credential and installation
authorization still apply. A worker with invalid GPU runtime may discover and
journal ownership, but must not start download or inference. Ordinary `/worker/claim`
retains all fresh-work admission gates.

New registered workers report the following bounded shape on readiness, a dedicated POST /worker/runtime, and active heartbeats when changed:

```ts
type WorkerRuntimeReport = {
  installationId: string;
  workerBuild: number;
  launcherBuild: number;
  protocolVersion: number;
  profileId: string;
  modelSha256: string;
  runtimeLockSha256: string;
  os: "windows" | "macos" | "linux";
  arch: "x64" | "arm64";
  activity:
    "starting" | "ready" | "busy" | "updating" | "paused" | "recovery_required";
  bootVerified: boolean;
};
type QualificationReport = {
  profileId: string;
  modelSha256: string;
  fixtureSha256: string;
  acceleratorUsed: boolean;
  provider: string;
  deviceLabel: string;
  wallMilliseconds: number;
  peakRamBytes: number | null;
  peakGpuMemoryBytes: number | null;
  outputValid: boolean;
  referenceCheckPassed: boolean;
  serviceContextPassed: boolean;
  reasonCodes: string[];
};
type BootReport = {
  serviceBindingSha256: string;
  profileId: string;
  installed: boolean;
  serviceContextPassed: boolean;
  unattendedRebootPassed: boolean;
  observedBootId: string | null;
  observedAt: string;
  reasonCodes: string[];
};
```

The receiving service enforces numeric bounds, exact profile compatibility, expected fixture/model digests, allowed provider values, and bounded strings. A reported acceleratorUsed flag alone does not qualify a recipe; it must match the signed recipe's tested execution-evidence checks. Approved hardware evidence and contributor reports remain distinguishable.

BootReport binds the exact native service definition/principal and profile without exposing account names or secrets. A service-context test is not a reboot test. Pairing can complete after model and service-context checks, but claim readiness waits for unattendedRebootPassed. When a reboot is needed, the installer requests the ordinary OS action, reports pending_boot_verification, and the boot service resumes automatically using the saved installation/worker identity. Do not force a reboot without local consent. A later code update may retain existing boot proof only if the verified service binding and profile boot requirements remain valid; changed service/principal/driver conditions require requalification.

Readiness is conjunctive: registered enabled identity, recent runtime report, qualified GPU/profile/media class, boot/service gates, allowed build/protocol/model, no update hold, and no reserved assignment. Existing claim/recovery fencing still applies. A draining/revoked worker cannot be re-enabled by an installer or update.

New setup failure codes include CPU_ONLY_UNSUPPORTED, GPU_PROVIDER_UNAVAILABLE, GPU_UNAVAILABLE_IN_SERVICE, GPU_QUALIFICATION_FAILED, DRIVER_ACTION_REQUIRED, UNSUPPORTED_OS_ARCH, DEPENDENCY_RECIPE_UNAVAILABLE, INSUFFICIENT_DISK, INSUFFICIENT_MEMORY, MODEL_INTEGRITY_FAILED, PREBOOT_UNLOCK_REQUIRED, STARTUP_INSTALL_FAILED, REPORTING_UNAVAILABLE, and UPDATE_SIGNATURE_INVALID. Keep safe code-to-message maps in both protocol fixtures and presenters; raw exception strings are not public messages.

## Structured event ingestion

```ts
type WorkerEvent = {
  eventId: string;
  operationId: string;
  sequence: number;
  category:
    | "installation"
    | "pairing"
    | "startup"
    | "processing"
    | "update"
    | "cleanup";
  stage: string;
  status: "started" | "progress" | "succeeded" | "failed" | "interrupted";
  occurredAt: string;
  durationMs?: number;
  code?: string;
  details?: {
    component?: string;
    componentVersion?: string;
    attempt?: number;
    exitCode?: number;
    downloadedBytes?: number;
    totalBytes?: number;
    droppedEvents?: number;
    diagnostic?: string;
  };
};
```

POST /worker/events uses permanent worker auth; installation events use the scoped route above. Server attaches installationId, workerId when known, receivedAt, and expiresAt. Client-supplied owner fields are rejected.

Limits: 50 events/batch, 64 KiB HTTP body, 4 KiB serialized event, 1024-character diagnostic, five-second minimum interval for unchanged progress stages. Local spool cap 20 MiB, 30-day age cap, reserved capacity for failures/terminal events, and an explicit dropped-event count. Backend ingest quota 2 MiB/session/day before pairing and 20 MiB/worker/day after pairing, adjustable through validated configuration. Apply existing Redis rate-limit infrastructure.

The canonical owner is the stable installationId under both setup and permanent authentication. Use a unique compound index on installationId plus eventId; duplicate content succeeds, conflicting reuse returns EVENT_ID_CONFLICT. Pairing or changing authentication cannot duplicate a retained spool event or reset its receipt/expiry time. Worker timelines resolve the registered installation binding and read the same events. Sequence orders device events but is not trusted as server time. List endpoints enforce expiresAt > now, worker/install scope, category/status/time filters, and pagination. Use exact 30 * 24 * 60 * 60 seconds from receivedAt for expiry; TTL index expireAfterSeconds is 0 on expiresAt.

Retained event records define the idempotency window; there are no permanent per-event tombstones. An expired retained duplicate may be acknowledged without renewal or visibility. For new records, require `receivedAt - 30 days < occurredAt <= receivedAt`, rejecting old identical payloads after physical TTL deletion. Changed payloads reusing an already deleted ID are outside the retained conflict history. Future-clock rejection has an explicit safe reason; W03/I01 use available server UTC to correct event timestamps before first submission. Accepted expiry remains exactly first server receipt plus 30 days.

## Release records, groups, and selected rollouts

```ts
type ApprovedWorkerProfile = {
  evidenceSha256: string;
  fixtureSha256: string;
  fixtureDurationSeconds: number;
  provider:
    | "CUDAExecutionProvider"
    | "DmlExecutionProvider"
    | "CoreMLExecutionProvider"
    | "MIGraphXExecutionProvider"
    | "OpenVINOExecutionProvider"
    | "ArmNNExecutionProvider";
  serviceBindingSha256: string;
  expiresAt: string;
  maxDurationSeconds: number;
  maxPreparedAudioBytes: number;
  maxWallMilliseconds: number;
};
type WorkerReleaseTarget = {
  approvedProfile: ApprovedWorkerProfile | null;
  os: "windows" | "macos" | "linux";
  arch: "x64" | "arm64";
  compatibleSources: Array<{
    profileId: string;
    modelSha256: string;
    runtimeLockSha256: string;
    rollbackAllowed: boolean;
  }>;
  releaseId: string;
  buildNumber: number;
  profileId: string;
  artifactPath: string;
  artifactBytes: number;
  artifactSha256: string;
  runtimeLockSha256: string;
  modelSha256: string;
  minimumLauncherBuild: number;
  protocolMin: number;
  protocolMax: number;
  stateReadMin: number;
  stateReadMax: number;
};
type UpdateDecision = {
  policyRevision: number;
  action: "none" | "prepare" | "hold";
  target: WorkerReleaseTarget | null;
  minimumClaimBuild: number;
  allowedFallbackReleaseIds: string[];
  reasonCodes: string[];
};
```

`approvedProfile: null` explicitly means the artifact is unqualified, even when published. The Ed25519 publication receipt signs the complete descriptor together with exact artifact build, OS/architecture, model and dependency-lock identities. H01 must derive the descriptor from an explicitly reviewed F01/native qualification record and the exact synthetic fixture manifest: `evidenceSha256` is the approved evidence bundle digest, `fixtureSha256` and `fixtureDurationSeconds` identify its tested fixture, provider and service-binding identity are exact, and expiry/media/time ceilings come from that reviewed record. H02 must verify these bindings against the signed TUF target before issuing the receipt with the configured publication authority key. Contributor accelerator flags, receipt publication, and a downloaded artifact are never sources of profile approval. All actual F01 candidates currently remain unavailable; no authority-approved native descriptor is claimed by B05.

The signed media ceiling cannot exceed the signed fixture duration. A long-capable artifact cannot qualify a new installation through a shorter installer fixture: the persisted report must match this exact fixture digest and pass its execution checks. A later qualification report can replace the readiness reference after running the separately approved larger fixture/profile. Records are immutable and current readiness references are revision-fenced; job admission snapshots retain their original queue-policy audit information while each assigned attempt records its own qualification report, evidence digest and media ceilings.

B02 calls exported `WorkerQualificationService.store(installationId, runtime, report, serviceBindingSha256)` only after authenticating the installation bearer and enforcing session expiry/rate limits. It returns `{reportId, decision: "reported", reasonCodes}` and does not grant claim permission. `evaluateForPairing(installationId, reportId, session?)` evaluates the exact published approved profile and service-context/model/provider/fixture evidence without requiring unattended reboot. When called inside pairing approval, supply the existing transaction session to fence release availability. Registration and failure reporting remain available for unsupported hardware. B02 owns its session/pairing routes; B05 introduces no public qualification route.

`WorkerReadinessService.evaluateNewClaim(workerId, session)` runs inside the caller's WorkerControl-fenced transaction and writes WorkerRuntime.rolloutFence plus ReleasePolicy.fence. It denies expired observations (five minutes), missing approval, policy holds, prohibited builds, unavailable releases, unsupported identities, unverified boot/service binding, and reserved ownership. Material runtime writes conflict on the same runtime row; observations never increment managementRevision. Owned heartbeat/stage/terminal cleanup/reconcile use their existing selector authority and retain the admitted media ceiling after a floor rise. Idle claim HTTP 204 responses carry `X-Worker-Reason: IDLE_NO_JOB`; denied claims carry exact reasonCodes in HTTP 409.

Release metadata is immutable once published and cryptographically bound to the distribution service's verified TUF target. Do not use app_releases or APK validation. Stage artifacts before permitting publication; reject reused build numbers even if the label differs. Missing platform/profile artifacts produce an explicit incompatible target result.

| Route                                    | Purpose                                                             |
| ---------------------------------------- | ------------------------------------------------------------------- |
| GET/POST /admin/worker-groups            | Paginated list and revision-checked creation                        |
| PATCH /admin/worker-groups/:id           | Revision-checked label/member changes                               |
| GET/POST /admin/worker-releases          | List and create draft from verified artifact metadata               |
| POST /admin/worker-releases/:id/publish  | Fresh-auth publish after artifact validation                        |
| POST /admin/worker-releases/:id/withdraw | Block new selection; preserve referenced artifacts                  |
| POST /admin/worker-releases/:id/stable   | Set the explicitly chosen new-install release                       |
| POST /admin/worker-rollouts/preview      | Expand selected IDs/groups and show compatible/incompatible results |
| POST /admin/worker-rollouts              | Confirm snapshot, target, and expected revisions; max 1000 IDs      |
| POST /admin/worker-rollouts/:id/pause    | Stop unstarted activations; retain actual in-progress state         |
| POST /admin/worker-rollouts/:id/retry    | Explicit retry of quarantined candidates                            |
| GET /admin/worker-rollouts/:id           | Desired, acknowledged, active, verified, failed, and offline counts |
| GET /worker/update-policy                | Authenticated UpdateDecision for this worker only                   |
| POST /worker/update-status               | Revision-bound stage event and observed runtime identity            |
| GET /worker-bootstrap/stable             | Public safe profile/release selection; no credentials or fleet data |

Rollout creation stores resolved worker IDs and group revisions. Later membership changes do not alter the rollout. Competing assignments require revision checks and explicit supersession. A rollout cannot grant a revoked identity access or erase its existing assignment.

The confirmation body includes operationId, expectedRevision, expectedGroupRevisions, selectedWorkerIds, selectedGroupIds, releaseId, minimumClaimBuild and allowedFallbackReleaseIds. minimumClaimBuild must not exceed the selected target build and applies only to the resolved selected workers. Publishing files or changing the new-install stable release does not raise any unselected worker's build floor.

Stages: available -> downloading -> prepared -> waiting_for_idle -> validating -> activating -> running -> verified; exceptional states failed, rolled_back, blocked, paused. Running means local/authenticated startup; verified also requires a successful synthetic or separately identified real processing observation. Do not label a download as an installed update.

Minimum-build policy is enforced for fresh claims, with owned-attempt compatibility retained. Cached update information cannot override a newer backend claim rejection. Rollback is an explicit permitted target under current policy, not arbitrary downgrade.

## Shared Python interfaces

These are new interfaces owned by the task that introduces each module. Existing worker protocol selectors remain unchanged.

```python
class PlatformAdapter:
    def detect(self) -> dict: ...
    def install_boot_service(self, launcher_path: str) -> dict: ...
    def check_service_context(self) -> dict: ...
    def acquire_machine_lock(self): ...
    def stop_and_verify_descendants(self, containment_id: str) -> None: ...
    def protect_secret(self, name: str, value: bytes) -> None: ...
    def load_secret(self, name: str) -> bytes: ...

class EventSpool:
    def append(self, event: dict) -> None: ...
    def upload_pending(self, client) -> dict: ...

class QualificationRunner:
    def qualify(self, profile: dict, fixture_path: str) -> dict: ...

class ReleaseVerifier:
    def resolve(self, decision: dict) -> dict: ...
    def verify_artifact(self, target: dict, path: str) -> None: ...

class UpdateCoordinator:
    def prepare(self, decision: dict) -> dict: ...
    def activate_when_idle(self, decision: dict) -> dict: ...
    def recover_interrupted_activation(self) -> dict: ...
```

The signatures describe planned interfaces, not stub code to ship. Implement typed dataclasses/protocols for these dictionaries in W01 and freeze wire names in checked-in fixtures. Implementing agents must not treat method bodies above as implementation.

## Distribution internal interface

Public origin is https://updates.music-mute.com. Keep bootstrap URLs stable; exact build artifacts use /releases/<releaseId>/<profileId>/<sha256>/<filename>. TUF metadata uses its standard versioned paths.

Internal POST /internal/publications authenticates a narrowly scoped publisher and registers a release and declared artifacts. PUT /internal/publications/:id/artifacts/:artifactId accepts a bounded stream with exact digest and length. POST /internal/publications/:id/commit validates complete signed metadata and atomically exposes the release. GET /internal/publications/:id provides an idempotent receipt. Partial publication is never downloadable as a release.

### B04/H02 signed publication receipt protocol (implemented backend verifier)

H02 must return the following exact envelope after atomic publication and verification of the complete TUF target metadata. This is a signed authority attestation, not an administrator's checksum assertion. The authority verifies staged bytes, exact lengths/digests and signed TUF metadata before signing. The backend performs no administrator-directed URL fetch.

```ts
type SignedPublicationReceipt = {
  keyId: string;
  payload: {
    protocol: "musicmute-publication-v1";
    publicationId: string; // lowercase UUIDv4
    origin: "https://updates.music-mute.com";
    releaseId: string; // lowercase UUIDv4
    buildNumber: number; // positive safe integer
    versionName: string; // 1-64 printable ASCII characters
    issuedAt: string; // ISO timestamp, not in the future
    expiresAt: string; // future timestamp, at most 24 hours after issuedAt
    tufTargetsSha256: string; // exact signed targets metadata bytes digest
    artifacts: WorkerReleaseTarget[]; // 1-32 distinct profileIds
  };
  signature: string; // 64-byte Ed25519 signature, unpadded base64url (86 chars)
};
```

Signing bytes are UTF-8 `musicmute-publication-v1\n` followed by canonical JSON of **payload only**: recursively sort object keys lexicographically by UTF-16 code units; preserve array order; encode strings using JSON string escaping; encode safe integers as decimal; emit no insignificant whitespace. The fixed protocol's keys are ASCII. Sign these bytes with Ed25519 without a prehash. Unknown envelope/payload/artifact fields are rejected. All artifact releaseId/buildNumber values must equal their payload values; all hashes are lowercase 64-character SHA-256. Artifact paths must be `/releases/<releaseId>/<profileId>/<artifactSha256>/<filename>` with one bounded ASCII filename and no traversal. Launcher, protocol and state-read bounds are positive safe integers with ordered ranges.

Backend trust configuration is `WORKER_PUBLICATION_KEY_ID`, `WORKER_PUBLICATION_PUBLIC_KEY` (Ed25519 SPKI PEM), and `WORKER_DISTRIBUTION_ORIGIN` (validated exact public origin). Unconfigured authority, unknown key ID, invalid signature, expired receipt or mismatched bindings rejects publication. There is no development bypass. H02's publisher authentication remains a separate internal transport boundary; signing private keys never enter backend requests/configuration. H02 must use the same envelope on commit and receipt recovery. B04 accepts `publicationReceipt` on draft creation and publication; publication requires the exact stored signed payload while valid. An expired draft requires a new build/draft, rather than mutation of its signed metadata. Idempotent replay of an already successful operation does not reverify expiration.

### B04 preview confirmation and B05 handoff

Preview returns `workers` and a `confirmation` object. Merge that confirmation into the original selection plus a fresh `operationId`. It contains `expectedRevision` (release policy revision), `expectedGroupRevisions`, `snapshotWorkerIds`, and `expectedWorkerRevisions` keyed by worker ID, each with `managementRevision`, per-worker `policyRevision`, and `compatibilityHash`. Compatibility hashes include profile, launcher, protocol, model and runtime-lock identities, excluding activity/liveness. Confirmation rejects the whole selection if any selected worker is incompatible or missing; it never silently expands or drops members. At most 100 groups and 1000 deduplicated workers are accepted. Competing targets require explicit `supersedeRolloutIds`; candidates already activating/running cannot be superseded.

The `WorkerReleasesModule` exports `WorkerRolloutsService` and its Mongoose models. `WorkerUpdatePolicy` (`worker_update_policy`) is keyed by workerId and stores `revision`, `rolloutId`, exact `target`, `minimumClaimBuild`, `allowedFallbackReleaseIds`, `paused`, `stage`, `observedBuild`, `receivedAt`, `runningAt`, and `verifiedAttemptId`. B05 must consume this authority for **fresh claims**, preserving owned-attempt behavior and touching the existing WorkerControl transaction fence. B04 does not independently modify claims. No row means no targeted update/floor; stable selection never supplies a missing row. Withdrawn fallback releases are dynamically excluded from decisions. Targeted changes, pause/retry and status authorization touch WorkerControl; preview confirmation additionally writes `WorkerRuntime.rolloutFence` to serialize compatibility changes without making heartbeat revisions a user CAS.

B05 must also increment `ReleasePolicy.fence` on `_id: "policy"` inside the fresh-claim transaction when consulting release availability. Release withdrawal serializes on that row; a snapshot-only read would otherwise permit a concurrent withdrawal race. Read exported models using the existing claim session rather than calling the standalone `getUpdateDecision` transaction from inside a claim transaction.

### B04 review revision: signed source transitions and actual liveness

`WorkerReleaseTarget.os`, `arch`, and `compatibleSources` are required signed fields, including an empty array for a code-only release. This directly changes the development contract; there is no old-shape decoder. `compatibleSources` contains at most 32 distinct exact profile/model/runtime-lock tuples, each with a required boolean `rollbackAllowed`. H02 must validate and sign every field. Duplicate source tuples, invalid platform values, unknown keys, and tampering are rejected. The shared protocol fixture now includes a representative recipe-changing `releaseTarget`.

Before startup, the current runtime may equal the exact target tuple (code-only update) or one **explicitly signed source tuple**. Both paths also require exact OS/architecture and compatible protocol/launcher limits. Artifact selection evaluates every artifact and rejects ambiguity rather than picking the first profile match. Preview, preparation policy and activation authorization use source compatibility. `running` and `verified` require the exact target build, profile, model, runtime lock, OS and architecture. `observedBuild` must equal the current persisted runtime report at every stage: activation reports the old running build, and only a successful startup/runtime report makes the new build observed. These checks are fenced against concurrent runtime changes.

Across recipe changes, the **selected new target's** signed source entry with `rollbackAllowed: true` authorizes reverse restoration of that old tuple. The backend also requires an explicit current `allowedFallbackReleaseIds` selection, published/nonwithdrawn fallback, build at/above the worker's floor, unambiguous matching fallback artifact and platform/protocol/launcher compatibility. Old immutable releases are never edited to name future targets. Code-only rollback can retain the identical tuple. A `rolled_back` observation additionally requires the exact fallback build/tuple in the current runtime. W04 must enforce the fallback artifact's signed stateReadMin/stateReadMax against actual local state before restoration; B01 does not report that state version, so backend authorization alone does not prove local state-read compatibility. B05 readiness/claims must verify the **installed exact identity** for whichever current target/fallback policy allows, not mistake source eligibility for target readiness.

Rollout detail exposes each current candidate's `lastSeenAt`, derived from the newest server-received WorkerRuntime.receivedAt or WorkerControl.lastSeenAt. Missing both is unknown; older than configured PROCESSING_LEASE_SECONDS is offline. WorkerUpdatePolicy.receivedAt remains the last ordered update event and is not a heartbeat. Retry clears the new candidate's receivedAt/observedBuild; it does not reuse a previous attempt's acknowledgement or advance liveness artificially.

`POST /worker/update-status` accepts exactly `policyRevision`, `stage`, `observedBuild`, `eventId`, plus `processingAttemptId` for `verified`. It authenticates only the requesting permanent worker, enforces ordered stages and activation idle/paused/release checks, and timestamps observations at receipt. `verified` requires a persisted successful (`ready`) JobAttempt belonging to this worker, started after its `runningAt`, plus its matching current runtime build/profile. A worker cannot manufacture verification using a boolean or another worker's attempt. `rolled_back` requires a currently published allowed fallback build at/above the selected floor. The worker must await successful `activating` acknowledgement before local activation. Pause leaves the real stage intact; per-worker `paused` holds new activations. Retry accepts explicit `workerIds`, advances only those candidates' policy revisions, and clears only their pause/quarantine. Rollout-level `paused` records that pause was requested; worker flags are the admission authority.

Only backend/authorized publishing workflows may use this internal interface. No contributor credential or browser token is a publisher credential. Backend resolves the configured service origin; caller-supplied hosts, local-file URLs, redirects to private networks, and filesystem paths are rejected.

### Authenticated native ZIP bundle inventory (W03/H01)

H01 packages every supported native worker release as ZIP with a root `bundle.json`.
W03 first verifies the complete artifact against the current signed TUF target,
then reads this exact inventory schema from inside those authenticated bytes:

```json
{"schemaVersion":1,"unpackedBytes":1234,"files":[{"path":"worker.py","bytes":100,"sha256":"<lowercase SHA-256>","executable":false}]}
```

`files` enumerates every regular member except `bundle.json`; `unpackedBytes`
includes that manifest's own serialized bytes. Member length, hash and executable
mode must match. Missing/extra members, duplicate/case-colliding paths, ancestor
conflicts, traversal, symbolic/hard links, device members and encrypted/split ZIP
archives are rejected. Extraction creates a new stage and preserves existing
active/prepared environments. Other archive formats are explicitly unsupported.
Policy ceilings apply independently of signed declarations: 16 GiB artifact,
32 GiB unpacked data, 1 MB manifest, 100,000 ZIP entries and 16 MiB central
directory. Free disk must cover the stage plus reserved headroom; existing active
and rollback assets remain protected by separate cache references. This inventory
introduces no second signature authority: its authenticity comes from the TUF
artifact hash and length.
