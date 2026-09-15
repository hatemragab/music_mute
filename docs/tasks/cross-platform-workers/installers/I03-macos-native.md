# I03: Deliver macOS native installation and LaunchDaemon qualification Implementation Plan

> **For agentic workers:** When implementation is separately authorized, use superpowers:executing-plans task by task. This file authorizes no commits, pushes, publishing, deployment, or real data changes.

**Status:** NOT STARTED
**Goal:** Install on qualified Macs and prove acceleration in a boot daemon without depending on a user login session.
**Architecture:** Follow the shared-core/native-adapter boundaries and existing lifecycle authority.
**Tech Stack:** Existing NestJS/TypeScript, Python, React, native OS tools, and signed static artifacts as applicable.
**Spec:** [Approved design](../../../superpowers/specs/2026-09-13-cross-platform-worker-fleet-design.md)
**Dependencies:** I01, W04

## Global constraints

Read [execution rules](../README.md) and [contracts](../contracts.md). All R01–R18 constraints apply. New paths below are proposed files, not claims of implementation. Preserve unrelated work and current ownership journals. No production access in tests; native GPU/boot proof is distinct from mocks.

## Files and responsibility

- Create worker/musicmute_worker/platforms/macos.py and worker/install/macos/ setup/startup/credential helper assets.
- Create worker/tests/test_macos_adapter.py and worker/tests/native/test_macos_install.py.
- Create worker/docs/macos.md with Apple Silicon and Intel qualification evidence links and exact blocking reasons.
- Use native launchd/service facilities; do not substitute a LaunchAgent or enable automatic login.

## Interfaces

- Implements PlatformAdapter for macOS and bootReport for the actual LaunchDaemon principal.
- Consumes CoreML/other qualified Mac recipes, secure service credential storage, child containment and the shared launcher state machine.

## Steps

- [ ] 1. Detect native architecture and avoid an accidental Rosetta/x64 dependency environment on Apple Silicon. Investigate Intel GPU paths and reject explicitly when the selected model cannot accelerate.

- [ ] 2. Install the private runtime and signed/notarized native assets as applicable. Preserve SIP, Gatekeeper, FileVault and system Python.

- [ ] 3. Install a LaunchDaemon with least-privileged processing identity and stable launcher path. Prove credential access before login through scoped service storage; do not assume a login keychain is unlocked.

- [ ] 4. Implement descendant supervision with explicit stop verification and restart recovery. Test orphan-child behavior after parent kill; POSIX process groups alone are not accepted as crash proof.

- [ ] 5. Request appropriate sleep prevention without claiming closed-lid/powered-off/preboot-unlock machines can process. Record unavailable telemetry without zero substitution.

- [ ] 6. If FileVault/preboot unlock or GPU access prevents unattended boot, report PREBOOT_UNLOCK_REQUIRED or GPU_UNAVAILABLE_IN_SERVICE and block the promised readiness; do not silently downgrade to sign-in startup.

- [ ] 7. Run the real model in the daemon account and verify signed-out/reboot behavior, interrupted setup, model caching, update activation and permitted rollback.

- [ ] 8. Run the listed checks, inspect the exact diff, and record evidence and unresolved limits. Leave the task uncompleted if required proof is missing.

## Behavioral acceptance fixture

Encode this scenario and the edge cases named in the steps in the listed tests before implementation. It is an expected outcome, not an executed test.

```gherkin
Scenario: FileVault blocks unattended startup after a restart
  Given the boot volume requires interactive preboot unlock
  When unattended qualification is evaluated
  Then the installer reports PREBOOT_UNLOCK_REQUIRED
  And does not disable encryption or enable auto-login
  And does not mark boot readiness verified
```

## Validation commands

Commands reference files introduced by this task or its dependencies. Backend commands run from backend/; dashboard commands from dashboard/; Python/native commands from the repository root unless explicitly qualified. Existing native integration helpers must create isolated services.

```sh
PYTHONPATH=worker python3 -m unittest discover -s worker/tests -p 'test_macos_adapter.py' -v
PYTHONPATH=worker python3 -m unittest discover -s worker/tests/native -p 'test_macos_install.py' -v
```

## Completion evidence and limits

Mac model/chip, OS/runtime versions, actual provider execution, service-context credential access and reboot/sign-out outcomes. Intel and Apple Silicon evidence stays separate.

Do not promise all Macs can access GPU before login. A real platform limit is a qualified rejection, not an excuse for CPU fallback.
