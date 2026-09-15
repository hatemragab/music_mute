# Cross-platform GPU Worker Fleet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task only after implementation authorization. Steps use checkbox syntax in the linked task files. No automatic subagent dispatch or operational action is authorized.

**Goal:** Deliver native one-command GPU workers for trusted contributors on Windows, macOS and Linux, with code approval, always-on boot processing, safe centralized logs and selected-worker signed updates.
**Architecture:** One shared Python worker and independent launcher use native OS adapters. Existing NestJS/backend and React/dashboard own pairing, jobs, runtime state, events and selected rollouts. A separate persistent CapRover app serves signed immutable releases at https://updates.music-mute.com.
**Tech Stack:** Python with managed locked environments, ONNX Runtime/provider-specific qualified recipes, FFmpeg, NestJS/TypeScript/Mongoose/Redis, React, native service managers, TUF and CapRover.
**Spec:** [Approved development design](../specs/2026-09-13-cross-platform-worker-fleet-design.md)
**Detailed tasks:** [23-task index](../../tasks/cross-platform-workers/README.md)
**Wire contracts:** [Shared contracts](../../tasks/cross-platform-workers/contracts.md)
**Status:** IMPLEMENTATION IN PROGRESS; see the task index and execution ledger for validated scope and remaining gates.

## Global constraints

- Development-only breaking changes are allowed. Create no migrations, backfills, compatibility bridges, old-client decoders or legacy installation adapters.
- Remove legacy mode, environment credential fallback, default z440 inference and obsolete migration commands.
- Native Windows/macOS/Linux installation; contributors need no Docker.
- GPU-only model inference. Stop setup with a safe dashboard-reported reason if only CPU inference is available.
- Start at boot without login; process whenever eligible jobs exist. No idle-only, login-only or AC-only policy.
- One active assignment per machine; preserve cancellation, cleanup and stopped-recovery semantics.
- Trusted contributors require expiring-code administrator approval.
- Detailed logs expire after 30 days; absent telemetry and interrupted reporting remain unknown.
- Updates apply only to explicit selected workers or a snapshot of selected group members.
- Signed immutable releases, separately selected stable installers and complete-environment permitted rollback.
- Distribution domain is https://updates.music-mute.com in a separate CapRover app.
- Management remains in the existing backend/dashboard.
- Reinstallation or breaking changes do not authorize deleting data. Report incompatible development state rather than converting or resetting it automatically.
- No code implementation, commits, pushes, publishing, deployment, credential changes or destructive operations are authorized by this plan.
- Actual hardware/service/reboot and hosted proof remain separate from unit or mock validation.

---

## Ordered tasks

### F01: Qualify candidate GPU recipes and define evidence

- [ ] Complete [F01: detailed file ownership, interfaces, steps, acceptance and commands](../../tasks/cross-platform-workers/foundation/F01-gpu-recipes-and-evidence.md).
- [ ] Record actual validation evidence and unresolved limits before marking the task complete.

**Depends on:** None.

### B01: Add the new worker runtime contracts and persistence

- [x] Complete [B01: detailed file ownership, interfaces, steps, acceptance and commands](../../tasks/cross-platform-workers/backend/B01-runtime-contract-and-schema.md). Local foundation reviewed; full claim admission remains B05.
- [ ] Record actual validation evidence and unresolved limits before marking the task complete.

**Depends on:** None.

### B02: Implement scoped installation sessions and code approval

- [ ] Complete [B02: detailed file ownership, interfaces, steps, acceptance and commands](../../tasks/cross-platform-workers/backend/B02-installation-pairing.md).
- [ ] Record actual validation evidence and unresolved limits before marking the task complete.

**Depends on:** B01.

### B03: Implement structured worker events and exact 30-day visibility

- [ ] Complete [B03: detailed file ownership, interfaces, steps, acceptance and commands](../../tasks/cross-platform-workers/backend/B03-events-and-retention.md).
- [ ] Record actual validation evidence and unresolved limits before marking the task complete.

**Depends on:** B01, B02.

### B04: Implement worker release records, groups, and selected targets

- [ ] Complete [B04: detailed file ownership, interfaces, steps, acceptance and commands](../../tasks/cross-platform-workers/backend/B04-releases-groups-and-rollouts.md).
- [ ] Record actual validation evidence and unresolved limits before marking the task complete.

**Depends on:** B01.

### B05: Enforce GPU, boot, build, and media eligibility at claim time

- [ ] Complete [B05: detailed file ownership, interfaces, steps, acceptance and commands](../../tasks/cross-platform-workers/backend/B05-claim-gates-and-qualification.md).
- [ ] Record actual validation evidence and unresolved limits before marking the task complete.

**Depends on:** B01, B04, F01.

### B06: Remove legacy runtime and migration machinery outright

- [ ] Complete [B06: detailed file ownership, interfaces, steps, acceptance and commands](../../tasks/cross-platform-workers/backend/B06-fleet-only-transition.md).
- [ ] Record actual validation evidence and unresolved limits before marking the task complete.

**Depends on:** B02, B05, W01.

### W01: Extract the shared worker core and stable launcher interfaces

- [ ] Complete [W01: detailed file ownership, interfaces, steps, acceptance and commands](../../tasks/cross-platform-workers/worker/W01-shared-core-and-state.md).
- [ ] Record actual validation evidence and unresolved limits before marking the task complete.

**Depends on:** F01.

### W02: Implement recipe selection, model preparation and GPU-only qualification

- [ ] Complete [W02: detailed file ownership, interfaces, steps, acceptance and commands](../../tasks/cross-platform-workers/worker/W02-gpu-runtime-and-qualification.md).
- [ ] Record actual validation evidence and unresolved limits before marking the task complete.

**Depends on:** W01, F01, B01.

### W03: Build independent update verification and durable event reporting

- [ ] Complete [W03: detailed file ownership, interfaces, steps, acceptance and commands](../../tasks/cross-platform-workers/worker/W03-signed-downloads-and-event-spool.md).
- [ ] Record actual validation evidence and unresolved limits before marking the task complete.

**Depends on:** W01, B03, B04.

### W04: Implement transactional activation, recovery and permitted rollback

- [ ] Complete [W04: detailed file ownership, interfaces, steps, acceptance and commands](../../tasks/cross-platform-workers/worker/W04-activation-and-rollback.md).
- [ ] Record actual validation evidence and unresolved limits before marking the task complete.

**Depends on:** W02, W03, B05.

### I01: Implement shared setup orchestration and pre-runtime reporting

- [ ] Complete [I01: detailed file ownership, interfaces, steps, acceptance and commands](../../tasks/cross-platform-workers/installers/I01-common-bootstrap-and-setup.md).
- [ ] Record actual validation evidence and unresolved limits before marking the task complete.

**Depends on:** W01, W02, W03, B02, B03.

### I02: Deliver Windows native installation and verified at-boot execution

- [ ] Complete [I02: detailed file ownership, interfaces, steps, acceptance and commands](../../tasks/cross-platform-workers/installers/I02-windows-native.md).
- [ ] Record actual validation evidence and unresolved limits before marking the task complete.

**Depends on:** I01, W04.

### I03: Deliver macOS native installation and LaunchDaemon qualification

- [ ] Complete [I03: detailed file ownership, interfaces, steps, acceptance and commands](../../tasks/cross-platform-workers/installers/I03-macos-native.md).
- [ ] Record actual validation evidence and unresolved limits before marking the task complete.

**Depends on:** I01, W04.

### I04: Deliver Linux native installation and systemd GPU operation

- [ ] Complete [I04: detailed file ownership, interfaces, steps, acceptance and commands](../../tasks/cross-platform-workers/installers/I04-linux-native.md).
- [ ] Record actual validation evidence and unresolved limits before marking the task complete.

**Depends on:** I01, W04.

### D01: Add pending installations and code-based worker approval

- [ ] Complete [D01: detailed file ownership, interfaces, steps, acceptance and commands](../../tasks/cross-platform-workers/dashboard/D01-pairing-and-installations.md).
- [ ] Record actual validation evidence and unresolved limits before marking the task complete.

**Depends on:** B02, B03.

### D02: Add worker groups, release publication and selected rollout controls

- [ ] Complete [D02: detailed file ownership, interfaces, steps, acceptance and commands](../../tasks/cross-platform-workers/dashboard/D02-selected-rollouts.md).
- [ ] Record actual validation evidence and unresolved limits before marking the task complete.

**Depends on:** B04.

### D03: Show worker qualification, update health and 30-day event timelines

- [ ] Complete [D03: detailed file ownership, interfaces, steps, acceptance and commands](../../tasks/cross-platform-workers/dashboard/D03-worker-health-and-log-timeline.md).
- [ ] Record actual validation evidence and unresolved limits before marking the task complete.

**Depends on:** B01, B03, D01, D02.

### H01: Build reproducible native release artifacts and signing workflow

- [ ] Complete [H01: detailed file ownership, interfaces, steps, acceptance and commands](../../tasks/cross-platform-workers/distribution/H01-release-packaging-and-signing.md).
- [ ] Record actual validation evidence and unresolved limits before marking the task complete.

**Depends on:** F01, W02, W03, W04, I02, I03, I04.

### H02: Prepare the separate CapRover distribution app and safe publication

- [ ] Complete [H02: detailed file ownership, interfaces, steps, acceptance and commands](../../tasks/cross-platform-workers/distribution/H02-caprover-artifact-app.md).
- [ ] Record actual validation evidence and unresolved limits before marking the task complete.

**Depends on:** B04, H01.

### V01: Prove GPU-only installation, boot operation and broad hardware coverage

- [ ] Complete [V01: detailed file ownership, interfaces, steps, acceptance and commands](../../tasks/cross-platform-workers/verification/V01-native-platform-qualification.md).
- [ ] Record actual validation evidence and unresolved limits before marking the task complete.

**Depends on:** I02, I03, I04, H01, B05.

### V02: Validate the integrated fleet under ownership, setup and update failures

- [ ] Complete [V02: detailed file ownership, interfaces, steps, acceptance and commands](../../tasks/cross-platform-workers/verification/V02-fleet-fault-and-contract-tests.md).
- [ ] Record actual validation evidence and unresolved limits before marking the task complete.

**Depends on:** B06, D03, D02, H02, W04.

### V03: Prepare the authorized development deployment and first selected rollout

- [ ] Complete [V03: detailed file ownership, interfaces, steps, acceptance and commands](../../tasks/cross-platform-workers/verification/V03-development-deployment-and-selected-rollout.md).
- [ ] Record actual validation evidence and unresolved limits before marking the task complete.

**Depends on:** V01, V02, H02.

## Review gates

1. Review F01 evidence rules and B01–B05 contracts before native installers and dashboard integration rely on them.
2. Review B06 for outright deletion of obsolete runtime/migration machinery, not a disguised bridge.
3. Review I02–I04 and V01 actual noninteractive GPU/boot outcomes. Unqualified families remain unavailable.
4. Review W03/W04/H01 signatures, state compatibility, shutdown proof and rollback fault injection.
5. Review D02/B04 selection snapshots and stable-target independence so publication cannot target everybody.
6. Review H02 persistent artifact storage, exact domain, controlled publisher and immutable range downloads.
7. Complete V02 before requesting authorization for the V03 development launch. No migration is part of that launch.

## Planning deliverable verification

Validate Markdown links, unique task IDs, acyclic dependencies, complete R01–R18 coverage, no source changes, and no task marked implemented. Check prose for obsolete migration/compatibility requirements after the user's development-only correction. Runtime test commands in task files are future execution instructions, not passed tests.
