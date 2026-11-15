# W01 — Freeze parity inventory and create the Windows build foundation

- Status: code-complete / Windows pending; source foundation, parity inventory and development review complete. Separate release security exception remains open.
- Code dependencies: none.
- Accepted scope points: P01, P02, P03, P30.
- Execution phase: A — implement now once authorized; native checks later.
- Evidence: [W01 code checks](../evidence/W01-foundation-2026-10-09.md); [current-source parity refresh and explicit gaps](../evidence/W01-final-parity-inventory-2026-10-10.md).

A dependency's pending Windows checks do not block this task's code work. Implement real native source now, test portable behavior on the Mac, and retain native checks for W34.

## Existing behavior and design consequence

The desktop UI is Swift, while reusable companion and engine behavior live in separate TypeScript/Python components. There is no root package installation. Establishing reproducible boundaries first avoids copying the companion or inheriting the web app's narrower scope.

## Read before editing

- [chrome-extension/README.md](../../../chrome-extension/README.md)
- [chrome-extension/docs/tasks.md](../../../chrome-extension/docs/tasks.md)
- [chrome-extension/package.json](../../../chrome-extension/package.json)
- [worker/package.json](../../../worker/package.json)
- [web-client/package.json](../../../web-client/package.json)

Also read [architecture](../ARCHITECTURE.md), [AI handoff](../AI-HANDOFF.md),
[validation](../VALIDATION.md), and the affected component instructions/manifests.

## Implementation checklist

- [x] Create windows-desktop/ with a component README, package manifest, lockfile, strict TypeScript, formatter/linter, unit/headless component test runner and separate main/preload/renderer build entries. Select a maintained Electron/toolchain version that explicitly supports the agreed Windows 10 minimum; record the compatibility evidence and pin versions.
- [x] Turn COVERAGE.md into a source-backed feature inventory, tracing each macOS screen/action and each of its error, empty, offline and signed-out states. Include local video audio extraction where supported, current thumbnails in Library/Now Playing/Up Next, recent Worker controls and all account actions.
- [x] Record shared module ownership and build order. Expose reusable companion contracts through an explicit build entry without depending on stale sibling dist, modifying unrelated clients or creating a root install.
- [x] Define scripts for source build, typecheck, lint, formatting, unit/component tests, contract tests and package fixtures. Define later Windows native build/test scripts separately, with explicit unsupported-host results.
- [x] Record dependency/license/native ABI requirements, app identity/version conventions, architecture detection and a Windows 10 compatibility budget. Add Windows ARM/x86 rejection fixtures without advertising Windows Server.
- [x] Update the progress ledger and any justified architecture refinement; preserve current dirty changes and exclude generated binaries, personal configuration and test media from tracked source.

## Code validation checklist

- [x] Run the new source build, type/lint and bootstrap unit checks using available Mac tooling; verify separate entry bundles do not import server/native modules into the renderer.
- [x] Check the inventory against all 30 coverage rows and verify every feature has an implementation task and a later acceptance scenario.
- [x] Test architecture/build-number decisions using fixtures for Windows 10 19045, older builds, Windows 11, x86 and x64-on-ARM host reports.

## Windows acceptance — deferred until W34

- [ ] Compile the actual Windows native dependencies and launch the packaged application on the recorded Windows 10/11 x64 targets.
- [ ] Verify installed dependency/runtime compatibility on a clean standard-user profile without developer tools.

## Detailed execution plan

1. Read the feature inventory and trace current Swift actions, companion commands,
   worker commands and account endpoints. Preserve behavior as well as labels:
   guest/offline states, owner changes, failure recovery and disabled explanations.
2. Verify current pinned versions and lockfiles rather than choosing versions from
   this document. Record supported Windows versions, licenses, native binaries and
   build prerequisites. Electron's embedded Node and the engine's Node are separate.
3. Build only from source into separate main, preload, renderer, agent and browser
   host outputs. Explicitly allow shared source imports; reject renderer imports
   of account storage, process launchers, worker modules and filesystem adapters.
4. Define the release input inventory before packaging: app assets, native helpers,
   extension identity, public account configuration, signed runtime metadata,
   model identity, update trust and third-party notices. Missing release inputs
   must cause a clear failure, never produce a purported consumer-ready artifact.
5. Record code-only commands in the component README. Native compilation,
   Windows installer execution and GPU qualification remain distinct W34 checks.

## Additional work and review checklist

- [x] Refresh the existing inventory against the current composed macOS/Windows source; record concrete receiving-source gaps and active late returns rather than claim those other tasks complete. See [2026-10-10 source refresh](../evidence/W01-final-parity-inventory-2026-10-10.md).
      The review includes the final macOS screens/actions while late owned
      Windows features are composed; distinguish accepted parity from later ideas.
- [x] Verify lockfile reproducibility and source-built shared modules on a clean
      temporary checkout, without installed-app state or stale sibling `dist`.
- [x] Review production and development dependency findings separately; record
      actual findings and implement compatibility-preserving runtime graph
      containment. See [dependency review and every-role gate evidence](../evidence/W01-development-dependency-review-2026-10-10.md).
- [ ] Before release, resolve or explicitly review/approve the eight remaining
      moderate development findings, refresh official advisory/registry status,
      and verify operator-controlled isolated builder inputs/configuration.
      Source containment does not approve this security exception or make the
      full dependency audit clean.
- [x] Store a bounded artifact inventory and license list; exclude generated
      runtime/model/media copies, private config, credentials and account data.

## Specific code-only fixtures

| Scenario                             | Required result                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------------------ |
| Build on the development Mac         | Source bundles and headless tests work without launching Electron or Windows binaries.     |
| Windows 10 build 19044 / 19045       | The former is refused; the latter passes the OS gate only, without implying GPU readiness. |
| Native ARM host with an x64 process  | Refused using native OS architecture, even if the process reports x64.                     |
| Missing helper/config/model manifest | Explicit package/readiness failure; no invented download URL or success receipt.           |
| Stale sibling generated output       | It cannot alter the source-built Windows artifact.                                         |

## Deliverables to review

Component manifest/lockfile/README, build boundary configuration, dependency and
license inventory, host-support fixtures and updated parity/evidence links. The
existing W01 checkpoint remains historical; the new checklist is not checked by
preparing this specification.

## Completion record

### Clean source and dependency review — 2026-10-09

The [current build-input and license inventory](../../../windows-desktop/docs/build-inputs-and-licenses.md)
records the pinned desktop/development dependencies, all nine release execution
graphs, source-derived assets, closed resource ownership, clean temporary source
build and unchanged lock hash. Fresh install without scripts, source build,
TypeScript and two bundle-boundary checks passed without sibling dist/node_modules
or an Electron binary. The missing-fixture copy in the initial snapshot was
corrected; it was not a repository TypeScript defect.

The full audit still reports eight moderate builder-chain findings, with no
patched sprintf-js version. Runtime audit has zero findings. The inventory records
actual exposure and compatibility-preserving containment; final release review of
the unresolved development advisory stays open. The [2026-10-10 parity refresh](../evidence/W01-final-parity-inventory-2026-10-10.md) now records every accepted point against current Mac/Windows receiving source, including explicit Setup payload/assistance, native export and peer repair/guard gaps. It does not close those tasks or their native acceptance.

- Implementation files and review: component parity inventory now distinguishes source-present, active source return, release input/review and W34-only proof; all P01–P30 are explicitly mapped without changing user OS/GPU/lifetime decisions.
- Commands/results and evidence: formatter and local-reference/point-coverage validation recorded in the new evidence. Historical foundation/clean-checkout and Root current build/dependency evidence remain dated; no new app/native/audit commands are claimed for the doc-only refresh.
- Unrun native/toolchain checks: actual Windows compiler/package/ABI/standard-user/GPU/Chrome/accessibility/live/release acceptance remains unchecked.
- Later receiving reconciliation: G01 full shared extension/Setup and G02 native export receiver are now [source-bound and checked](../evidence/W04-W26-setup-export-receiving-2026-10-10.md); automatic Prepare has [actual lifecycle proof](../evidence/W08-desktop-lifecycle-2026-10-10.md). Current repair/GPU returns stay in W06–W12, not silently closed by inventory presence. Development review and runtime graph containment are complete; W31/W34 approved inputs/acceptance and release security decision remain open. No clean full audit or release approval is implied.

Check completed items individually and update [TASKS](../TASKS.md) and
[PROGRESS](../PROGRESS.md). Use `code-complete / Windows pending` only when
the required source work and executable code checks are complete; unavailable
native compilation remains explicitly recorded. Do not claim a release from
fixture or source-only proof.

### Development dependency source review and containment — 2026-10-10

The [bounded dependency evidence](../evidence/W01-development-dependency-review-2026-10-10.md)
separates zero runtime findings from eight moderate builder-chain findings, and
records current primary advisory/registry status. No compatible published fix
was verified: the suggested downgrade breaks exact packaging pins, and the newer
v26 tag still selects the affected @electron/get v3 chain. Existing pins remain.

The production release gate now rejects all eight reviewed build-only packages
from every runtime graph, including bundled inputs and external import edges.
Each-role nested/Windows/case/subpath rejection and allowed-runtime fixtures pass;
the freshly source-built twelve metafiles pass the real nine-graph gate. The
source dependency-review checkbox is complete. The separate release/security
exception, actual isolated Windows builder and W31/W34 acceptance remain open.

Current reconciliation: Root's whole Desktop TypeScript passed after the new
Session fixture literal types were corrected. Current source build and both
boundaries passed, and all twelve fresh metafiles passed the real nine-entry
release gate. This supersedes the peer-fixture typecheck failure recorded in the
dependency evidence; it does not change the separate release/security decision.
