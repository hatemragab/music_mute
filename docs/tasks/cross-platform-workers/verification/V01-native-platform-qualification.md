# V01: Prove GPU-only installation, boot operation and broad hardware coverage Implementation Plan

> **For agentic workers:** When implementation is separately authorized, use superpowers:executing-plans task by task. This file authorizes no commits, pushes, publishing, deployment, or real data changes.

**Status:** NOT STARTED
**Goal:** Establish actual platform support using native machines and qualify no-login processing, not just source tests.
**Architecture:** Follow the shared-core/native-adapter boundaries and existing lifecycle authority.
**Tech Stack:** Existing NestJS/TypeScript, Python, React, native OS tools, and signed static artifacts as applicable.
**Spec:** [Approved design](../../../superpowers/specs/2026-09-13-cross-platform-worker-fleet-design.md)
**Dependencies:** I02, I03, I04, H01, B05

## Global constraints

Read [execution rules](../README.md) and [contracts](../contracts.md). All R01–R18 constraints apply. New paths below are proposed files, not claims of implementation. Preserve unrelated work and current ownership journals. No production access in tests; native GPU/boot proof is distinct from mocks.

## Files and responsibility

- Create worker/qualification/run_native_matrix.py and documented operator commands.
- Complete docs/tasks/cross-platform-workers/evidence/hardware-matrix.md and per-profile reports referenced from it.
- Create worker/tests/qualification/test_evidence_report.py.
- Use only synthetic/owned fixtures and a dedicated development backend.

## Interfaces

- Consumes actual native installers, signed development artifacts and the candidate matrix.
- Produces qualified profile reports with digests, exact hardware/OS/driver versions, test context and rejected/unavailable reasons. H01 stable publication requires these reports.

## Steps

- [ ] 1. Acquire or identify actual Windows, Apple Silicon/Intel Mac, and Linux NVIDIA/AMD/Intel test machines and relevant architectures. Record unavailable machines explicitly.

- [ ] 2. Run clean one-command setup, interrupted/resumed setup, missing GPU, missing driver, missing package recipe, disk exhaustion, invalid model and CPU-fallback cases.

- [ ] 3. Run the actual model through the installed boot principal, signed out and after reboot without user login. Record disk-encryption/service-GPU limitations as blockers, never hidden exceptions.

- [ ] 4. Prove cancellation, parent crash, child cleanup, network loss, time skew, bounded retries and one-machine/one-assignment exclusion.

- [ ] 5. Run representative permitted media lengths including the maximum qualified class and compare actual reference output and peak memory. Mark only measured classes eligible.

- [ ] 6. Exercise signed update, complete-environment rollback and boot during interrupted activation on each qualified platform.

- [ ] 7. Publish safe evidence reports to the task pack; require explicit authorization separately before any real contributor or production deployment.

- [ ] 8. Run the listed checks, inspect the exact diff, and record evidence and unresolved limits. Leave the task uncompleted if required proof is missing.

## Behavioral acceptance fixture

Encode this scenario and the edge cases named in the steps in the listed tests before implementation. It is an expected outcome, not an executed test.

```gherkin
Scenario: A platform has no real hardware evidence
  Given unit tests and packaging succeeded for a candidate GPU profile
  But no machine ran its model and unattended boot tests
  When the release matrix is reviewed
  Then that profile remains unavailable or candidate
  And cannot be advertised as qualified
```

## Validation commands

Commands reference files introduced by this task or its dependencies. Backend commands run from backend/; dashboard commands from dashboard/; Python/native commands from the repository root unless explicitly qualified. Existing native integration helpers must create isolated services.

```sh
PYTHONPATH=worker python3 -m unittest discover -s worker/tests/qualification -p 'test_evidence_report.py' -v
python3 worker/qualification/run_native_matrix.py --help
```

## Completion evidence and limits

Native reports, short/long fixture checks, boot/sign-out proof and qualified/rejected/unavailable status per family. Help output is not runtime qualification.

Real machine availability can block acceptance. Never substitute the iPhone simulator, CPU execution, or a different GPU family as proof.
