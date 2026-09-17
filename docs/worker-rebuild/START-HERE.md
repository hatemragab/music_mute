# Music Mute worker rebuild: start here

**Package revision:** 3.0. **Prepared:** September 17, 2026.

This package contains completed design documents and implementation instructions for the Music Mute worker rebuild. It is not an implemented worker, an instruction to deploy immediately, or evidence that GPU tests have passed.

## First assignment to the coding agent

> Work in `hatemragab/music_mute`. Read this file, `AGENT-RULES.md`, `ROADMAP.md`, and `REPO-STUDY-MAP.md`. The existing entry/collection branch is `codex/worker-rebuild`; do not recreate or reset it. Create `codex/worker-architecture` from the current accepted `origin/codex/worker-rebuild`. Follow `tasks/01-worker-architecture.md` only. Import and review the supplied design documents rather than designing the system again. Keep this branch documentation-only. Commit, push, and open a pull request with base `codex/worker-rebuild`. Stop for review. Do not merge, deploy, publish packages, change `main`, or begin the next branch without the maintainer accepting the previous branch and authorizing continuation.

When this directory is copied into the repository, use **`docs/worker-rebuild/`**. Preserve the directory structure so the relative links work. Extract the archive outside the repository first, create the architecture branch, and only then copy the package into that path. Do not copy files over existing work without inspecting the differences.

The only Python file supplied is the maintainer's unchanged historical reference, `reference/separate.py`. It is documentation evidence, not the new runtime. Do not install it, register it as a service, or import it from production code.

## Decisions already settled

| Area | Decision |
| --- | --- |
| Starting point | `codex/worker-rebuild` exists and starts from the worker clean slate |
| Protected work | Neither `main` nor `codex/worker-clean-slate` receives implementation commits |
| Git permissions | Agent may create the assigned branch, commit, push, and open/update its PR against `codex/worker-rebuild` |
| Approval boundary | Maintainer reviews and merges each branch; the agent then starts its authorized successor |
| Backend | Existing NestJS application, MongoDB and Redis; no Supabase |
| Hierarchy | Backend → machines → supervisor on each machine → multiple processing child workers |
| Hardware | Actual first targets: Mac mini M4, then Windows Z440 / RX 580 8 GB |
| Windows access | SSH credentials and verified host details will be supplied later; never invent them |
| Test resources | Local isolated MongoDB replica set and Redis; scoped S3 test objects using owner-supplied backend credentials |
| Secrets | Owner may provide `.local.env`; it is never committed, attached to a PR, uploaded as logs, or sent to workers |
| Processing | Kim Vocal 2; reference-compatible gap trimming; optional real denoise; voice-only MP3 |
| Pipeline controls | Dashboard controls new-job defaults and machine/worker eligibility; current jobs retain frozen recipes |
| Distribution | WebSocket notifications and heartbeat; HTTPS ownership and grants; direct worker ↔ S3 data |
| Recovery | Renewable leases, new attempt IDs, conditional finalization, bounded retries, no cross-machine resume |
| Updates | MVP uses immutable versioned bundles with manual update and independent local rollback; automatic fleet rollout is post-MVP |

No more product questions are needed to begin the documentation and backend branches. Missing SSH details, exact GPU-compatible dependency pins, actual hardware performance, artifact URLs, and signing/publishing credentials are later validation inputs, not excuses to invent values or to alter the design.

## Read by purpose

| Need | File |
| --- | --- |
| Branch order, acceptance checkpoints, exact Git workflow | [ROADMAP.md](ROADMAP.md) |
| Permissions, safety limits, evidence, stop rules | [AGENT-RULES.md](AGENT-RULES.md) |
| Existing repository files to understand | [REPO-STUDY-MAP.md](REPO-STUDY-MAP.md) |
| Finished system design | [architecture/01-system-design.md](architecture/01-system-design.md) |
| Entities, queue ownership, wire protocol | [architecture/02-domain-and-protocol.md](architecture/02-domain-and-protocol.md) |
| Audio semantics, trimming, denoise, recipe policy | [architecture/03-audio-pipelines.md](architecture/03-audio-pipelines.md) |
| Enrollment, credentials, installer, service security | [architecture/04-installation-and-security.md](architecture/04-installation-and-security.md) |
| Logs, capacity, heartbeats, releases and rollback | [architecture/05-operations-and-updates.md](architecture/05-operations-and-updates.md) |
| Dashboard behavior and states | [architecture/06-dashboard-spec.md](architecture/06-dashboard-spec.md) |
| Tests, evidence and release gate | [architecture/07-test-strategy.md](architecture/07-test-strategy.md) |
| Source-derived review of the attached script | [reference/TRIMMER-REVIEW.md](reference/TRIMMER-REVIEW.md) |
| Source provenance and external documentation | [reference/SOURCES.md](reference/SOURCES.md) |

## Work one branch at a time

Each branch task has a purpose, prerequisite, study list, proposed file changes, ordered implementation checkpoints, tests, exclusions, and handoff criteria. File paths marked **new/proposed** do not already exist. Paths marked **read** were inspected; **discovered** paths were found in imports, manifests, or listings and must be read locally.

Within the assigned branch, work through its checkpoints, test, and make focused commits. Stop if a checkpoint is blocked by a correctness or security issue. A hardware check lacking access is `NOT_RUN`, not `PASS`; continue only independent work inside the same branch. Push a **draft** PR when required evidence is still missing. Make it ready for review only when the branch exit gate is met.

Do not run the entire seven-branch implementation sequence unattended. The branch PR is the human review boundary. No separate approval is needed for every ordinary local test command within the authorized branch, but disruptive operations have additional limits in `AGENT-RULES.md`.

## Important changes from the earlier roadmap

Architecture is strictly documentation-only. GPU feasibility has its own branch immediately after architecture and before any control-plane implementation. Installation and platform-service work lives with the shared runtime. Automatic fleet updates are post-MVP; release readiness still proves versioned packaging, manual update, and rollback. The collection branch already exists. The actual trimmer removes qualifying internal gaps; it must not be replaced with edge-only trimming. Initial recipe default is trimming enabled and denoise disabled, preserving the supplied script's default trimming behavior while adding genuine switches.

The `.local.env` filename differs from the repository's existing `.env.local` convention. Follow the explicit handling in the rules and local runbook; do not assume the file is loaded or ignored automatically.

## What has and has not been tested during preparation

The repository was read at commit `a786a1773a3c72fb09d1b02def1ae39330561892`. A targeted source inspection was performed, not a complete audit. The original `trim_vocal_gaps` function was tested on eight synthetic audio cases in the assistant's Linux sandbox. Package links, JSON, checksums, and the proposed Git flow are checked separately in the package validation record.

No project implementation, M4/RX 580 inference, SSH connection, service installation, live S3 integration, npm publication, deployment, repository branch creation, push, or merge was performed while preparing this archive. Architecture documents are supplied; architecture **branch acceptance** is still pending.
