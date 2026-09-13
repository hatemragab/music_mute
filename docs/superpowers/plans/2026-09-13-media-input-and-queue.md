# Media input and fair queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task after explicit implementation approval. Use superpowers:subagent-driven-development only if delegation is separately authorized. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accept common audio/video and bounded YouTube inputs up to 30 minutes, prepare audio locally, and protect shared processing capacity with enforceable account and queue policies managed in the existing dashboard.

**Architecture:** Extend existing native mobile preparation, NestJS/MongoDB admission and job lifecycle, and Windows worker protocol. Retain direct private-S3 audio uploads and the React dashboard; add versioned policy, atomic usage/workload accounting, fair selection, and verified worker limits without replacing queue infrastructure.

**Tech Stack:** Kotlin/Compose/WorkManager and platform media APIs; Swift/SwiftUI/AVFoundation/background URLSession; NestJS/TypeScript/Mongoose/external Redis/S3; Python/DirectML worker; React/TypeScript/Vite.

**Spec:** [Accepted scope](../../tasks/media-input-and-queue/scope.md) and [shared contracts](../../tasks/media-input-and-queue/contracts.md).

## Global Constraints

- Status: **implementation approved and underway**. The [execution ledger](../../tasks/media-input-and-queue/execution.md) records the later API/dashboard deployment and Z440 SSH-update authorization and supersedes planning-only restrictions below.
- Maximum audio/video/YouTube duration: **1,800 seconds inclusive**.
- Initial prepared-audio maximum: **100,000,000 bytes inclusive**, validated before enablement.
- **One unfinished job per account** across sources/devices; **3,600 audio seconds per rolling 86,400 seconds**.
- Native local preparation only; default soundtrack; cleaned audio output only; no trimming or original-video upload fallback.
- Background behavior is bounded by the operating system and must recover honestly.
- Only existing **iPhone 17 Pro / iOS 26.0**, UDID **3CC14436-EC3C-4419-A079-C84951E5FA07**, may be used for device/UI tests; report absence as blocked.
- Android unit/static/build checks do not establish Android device compatibility. No Android device/emulator testing without changed authorization.
- Windows benchmarking requires an authorized idle test environment; never operate/stop the live worker or claim live jobs as a shortcut.
- No application edits during this planning turn. No commits, pushes, publication, deployments, infrastructure changes, migrations, or deletion of user data without explicit authorization.
- Preserve unrelated edits and current source/library media. Do not stage secrets, generated media/builds, credentials, or personal data.
- Backend contracts first; extend existing admin permissions, audit operations, revision checks, durable queue, and safe worker ownership.
- Do not increase worker concurrency or add processing chunks as part of this package. Unknown telemetry/capacity is unavailable, not zero.

---

## Execution sequence and gates

The [task index](../../tasks/media-input-and-queue/README.md) maps all 23 tasks and dependencies. Each task file defines ownership, interfaces, concrete checks, and completion criteria. Run failing regression tests before behavior changes; run focused passing tests afterward; complete subsystem checks once per coherent change rather than repeating full suites after every file.

- [ ] **Gate 0 — user reviews this package.** Do not begin R01 or any implementation until explicit authorization to start. Review can approve a subset of tasks.
- [ ] **Phase 1 — R01/R02:** establish fixtures and measured constraints. Keep missing hardware/platform evidence visible. Read-only baseline discovery can identify gaps; do not infer measurements from stale notes.
- [ ] **Phase 2 — B01–B06:** implement backend policy/accounting/fairness/admin contracts with synthetic and isolated transaction tests. Complete a contract review before mobile/dashboard integration. R02-gated expansion remains unavailable until evidence is present.
- [ ] **Phase 3 — W01/W02:** implement compatible worker validation, timing, and stop-evidence behavior; prove old worker exclusion and old-job recovery.
- [ ] **Phase 4 — A01–A04 and I01–I04:** implement preparation and guarded YouTube imports, then user visibility and recovery. This phase can be reviewed per platform without implying device proof on the other platform.
- [ ] **Phase 5 — D01–D03:** connect the existing dashboard to verified backend contracts and display policy/evidence accurately.
- [ ] **Phase 6 — V01/V02:** run integrated lifecycle/race checks and authorized simulator acceptance. Produce a readiness report listing measured limits and any blocked evidence.
- [ ] **Gate 1 — review completed code and evidence.** Local readiness is not authorization to deploy, publish, operate a live worker, force an app update, or turn on a live 30-minute limit.

## Completion evidence

For each task, record changed paths, exact commands, outcomes, evidence paths, remaining risks, and whether validation was unit, isolated integration, simulator, offline Windows hardware, or live. Keep unchecked tasks unchecked. If a task needs a benchmark output that is unavailable, complete independent code work behind a disabled capability and report its enablement gate as blocked; never mark the entire feature ready.

## Planning validation

The author must check local Markdown links, task-ID coverage and dependencies, referenced existing paths, accepted-requirement coverage, code-block balance, and `git diff --check`. This validates the plan only. Tests/builds/benchmarks listed in the tasks remain future work.
