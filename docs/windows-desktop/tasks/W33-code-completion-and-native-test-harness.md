# W33 — Finish all code checks and prepare the Windows acceptance harness

- Status: code-complete / Windows pending; all33 implementation/available-code-check tasks closed, W34 deferred.
- Code dependencies: [W01](W01-inventory-and-build-foundation.md), [W02](W02-shared-core-and-contracts.md), [W03](W03-windows-native-security-adapters.md), [W04](W04-electron-shell-and-navigation.md), [W05](W05-backend-platform-and-contract-support.md), [W06](W06-runtime-and-model-package-layout.md), [W07](W07-directml-selection-and-qualification.md), [W08](W08-automatic-prepare-and-repair.md), [W09](W09-startup-and-readiness-receipts.md), [W10](W10-per-user-agent-and-worker-lifetime.md), [W11](W11-gpu-admission-and-handover.md), [W12](W12-local-files-and-youtube-processing.md), [W13](W13-cloud-mode-and-processing-policy.md), [W14](W14-complete-account-experience.md), [W15](W15-usage-policy-and-realtime.md), [W16](W16-complete-library-and-metadata.md), [W17](W17-listening-history-and-counts.md), [W18](W18-player-and-playback-queue.md), [W19](W19-advanced-listening-features.md), [W20](W20-background-account-saving-and-outbox.md), [W21](W21-verified-cache-and-community-reuse.md), [W22](W22-storage-budget-and-cleanup.md), [W23](W23-worker-onboarding-and-eligibility.md), [W24](W24-worker-controls-and-saved-intent.md), [W25](W25-worker-advanced-maintenance.md), [W26](W26-chrome-native-host-and-registration.md), [W27](W27-shared-extension-feature-parity.md), [W28](W28-preferences-localization-and-accessibility.md), [W29](W29-app-runtime-and-model-updates.md), [W30](W30-diagnostics-and-security-review.md), [W31](W31-installer-signing-and-distribution.md), [W32](W32-dashboard-and-cross-product-integration.md).
- Accepted scope points: P01, P02, P03, P04, P05, P06, P07, P08, P09, P10, P11, P12, P13, P14, P15, P16, P17, P18, P19, P20, P21, P22, P23, P24, P25, P26, P27, P28, P29, P30.
- Execution phase: A — implement now once authorized; native checks later.
- Evidence: [requirement ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w33-native-acceptance-harness-portion) and dated harness checkpoints below.

Authorized source implementation and portable checks have run. The native harness and component native commands now use the approved QA process guard described below; actual compiler/test descendant cleanup proof still requires Windows. Global W01–W32/visible-feature/code-completion is Root-owned and stays independently reviewed. Native execution remains for W34; planning or simulated evidence never marks it passed.

## Existing behavior and design consequence

The user's execution sequence deliberately permits complete implementation before Windows is connected. This task closes code gaps and prepares real acceptance; it cannot convert unrun native checks into passes.

## Read before editing

- [chrome-extension/package.json](../../../chrome-extension/package.json)
- [worker/package.json](../../../worker/package.json)
- [backend/package.json](../../../backend/package.json)
- [dashboard/package.json](../../../dashboard/package.json)
- [docs/worker-windows-macos/READINESS.md](../../../docs/worker-windows-macos/READINESS.md)
- [worker/RELEASING.md](../../../worker/RELEASING.md)

Also read [architecture](../ARCHITECTURE.md), [AI handoff](../AI-HANDOFF.md),
[validation](../VALIDATION.md), and the affected component instructions/manifests.

## Implementation checklist

- [x] Review every W01–W32 implementation checklist and all 30 COVERAGE rows. Finish missing production behavior, error paths and adapters; remove temporary success stubs and unjustified win32 test skips.
- [x] Run focused and required affected-component code checks using VALIDATION.md. Record exact commands/results/skips and distinguish existing unrelated failures from failures caused by this work.
- [x] Perform a scoped diff review for backward compatibility, secret exposure, unsafe path/process handling, duplicate shared logic and unintended changes. Do not format or repair unrelated dirty work.
- [x] Finish the Windows test harness/runbook covering every native checkbox, with prerequisite detection, named target selection, disposable fixtures, redacted outputs and positive descendant cleanup. Source/planning portions have [dated proof](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w33-native-acceptance-harness-portion); the later guarded compiler-tree source audit below is complete; actual native execution remains open. Include native build/link/package checks unavailable on the Mac.
- [x] Prepare the [OS/GPU/account/Chrome test-data specification and evidence matrix](../../../windows-desktop/acceptance/TEST-DATA.md) without provisioning machines/accounts, downloading models or mutating installations. Identify cases needing additional user authorization such as real enrollment/purge. Source document only; every actual target/native observation remains W34.
- [x] Record a feature-by-feature code completion report, exact build inputs, unresolved toolchain checks, external configuration needs and release blockers. No Windows machine connection is required to reach the end of this task.
- [x] Update task/index/progress statuses honestly. Continue fixing code failures now; defer only checks that truly require Windows, real services or an authorized external action.

## Code validation checklist

- [x] Run the documented safe code-check matrix, with protocol/package/fault/owner-isolation regressions for shared changes.
- [x] Validate the native test harness structurally and dry-run its planning mode with fakes; it must refuse unsupported targets and destructive cases without explicit authorization. **Harness proof** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w33-native-acceptance-harness-portion)).
- [x] Check all task links/dependencies/evidence references and prove every accepted point has code implementation plus a named Windows scenario.

## Windows acceptance — deferred until W34

- [ ] Native execution remains for W34; confirm the harness runs on the supplied machine when connected.
- [ ] Do not mark this task's Windows status passed merely because the harness or Windows build configuration exists.

## Detailed execution plan

1. Start from the current dirty worktree and evidence, not from an assumed clean
   revision. Revalidate any checked item whose source/dependency changed; preserve
   unrelated work and name pre-existing failures without converting them to passes.
2. Audit production entry points for every feature in FEATURE-ACCEPTANCE.md.
   Controllers without main/session/browser bindings, unreachable views, missing
   resources, TODO success stubs and swallowed factory errors are unfinished work.
3. Close the integration returns in EXECUTION-PLAN.md: cloud/account/usage,
   Library/history/player, captured outbox/reuse/storage, fleet/Chrome admission,
   then updater/installer/diagnostics/localization. Fix code failures before W34.
4. Run the focused suites first and then required affected component checks.
   Distinguish source/headless/portable C++ parser tests from Win32 compilation,
   installed app checks and genuine GPU/media/live-service evidence.
5. Prepare a harness with a safe planning mode. It inventories expected targets,
   prerequisites and cases, but invokes no driver installation, enrollment, real
   account deletion, purge, publication or hardware inference during dry-run.
6. Emit a machine-readable acceptance ledger with case ID, owning task, OS/GPU,
   package/runtime/model identity, required prerequisite, command/action,
   expected observation, actual result, evidence link and cleanup result.
7. Finish with a source-completion report plus exact native/external blockers.
   No Windows connection is required to finish available source work; native
   build errors discovered later still require repair and regression checks.

## Additional closure checklist

- [x] Inspect final app/preload/agent/browser bundles for missing imports/resources,
      accidental secrets, unsupported Windows APIs and stale sibling build inputs.
- [x] Verify signed preparation/update/package loaders accept only approved public
      metadata and release tooling refuses placeholder or absent trust. Actual
      approved binaries/configuration/signing inputs remain the external gate below.
- [x] Check final production cleanup/shutdown tracks all pending work and releases
      pins/leases only after exact consumer-tree exit or verified operation teardown.
- [x] Audit all 30 points against actual visible commands, including native share,
      queue editing, account recovery, Worker Advanced and updater recovery states.
- [x] Create portable harness-schema/dry-run fixtures and documented Windows-only **Harness proof** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w33-native-acceptance-harness-portion)).
      commands, without running them while the machine is disconnected.
- [x] Recheck every checkbox/evidence link and task-index status against current
      source; declare native compilation and live acceptance still pending.

## Specific code-only fixtures

Harness plan refuses an unspecified/unsupported architecture, 19044 host report,
missing package identity, unknown case, unauthorized destructive/live action or
unbounded log destination. It supports resume without repeating a passed case for
an unchanged target/artifact and never carries a pass to another OS/GPU/version.
Mock GPU/native observations are labelled simulated. A Windows 11 result cannot
close Windows 10 acceptance; native compilation is never recorded as run from a
structural parser or a generated executable alone.

## Deliverables to review

Final per-feature source report, required check results, inspected build inputs,
acceptance runner/runbook and evidence schema, release blockers and a resumable
W34 queue. Product completeness requires real composition, not merely task files
or a high test count.

### Full feature-report source return — 2026-10-10

- [x] Write [CODE-COMPLETION](../CODE-COMPLETION.md) with all30 accepted points
      and93 exact feature journeys, actual entry/receiver/resource/visible state,
      meaningful fixture/fault proof, detailed ledgers and named W34 scenarios.
      Its549 local links, exact30/93 coverage and registered scenario references
      were validated; formatting passed. Root corrected the exact extension-only
      generator link, later W22 receiving evidence and phase-acknowledgement versus
      Job-receipt wording during review.
- [x] Record exact public build/runtime/model/extension inputs, the separate
      runtime/full-development dependency findings and unavailable approved
      resources/toolchain/signing/configuration/native acceptance.
- [x] Reconcile independently owned final Native receiving returns and the frozen
      whole affected-component checks before declaring aggregate source closure.

## Final production-entry evidence matrix

- [x] For each advertised capability record entry → receiver/adapter → required
      resource/authority → visible state → code fixture → deferred Windows case.
      A controller, successful HELLO or static capability alone is insufficient.
- [x] Include fixed app/browser/headless entries, approved account/app/helper pins,
      cloud-without-Prepare, cache-only recovery and verified publication ownership.
- [x] Revalidate the latest browser fixture failure/test typing change and source
      entry edits; do not cite older whole-app passes as current. Run full affected
      shared-extension Mac regression in code-only form before final closure.
- [x] Reconcile native-only link visibility, mandatory Advanced parity, every writer
      journal and factory/shutdown order with the final actual production graph.

## Completion record

### Harness source return — 2026-10-09

The [later native/package audit](../evidence/W03-W31-W33-2026-10-09-audit.md)
adds closed native build-input inventory, filtered native compiler environment,
and source-digest resolution from the compiled module location. Current portable
package/harness suites pass with real temporary ASAR licensing fixtures. It does
not promote source checks to MSVC, signed package or installed acceptance.

- [x] Deliver [typed manifest/plan/runner](../../../windows-desktop/acceptance/README.md)
      with all 30 accepted point groups, native fault cases and bounded evidence.
- [x] Validate unsupported/unspecified targets, closed native action grammar,
      no simulated passes, exact-target/case/source resume and artifact hash fences.
- [x] Run planning with disposable fake metadata; it invokes no native process,
      creates no installation/account/model state and records Windows-executed false.
- [x] Write the explicit W34-only x64 compile/isolated CTest runner and readonly
      real native QA target descriptor; no production fixture authority is added.
- [x] Complete W01–W32 integration/final affected-component code checks under Root.
- [ ] Run actual connected Windows/native/installed/live acceptance under W34.

### Final source harness checkpoint — 2026-10-09

- [x] Execute portable harness/package cases and bounded source-digest CLI; record native source identity and injected-versus-real-file boundaries in [audit evidence](../evidence/W03-W31-W33-2026-10-09-audit.md).
- [x] Record Root whole Desktop checks: 1,424 tests / 174 files; typecheck/lint/format/build and two renderer/preload boundary fixtures passed. These commands minted no native acceptance result.
- [ ] Collect connected-Windows compiled/native, signed-package, Chrome/GPU, logon/uninstall and fault-injection evidence before candidate acceptance.

This historical harness checkpoint alone did not close global code completion. The final Root source return below closes available code work; Windows acceptance stays pending.

Task/index/progress reconciliation remains Root-owned. Use `code-complete / Windows pending` only when
the required source work and executable code checks are complete; unavailable
native compilation remains explicitly recorded. Do not claim a release from
fixture or source-only proof.

## Native harness requirement ledger — 2026-10-09

H-plan/H-native/H-evidence bind each owned harness source requirement to its
actual production CLI, exact candidate/target authority, portable test and native
gate in the [source ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w33-native-acceptance-harness-portion).
Root’s 22:43:50 base whole Desktop pass was 1,476/179 with typecheck/lint444/format;
current source build and two boundaries were rerun after the newly found package
graph/Force/catalog changes. Global source completion is not inferred from this
harness return, and every Windows/compiler/signature/install/live row stays open.

## Later acceptance source audit — 2026-10-10

- [x] Correct manual case ownership to the original [COVERAGE](../COVERAGE.md)
      points, including guest local P08, GPU coordination P22, lifecycle P25,
      backend/dashboard P26, updates P27, security/diagnostics P28 and distribution
      P29. Preserve prior case IDs, revise the changed definitions and reject old
      case-digest evidence on resume.
- [x] Add explicit window-owned export cleanup, corrupt-runtime repair/backup
      faults and handle-held cache deletion/lost-ACK procedures. These are W34 cases,
      not executed native tests.
- [x] Validate every manual point's task ownership against the actual COVERAGE
      table; require confirmed cleanup for passed evidence and reject non-string
      enum coercion, SIDs and known credential patterns. The acceptance fixture slice
      passed **13 tests/one file at 01:15:42**; the wider shell/Prepare/export slice
      passed **82 tests/nine files at 01:20:26**. Later changes need their own checks.
- [x] Replace native-run's normal parent `close` assumption with actual
      compiler/test descendant Job-zero proof. Timeout/overflow already records
      unconfirmed cleanup, but normal CMake/MSBuild/CTest parent exit alone cannot
      establish it. The runner and both component commands require the approved
      QA tool guard and request-bound positive whole-Job-zero receipt; the
      [current source evidence](../evidence/W33-final-source-regression-2026-10-10.md)
      records the guarded source and portable refusal/receipt fixtures. Actual
      native execution/proof remains W34; no native pass has been recorded.
- [x] Finish all remaining runtime/readiness/local-processing, storage/security,
      full regression and production-entry returns before global source closure.

### Native component-command receiving return — 2026-10-10

- [x] Route actual `build:native` and `test:native` through the existing guarded
      acceptance runner. Require named target/tools-v2/output inputs and explicit
      Windows-phase acknowledgement; remove the raw PATH CMake/CTest path.
- [x] Execute five package/boundary/command fixtures, including the actual
      non-Windows CLI refusing before runner or input loading, with no native
      invocation. The acceptance/guard/package-recipe slice passed31/three files
      at03:43:24; owned lint/format and diff checks passed.
- [ ] Execute the separately approved bootstrap guard, actual tool Job cleanup,
      MSVC/CMake link and CTest scenarios on the connected Windows target.

## Final Root code-completion return — 2026-10-10

All implementation/available-check rows above are supported by the
[30-point/93-journey report](../CODE-COMPLETION.md),
[final frozen regression](../evidence/W33-final-source-regression-2026-10-10.md),
[Native receiver return](../evidence/W22-final-native-library-cleanup-2026-10-10.md)
and [source security review](../SECURITY-REVIEW.md). Main/window/account/role
composition, exact cleanup retention and approved-input refusal are reviewed;
code fixtures are separate from native observations. Source/check index is33/33.

- [ ] Supply independently reviewed actual public configuration, licensed runtime/
      model/native PE assets, QA tool guard and signed candidate inputs before
      Windows installed/release acceptance; fixtures do not configure a release.
- [ ] Run W34 on the connected named Windows target, retain missing OS/GPU/vendor
      rows, and separately authorize signing/publication or live mutations.
