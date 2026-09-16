# Music Mute Worker Rebuild: Git Branches and Checkpoints

> Implementation roadmap for the maintainer and coding agents.
> Start from `codex/worker-clean-slate`. Keep `main` unchanged until the complete, release-gated worker MVP is accepted.
> This document is a plan, not evidence that any implementation, test, merge, deployment, or package publication has happened.

## 1. Confirmed starting point

The project is developed with Git. Work must be divided into focused branches, reviewed at explicit checkpoints, and merged. Each implementation branch starts from the accepted previous implementation checkpoint. Do not implement the whole roadmap in one branch or one uninterrupted agent run.

| Item                           | Confirmed decision                                                                                                |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Repository                     | `hatemragab/music_mute`                                                                                           |
| Starting branch                | `codex/worker-clean-slate`, already created by the maintainer                                                     |
| Previous worker                | Deleted, together with its worker backend routes and worker dashboard features. Do not restore that architecture. |
| Main branch                    | Must remain unchanged until release readiness is accepted                                                         |
| Backend                        | Existing private-VPS NestJS application; no Supabase                                                              |
| Execution hierarchy            | One backend, many machines, multiple processing workers per machine                                               |
| Available Windows test machine | HP Z440, Windows, AMD RX 580 with 8 GB VRAM                                                                       |
| Available Apple test machine   | Mac mini M4, also the current development machine                                                                 |
| Other GPU hardware             | No NVIDIA or Linux AMD test machine confirmed                                                                     |

The clean-slate README still describes retained job history and completed-result access, with new submissions temporarily unavailable. Preserve those existing product contracts and user data while implementing the new execution system. A worker rebuild is not permission to delete the application, retained jobs, authentication, billing/usage behavior, or account-deletion workflows. [R1]

Repository inspection for this plan covered the branch's root listing, README, CONTRIBUTING guide, and backend/dashboard package manifests. It was not a full source-code audit. Re-read the checked-out branch before implementing. [R1–R4]

## 2. Keep the architecture small

Implement the agreed design, without introducing additional infrastructure unless a demonstrated requirement needs it.

| Area               | MVP decision                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------ |
| Supervisor and CLI | One lightweight Node.js/TypeScript agent per machine                                                   |
| Processing         | Python child processes, one active job per child                                                       |
| Backend connection | One authenticated native WebSocket connection per machine for notifications, heartbeat, and progress   |
| Durable operations | HTTPS enrollment, claims, lease renewals, completion/failure, log batches, and transfer-grant requests |
| Queue ownership    | MongoDB-backed atomic claims and attempt leases; Redis for transient presence/notifications            |
| Transfers          | Direct S3 presigned downloads/uploads; backend coordinates metadata                                    |
| GPU policy         | Verify actual accelerated inference; reject CPU-only production processing                             |
| Initial recipe     | `Kim_Vocal_2.onnx`, optional silence trimming, and a real selected noise-reduction implementation      |
| Concurrency        | One child per GPU initially; explicit limits and benchmark-backed increases                            |
| Installation       | Platform bootstrap scripts calling a shared CLI; managed, pinned runtimes                              |
| Boot services      | Windows Service, Linux system service, macOS system LaunchDaemon                                       |
| Updates            | Selected-machine rollout, drain, versioned releases, independent local rollback                        |

Retain extension points for Demucs, other MDX models, dereverb, denoise, normalization, bass/drum extraction, and karaoke. Do not implement every future recipe now.

No Kubernetes, no public/community worker network, no second distributed queue, no arbitrary remote shell, no new repository-wide build framework, and no separate supervisor implementation for every operating system.

## 3. Branch topology

Use one collection branch, `codex/worker-rebuild`, to receive accepted milestones. It exists only to assemble and review the feature while `main` stays unchanged.

Use this sequential implementation chain:

```text
codex/worker-clean-slate                 existing, frozen baseline
    |
    v
codex/worker-architecture                contracts + real GPU feasibility
    |
    v
codex/worker-control-plane              backend ownership + enrollment
    |
    v
codex/worker-shared-runtime             supervisor + processing + S3
    |
    v
codex/worker-installers                 CLI + Windows/macOS/Linux adapters
    |
    v
codex/worker-dashboard                  administration + visibility
    |
    v
codex/worker-updates                    selective rollout + rollback
    |
    v
codex/worker-integration                complete system + failure tests
    |
    v
codex/worker-release-readiness          packaging + final acceptance
```

Every accepted implementation branch merges into `codex/worker-rebuild`. After all milestones are accepted:

```text
codex/worker-rebuild  -- final reviewed pull request -->  main
```

`codex/worker-integration` is the late integration-testing branch. `codex/worker-rebuild` is the collection branch. They have different purposes.

### Why no separate OS branches now?

Windows, macOS, and Linux installer work belongs in one branch with separate checkpoints. This keeps the common runtime consistent and avoids three parallel implementations drifting apart. A separate OS branch is unnecessary for the available two-machine test setup.

### Parent and merge rules

| Step  | Branch                           | Create from                    | Merge into                        |
| ----- | -------------------------------- | ------------------------------ | --------------------------------- |
| Setup | `codex/worker-rebuild`           | `codex/worker-clean-slate`     | `main`, only after final approval |
| 1     | `codex/worker-architecture`      | `codex/worker-clean-slate`     | `codex/worker-rebuild`            |
| 2     | `codex/worker-control-plane`     | Accepted architecture branch   | `codex/worker-rebuild`            |
| 3     | `codex/worker-shared-runtime`    | Accepted control-plane branch  | `codex/worker-rebuild`            |
| 4     | `codex/worker-installers`        | Accepted shared-runtime branch | `codex/worker-rebuild`            |
| 5     | `codex/worker-dashboard`         | Accepted installers branch     | `codex/worker-rebuild`            |
| 6     | `codex/worker-updates`           | Accepted dashboard branch      | `codex/worker-rebuild`            |
| 7     | `codex/worker-integration`       | Accepted updates branch        | `codex/worker-rebuild`            |
| 8     | `codex/worker-release-readiness` | Accepted integration branch    | `codex/worker-rebuild`            |

An **accepted branch** includes its reviewed collection-branch merge commit. Fast-forward the completed branch to that commit before creating its successor. The exact workflow is in section 6.

Keep `codex/worker-clean-slate` frozen. Do not merge feature work backward into it. Do not create subsequent implementation branches directly from `main`.

## 4. Checkpoints for each implementation branch

### Branch 1: `codex/worker-architecture`

**Purpose:** establish a small executable foundation and prove the two available GPU paths before building the surrounding system.

**Work:**

- Inspect surviving job, S3, app, usage, authorization, and dashboard contracts. Record how the new worker protocol connects to them without restoring removed worker routes.
- Define machine, GPU device, worker process, job attempt, installation session, capability, pipeline version, and release identities. Define schemas once and validate at both sides of the protocol.
- Establish component boundaries and test commands. Follow the repository's component-owned dependency structure; do not migrate the entire repo into a new monorepo tool. [R2]
- Build a minimal local Kim inference probe using pinned dependencies, model checksum, and a rights-cleared audio fixture. Capture provider configuration, output validation, and acceleration evidence.
- Test first on the M4 development machine, then run the same probe on the Windows RX 580. Do not approve a provider just because its name appears in a list.
- Specify versioned release directories and the external launcher boundary now, even though rollout implementation arrives later.

**Resolve inside this checkpoint:** the exact denoising implementation/preset, silence-trimming semantics, output contract, supported initial OS versions, runtime versions, and model/license provenance. Reuse surviving app requirements where they exist. Where absent, record a proposed choice for maintainer approval before implementing behavior. Do not substitute a no-op for noise reduction.

**Initial assumptions to evaluate:** trimming is opt-in and should not remove internal speech pauses without an explicit product decision; preserve voice-only output compatibility unless the maintainer changes the contract. Provider-specific model preprocessing must be identical in meaning across hosts.

**Checkpoints:**

- [ ] A1. Repository baseline, architecture decisions, protocol contracts, and acceptance matrix are recorded.
- [ ] A2. Kim produces valid accelerated output on the M4; actual evidence is attached.
- [ ] A3. Kim produces valid accelerated output on the RX 580; actual evidence is attached.
- [ ] A4. Unknown implementations and dependencies are resolved or explicitly blocked; the next branch's interfaces are stable.

**Tests:** contract validation, unsupported-platform fixtures, malformed model/input handling, real inference on both available machines. Service-account inference is checked again after service installation in branch 4.

**Not included:** production queue, dashboard screens, public npm publication, automatic service installation on the development Mac.

**Exit:** both required hardware probes pass. A GPU failure is a blocker to resolve, not permission to enable CPU-only processing. No hardware test may be marked passed from a mock or generated log.

### Branch 2: `codex/worker-control-plane`

**Purpose:** implement reliable backend ownership before connecting real processing workers.

**Work:**

- Add isolated NestJS modules for enrollment, machines/workers, capabilities, claims, leases, telemetry, and narrowly scoped administrator operations.
- Generate single-use, expiring enrollment codes, store only code hashes, and exchange them for restricted installation sessions. Activate a machine only after validation; installation diagnostics must be accepted before activation.
- Implement revocable machine credentials. Worker credentials must not grant database, Redis, S3 bucket-listing, or administrator access.
- Atomically claim compatible queued work using `machineId`, `workerId`, `gpuId`, `attemptId`, lease expiry, and a separate execution deadline.
- Implement batched renewals, conditional expiry recovery, idempotent completion/failure, cancellation, bounded retry categories, and rejection of stale attempts.
- Add native WebSocket notifications and live presence, but keep persisted job ownership independent of socket delivery. Reconcile from MongoDB after backend restart or lost transient state.
- Issue attempt-scoped input/output grants and validate output ownership. Preserve existing user/account authorization boundaries and completed-history access.
- Accept ordered installation/runtime log batches with deduplication. Sample heartbeat history only; process every valid ownership renewal and current-state update.

**Proposed configurable defaults:** 20-second heartbeat/renewal, 90-second lease, 10-second expiry scan, up to three execution attempts depending on the error, 15-minute single-use enrollment invitation, 48-hour sampled heartbeat retention. These are starting settings to test, not measured limits.

**Checkpoints:**

- [ ] B1. Expired/reused enrollment codes fail; failed installations remain inspectable; machine revocation works.
- [ ] B2. Concurrent claims cannot grant the same active attempt to two workers.
- [ ] B3. Expired ownership is released; a reassigned job rejects the original worker's late completion.
- [ ] B4. Cancellation, duplicate callbacks, authorization, and backend restart recovery pass.
- [ ] B5. Log ingestion, live presence, and historical expiry behavior are separately verified.

**Tests:** deterministic fake-clock tests; real MongoDB/Redis integration tests against isolated test services; authenticated HTTP/WebSocket contract tests. Do not implement lease recovery by waiting for database TTL deletion.

**Not included:** remote GPU execution, charts, predictive scheduling, BullMQ, or production migration.

**Exit:** simulated machines can safely claim, renew, fail, cancel, lose, and complete jobs. No real production credentials are required for these tests.

### Branch 3: `codex/worker-shared-runtime`

**Purpose:** make the same agent and engine process real jobs on both available machines.

**Work:**

- Implement one supervisor, one machine connection, persistent machine identity, and a local installation lock. Child workers request jobs through the supervisor instead of receiving independent machine credentials.
- Implement reconnect backoff with jitter, claim-on-connect, claim-after-completion, and a slow randomized idle reconciliation check.
- Spawn and supervise Python workers. Each child owns its inference session, executes one attempt at a time, and uses an explicitly selected device. Honor provider-specific session restrictions, including DirectML configuration and single-session execution constraints. [T3]
- Implement input validation, direct S3 transfer, Kim separation, approved trimming/denoise options, output encoding, attempt-specific uploads, and cleanup. Use argument arrays rather than constructing shell commands from job input.
- Request or refresh short-lived transfer grants when needed. Keep each attempt's temporary files isolated and bound disk use.
- Renew leases only for healthy owned attempts. Detect a hung child separately from supervisor health; enforce execution/stall deadlines and stop publishing under lost ownership.
- Add configurable child-worker limits: the lowest applicable dashboard, local-owner, and validated capacity limit wins. Default to one worker per GPU; pause admission under memory pressure and reduce capacity after memory failures.
- Implement structured diagnostics with local spooling, acknowledgement/retry, redaction, and observable storage limits. No silent log loss when a spool is full.

**Checkpoints:**

- [ ] C1. One authenticated supervisor registers child workers and obeys capability matching.
- [ ] C2. Both actual machines complete the S3-to-processing-to-S3 path using the same codebase.
- [ ] C3. Child crashes, supervisor crashes, lost leases, expired URLs, cancellation, and disk limits are handled.
- [ ] C4. Multiple children are supported and limits enforced; higher GPU concurrency is enabled only where testing validates it.
- [ ] C5. Trimming and denoise produce real expected behavior; final outputs preserve the app contract.

**Tests:** local orchestration with a clearly labeled fake engine; real Kim runs on both machines; controlled interruption tests; audio validity and pipeline tests; S3 integration using isolated test objects.

**Not included:** installers, boot service registration, new models, automatic capacity increases, cross-machine resume, or arbitrary user-defined pipelines.

**Exit:** both hosts process jobs and recover safely in development mode. A replacement worker restarts a failed attempt from the input; it does not resume an audio offset.

### Branch 4: `codex/worker-installers`

**Purpose:** turn the proven runtime into a repeatable one-command installation and unattended service.

**Work:**

- Package the shared CLI for eventual npm distribution. Implement `status`, `start`, `stop`, `restart`, `doctor`, `benchmark`, `update`, and `logs`; add `drain` and `uninstall`.
- Before branch 6, `update` must report that managed updates are not enabled. It must not perform an unsafe in-place dependency upgrade.
- Add thin Windows PowerShell and macOS/Linux shell bootstraps. A clean host must not be required to have Node/npm already installed. Use approved pinned artifacts and isolated runtime environments.
- Start sanitized local logging before dependency installation, redeem the enrollment code, upload diagnostics through the restricted installation session, validate artifacts, and support safe retries of interrupted installation.
- Detect OS, architecture, GPU/backend capability, dedicated or unified memory, driver compatibility, disk, and connectivity. Reject unsupported hosts with a specific reason; do not silently modify GPU drivers.
- Install a Windows Service, macOS LaunchDaemon, and Linux systemd adapter. Run with the least privilege that permits required operation; store credentials for the actual service identity.
- Download the versioned S3 benchmark fixture and validate accelerated processing through the installed service, not only through the interactive shell. Activate production capability only after this succeeds.
- Make reinstall, repair, second-instance rejection, drain/stop, and uninstall behavior explicit and testable.

**Checkpoints:**

- [ ] D1. Local package installation and CLI commands work without npm publication.
- [ ] D2. Windows installation, benchmark, and logged-out service execution pass on the Z440.
- [ ] D3. macOS installation, benchmark, and logged-out service execution pass on the M4.
- [ ] D4. Reboot recovery, failed install reporting, interrupted download retry, credential access, and uninstall pass on both.
- [ ] D5. Linux packaging/service logic and rejection paths pass CI; unverified GPU combinations remain disabled.

**Tests:** bootstrap/unit/packaging tests, clean-environment installation, actual logged-out/reboot tests, secret-redaction tests, failed-install tests. Missing evidence is a blocker for the platform being released.

**Not included:** publishing npm packages, silently installing services on the developer's Mac, enabling unsupported GPU configurations, or bypassing administrator consent/disk encryption.

**Exit:** the owner can install and run the worker on both available machines without leaving a terminal or user session open. Record boot-unlock prerequisites separately; do not claim software can bypass them.

### Branch 5: `codex/worker-dashboard`

**Purpose:** provide the minimum operational controls in the existing React dashboard, not a replacement dashboard framework. [R4]

**Work:**

- Add a machine list/detail view with nested workers, connection state, GPU/backend, installed versions, current attempts, benchmark evidence, effective capacity, and disabled reasons.
- Generate expiring enrollment commands; show sanitized installation history, errors, and command expiry without exposing persistent machine credentials.
- Add machine pause/resume/drain, bounded capacity configuration, credential revocation, and approved benchmark requests.
- Show job attempts, lease expiry/reassignment, cancellation, retries, structured logs, and recent sampled telemetry. Distinguish requested settings from acknowledged effective settings.
- Keep controls behind existing administrator authorization. Audit sensitive actions and handle empty, loading, offline, stale-data, denied, and error states.

**Checkpoints:**

- [ ] E1. Dashboard-generated enrollment successfully installs a test machine.
- [ ] E2. Machines and child workers appear as separate entities with accurate state.
- [ ] E3. Capacity, drain, pause, and revocation affect real behavior and display acknowledgement.
- [ ] E4. Failed installation and lost-job diagnosis can be performed from the dashboard.
- [ ] E5. Authorization and UI failure-state tests pass; no arbitrary remote command execution exists.

**Tests:** component tests, API contract tests, browser tests, and a live test against the two test workers.

**Not included:** billing, a public worker marketplace, advanced fleet analytics, or a complete UI redesign. Release-management controls are added in branch 6.

**Exit:** normal enrollment, inspection, diagnosis, and capacity control no longer require manual database edits.

### Branch 6: `codex/worker-updates`

**Purpose:** enable selected-machine automatic updates with recovery that survives a broken agent.

**Work:**

- Build versioned release manifests with compatible protocol/platform/backend information, verified artifacts, signed metadata, and model hashes.
- Add dashboard selection of target machines/groups, desired version, pause, promotion, and rollback. Use explicit canaries; do not auto-promote an unproven release to the whole fleet.
- Download and prepare a release beside the active one, stop new claims, drain, switch, run service/GPU health checks, and report success or rollback.
- Implement the small independent launcher/watchdog. It must detect startup failure/crash loops and restore the previous working release without relying on the broken agent or a working backend connection.
- Retain previous runtime/model artifacts and backward-compatible local state. Do not overwrite active Python environments, rotate incompatible secrets during the switch, or update GPU drivers.
- Keep minimum healthy capacity available during rollout. Define interrupted-update recovery and quarantine a failed release so the host does not retry it endlessly.

**Checkpoints:**

- [ ] F1. Only selected machines receive a release; non-targeted machines continue processing.
- [ ] F2. Normal updates drain work and resume with the new version.
- [ ] F3. Invalid signatures, incompatible manifests, and incomplete downloads are rejected.
- [ ] F4. Broken startup and GPU health failures cause local rollback on both available platforms.
- [ ] F5. Rollback works during backend/network unavailability; dashboard reports the final version when reconnected.

**Tests:** known-good/known-bad test bundles, interrupted switch, restart loops, revoked or invalid metadata, canary selection, and actual service-level recovery on both machines.

**Not included:** updating the watchdog itself automatically, fleet-wide automatic promotion, driver upgrades, or a general-purpose software deployment platform.

**Exit:** an intentionally defective test release cannot leave the two supported installations permanently broken under the tested failure cases. Record limits rather than claiming universal recovery.

### Branch 7: `codex/worker-integration`

**Purpose:** verify the complete feature and repair integration defects without adding new capabilities.

**Work:** restore new-job submission through the new control plane behind an explicit enablement gate; exercise the existing app/API flow; verify history, result retrieval, usage/account behavior, and notifications where affected. Audit CI/deployment triggers and reverse-proxy WebSocket configuration in a nonproduction environment.

**Checkpoints:**

- [ ] G1. Both machines process a shared queue concurrently; each accepted result has exactly one authoritative attempt.
- [ ] G2. A machine disappearing mid-job leads to expiry and reassignment; its late result cannot replace the new attempt's result.
- [ ] G3. Reconnect storms, missed notifications, duplicate requests, backend restart, transient Redis loss, expired grants, malformed audio, low disk, and GPU memory failures are exercised.
- [ ] G4. Cancellation/account deletion prevents unauthorized further publication and cleanup leaves no accepted references to abandoned attempts.
- [ ] G5. Enrollment, logs, 48-hour sample retention, capacity control, boot services, and staged rollback work together.
- [ ] G6. Existing app/history/admin regression suites pass; no removed worker implementation was resurrected.

**Tests:** end-to-end scenarios against isolated services/S3 prefixes, real two-machine execution, security boundary tests, representative longer audio, and existing affected component suites.

**Not included:** new separation models, new supported hardware claims, unrelated app redesign, or production enablement.

**Exit:** the system works as a complete feature, including failure paths. No critical correctness, security, data-loss, or recovery defect remains open.

### Branch 8: `codex/worker-release-readiness`

**Purpose:** make the tested feature reproducible and ready for an explicit final merge and release.

**Work:** pin and reproduce artifacts; document deployment, rollback, permissions, secret handling, npm publishing ownership, bootstrap hosting, signing-key custody, resource limits, and model/fixture redistribution review. Prepare additive data/index changes and backup/recovery procedures; do not delete old history.

**Checkpoints:**

- [ ] H1. Frozen release candidate installs and passes service-level GPU tests on both available machines.
- [ ] H2. All branch evidence, checkpoints, checksums, limitations, and release notes are complete.
- [ ] H3. Package contents contain no secrets, personal audio, private environment files, or unintended files; publishing is still an explicit owner action.
- [ ] H4. Release support flags match hardware evidence; NVIDIA and Linux GPU paths are not advertised as verified without actual tests.
- [ ] H5. Fresh install, upgrade, failure rollback, revoke, and uninstall runbooks are reproducible.
- [ ] H6. `main` has remained unchanged; final cumulative diff, CI, and deployment triggers are reviewed.
- [ ] H7. Maintainer approves the final `codex/worker-rebuild` → `main` pull request and separate production enablement.

**Tests:** complete affected checks, exact candidate bundle checks, package dry run, real installation/recovery tests, and final regressions. Do not rerun only against a development checkout and assume the release archive is identical.

**Not included:** automatic merge into `main`, automatic npm publication, production migrations, or turning processing on without authorization.

**Exit:** the complete declared MVP is accepted. Only then may the owner perform the final merge and release actions.

## 5. Platform acceptance and honest support labels

| Target                                   | Intended model backend                                                                   | Required evidence / release behavior                                                                   |
| ---------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Mac mini M4 / macOS ARM64                | ONNX Runtime CoreML configured and verified for the agreed Apple GPU acceleration policy | Actual development and service tests required                                                          |
| Z440 / Windows / RX 580                  | ONNX Runtime DirectML                                                                    | Actual development and service tests required                                                          |
| Windows or Linux NVIDIA                  | ONNX Runtime CUDA                                                                        | Implement/test adapters as applicable; disabled until actual GPU validation                            |
| Linux AMD                                | A tested supported ROCm stack with ONNX Runtime MIGraphX                                 | Unverified until actual hardware validation; do not assume Windows RX 580 success proves Linux support |
| Intel Mac, Intel GPU, CPU-only execution | Not supported                                                                            | Explicit rejection                                                                                     |

For the Kim ONNX path, CoreML is not the same API as PyTorch MPS. CoreML can choose different compute resources, so provider presence alone is insufficient evidence of the agreed GPU behavior. The deprecated ONNX Runtime ROCm provider was removed in version 1.23; evaluate MIGraphX for the AMD Linux path rather than building a new dependency on the removed provider. [T2, T4]

Discrete NVIDIA/AMD GPU admission requires at least 4 GB VRAM under the agreed policy; 8 GB+ is recommended. Record dedicated capacity and current available memory separately. Apple admission uses unified-memory information and an actual working-memory test rather than pretending it has dedicated VRAM. Supporting CPU preprocessing is allowed; accepting wholly CPU-only model inference is not.

Each configuration is labeled **verified**, **experimental/disabled**, **blocked**, or **unsupported**, with a reason and evidence. A successful compile or fake-engine run cannot change a hardware support label to verified.

The initial production-enabled scope is the two available machines after they pass. Windows/Linux NVIDIA and AMD Linux remain architecture targets, not fabricated release claims. This follows the agreed phased rollout. If the maintainer requires them in the first public support promise, H4 remains blocked until corresponding hardware tests are completed.

## 6. Exact Git workflow

These commands are documentation, not instructions to run every stage immediately. Run them in a clean working tree, at the relevant accepted checkpoint. Remote pushes and final merges require the maintainer's normal authorization. Check release/deployment triggers before pushing branches or tags.

### 6.1 Set up once

```bash
# Fetch remote state; inspect and resolve uncommitted work before continuing.
git fetch origin --prune
git status --short

# Existing local branch:
git switch codex/worker-clean-slate
git pull --ff-only origin codex/worker-clean-slate

# If it exists only remotely, use this INSTEAD of the switch/pull above:
# git switch --track -c codex/worker-clean-slate origin/codex/worker-clean-slate

# Record these SHAs in the architecture checkpoint.
git rev-parse HEAD
git rev-parse origin/main

# Only create these branches when they do not already exist.
git switch -c codex/worker-rebuild
git push -u origin codex/worker-rebuild

git switch codex/worker-clean-slate
git switch -c codex/worker-architecture
git push -u origin codex/worker-architecture
```

Do not force-reset an existing branch to make these commands work. Inspect its commits first.

### 6.2 Finish and merge one milestone

Commit focused implementation, tests, and its evidence report on the current branch. Open a pull request with:

```text
Head: codex/worker-architecture
Base: codex/worker-rebuild
```

Require the branch's exit checklist and review. Use **Create a merge commit**, not squash or rebase, for the implementation-chain pull requests. Confirm this merge method is permitted by repository rules; do not change protection settings automatically.

Once merged, synchronize the completed feature branch and create its successor:

```bash
git fetch origin --prune
git switch codex/worker-architecture
git merge --ff-only origin/codex/worker-rebuild

git push origin codex/worker-architecture

# Only after checkpoint A is accepted:
git switch -c codex/worker-control-plane
git push -u origin codex/worker-control-plane
```

Repeat the same sequence for each row in the branch table. The fast-forward includes the accepted merge commit; the next branch therefore starts from the previous branch's exact approved state. `--ff-only` refuses unexpected divergence instead of generating an unreviewed merge. [T1]

Keep completed remote branches until final release. Disable automatic branch deletion for this chain, or intentionally recreate the completed branch at the accepted collection-branch commit before continuing. Do not silently change the branch topology.

If fast-forward synchronization fails, stop and inspect `git log --graph --oneline --decorate --all`. Do not force-push, squash, rebase published history, or use `reset --hard` as a shortcut.

### 6.3 Record accepted checkpoints

Create an immutable annotated tag at the accepted collection-branch commit, after review. Example:

```bash
git tag -a worker-mvp/01-architecture -m "Accepted worker architecture checkpoint"
git push origin worker-mvp/01-architecture
```

Use `02-control-plane`, `03-shared-runtime`, `04-installers`, `05-dashboard`, `06-updates`, `07-integration`, and `08-release-readiness` similarly. Verify tag-triggered automation first. A checkpoint tag is not a production-release instruction.

### 6.4 Fixes after a successor has started

Do not amend or rewrite an accepted checkpoint. Put the correction and its regression test on the current active implementation branch when it is required for that milestone; document the earlier contract it repairs. Do not create a fix branch per small defect.

If a critical defect invalidates an accepted gate, stop progression, repair it, and rerun affected downstream checks. Record new evidence without moving the old tag.

### 6.5 Final merge

After release readiness merges into the collection branch, open one final pull request:

```text
Head: codex/worker-rebuild
Base: main
```

Review the cumulative change, including the original clean-slate deletion. The final branch already contains all preceding stages; do not individually merge every older branch into `main` again.

Compare `origin/main` to the recorded baseline SHA. Unexpected movement is a review issue: incorporate and test legitimate changes on the rebuild chain before final acceptance, without resetting `main`.

The maintainer performs the final merge. Treat deployment, feature enablement, npm publication, and production data/index changes as explicit release actions, not side effects authorized by this roadmap.

## 7. Agent execution and evidence contract

### Instructions for any coding agent

Read this roadmap, repository contribution guidance, and applicable component instructions. Inspect the actual checkout and branch before editing. Work only on the assigned milestone.

Do not change `main`, re-create the deleted worker, deploy to production, publish packages, expose credentials, install a boot service, reboot a machine, or change GPU drivers without explicit authorization. Do not alter unrelated application behavior or downgrade GPU admission rules to pass a test.

Use the existing backend and dashboard tooling. The inspected backend manifest declares pnpm and a `verify` script, while some prose documentation still uses npm examples. Inspect the current lockfile/package manager and reconcile instructions rather than creating competing lockfiles. The dashboard already has format, lint, typecheck, test, build, and browser-test commands. [R3, R4]

Keep credentials, machine tokens, enrollment codes, presigned URLs, and user audio out of Git and reports. Tests must use isolated services and rights-cleared fixtures. A host operator can inspect assigned audio; the first fleet consists of trusted machines.

At the end of each milestone, report completed work, tests actually executed, failing/skipped tests, hardware evidence, known limits, and the next branch. Stop at the checkpoint. Do not create the successor, merge, or publish merely because tests completed.

### Evidence file

Write one concise report per milestone under:

```text
docs/worker/checkpoints/01-architecture.md
...
docs/worker/checkpoints/08-release-readiness.md
```

Use this template:

```markdown
# Checkpoint: <number and name>

Branch:
Parent checkpoint:
Implementation commit tested:
Status: NOT_STARTED | IN_PROGRESS | BLOCKED | READY_FOR_REVIEW | ACCEPTED

## Delivered

Describe the actual completed behavior and relevant files.

## Verification

| Test | Environment/hardware | Result                | Evidence                             |
| ---- | -------------------- | --------------------- | ------------------------------------ |
| ...  | ...                  | PASS / FAIL / NOT_RUN | Sanitized artifact or command output |

## Remaining limitations

List unresolved defects, unavailable hardware, skipped tests, and release impact.

## Handoff

Next branch:
Required prerequisites:
```

Record the tested implementation SHA before committing the evidence report; do not invent a self-referencing commit SHA. Acceptance and merge SHAs can be recorded in the PR and checkpoint tag. Only the maintainer marks a milestone accepted.

For long logs, retain the sanitized artifact in controlled storage and reference it from the report. Installation events are unsampled; historical heartbeats may be sampled with 48-hour expiry. Backend outages require local spooling and retry; a disconnected machine cannot guarantee immediate delivery of its last log entries.

## 8. Definition of complete

The feature is complete for its declared release scope when a dashboard-issued command enrolls a supported machine, verifies GPU execution, installs a boot service, benchmarks it, and connects its supervised workers to the durable queue. Both available machines can process work, upload outputs, recover from loss, obey capacity controls, expose diagnostics, and survive a deliberately failed update through local rollback.

The app's existing history/result behavior remains intact, new submissions use the replacement system, unauthorized or stale attempts cannot publish results, and unverified GPU platforms remain disabled. All required evidence is present before the final merge to `main`.

Automatic concurrency optimization, additional models, public worker operators, arbitrary workflow builders, universal Linux support, cross-machine checkpoint/resume, and backend high availability remain later work. A single-VPS backend is not made highly available merely by adding processing machines.

## 9. Source and verification references

Repository references were read from `codex/worker-clean-slate` for this plan. Branch references can move; record exact commit SHAs when implementation starts.

- **[R1]** MusicMute clean-slate README: `https://github.com/hatemragab/music_mute/blob/codex/worker-clean-slate/README.md`
- **[R2]** Repository contribution rules: `https://github.com/hatemragab/music_mute/blob/codex/worker-clean-slate/CONTRIBUTING.md`
- **[R3]** Backend package manifest: `https://github.com/hatemragab/music_mute/blob/codex/worker-clean-slate/backend/package.json`
- **[R4]** Dashboard package manifest: `https://github.com/hatemragab/music_mute/blob/codex/worker-clean-slate/dashboard/package.json`
- **[T1]** Official Git merge semantics, including merge commits and fast-forward-only behavior: `https://git-scm.com/docs/git-merge`
- **[T2]** ONNX Runtime CoreML provider and compute-unit configuration: `https://onnxruntime.ai/docs/execution-providers/CoreML-ExecutionProvider.html`
- **[T3]** ONNX Runtime DirectML provider and session/device restrictions: `https://onnxruntime.ai/docs/execution-providers/DirectML-ExecutionProvider.html`
- **[T4]** ONNX Runtime ROCm provider removal and MIGraphX direction: `https://onnxruntime.ai/docs/execution-providers/ROCm-ExecutionProvider.html`

The branch boundaries, acceptance gates, intervals, and rollout rules above are project recommendations and requirements, not guarantees supplied by those references.
