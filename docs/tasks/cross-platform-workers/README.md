# Cross-platform GPU workers: task index

**Status:** REVISED 2026-09-15 to a light fleet v1 — B01–B06 and W01–W04 locally reviewed and kept; I01 in progress; I02/I03/I04, D01 and F02 active; H01 redefined as light packaging; D02, D03, H02 and V01–V03 deferred out of v1. See [execution ledger](evidence/execution-ledger.md).
**Date:** 2026-09-13, revised 2026-09-15
**Workspace:** /Users/hatemragap/work_spaces/music_remover
**Revised direction:** [Light fleet v1](revised-direction.md) — **supersedes this register wherever they conflict**
**Design:** [Approved architecture](../../superpowers/specs/2026-09-13-cross-platform-worker-fleet-design.md)
**Master plan:** [Implementation plan](../../superpowers/plans/2026-09-13-cross-platform-worker-fleet.md) — its task sequencing is superseded by the revised direction
**Contracts:** [Wire formats and component interfaces](contracts.md)
**Coverage:** [Requirements, dependencies and validation gates](coverage-and-validation.md)

## Latest user clarification

**2026-09-15 — light v1.** "I need a light multi cross workers, remove the complex things. Make it light, I need to go up — not waste a lot of time in development." Task scope is cut to what a real contributor machine needs to install, pair, claim, process and report. Deferred tasks keep their files and are not deleted. Where this clarification and the register above conflict, the [revised direction](revised-direction.md) governs. The earlier clarification below remains binding.

This project is still in development. Breaking changes are allowed. Do not create migrations, backfills, compatibility bridges, old-client decoders or legacy installation adapters. Remove the old mode and obsolete migration machinery outright. New installations pair through the new flow. This supersedes the earlier discussion of a production migration.

Breaking changes do not authorize deleting existing data. If old development records or local state are incompatible, identify the exact manual reset/re-enrollment requirement and obtain authorization before any destructive reset. There is no production migration task in this pack.

## Execution rules

- Implementation is now explicitly authorized. Task files still do not authorize commits, pushes, publication, deployment, real credential changes or data deletion.
- When implementation is explicitly requested, read the design, contracts, relevant task, repository instructions and current source before editing.
- Use superpowers:executing-plans with review checkpoints. Do not spawn agents unless explicitly authorized by the user or applicable execution instructions.
- Every task begins NOT STARTED. Mark complete only when its acceptance and required validation have actual evidence; code existence or generated reports alone is insufficient.
- Test commands naming new files become runnable when that task introduces those files. They were not run while writing this plan.
- Keep secrets/environment values out of docs, logs, tests and packages. Use native isolated MongoDB/Redis helpers; no tests against real accounts/audio/services.
- Preserve administrative drain/revoke decisions and unresolved assignment journals. Never use offline status or stopped heartbeats as process-stop proof.
- A registered GPU recipe is not qualified by mocks. Missing real hardware, preboot unlock or unavailable service-session acceleration must be reported.
- New protocol v3 is implemented directly. Build-floor enforcement within that protocol still allows existing owned attempts to finish safely. Deliberately incompatible changes require a coordinated idle development restart.
- No worker Docker dependency. The separate CapRover artifact app uses CapRover's normal hosting packaging, which does not change how contributors run workers.
- Existing mobile apps are outside scope. If a later change touches mobile validation, use only the user's designated iPhone 17 Pro/iOS 26.0 simulator, UDID 3CC14436-EC3C-4419-A079-C84951E5FA07.
- Implementation preserves unrelated changes and uses scoped formatting/tests. Evidence distinguishes local source validation from native GPU/boot proof and deployed behavior.

## Task register

Status reflects the [revised direction](revised-direction.md). **ACTIVE** = in v1, must complete. **KEPT** = built and reviewed, no further v1 work. **DORMANT** = built and reviewed, deliberately not wired or packaged in v1. **DEFERRED** = out of v1, no work scheduled, files kept.

| Task                                                                   | Deliverable                                                              | Dependencies                      | Status                 |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------- | ---------------------- |
| [F01](foundation/F01-gpu-recipes-and-evidence.md)                      | Qualify candidate GPU recipes and define evidence                        | None                              | IN PROGRESS — matrix cut to 4 profiles pending |
| [F02](foundation/F02-first-machine-end-to-end-spike.md)                | Prove the full loop on one real machine                                  | I01, I03 (or I02)                 | NOT STARTED — **ACTIVE**, gates launch |
| [B01](backend/B01-runtime-contract-and-schema.md)                      | Add the new worker runtime contracts and persistence                     | None                              | COMPLETE (LOCAL) — KEPT |
| [B02](backend/B02-installation-pairing.md)                             | Implement scoped installation sessions and code approval                 | B01                               | LOCAL REVIEWED — KEPT  |
| [B03](backend/B03-events-and-retention.md)                             | Implement structured worker events and exact 30-day visibility           | B01, B02                          | LOCAL REVIEWED — KEPT  |
| [B04](backend/B04-releases-groups-and-rollouts.md)                     | Implement worker release records, groups, and selected targets           | B01                               | LOCAL REVIEWED — KEPT, no v1 UI |
| [B05](backend/B05-claim-gates-and-qualification.md)                    | Enforce GPU, boot, build, and media eligibility at claim time            | B01, B04, F01                     | LOCAL REVIEWED — KEPT  |
| [B06](backend/B06-fleet-only-transition.md)                            | Remove legacy runtime and migration machinery outright                   | B02, B05, W01                     | LOCAL REVIEWED — KEPT  |
| [W01](worker/W01-shared-core-and-state.md)                             | Extract the shared worker core and stable launcher interfaces            | F01                               | LOCAL REVIEWED — KEPT  |
| [W02](worker/W02-gpu-runtime-and-qualification.md)                     | Implement recipe selection, model preparation and GPU-only qualification | W01, F01, B01                     | LOCALLY REVIEWED — KEPT |
| [W03](worker/W03-signed-downloads-and-event-spool.md)                  | Build independent update verification and durable event reporting        | W01, B03, B04                     | LOCALLY REVIEWED — **DORMANT** |
| [W04](worker/W04-activation-and-rollback.md)                           | Implement transactional activation, recovery and permitted rollback      | W02, W03, B05                     | LOCALLY REVIEWED — **DORMANT** |
| [I01](installers/I01-common-bootstrap-and-setup.md)                    | Implement shared setup orchestration and pre-runtime reporting           | W01, W02, W03, B02, B03           | IN PROGRESS — **ACTIVE** |
| [I02](installers/I02-windows-native.md)                                | Deliver Windows native installation and verified at-boot execution       | I01, W04                          | NOT STARTED — **ACTIVE** |
| [I03](installers/I03-macos-native.md)                                  | Deliver macOS native installation and LaunchDaemon qualification         | I01, W04                          | NOT STARTED — **ACTIVE**, build first |
| [I04](installers/I04-linux-native.md)                                  | Deliver Linux native installation and systemd GPU operation              | I01, W04                          | NOT STARTED — **ACTIVE** |
| [D01](dashboard/D01-pairing-and-installations.md)                      | Add pending installations and code-based worker approval                 | B02, B03                          | NOT STARTED — **ACTIVE**, minimal |
| [H01](distribution/H01-release-packaging-and-signing.md)               | Build reproducible native release artifacts and signing workflow         | I02, I03, I04                     | NOT STARTED — **ACTIVE**, redefined light |
| [D02](dashboard/D02-selected-rollouts.md)                              | Add worker groups, release publication and selected rollout controls     | B04                               | **DEFERRED** out of v1 |
| [D03](dashboard/D03-worker-health-and-log-timeline.md)                 | Show worker qualification, update health and 30-day event timelines      | B01, B03, D01, D02                | **DEFERRED** out of v1 |
| [H02](distribution/H02-caprover-artifact-app.md)                       | Prepare the separate CapRover distribution app and safe publication      | B04, H01                          | **DEFERRED** out of v1 |
| [V01](verification/V01-native-platform-qualification.md)               | Prove GPU-only installation, boot operation and broad hardware coverage  | I02, I03, I04, H01, B05           | **DEFERRED** — folded into F02 |
| [V02](verification/V02-fleet-fault-and-contract-tests.md)              | Validate the integrated fleet under ownership, setup and update failures | B06, D03, D02, H02, W04           | **DEFERRED** — folded into F02 |
| [V03](verification/V03-development-deployment-and-selected-rollout.md) | Prepare the authorized development deployment and first selected rollout | V01, V02, H02                     | **DEFERRED** — folded into F02 |

Tasks not in this register were never in the pack. Deferred tasks keep their files and evidence; they are not deleted and can be re-enabled by a later revision.

## v1 execution order

1. [I01](installers/I01-common-bootstrap-and-setup.md) closeout — native host registration, native `Retry-After` persistence, aggregate spool bound.
2. [I03](installers/I03-macos-native.md) — provable on local hardware.
3. [I02](installers/I02-windows-native.md), then [I04](installers/I04-linux-native.md) — same adapter interface, run on the real machines.
4. [D01](dashboard/D01-pairing-and-installations.md) minimal pairing UI — required before a real approval.
5. [H01](distribution/H01-release-packaging-and-signing.md) light — tarball plus SHA-256, manual publish.
6. [F02](foundation/F02-first-machine-end-to-end-spike.md) — the gate. One machine, full loop, real job.
7. Launch on the machines that passed F02.

F01's matrix cut (editing `worker/qualification/candidates.json`) is a source change and waits for explicit authorization.

## Dependency order

Superseded by [v1 execution order](#v1-execution-order) above. The original ten-wave order assumed every task was in scope; with D02, D03, H02 and V01–V03 deferred, the waves collapse to the linear sequence in that section.

Two rules from the original order still apply:

- Shared-ownership files are handled sequentially even when dependencies permit independent work. D01 and D02 shared `router.tsx`, `app-shell.tsx` and `api/contracts.ts`; D02 is deferred, so D01 no longer contends for them.
- Dependencies are dependency waves, not an instruction to delegate.

## Files and responsibilities

| Proposed area                                            | Responsibility                                                                       | v1 |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------ | -- |
| worker/musicmute_worker/                                 | Shared worker, typed protocol, separation, installer orchestration and durable state | ACTIVE |
| worker/musicmute_worker/platforms/                       | Native Windows/macOS/Linux adapters and containment                                  | ACTIVE |
| worker/musicmute_worker/update/                          | Independent signed downloads, activation journal and rollback                        | DORMANT — built, not wired |
| worker/install/                                          | Thin PowerShell/POSIX bootstrap and native service assets                            | ACTIVE |
| worker/profiles/ and worker/qualification/               | Exact dependency recipes and actual GPU/boot evidence                                | ACTIVE — 4 profiles |
| backend/src/worker-installations/                        | Scoped setup sessions, expiring codes and administrator approval                     | KEPT |
| backend/src/worker-events/                               | Safe scoped event ingestion/query and 30-day retention                               | KEPT — no v1 timeline UI |
| backend/src/worker-releases/                             | Worker artifacts, stable release, saved groups and selected targets                  | KEPT — no v1 rollout UI |
| Existing backend/src/worker/ and processing-queue/       | Registry authority, readiness and transactionally fenced eligibility                 | KEPT |
| Existing dashboard worker features plus worker-releases/ | Installations, approval, log timelines, groups and rollout controls                  | D01 only; timeline/groups DEFERRED |
| worker-distribution/                                     | Separate persistent CapRover file/publication service                                | DEFERRED — do not create in v1 |
| .github/workflows/worker-release-build.yml               | Native build artifacts only; no automatic publish/deploy                             | DEFERRED — H01-light builds locally |
| evidence/ during execution                               | Safe test, hardware and deployment reports; never fabricated completion              | ACTIVE |

## Definition of done (v1)

The fill-in-the-blank sentence for v1: **a real machine installs with one command, an administrator approves its pairing code, it claims and completes a real job on a real GPU, and the dashboard shows it happened — with no manual secret transfer.**

Specifically:

- F02's report exists and records a completed loop on at least one real machine, naming the exact GPU, driver and profile.
- The supported profile set (4 entries, 3 families) is documented with every exclusion reasoned; unsupported hardware is clearly listed.
- Final source contains one fleet protocol and no migration or legacy runtime.
- Setup, pairing and logging work end to end on each platform that passed F02.
- No profile is called qualified without a real machine run.

**Explicitly NOT required for v1:** signed/TUF updates, activation rollback, groups, rollout UI, event timeline UI, the CapRover distribution app, or a formal multi-hardware qualification matrix. Those are deferred, not cancelled.

No feature is called production-ready solely from local unit tests. Actual hosting and contributor rollout remain pending until separately authorized and verified.
