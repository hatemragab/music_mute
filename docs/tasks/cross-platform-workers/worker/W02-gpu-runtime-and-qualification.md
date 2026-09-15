# W02: Implement recipe selection, model preparation and GPU-only qualification Implementation Plan

> **For agentic workers:** When implementation is separately authorized, use superpowers:executing-plans task by task. This file authorizes no commits, pushes, publishing, deployment, or real data changes.

**Status:** LOCALLY REVIEWED — fix round 1 accepted by independent re-review. See [report](../evidence/W02-report.md) and [review](../evidence/W02-review.md). All profiles remain unqualified pending native service, reference, capacity and distribution gates.
**Goal:** Automatically choose a qualified GPU runtime, prepare dependencies/model and refuse CPU-only or unproven inference.
**Architecture:** Follow the shared-core/native-adapter boundaries and existing lifecycle authority.
**Tech Stack:** Existing NestJS/TypeScript, Python, React, native OS tools, and signed static artifacts as applicable.
**Spec:** [Approved design](../../../superpowers/specs/2026-09-13-cross-platform-worker-fleet-design.md)
**Dependencies:** W01, F01, B01

## Global constraints

Read [execution rules](../README.md) and [contracts](../contracts.md). All R01–R18 constraints apply. New paths below are proposed files, not claims of implementation. Preserve unrelated work and current ownership journals. No production access in tests; native GPU/boot proof is distinct from mocks.

## Files and responsibility

- Create worker/musicmute_worker/hardware.py, qualification.py, profiles.py and separation/engine.py.
- Create worker/profiles/ profile manifests and lockfiles for concretely qualified combinations.
- Create worker/tests/test_qualification.py, test_profiles.py and synthetic/reference fixture metadata.
- Modify shared progress.py and execution orchestration to fingerprint model/runtime/provider identities.

## Interfaces

- Consumes signed profile manifest, F01 candidate evidence and QualificationReport.
- Produces QualificationRunner.qualify(profile, fixture_path), deterministic profile selection, runtime/model fingerprints and safe reasonCodes. New profile support must not change wire names.

## Steps

- [ ] 1. Detect actual OS architecture, device candidates, driver availability, RAM and free disk. Distinguish shared Apple memory from dedicated VRAM; retain null for unavailable measures.

- [ ] 2. Select only allowed GPU providers and profile variants. Prevent a CUDA path being accidentally selected when a DirectML recipe was intended, or torch GPU detection masking CPU ONNX inference.

- [ ] 3. Create private runtime environments from fixed locks and approved wheels; prepare hash-verified model/FFmpeg assets. Reuse cached assets only by verified digest.

- [ ] 4. Run actual model inference with bounded time/memory and execution-provider evidence; validate finite output, decoding, reference tolerance and service-context observations.

- [ ] 5. Attempt another supported GPU recipe when the first fails, with bounded attempts and clear events. Never fall back to CPU-only inference or claim acceleration from discovery alone.

- [ ] 6. Extend checkpoint fingerprints to include separator code, model, fixture/limits, runtime lock, provider and relevant library versions. Invalidate reuse when any changes.

- [ ] 7. Attach only the measured media qualification class. Do not expand media limits, concurrent slots or maximum duration based on an unrepresentative short test.

- [ ] 8. Run the listed checks, inspect the exact diff, and record evidence and unresolved limits. Leave the task uncompleted if required proof is missing.

## Behavioral acceptance fixture

Encode this scenario and the edge cases named in the steps in the listed tests before implementation. It is an expected outcome, not an executed test.

```gherkin
Scenario: GPU provider silently falls back to CPU
  Given provider discovery reports a compatible accelerator
  When the sample model executes entirely with CPU inference
  Then setup reports CPU_ONLY_UNSUPPORTED
  And readiness remains false
  And no real job is claimed
```

## Validation commands

Commands reference files introduced by this task or its dependencies. Backend commands run from backend/; dashboard commands from dashboard/; Python/native commands from the repository root unless explicitly qualified. Existing native integration helpers must create isolated services.

```sh
PYTHONPATH=worker python3 -m unittest discover -s worker/tests -p 'test_qualification.py' -v
PYTHONPATH=worker python3 -m unittest discover -s worker/tests -p 'test_profiles.py' -v
```

## Completion evidence and limits

Selection fixtures, actual execution-evidence parser tests, hash/cache invalidation and device-family rejection reasons; actual hardware reports are completed by V01.

Mocked provider success is not hardware support. Keep unavailable profiles out of the signed qualified catalog.
