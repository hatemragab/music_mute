# Sequential execution plan for the AI agent

Current deliverable: task preparation. Use this plan for an authorized
implementation session; real Windows tests remain deferred until connection.

## Fixed outcome

Deliver the complete macOS feature scope on Windows 10 22H2 x64/build 19045 and
Windows 11 x64, with one shared Chrome extension and mandatory qualified DirectML
model inference. Install and run as the logged-in standard user. Keep everyday
setup simple, the approved worker independent of personal app/account lifetime,
and technical controls under Advanced. No ARM, x86 or CPU inference fallback.

## One task at a time

Read AI-HANDOFF.md, TASKS.md, the selected task and its source references. Compare
its checklist with the current source before writing. Complete a reviewable
slice, run meaningful available code checks, write evidence and update progress.
Continue with the next available dependency without requiring Windows. Search
existing source and official documentation to resolve implementation uncertainty.
Do not stop merely because a native check cannot run; preserve that check for W34.
Use INPUTS-AND-BLOCKERS.md to distinguish an implementation gap from an unavailable
release input, native toolchain or later authorized external operation.

For the current partial checkout, first read RESUME-GAPS.md and revalidate its
known browser fixture/typecheck failures. Preserve checked historical slices but
finish their production returns rather than reimplementing them or calling the
final tree green from older results. Current task preparation runs no app tests.

A dependency means its required contract/foundation is available, not that all
later UI composition or native acceptance is complete. For example, W04 supplies
the safe shell before the later Library/Worker/update views exist. Keep its whole
feature checkbox open until those views are actually bound. Never mark a fake
adapter, absent release resource or unavailable native compiler as passing.

## Work order and integration returns

| Order | Tasks                                      | Reviewable output and required return                                                                                                                                                    |
| ----- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | W01–W04                                    | Inventory/build, typed shared boundaries, real native source and isolated shell. Revisit W04 as later services/views are bound.                                                          |
| 2     | W05                                        | Compatible Windows platform/consumer backend contracts; retain existing Google/admin eligibility and mobile behavior.                                                                    |
| 3     | W06–W09                                    | Reproducible runtime/model metadata, strict GPU qualification, automatic Prepare/recovery and trustworthy readiness. Fresh downloads must exist in source.                               |
| 4     | W10–W12                                    | User-session authority, physical GPU admission and real guest personal pipeline; bind app and Chrome consumers without owning fleet credentials.                                         |
| 5     | W13 foundation, W14, W15, then W13 closure | Define mode/cloud commands, bind real account and usage/realtime, then close billable confirmation, policy and result adoption. A simulated Account port cannot close cloud integration. |
| 6     | W16, W17, W18, W19                         | Complete local/account Library, genuine listening history, player/queue and advanced listening. Return to Library counts, queue metadata and media pins after player/history binding.    |
| 7     | W20, W21, W22, then W20/W21 closure        | Captured-owner outbox, exact reuse/publication and storage admission. Bind all writers/consumers to the same pins, retention and workspace-exit authority.                               |
| 8     | W23–W25                                    | Approved worker onboarding, saved-intent controls, Advanced diagnostics/benchmarks/maintenance. Bind real session events; no live enrollment while implementing.                         |
| 9     | W26–W28                                    | Actual native host/registry source, one shared extension's Windows routing, complete settings/localization/accessibility. Return to W12/W13/W21 for browser paths.                       |
| 10    | W29–W32                                    | Signed coordinated updates/rollback, bounded diagnostics/security, per-user installer/release tooling and dashboard/product integration. Revisit localization for these final views.     |
| 11    | W33                                        | Close every production-composition gap, finish available code checks, prepare the native acceptance harness and exact unresolved checks.                                                 |
| 12    | W34, after machine connection              | Build/run native acceptance on the named Windows machine. Record additional OS/GPU coverage as pending where hardware is unavailable.                                                    |

The numbered task files remain stable. Integration returns are part of their
scope, not extra features. Keep all implementation items open until their full
behavior is reachable through the production app/session/browser entries.

Required late returns include W08→W11/W29 maintenance, W09→W10/W26 status,
W21→W20/W22/W27 production consumers and W25→W28/W29/W31 UI/update inputs.
For release work use W29 schemas/factory → W31 resources → W29 concrete activation/
fleet proof → W32 final policy/distribution binding. These returns do not require
future-task closure before an earlier contract foundation can be written.

## Completion evidence rules

- `[x]` means the precise item completed with evidence, not merely that code exists.
- Source/headless checks cover parsers, state machines, contracts, permissions
  requested by adapters, races, persistence and error handling using fakes/fixtures.
- Native source may be written while compilation/linking remains unavailable;
  identify the missing check and continue portable work.
- W34 alone closes real Windows installation, DPAPI/ACL/registry/Job behavior,
  GPU placement/output, playback/listening, real browser and lifecycle acceptance.
- Existing passing records describe their recorded checkpoint. A later change can
  require new validation; the latest known failure must remain visible.
- No commit/push/deploy/publication, real worker enrollment, account destruction,
  production mutation or data purge follows from implementing the code tasks.

## Required interruption handoff

Record the current task/slice, affected files, exact latest commands/results,
partial unvalidated code, open integration gaps, deferred Windows checks and the
next concrete action. Preserve unrelated dirty work. Use evidence/TEMPLATE.md and
PROGRESS.md. Read RESUME-GAPS.md before treating earlier checked items as current.

## Prompt for a later implementation session

> Read docs/windows-desktop/README.md and AI-HANDOFF.md, then execute the task pack
> using EXECUTION-PLAN.md. Implement W01–W33 one task at a time, preserving existing
> work and completing their production composition. Run code-only checks available
> on this Mac; write real native source and the Windows test harness without waiting
> for a connected Windows machine. Mark individual items only with evidence. Resolve
> code/design problems through source study and official research, then continue
> dependent or independent work. Keep all real Windows checks for W34 after I connect
> the machine. Do not commit, push, deploy, publish, enroll a real worker or delete
> real data without my separate instruction.
