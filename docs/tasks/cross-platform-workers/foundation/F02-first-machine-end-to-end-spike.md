# F02: First-machine end-to-end spike Implementation Plan

> **For agentic workers:** When implementation is separately authorized, use superpowers:executing-plans task by task. This file authorizes no commits, pushes, publishing, deployment, or real data changes.

**Status:** NOT STARTED — added 2026-09-15 by the [revised direction](../revised-direction.md); no source, evidence or run exists
**Goal:** Prove the complete core loop — install, pair, approve, claim, real GPU separation, reported timeline — on one real machine before any packaging, distribution or fleet-scale work proceeds.
**Architecture:** Uses the shared worker core, the one-command installer and the existing backend pairing/claim/event authority unchanged. Introduces no new runtime path and no compatibility adapter; it is a proof task, not a feature task.
**Tech Stack:** Existing Python worker/installer, NestJS backend, dashboard, native platform adapter, real GPU.
**Spec:** [Approved design](../../../superpowers/specs/2026-09-13-cross-platform-worker-fleet-design.md)
**Dependencies:** I01 (shared setup orchestration), plus at least one native adapter — I03, I02 or I04. macOS is built first because it is the only adapter exercisable on local hardware.

## Global constraints

Read [execution rules](../README.md) and [contracts](../contracts.md). All R01–R18 constraints apply. New paths below are proposed files, not claims of implementation. Preserve unrelated work and current ownership journals. No production access in tests; native GPU/boot proof is distinct from mocks.

## Dependency correction

An earlier revision of the [revised direction](../revised-direction.md) placed this task at wave 1 with no dependencies. That was wrong and is corrected here. The loop this task proves cannot execute before:

- **I01** supplies the shared setup orchestration, and `setup_host.main` stops refusing every real native host.
- **One native adapter** (I03, I02 or I04) registers an actual host for the machine under test. Without one there is no installable host and no boot principal.

Windows, macOS and Linux machines are all available for testing, but only **macOS can be exercised from the development machine** — Windows and Linux steps must be run on those boxes. The spike therefore runs on whichever platform finishes its adapter first, and **gates H01-light packaging and the v1 launch**. Its intent is unchanged: it must complete before packaging and distribution work, because a failed spike invalidates assumptions those tasks otherwise build on for weeks.

## Files and responsibility

- Create `worker/qualification/first_machine_spike.py` — scripted, resumable operator run that records the outcome of each leg and refuses to advance past a failed one.
- Create `worker/tests/test_first_machine_spike.py` — leg sequencing, fail-closed advancement, evidence assembly.
- Create `docs/tasks/cross-platform-workers/evidence/F02-report.md` during execution.
- Consumes existing, already-reviewed components unchanged: I01 installer, W02 GPU runtime/preparation, W04 activation, B02 pairing, B03 events, B05 claim gates. This task must **not** add a product code path.

## Interfaces

- Consumes the existing `QualificationReport`, installation/pairing routes and `WorkerRuntimeReport` from contracts.md.
- Produces a single machine-bound evidence record: exact OS/arch/GPU/driver, profile id, model and fixture digests, each leg's terminal outcome, the accepted job identity, the produced artifact digest, and the observed dashboard timeline. No credentials, tokens, pairing codes or raw audio.

## Steps

- [ ] 1. Select exactly one machine with a supported GPU profile (see the [revised direction](../revised-direction.md) for the supported set) and record its exact OS build, architecture, GPU and driver. If no supported profile is present, stop and record the exact blocking reason code; do not proceed on CPU.
- [ ] 2. Run the real one-command installer on that machine. Record every setup stage outcome and any `pending_boot_verification` state. Do not suppress an elevation or reboot prompt.
- [ ] 3. Complete pairing with an administrator approval using a real displayed code. Confirm the permanent credential is proven by authenticated readiness, not by the approval alone.
- [ ] 4. Confirm the machine claims exactly one job and that no second assignment is admitted while the first is owned.
- [ ] 5. Run one real separation to completion with a valid output, and record the artifact digest, wall duration and peak memory where observable.
- [ ] 6. Confirm the dashboard shows the setup, runtime and processing timeline for that machine, and that an interrupted report renders as unknown rather than as success or zero.
- [ ] 7. Re-run stages 2–6 after a machine restart to confirm identity, credentials and journals survive. Record whether unattended boot is proven or remains an open I03/I02/I04 gate; do not claim boot proof from an interactive run.
- [ ] 8. Run the listed checks, inspect the exact diff, and record evidence and unresolved limits. Leave the task uncompleted if any leg failed.

## Behavioral acceptance fixture

Encode this scenario and the edge cases named in the steps in the listed tests before implementation. It is an expected outcome, not an executed test.

```gherkin
Scenario: One real machine completes the whole loop
  Given a machine with a supported GPU profile
  When the operator runs the one-command installer and an administrator approves the pairing code
  Then the machine claims exactly one job and produces a valid separated result
  And the dashboard shows the setup, runtime and processing timeline
  And no secret was transferred manually
```

```gherkin
Scenario: The spike cannot run because no supported profile is installed
  Given the machine has no supported GPU profile
  When the spike runs
  Then it records the exact blocking reason code
  And it claims no job and reports no fabricated success
```

## Validation commands

Commands reference files introduced by this task or its dependencies. Backend commands run from backend/; dashboard commands from dashboard/; Python/native commands from the repository root unless explicitly qualified. Existing native integration helpers must create isolated services.

```sh
PYTHONPATH=worker python3 -m unittest discover -s worker/tests -p 'test_first_machine_spike.py' -v
python3 worker/qualification/first_machine_spike.py --help
```

Help output is not runtime qualification. The spike's value is the real run, not the script.

## Completion evidence and limits

A dated report naming the machine, its exact GPU/driver/profile, each leg's terminal outcome, the accepted job identity, the output digest, and the observed timeline — with credentials, tokens, pairing codes and raw audio excluded.

Native hardware may be unavailable. This blocks the spike, not truthful documentation or other task work. A pass proves **one** machine on **one** platform. With V01 deferred, F02's report is the v1 evidence that a profile works — but it does **not** qualify that profile across other hardware, does not prove unattended boot, and does not prove any other platform. Report per-platform results separately; never pool them into one claim. If the spike fails, the finding supersedes downstream scheduling: report it and stop rather than continuing H01-light work on an unvalidated core.