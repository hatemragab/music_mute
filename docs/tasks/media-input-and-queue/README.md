# Media input and queue protection — review package

**Status: implementation approved and underway; see [execution and validation](execution.md).**

This package records the decisions accepted in the September 13, 2026 discussion. The user subsequently approved all implementation, API/dashboard CapRover deployment, and the Z440 worker update over SSH. Git publication remains outside this authorization. Historical task checklists describe the reviewed work; current evidence and operational blockers are recorded in the execution ledger.

## Read in this order

1. [Accepted scope and constraints](scope.md).
2. [Shared contracts and accounting rules](contracts.md).
3. [Discovery and benchmarks](discovery/README.md).
4. [Backend tasks](backend/README.md), then [worker tasks](worker/README.md).
5. [Android tasks](android/README.md) and [iOS tasks](ios/README.md).
6. [Dashboard tasks](dashboard/README.md).
7. [Integration and readiness tasks](verification/README.md).

The [execution plan](../../superpowers/plans/2026-09-13-media-input-and-queue.md) contains the execution sequence and review gates. Backend contracts must be implemented and verified before dependent dashboard work. This extends the current application, worker, and dashboard; it does not replace their architecture.

## Task index

The 23 tasks below retain their original dependencies. Current completion and validation are recorded in [execution.md](execution.md) and the domain evidence files. Hardware qualification is distinct from source implementation.

| ID | Reviewable deliverable | Dependencies |
| --- | --- | --- |
| R01 | Synthetic media fixtures and platform compatibility evidence | Plan approval |
| R02 | Offline worker benchmarks and concrete capacity recommendations | R01; authorized idle Windows benchmark environment |
| B01 | Versioned processing policy and backward compatibility | R01; benchmark-dependent enablement remains closed until R02 |
| B02 | Atomic rolling allowance and unfinished-job accounting | B01 |
| B03 | Global workload admission and bounded reservation lifecycle | B02; R02 for enabled capacity values |
| B04 | Fair, duration-aware queue selection with aging | B03 |
| B05 | Worker capability fencing, measured reconciliation, and settlement | B02–B04 |
| B06 | Admin controls, account exceptions, and queue/usage APIs | B01–B05 |
| W01 | Policy-aware input/output validation and capability reporting | B01, B05, R01 |
| W02 | Duration-based execution limits and safe retry/cancel recovery | W01, R02 |
| A01 | Android local extraction and conversion | B01, R01 |
| A02 | Android pickers, preparation lifecycle, and temporary storage | A01 |
| A03 | Android YouTube preflight and bounded audio download | A01, A02 |
| A04 | Android allowance, queue, and failure presentation | A02, A03, B02, B03, B06 |
| I01 | iOS local extraction and conversion | B01, R01 |
| I02 | iOS pickers, background lifecycle, and temporary storage | I01 |
| I03 | iOS YouTube preflight and bounded audio download | I01, I02 |
| I04 | iOS allowance, queue, and failure presentation | I02, I03, B02, B03, B06 |
| D01 | Dashboard policy editor and readiness controls | B06, R02 |
| D02 | Dashboard queue workload, worker evidence, and safe actions | B06, D01 |
| D03 | Dashboard account allowance and expiring exceptions | B06, D01 |
| V01 | Cross-component contracts, races, and failure regression suite | B01–B06, W01–W02, A01–A04, I01–I04, D01–D03 |
| V02 | Authorized simulator acceptance and release-readiness report | V01, R01, R02 |

## Measurement-dependent decisions

These are explicit task outputs, not unanswered product questions:

- Exact input container/codec support per platform and OS; an extension alone does not establish support.
- Original local source byte ceiling, temporary-storage headroom, and bounded preparation/download/probe timeouts.
- Validation of the accepted starting **100,000,000-byte inclusive prepared-audio ceiling**, and a compatible output ceiling.
- Exact global outstanding-job/workload ceilings, fairness tuning, reliable estimate ranges, and execution timeouts.
- Whether measured single-slot waiting is acceptable for 30-minute work. Additional slots, a worker fleet expansion, and resumable audio chunking are outside this implementation package. If required by the evidence, report a separate capacity proposal and leave expanded long-job admission disabled.

## Current source baseline

Inspected locally on September 13, 2026; this is not a production-settings audit.

- Android is Kotlin/Compose, minSdk 26, targetSdk 36; iOS is Swift/SwiftUI, deployment target iOS 17. This is not a Flutter project.
- Apps currently prepare audio only, with hardcoded duration below 600 seconds and input below 30,000,000 bytes.
- `backend/src/jobs/job-state.ts`, processing settings/DTOs, and worker validation repeat the old ceilings.
- `GET /api/v1/processing-policy` already exists and currently exposes schema version 1. Extend it; do not introduce a competing policy endpoint.
- Processing settings already have audited revision-protected updates and `maxActiveJobsPerUser`, whose code default is `null` (unlimited). Live values were not read.
- `worker-coordinator.service.ts` selects by `queueOrder` and maintains one assignment per worker control. This does not establish the number of live workers or safe machine concurrency.
- Android uses `youtubedl-android` with an audio-only selection and `--no-playlist`; iOS uses pinned YouTubeKit. Playlist ignoring alone is not explicit playlist rejection.
- Existing backend is API-only NestJS/TypeScript with MongoDB transactions, external Redis, private S3 grants, and an external Windows worker. Existing dashboard is React/TypeScript/Vite.

## Review boundary

Only Markdown planning files are authorized in this turn. No application edits, dependency changes, test execution against services/devices, benchmark runs, migrations, commits, pushes, deployment, or changes to live settings are part of this planning work. Future task commands describe required validation; they are not claims of completed tests.
