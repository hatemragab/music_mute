# I02: Deliver Windows native installation and verified at-boot execution Implementation Plan

> **For agentic workers:** When implementation is separately authorized, use superpowers:executing-plans task by task. This file authorizes no commits, pushes, publishing, deployment, or real data changes.

**Status:** NOT STARTED
**Goal:** Install everything through PowerShell and prove GPU processing before login under the real task/service account.
**Architecture:** Follow the shared-core/native-adapter boundaries and existing lifecycle authority.
**Tech Stack:** Existing NestJS/TypeScript, Python, React, native OS tools, and signed static artifacts as applicable.
**Spec:** [Approved design](../../../superpowers/specs/2026-09-13-cross-platform-worker-fleet-design.md)
**Dependencies:** I01, W04

## Global constraints

Read [execution rules](../README.md) and [contracts](../contracts.md). All R01–R18 constraints apply. New paths below are proposed files, not claims of implementation. Preserve unrelated work and current ownership journals. No production access in tests; native GPU/boot proof is distinct from mocks.

## Files and responsibility

- Create worker/musicmute_worker/platforms/windows.py and worker/install/windows/ setup/startup/secret/diagnostic scripts.
- Adapt proven Windows Job Object and machine mutex implementation from the moved processes module.
- Create worker/tests/test_windows_adapter.py and worker/tests/native/windows_setup.Tests.ps1.
- Replace obsolete Configure-Worker/Start-Worker instructions with the new installer; no legacy installer shim.

## Interfaces

- Implements PlatformAdapter for Windows and the shared install/update status contracts.
- At-boot task must reference the stable launcher and the same account capable of reading DPAPI credentials. Qualification runs under that exact noninteractive principal.

## Steps

- [ ] 1. Detect architecture, GPU/driver/runtime support using native APIs and recipe checks. Install managed dependencies in application-owned directories; use only qualified vendor prerequisite paths.

- [ ] 2. Protect reporting and permanent credentials with DPAPI plus ACLs and zero temporary plaintext buffers. Do not pass secrets in process arguments or child environments.

- [ ] 3. Build at-boot startup with no runtime limit, bounded restart and actual signed-out execution. Reuse current account/password task mechanics where required; Windows Hello PIN is not treated as an account password.

- [ ] 4. Acquire the machine-wide mutex across install/start/update; create descendants in Job Objects from creation so supervisor crashes do not leave orphan GPU work.

- [ ] 5. Do not require idle state, logged-in state or AC power for job admission. Request keep-awake while appropriate without permanently rewriting power plans; report real OS/hardware limitations.

- [ ] 6. Verify task ownership/definition/account before replacing only this installation's entry; configure repair/uninstall through the same safe identity checks.

- [ ] 7. Run native tests plus actual model separation through the installed task, signed out and after reboot without login. Surface GPU_UNAVAILABLE_IN_SERVICE rather than treating an interactive run as sufficient.

- [ ] 8. Run the listed checks, inspect the exact diff, and record evidence and unresolved limits. Leave the task uncompleted if required proof is missing.

## Behavioral acceptance fixture

Encode this scenario and the edge cases named in the steps in the listed tests before implementation. It is an expected outcome, not an executed test.

```gherkin
Scenario: GPU works interactively but fails under the boot task
  Given an interactive DirectML sample passed
  When the configured boot account cannot execute the model
  Then setup reports GPU_UNAVAILABLE_IN_SERVICE
  And the dashboard shows failed boot qualification
  And the machine is not admitted as always-on ready
```

## Validation commands

Commands reference files introduced by this task or its dependencies. Backend commands run from backend/; dashboard commands from dashboard/; Python/native commands from the repository root unless explicitly qualified. Existing native integration helpers must create isolated services.

```sh
PYTHONPATH=worker python3 -m unittest discover -s worker/tests -p 'test_windows_adapter.py' -v
powershell -NoProfile -Command "Invoke-Pester -Path worker/tests/native/windows_setup.Tests.ps1 -CI"
```

## Completion evidence and limits

Actual Windows GPU/driver versions, task account/ACL checks without secrets, signed-out and reboot model/job proof, crash-child cleanup and update recovery.

PowerShell/provider mocks are not boot or DirectML proof. If Windows permission/policy blocks startup, explain and report it rather than weakening security settings.
