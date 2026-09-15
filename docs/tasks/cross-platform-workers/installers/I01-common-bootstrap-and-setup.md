# I01: Implement shared setup orchestration and pre-runtime reporting Implementation Plan

> **For agentic workers:** When implementation is separately authorized, use superpowers:executing-plans task by task. This file authorizes no commits, pushes, publishing, deployment, or real data changes.

**Status:** IN PROGRESS — see [execution brief](../evidence/I01-execution-brief.md).
**Goal:** Make setup resumable from the first bootstrap stage and finish with code pairing plus authenticated readiness.
**Architecture:** Follow the shared-core/native-adapter boundaries and existing lifecycle authority.
**Tech Stack:** Existing NestJS/TypeScript, Python, React, native OS tools, and signed static artifacts as applicable.
**Spec:** [Approved design](../../../superpowers/specs/2026-09-13-cross-platform-worker-fleet-design.md)
**Dependencies:** W01, W02, W03, B02, B03

## Global constraints

Read [execution rules](../README.md) and [contracts](../contracts.md). All R01–R18 constraints apply. New paths below are proposed files, not claims of implementation. Preserve unrelated work and current ownership journals. No production access in tests; native GPU/boot proof is distinct from mocks.

## Files and responsibility

- Create worker/musicmute_worker/installer.py, installation_state.py and native bootstrap event schema fixtures.
- Create worker/install/install.sh and worker/install/install.ps1 entrypoints with platform delegation.
- Create worker/tests/test_installer.py, test_bootstrap_events.py and installer transcript fixtures.
- Create worker/docs/install.md with the proposed public commands, permission prompts and safe failure explanations.

## Interfaces

- Consumes installation/pairing/reporting contracts, signed stable-bootstrap metadata, PlatformAdapter and qualification interfaces.
- Produces one common setup state machine and equivalent native pre-Python events. Native entrypoints must share protocol fixtures instead of duplicating workflow decisions.

## Steps

- [ ] 1. Generate and securely persist installation identity/reporting capability before registration. Journal setup stages so rerunning one command resumes and does not create a second identity.

- [ ] 2. Implement tiny native detection, HTTPS registration and bounded local event spool before managed Python exists. If initial download never runs, show the documented visibility limit.

- [ ] 3. Verify bootstrap release trust and install private Python/FFmpeg/dependencies/model; do not modify system Python or an unrelated existing environment.

- [ ] 4. Enforce hardware/disk/runtime/model/service qualification before requesting pairing. Preserve failure reason and retry history; do not advance progress to success after a rejected stage.

- [ ] 5. Install the native boot mechanism through the platform adapter, perform service-context checks, request the expiring code, and poll with bounded intervals. Expired codes require an explicit pairing retry.

- [ ] 6. After approval, use the protected permanent token for identity/readiness. Existing admin drain/revoke and unsupported build policy override installer success.

- [ ] 7. Support safe repair, pause/status and uninstall entrypoints. Uninstall first stops/verifies descendants and preserves or explicitly requests handling of unresolved job state; removal never erases unrelated files.

- [ ] 8. Run the listed checks, inspect the exact diff, and record evidence and unresolved limits. Leave the task uncompleted if required proof is missing.

## Behavioral acceptance fixture

Encode this scenario and the edge cases named in the steps in the listed tests before implementation. It is an expected outcome, not an executed test.

```gherkin
Scenario: Dependency installation fails before pairing
  Given the native bootstrap obtained a scoped reporting session
  When package installation exits unsuccessfully
  Then local and remote events identify the component and safe reason
  And no pairing code or ready worker is created
  And rerunning setup resumes from the failed stage
```

## Validation commands

Commands reference files introduced by this task or its dependencies. Backend commands run from backend/; dashboard commands from dashboard/; Python/native commands from the repository root unless explicitly qualified. Existing native integration helpers must create isolated services.

```sh
PYTHONPATH=worker python3 -m unittest discover -s worker/tests -p 'test_installer.py' -v
PYTHONPATH=worker python3 -m unittest discover -s worker/tests -p 'test_bootstrap_events.py' -v
```

## Completion evidence and limits

Resumable transcripts, native-before-Python reporting, token-scope checks, failure retention and zero-job claims before approval/readiness.

Never upload raw installer stdout or plaintext credentials. Expired capabilities need a new reporting session, not a privileged anonymous recovery endpoint.
