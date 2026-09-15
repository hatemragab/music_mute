# W01: Extract the shared worker core and stable launcher interfaces Implementation Plan

> **For agentic workers:** When implementation is separately authorized, use superpowers:executing-plans task by task. This file authorizes no commits, pushes, publishing, deployment, or real data changes.

**Status:** LOCAL IMPLEMENTATION REVIEWED — no critical or important finding. See [report](../evidence/W01-report.md) and [review](../evidence/W01-review.md) for exact evidence, retired checks and native implementation limits.
**Goal:** Replace the Windows-only source layout with one shared package and explicit native contracts, preserving current job safety within the new protocol.
**Architecture:** Follow the shared-core/native-adapter boundaries and existing lifecycle authority.
**Tech Stack:** Existing NestJS/TypeScript, Python, React, native OS tools, and signed static artifacts as applicable.
**Spec:** [Approved design](../../../superpowers/specs/2026-09-13-cross-platform-worker-fleet-design.md)
**Dependencies:** F01

## Global constraints

Read [execution rules](../README.md) and [contracts](../contracts.md). All R01–R18 constraints apply. New paths below are proposed files, not claims of implementation. Preserve unrelated work and current ownership journals. No production access in tests; native GPU/boot proof is distinct from mocks.

## Files and responsibility

- Move reusable windows-worker/musicmute_worker/ modules and tests into worker/musicmute_worker/ and worker/tests/; use one source of truth.
- Create worker/musicmute_worker/platforms/base.py, runtime_types.py, launcher.py and worker/pyproject.toml.
- Move separator orchestration from backend/separate.py into worker-owned separation modules; update only backend references that actually need it.
- Remove obsolete Windows handoff/legacy import shims and update package commands/docs for the new layout; no old-install adapter.

## Interfaces

- Produces typed equivalents of PlatformAdapter, EventSpool, QualificationRunner, ReleaseVerifier and UpdateCoordinator signatures in contracts.md.
- Keeps job selector and recovery semantics while requiring the new protocol. State/config paths are supplied explicitly; no dependency on caller working directory.

## Steps

- [ ] 1. Move source and tests together, with an import/entrypoint test proving the core imports on all three OS families without importing GPU libraries into the launcher.

- [ ] 2. Separate transfer/protocol/execution/journal logic from OS behavior. Keep each module responsibility narrow; do not duplicate worker.py for Linux or Mac.

- [ ] 3. Introduce typed runtime/report/config structures and shared validation of new protocol fixtures. Remove default worker_id z440 and require approved installation binding.

- [ ] 4. Put protected identity/config, operation journals, events, releases and model cache in explicitly separate paths. Same-machine repair reuses identity; cloning an installed directory is rejected.

- [ ] 5. Define a machine-wide launcher lock and worker child handshake so installer repair, worker restart and updater cannot concurrently own a GPU process.

- [ ] 6. Move current tests for retries, checksum validation, cancellation, execution evidence, terminal cleanup and recovery to the shared package; update their entry commands.

- [ ] 7. Reject incompatible old local schemas with a safe reinstall/re-enrollment reason. Do not create converters or compatibility shims, and never silently erase an active journal.

- [ ] 8. Run the listed checks, inspect the exact diff, and record evidence and unresolved limits. Leave the task uncompleted if required proof is missing.

## Behavioral acceptance fixture

Encode this scenario and the edge cases named in the steps in the listed tests before implementation. It is an expected outcome, not an executed test.

```gherkin
Scenario: Launcher starts from a different directory
  Given a paired installation has explicit state and release paths
  When its boot service starts the launcher with a different working directory
  Then the same installation and journals are loaded
  And no new identity or duplicate worker is created
```

## Validation commands

Commands reference files introduced by this task or its dependencies. Backend commands run from backend/; dashboard commands from dashboard/; Python/native commands from the repository root unless explicitly qualified. Existing native integration helpers must create isolated services.

```sh
PYTHONPATH=worker python3 -m unittest discover -s worker/tests -v
python3 -m compileall -q worker/musicmute_worker
```

## Completion evidence and limits

Shared-package import tests, preserved behavior tests, explicit-state entrypoint proof and no duplicated platform worker implementations.

Code movement is not permission to modify deployed folders or preserve obsolete installers through new legacy adapters.
