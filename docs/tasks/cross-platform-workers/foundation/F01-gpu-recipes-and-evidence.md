# F01: Qualify candidate GPU recipes and define evidence Implementation Plan

> **For agentic workers:** When implementation is separately authorized, use superpowers:executing-plans task by task. This file authorizes no commits, pushes, publishing, deployment, or real data changes.

**Status:** IN PROGRESS — local candidate inventory and fail-closed admission implemented; native evidence pending
**Goal:** Produce the broad candidate matrix and measurable admission rules before any platform is advertised as supported.
**Architecture:** Follow the shared-core/native-adapter boundaries and existing lifecycle authority.
**Tech Stack:** Existing NestJS/TypeScript, Python, React, native OS tools, and signed static artifacts as applicable.
**Spec:** [Approved design](../../../superpowers/specs/2026-09-13-cross-platform-worker-fleet-design.md)
**Dependencies:** None; begin after implementation authorization.

## Global constraints

Read [execution rules](../README.md) and [contracts](../contracts.md). All R01–R18 constraints apply. New paths below are proposed files, not claims of implementation. Preserve unrelated work and current ownership journals. No production access in tests; native GPU/boot proof is distinct from mocks.

## Files and responsibility

- Create worker/qualification/candidates.json and worker/qualification/README.md.
- Create docs/tasks/cross-platform-workers/evidence/hardware-matrix.md during execution.
- Create worker/tests/qualification/test_recipe_manifest.py; keep hardware sample assets public/synthetic and licensed.
- Read backend/separate.py, windows-worker/musicmute_worker/benchmark.py and the upstream tagged provider implementations.

## Interfaces

- Consumes R03/R04/R15 and QualificationReport in contracts.md.
- Produces candidate profile IDs with OS/arch/provider, exact proposed dependency versions, driver constraints, model/fixture hashes, evidence checks, and status. W02/H01 may package only fully specified recipes; V01 decides qualified status.

## Steps

- [x] 1. Inventory Windows AMD/Intel/NVIDIA DirectML and CUDA, Apple Silicon/Intel Mac GPU candidates, Linux NVIDIA/AMD/Intel, and feasible ARM64 combinations. Record a reason for every unsupported or untestable family; do not omit difficult families.

- [ ] 2. Inspect actual ONNX graph/provider support and dependency compatibility for Kim Vocal 2. Resolve conflicting ONNX packages in isolated environments; never install CPU and GPU distributions that overwrite the same module together.

- [ ] 3. Use a short public/synthetic fixture plus representative clips for each admitted media class. Measure reference output validity, accelerator graph execution, cold/warm duration, peak memory where observable, cancellation, and a resource-bounded long clip.

- [ ] 4. Record the exact model and fixture digests, recipe versions, operating system, driver, and test context. An available provider list and a torch GPU flag do not establish ONNX acceleration.

- [ ] 5. Define measured tolerances from the current trusted separation output; do not require bit-identical MP3s across accelerators. Reject invalid/nonfinite output, CPU-only neural inference, unexplained output differences, or excessive memory for the intended limits.

- [x] 6. Mark missing real hardware as unavailable. Leave that recipe non-admissible and create an explicit evidence entry rather than inventing qualification.

- [ ] 7. Review redistribution provenance for the exact model and bundled runtimes; preserve required notices and use approved immutable sources.

- [ ] 8. Run the listed checks, inspect the exact diff, and record evidence and unresolved limits. Leave the task uncompleted if required proof is missing.

## Behavioral acceptance fixture

Encode this scenario and the edge cases named in the steps in the listed tests before implementation. It is an expected outcome, not an executed test.

```gherkin
Scenario: A GPU is listed but the model executes entirely on CPU
  Given a candidate recipe lists a hardware provider
  And profiling shows no neural inference on that accelerator
  When qualification runs
  Then its status is rejected with CPU_ONLY_UNSUPPORTED
  And no release marks the recipe eligible for jobs
```

## Validation commands

Commands reference files introduced by this task or its dependencies. Backend commands run from backend/; dashboard commands from dashboard/; Python/native commands from the repository root unless explicitly qualified. Existing native integration helpers must create isolated services.

```sh
PYTHONPATH=worker python3 -m unittest discover -s worker/tests/qualification -p 'test_recipe_manifest.py' -v
```

## Completion evidence and limits

Checked candidate manifest, safe version inventory, digested fixtures, measured reference rules, and hardware matrix entries. No unsupported family is labelled qualified.

Native hardware may be unavailable. This blocks qualification for that recipe, not truthful documentation or other task work.

Additional implementation evidence: [verified model identity and graph inventory](../evidence/model-artifact.md), [deterministic smoke fixture](../evidence/synthetic-fixture.md), and [target dependency metadata](../evidence/dependency-metadata.md). W02 must correct the documented Python/NumPy and macOS Intel wheel conflicts before any proposed candidate becomes an installable recipe. Reference quality, locked runtime and native qualification remain open.

## Execution evidence (2026-09-13)

- Candidate and admission implementation: `worker/qualification/`
- Behavioral tests: `worker/tests/qualification/test_recipe_manifest.py`
- Truthful platform inventory: `docs/tasks/cross-platform-workers/evidence/hardware-matrix.md`
- Detailed local result and unresolved gates: `docs/tasks/cross-platform-workers/evidence/F01-report.md`
- Local validation passed 10 tests. No candidate is qualified; steps 2–5, 7, and native portions of 8 remain open.
