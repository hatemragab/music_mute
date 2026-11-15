# AI implementation handoff

## Authorization and order

Current2026-10-10 state: W01–W33 source and available checks are complete.
Read [the final report](CODE-COMPLETION.md) and [current handoff](RESUME-GAPS.md)
before using the historical execution loop below. Next work is W34 on the
connected named Windows target; all native/live/release observations remain pending.

This handoff was prepared at the user's request on 2026-10-09. The active goal
now explicitly authorizes implementation of all tasks. Preserve existing source/
evidence and revalidate changed checkpoints; the planning phase is retained as
historical evidence rather than a current prohibition on authorized source work.
Work through W01–W33 one by one without repeatedly asking to continue and without
requiring a connected Windows machine. Follow [the execution plan](EXECUTION-PLAN.md),
including the named integration returns after dependent components exist.
Preparing this document does not itself start implementation or authorize
commit, push, publish, deploy, change production, enroll a real worker or delete
real data.

Read the root AGENTS/README, this folder's README/ARCHITECTURE/VALIDATION,
then RESUME-GAPS.md and the task index. For each task read the affected component README, manifest,
nested AGENTS and the source anchors. Recheck the working tree: this plan was
written against a heavily modified checkout. Preserve unrelated work.

The old Chrome component's macOS-only MVP scope and Windows LocalService
assumptions are superseded for the new Windows consumer product by the user's
explicit Windows scope. Keep the existing macOS product and legacy Windows
service working; do not migrate or remove installations automatically.

## Execution loop

1. Select the lowest-numbered task whose required code foundations are available.
   Dependencies do not require later UI/native closure first; use the integration
   returns in EXECUTION-PLAN.md to avoid circular work. Update its status and
   PROGRESS.md to `in-progress`.
2. Trace its existing behavior before editing. Implement the smallest complete
   shared change and the Windows adapter. Do not replace missing native behavior
   with success-returning stubs, TODO implementations or broad `win32` skips.
3. Implement native source and native test harnesses even if compilation or
   execution needs Windows. Use dependency injection to test orchestration and
   failure behavior on the Mac. Label those tests as simulated adapters.
4. Run the task's meaningful code checks, then the affected component checks.
   Record unavailable toolchains or fixtures accurately; fix failures caused by
   this work. Do not run UI/device/live-service tests during this phase.
5. Check each implementation/code item only after completion and evidence.
   Update the index/progress/evidence. Leave every unrun Windows item unchecked.
6. Continue immediately to the next code task. A pending Windows item is not a
   dependency blocker. A real design or code failure is; resolve it or continue
   independent work with the exact unresolved dependency recorded.
7. After W33, report implementation and code-check status plus the exact pending
   Windows matrix. When the user connects Windows, execute W34 against that
   named machine and separately approved additional targets, if needed.

The final prompt in EXECUTION-PLAN.md is ready to give to the implementation
agent. W34 execution starts only after the user connects and names the Windows
target. Until then, write native source and the harness, run portable code checks
and record unavailable native compilation as pending rather than stopping all
code work.

## Checklist semantics

| Marker/status                         | Meaning                                                                                                                                       |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `[ ]`                                 | Required work or evidence remains. “Skipped”, “not available” and “mock passed” never close a native item.                                    |
| `[x]`                                 | The stated item was completed, with an evidence reference.                                                                                    |
| `planned`                             | Detailed task exists; no implementation claim.                                                                                                |
| `in-progress`                         | Source work is underway.                                                                                                                      |
| `code-complete / Windows pending`     | Required implementation and executable code checks passed; named native checks await Windows.                                                 |
| `code-written / checks pending`       | Source exists but a required code/native-toolchain check could not run; record the specific check, not a pass. Continue other implementation. |
| `verified on recorded Windows target` | Native checks passed on the named OS/GPU/package combination; other combinations may remain open.                                             |
| `release-ready`                       | All required release gates passed; publication still requires authorization.                                                                  |

Do not add an overall “done” check that hides these distinctions. Existing checked
items refer to earlier source checkpoints; revalidate them when their dependencies
or current source change. Completing this planning update does not close any
unchecked product implementation or native acceptance item.

## Non-negotiable implementation rules

- Windows 10 22H2 x64 remains a toolchain/dependency compatibility gate. Reject
  unsupported host architecture even when a process reports x64 under emulation.
- GPU inference must fail closed if acceleration is absent or invalid. Keep
  CPU audio utilities separate from inference policy. Never infer support from
  an adapter name, `DmlExecutionProvider` availability or a previous machine.
- Local processing never requires login. Account loss does not interrupt local
  playback. It invalidates account work and account-owned capabilities promptly.
- Preserve the current inclusive 20-minute processing ceiling. Chrome automatic
  processing is strictly below its saved 1–20 minute limit, default 20; retain
  a shorter saved limit or disabled automatic mode.
- Preserve both existing manual cloud browser-provider processing and the
  separate native cloud handoff. Saved cloud mode disables automatic initiation;
  a handoff-only replacement must not silently reduce macOS feature parity.
- Native global/user/country hiding changes native source pickers only. Keep
  Chrome controls/handoff/bridge unchanged; actual account/allowance admission
  and existing browser eligibility still apply.
- Manual cloud browser startup does not depend on local Prepare/model/GPU. Keep
  one UI/headless account authority and accepted Chrome work across personal Quit.
- Fleet credentials and user intent are separate from the app account. Closing
  the window, quitting the personal app or signing out of MusicMute must not
  silently stop the approved fleet worker. Windows logout ends it.
- Preserve full-snapshot raw WebSocket flows. HTTP remains appropriate for auth,
  commands, transfers and explicit non-live reads. Do not add status polling.
- Before API or wire-contract edits, follow the installed Zalando API guideline
  skill and the repository's protocol/OpenAPI instructions. Extend existing
  contracts compatibly and regenerate their existing artifacts as prescribed.
- Never expose backend credentials, refresh tokens, worker secrets or private
  transfer grants in the renderer, Chrome, logs or committed fixtures.
- Do not modify real installed Mac runtime/model/worker state during testing.
  Use temporary directories and synthetic media; no real enrollment or claims.
- Keep personal diagnostics local and redacted. Preserve existing authorized
  fleet diagnostic behavior; do not initialize a second telemetry path.
- There is no root package install. Add dependencies only when necessary, pin
  reproducibly and document Windows 10 support, license and packaging impact.

## Handoff after any interruption

Update PROGRESS.md with current task, files touched, last passing commands,
remaining failures, pending Windows checks and the next concrete action. Write
bounded, redacted evidence under `evidence/`. Do not store secrets, media, account
identifiers or machine-specific private paths in this folder. Resume from the
recorded task after rechecking source, rather than restarting the whole plan.
