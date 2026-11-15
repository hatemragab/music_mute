# Windows desktop implementation plan

Prepared: 2026-10-09. Scope: MusicMute Windows desktop, shared Chrome extension,
personal GPU processing, accounts, Library and the per-user fleet worker.

**Historical baseline: W01–W33 source/code checks were closed before the Store migration.**
The [final code-completion report](CODE-COMPLETION.md) maps all30 accepted points
and93 journeys. Native Windows acceptance remains W34 after the connected named
machine and required approved inputs are available. Source closure does not prove
Windows/GPU/installed/live/release behavior or authorize publication.

The authorized release route is now free Microsoft Store signing with independent
GUI and Worker main packages. Follow the [18 MSIX migration tasks](store/MSIX-MIGRATION.md)
and their source/physical checkpoints. This work is still in progress; the older
code-completion report does not close these new tasks.

**15 October checkpoint:** fresh current-source GUI and Worker directories passed
their production builds and receiving checks on the Z440. Both new MSIX files
also passed the genuine SDK archive readbacks and were copied with verified
hashes to a new Z440 Desktop folder. Eight production-core DirectML cold/warm
calls passed with byte-identical outputs across the original and new runtime
profiles. The new default measured 50.7 seconds cold and 33.0 seconds warm on the
same 4m 43.6s song. The private
drafts and age ratings are saved, but the original GUI upload was
rejected for a missing headless-app waiver. The owner has asked to leave the
[prepared support request](store/SUBMISSION-PACKET-2026-10-15.md#ready-to-send-microsoft-support-request)
for them to submit later. Neither app is Store-signed or installed. See the
[current build evidence](store/IMPLEMENTATION-2026-10-12.md).

Both Store drafts now have saved reviewer notes and matching EN/AR Windows
privacy text; all four localized listing-text records were reopened and verified.
The [release-material readiness index](store/STORE-REVIEW-READINESS-2026-10-15.md)
links the handoff bundle and actual remaining approval, screenshot, reviewer-access
and distribution/privacy review gates. Nothing has been submitted or published.

## Agreed product decisions

| Decision           | Required behavior                                                                                                                                                                                                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Supported system   | Windows 10 22H2 x64, build 19045, is the minimum Windows 10 release; also support Windows 11 x64. No ARM, ARM emulation qualification, x86 or Windows Server promise.                                                                                                                                                    |
| Feature scope      | All 30 accepted macOS parity points, including accounts, Library, player, Prepare, worker and Chrome. See [coverage](COVERAGE.md).                                                                                                                                                                                       |
| UI                 | Locally packaged Electron + React + TypeScript; share behavior with existing components and use explicit Windows adapters.                                                                                                                                                                                               |
| Processing         | The existing model and engine, using ONNX Runtime DirectML on a qualified physical GPU. No silent CPU inference or cloud fallback. CPU decoding, DSP and encoding are allowed.                                                                                                                                           |
| Browser            | One shared Chrome extension and extension identity for both platforms.                                                                                                                                                                                                                                                   |
| Worker             | Standard-user installation and execution; no administrator prompt, WinSW or machine service for this consumer product. It runs only while its Windows user is logged in.                                                                                                                                                 |
| Account separation | Personal local processing works signed out. Fleet enrollment retains Google sign-in and backend administrator approval.                                                                                                                                                                                                  |
| Simplicity         | Automatic setup and GPU selection, concise progress and worker controls, technical detail under Advanced.                                                                                                                                                                                                                |
| Work sequence      | Implement every code task without a connected Windows machine; run code checks available on the development Mac. After implementation, run native Windows tests when the user connects the machine.                                                                                                                      |
| Release            | Two independent Store MSIX main packages, free Store signing only. On 15 October the owner authorized certification and private release to one named tester account; public release remains prohibited. Earlier website installer work is historical. Building source does not authorize deployment or fleet operations. |

## Start here

1. [AI handoff](AI-HANDOFF.md): execution instructions and checkbox rules.
2. [Execution plan](EXECUTION-PLAN.md): sequential work, integration checkpoints and continuation rules.
3. [Architecture](ARCHITECTURE.md): process, security, setup and lifecycle decisions.
4. [Source map](SOURCE-MAP.md) and [research](RESEARCH.md): existing code and official references.
5. [Task index](TASKS.md): 34 ordered task files with dependencies and acceptance checks.
6. [Coverage](COVERAGE.md) and [feature acceptance inventory](FEATURE-ACCEPTANCE.md): all 30 accepted points and their concrete user journeys.
7. [Validation](VALIDATION.md): code-only checks during implementation, Windows acceptance later.
8. [Progress](PROGRESS.md): current status and resumable handoff.
9. [Inputs and blockers](INPUTS-AND-BLOCKERS.md): required release/configuration inputs and how to keep code work moving when they are unavailable.
10. [Current source gaps](RESUME-GAPS.md): latest partial checkpoints, known failures and exact production integration returns; read before relying on historical checks.
11. [Code-completion map](CODE-COMPLETION.md): all30 scope points and93 journeys,
    actual receiving paths/fixtures and named deferred Windows scenarios; current
    source closure is complete; native/live/release gates remain pending.
12. [Source security review](SECURITY-REVIEW.md): actual trust boundaries, negative
    evidence, dependency findings and unrun native/release gates.

Tasks W01–W33 include implementation and code validation. W34 is the later
Windows acceptance/release-readiness task. Windows checks inside earlier tasks
are collected in W34; they must remain unchecked until actually run.

## Completion means evidence

Each task has independent implementation, code-check and Windows-acceptance
checklists. A task may be `code-complete / Windows pending`; this permits moving
to its dependent tasks. It does not mean Windows support or a release is verified.
Record commands, results, source revision or dirty-diff fingerprint and limitations
using [the evidence template](evidence/TEMPLATE.md). Never turn pending Windows
checks into passes, and never stop all implementation solely because Windows is
disconnected.

Performance observations apply only to the dated target and scenario. They do
not establish a minimum VRAM requirement or broader performance guarantee. A
build does not establish an available download or qualify the existing
service-based Windows worker as this consumer application.

## What every task provides

Each of the 34 task files identifies its dependencies, accepted scope points,
existing behavior and source references, implementation checklist, code-check
checklist and deferred Windows acceptance. Its detailed handoff specifies the
execution steps, input/output authority, failure and recovery cases, meaningful
fixtures and deliverables. Record completed work in the task and progress ledger
with its evidence; preserve unchecked work across interruption and resume.

The task index tracks full task closure. Checked historical items inside a task
describe their recorded slice; they do not close newly added integration or
revalidation work. Read [current gaps](RESUME-GAPS.md) before trusting an old pass.
