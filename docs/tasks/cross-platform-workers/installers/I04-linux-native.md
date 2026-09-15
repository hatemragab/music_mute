# I04: Deliver Linux native installation and systemd GPU operation Implementation Plan

> **For agentic workers:** When implementation is separately authorized, use superpowers:executing-plans task by task. This file authorizes no commits, pushes, publishing, deployment, or real data changes.

**Status:** NOT STARTED
**Goal:** Automatically prepare qualified Linux GPU recipes and run continuously in a least-privileged boot service.
**Architecture:** Follow the shared-core/native-adapter boundaries and existing lifecycle authority.
**Tech Stack:** Existing NestJS/TypeScript, Python, React, native OS tools, and signed static artifacts as applicable.
**Spec:** [Approved design](../../../superpowers/specs/2026-09-13-cross-platform-worker-fleet-design.md)
**Dependencies:** I01, W04

## Global constraints

Read [execution rules](../README.md) and [contracts](../contracts.md). All R01–R18 constraints apply. New paths below are proposed files, not claims of implementation. Preserve unrelated work and current ownership journals. No production access in tests; native GPU/boot proof is distinct from mocks.

## Files and responsibility

- Create worker/musicmute_worker/platforms/linux.py and worker/install/linux/ setup/systemd/device-access assets.
- Create worker/tests/test_linux_adapter.py and worker/tests/native/test_linux_install.py.
- Create worker/docs/linux.md with distribution/architecture/GPU evidence and prerequisite actions.
- Use system systemd services for the initial qualified Linux startup path; unsupported init systems fail explicitly until qualified.

## Interfaces

- Implements PlatformAdapter for Linux using a dedicated service account, restricted credential files, native GPU device permissions and cgroup containment.
- Consumes NVIDIA CUDA, AMD and Intel candidate recipes qualified by F01/W02; never silently reinterpret an unsupported GPU as CPU support.

## Steps

- [ ] 1. Inspect distribution/version, libc, architecture, kernel, GPU vendor/device and actual runtime/driver availability. Use qualified wheels/build recipes for each combination.

- [ ] 2. Install managed Python and application dependencies separately from system package management. Isolate vendor runtime profiles; a missing wheel is a clear unsupported recipe result, not an unbounded build from source.

- [ ] 3. For driver prerequisites, provide the exact supported package action through a bounded elevated step, detect required reboot and resume. Do not disable Secure Boot or modify unrelated driver configuration.

- [ ] 4. Create a dedicated service account, application directories and restricted secrets. Grant only required render/video/device access; never run separation as root for convenience.

- [ ] 5. Install an enabled system systemd unit targeting the stable launcher with cgroup-wide stop/kill behavior, restart limits, network recovery and explicit GPU device access.

- [ ] 6. Test no-login startup, service-account inference, parent/child crash cleanup, network failure, missing device permissions and disk pressure. Do not require a desktop session or user lingering.

- [ ] 7. Exercise each qualified NVIDIA/AMD/Intel recipe and feasible architecture independently; record rejection or unavailable evidence for the rest.

- [ ] 8. Run the listed checks, inspect the exact diff, and record evidence and unresolved limits. Leave the task uncompleted if required proof is missing.

## Behavioral acceptance fixture

Encode this scenario and the edge cases named in the steps in the listed tests before implementation. It is an expected outcome, not an executed test.

```gherkin
Scenario: A Linux service lacks GPU device access
  Given the model works for the installing administrator
  When the dedicated service account cannot access its GPU device
  Then setup reports GPU_UNAVAILABLE_IN_SERVICE
  And does not run the worker as root or fall back to CPU
```

## Validation commands

Commands reference files introduced by this task or its dependencies. Backend commands run from backend/; dashboard commands from dashboard/; Python/native commands from the repository root unless explicitly qualified. Existing native integration helpers must create isolated services.

```sh
PYTHONPATH=worker python3 -m unittest discover -s worker/tests -p 'test_linux_adapter.py' -v
PYTHONPATH=worker python3 -m unittest discover -s worker/tests/native -p 'test_linux_install.py' -v
```

## Completion evidence and limits

Distribution/kernel/driver/profile matrix, systemd unit verification, service-account GPU evidence and reboot/child-termination tests.

Linux is not one binary platform. Missing hardware or unsupported vendor stacks remain explicit matrix gaps until real qualification is possible.
