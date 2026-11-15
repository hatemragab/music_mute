# W06 — Prepare reproducible Windows runtime and model installation

- Status: code-complete / genuine release inputs and Windows acceptance pending; see the current source audit for the exact tested boundary.
- Code dependencies: [W02](W02-shared-core-and-contracts.md), [W03](W03-windows-native-security-adapters.md).
- Accepted scope points: P05, P06, P27, P29.
- Execution phase: A — implement now once authorized; native checks later.
- Evidence: [consumer packaging and bootstrap code checks](../evidence/W06-consumer-runtime-package.md).

The implementation phase was subsequently authorized. Checked source rows below
refer to the current requirement matrix and actual portable tests; genuine build
inputs, Windows execution and W34 acceptance remain separate prerequisites.

## Current source audit — 2026-10-10

[Requirement → production entry → portable proof → native acceptance](../evidence/W06-W09-runtime-prepare-readiness-closure-2026-10-10.md)
records every boundary below. `[x]` in implementation/code sections means source
and portable proof, never Windows execution. Historical completion commands below
remain dated slices; use the current matrix for subsequent changes.

## Existing behavior and design consequence

The Mac thin bundle already separates app/runtime/model. The Windows worker has signed runtime packaging, but its service layout and dependencies cannot be installed unchanged as a consumer application.

## Read before editing

- [chrome-extension/docs/setup-updates.md](../../../chrome-extension/docs/setup-updates.md)
- [chrome-extension/src/companion/downloader-bundle.ts](../../../chrome-extension/src/companion/downloader-bundle.ts)
- [worker/RELEASING.md](../../../worker/RELEASING.md)
- [worker/src/platform/windows/release-builder.ts](../../../worker/src/platform/windows/release-builder.ts)
- [worker/src/platform/windows/release-manifest.ts](../../../worker/src/platform/windows/release-manifest.ts)
- [worker/src/platform/windows/pe-audit.ts](../../../worker/src/platform/windows/pe-audit.ts)
- [docs/r2-storage/README.md](../../../docs/r2-storage/README.md)

Also read [architecture](../ARCHITECTURE.md), [AI handoff](../AI-HANDOFF.md),
[validation](../VALIDATION.md), and the affected component instructions/manifests.

## Implementation checklist

- [x] Define versioned per-user runtime/model/staging/rollback directories, a shared lease-aware runtime reference for personal and fleet consumers, and separate fleet credential/state roots. Avoid duplicate large model/runtime copies.
- [x] Create a reproducible x64 runtime recipe containing required Node, Python, FFmpeg, ONNX DirectML and acquisition dependencies. Respect worker version/ABI requirements; do not assume Electron's Node is interchangeable.
- [x] Implement signed bootstrap manifest/inventory verification, pinned versions/hashes, bounded downloads, safe archive extraction, expected-file/PE checks, disk estimates and atomic activation. No PATH dependence, end-user terminal setup or administrator step.
- [x] Download the model only from its approved owner/upstream source with exact identity verification. Do not mirror it into the public release bucket. Keep backend R2 credentials out of all packages.
- [x] Implement resumable bounded partial downloads, verification before reuse, completed-archive deletion, low-disk handling and rollback retention. Reject unsigned/untrusted manifests, redirects outside policy and archive path/link escapes.
- [x] Prepare source and build recipes for native binaries even when Windows build is deferred; fixture archives are explicitly test-only and cannot be published as a fresh-user runtime.
- [x] Record redistributable/license notices and how clean Windows systems receive required runtime DLLs without a separate privileged installer.

## Code validation checklist

- [x] Test signed-manifest/inventory failure cases, bad digest/length, truncated/resumed downloads, archive traversal/reparse entries, disk exhaustion and activation crash recovery using temporary fixtures.
- [x] Validate package allowlists and x64 PE metadata using fixtures; assert no credentials, development paths, service installer or placeholder download host can enter a release candidate.
- [x] Run affected packaging/unit/type/build checks; separately record native components that cannot be compiled on this host.

## Windows acceptance — deferred until W34

- [ ] Build/audit the real Windows runtime and install it on a clean standard-user system without Python/Node/FFmpeg already installed.
- [ ] Prove fresh HTTPS runtime/model download, DLL loading, signature/inventory verification and bounded archive cleanup.

## Agent execution contract — planning review 2026-10-09

Start from the existing consumer builder, manifest verifier and Prepare adapters;
do not create a second runtime installer. The consumer profile is explicit
`installationProfile: "windows-user"`; omitted profile continues to mean the
legacy service artifact. The trusted catalog entry is `windows-amd64-user`, while
the signed platform remains `windows-amd64`. A service artifact cannot be a
fallback when a consumer entry is missing.

| Boundary       | Trusted input                                                                                  | Required output and invariant                                                                                                                |
| -------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Build assembly | Repository pins, verified dependency archives/wheels, actual x64 helper, compiled agent inputs | Reproducible inventory and archive; missing native/agent input fails the build. Fixture PE/scripts are test-only.                            |
| Signature      | App-owned public keys, signed profile/version/sequence/expiry/archive bytes and SHA-256        | Exact validated metadata. Never accept a key supplied by the downloaded archive. Archive SHA binds the contained inventory.                  |
| Installation   | Verified archive and fixed per-user paths                                                      | Private staging, checked archive inventory, immutable release directory, then activation proof. Renderer cannot supply a URL or destination. |
| Model          | Shared `local-model.ts` upstream pin                                                           | Exact bytes/SHA verified through a private descriptor; model remains outside the release archive and public runtime bucket.                  |
| Consumers      | Personal/fleet/Prepare identities and active pins                                              | A release stays present while any verified consumer owns it; fleet secrets stay in the separate fleet root.                                  |

Required consumer inventory includes `runtime/node/node.exe`, the pinned Python
and FFmpeg layout, `runtime/native/musicmute-native.exe`,
`agent/session-agent.cjs`, `agent/login-worker.cjs`, `agent/personal.cjs`,
`agent/fleet.cjs`, `agent/prepare.cjs`, shared engine/CLI source and private acquisition tooling at
`tools/downloader/downloader_bootstrap.py` and `tools/youtube/bin/deno.exe`.
Do not add WinSW, service installation, mutable credentials, models, `.env`,
development absolute paths or acquisition user state to the archive.

### Implementation order and handoff boundaries

1. [x] Re-read `consumer-package.ts`, `release-manifest.ts`,
       `build-windows-consumer-runtime.ps1`, desktop `windows-config.ts` and
       `main/prepare/bundle.ts`; reconcile one path/profile contract before edits.
       Preserve legacy service verification tests and macOS bootstrap behavior.
2. [x] Audit the existing dependency pins and x64 PE imports, redistributable
       licenses and required DLL delivery. Keep pinned archive/wheel checksums in
       one reviewed cohort; a version string or successful import is insufficient.
3. [x] Revalidate the signed-descriptor HTTPS downloader and resumable journal.
       The sealed `runtime/runtime-source.json` and real runtime/model transfer
       now compose through actual Operations and signed ZIP fixtures. Genuine
       approved release resources remain W31 inputs; the old packaged-only/empty-
       descriptor observations are historical.
4. [x] Bind a partial to artifact profile, exact signed SHA/bytes, trusted URL,
       strong response validator and verified prefix length. Append only a matching
       `206`/`Content-Range`; a `200`, changed validator or compressed response must
       restart safely or fail. An existing `.partial` is never activation proof.
5. [x] Finish bounded ZIP planning/extraction and file/PE inventory checks under
       native private-path validation. Budget archive + expanded runtime + temporary
       model + qualification scratch + retained rollback before starting.
6. [x] Integrate activation with W08/W11/W29 maintenance and W22 pins. Write
       proof before atomic rename, publish the active receipt last, and retain the
       prior release until all dependent process trees and pins are settled.
7. [x] Delete only the completed, verified, app-owned archive after activation
       is durable. Leave failed/unknown transactions recoverable and bounded;
       never remove user media or replace an in-use release.

### Races and fault fixtures to close

- [x] Two processes preparing the same target: exactly one installation owner;
      the waiter sees bounded Preparing state and cannot publish its own receipt.
- [x] Signature/profile/key/sequence/expiry mismatch, truncated body, short
      writes, oversize body, redirect outside policy and expired new artifact:
      no activation; exact already-active offline reuse is tested separately.
- [x] ZIP `../`, drive/UNC/ADS paths, case collisions, reserved names, symlink,
      junction/hardlink entries, duplicate inventory paths, missing agent/helper,
      ARM PE or wrong Python/Node ABI: fail before any final-path publication.
- [x] Crash before proof, after proof, after release rename, during model
      publication and before receipt commit: recovery either verifies the exact
      candidate or retains the previous activation; no existence-only Ready.
- [ ] Active personal/fleet/update pin, Windows open-file error and insufficient
      disk during rollback cleanup: retain protected files and report deferred work.

Code fixtures belong in the existing worker consumer-package/manifest/PE tests
and desktop bundle/archive/model/Prepare tests. Use temporary archives and
injected downloads/native ports; never download/install the runtime or model on
the Mac to make these tests pass. Run component typechecks, scoped lint/format,
fixture tests and source builds after future code changes. Record fixture
executables distinctly from a production archive.

### Deferred machine evidence and reviewable deliverables

- [ ] On Windows 10 build 19045 and Windows 11 x64, build the real native helper,
      assemble the actual archive and record inventory, PE/DLL audit and SHA/size.
- [ ] From a fresh standard-user profile with no preinstalled tools, perform
      real HTTPS runtime/model acquisition; prove Deno/provider/DLL loading,
      verified activation, cancel/relaunch recovery and no elevation.
- [ ] Deliver a path/profile contract, dependency/license ledger, immutable
      archive/metadata/inventory report, interruption matrix and explicit W34 rows.
      Publication/signing-account changes remain separately authorized actions.

Research checked for this handoff: HTTP range and representation validators are
defined by [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html#section-14).
The local resume policy above is an application decision, not evidence that a
particular download endpoint implements it. Windows links/mount redirection
require native checks because [reparse points](https://learn.microsoft.com/en-us/windows/win32/fileio/reparse-points)
can change path resolution. Actual filesystem behavior remains W34 evidence.

## Sealed transfer resource and retention closure

- [x] Bind `runtime/runtime-source.json` to trusted app inventory and signed
      consumer metadata: exact target/profile/platform, immutable approved URL,
      archive bytes/SHA and declared expansion bytes. Never invent hosted assets.
- [x] Reconcile private `prepare/downloads` partial/verified archives and model
      partial/verified files with DPAPI `prepare_runtime_transfer` and
      `prepare_model_transfer`. Keep only recognized current resumable state;
      unknown/replaced files remain protected conflicts.
- [x] Test exact `206`, `200` restart, weak/missing ETag, `416`, changed encoding,
      checkpoint failure/uncheckpointed tail and final digest failure. No response
      implies that a subsequent server request must honor Range.
- [x] Recover deletion of the completed archive after activation; retain exact
      rollback bytes under W22/W29 while bounding temporary download retention.

See [HTTP Range semantics](https://www.rfc-editor.org/rfc/rfc9110.html#section-14.2).

## Source deliverables and machine boundary

- [x] Path/profile and dependency/license ledger; signed transfer/ZIP/activation
      fixtures; exact WAL/birth interruption and bounded retention matrix (R01–R17).
- [x] Require the private ordinary/delay PE dependency graph at package assembly
      **and** extracted-stage acceptance; RuntimeProof v2 contains a separate
      `dllPolicy`, without changing the actual GPU engine policy.
- [x] Support corrupt canonical repair through genuine retained Prepare/retired
      mutation authority, one exact backup and sidecar, and the fixed native cleanup
      port. A cache-write fault never classifies valid runtime bytes as corrupt.
- [ ] Supply reviewed licensed VC/Python/DirectML/native inputs and execute clean
      standard-user Windows DLL/dynamic-loading validation. Static imports and
      synthetic PE headers are not runtime loading or redistribution permission.

## Completion record

- Implementation files and review: consumer-package.ts, native-only consumer build recipe, profile-aware signed metadata and inventory, shared downloader bootstrap Windows WinAPI boundary; remaining setup/download/model/activation source belongs to W06/W08.
- Commands/results and evidence: 58 worker TS tests, 8 companion downloader TS tests, 15 Python bootstrap checks (13 existing prepared-wheel cases unrun), 2 recipe checks, worker typecheck and scoped lint/format/diff checks passed; see evidence for scope.
- Unrun native/toolchain checks: native Windows assembly, PowerShell execution, DLL/DirectML/Deno/provider loading, real ACL/NTFS behavior, installer and fresh HTTPS Prepare.
- Current source return: R01–R13 and R14–R17 in the current matrix cover signed network transfer, fresh dependency audit, owned staging/repair, activation and cleanup. Genuine licensed/private dependency inputs and native execution remain W31/W34. Archive/model URLs cannot be fabricated to satisfy missing inputs.

Check completed items individually and update [TASKS](../TASKS.md) and
[PROGRESS](../PROGRESS.md). Use `code-complete / Windows pending` only when
the required source work and executable code checks are complete; unavailable
native compilation remains explicitly recorded. Do not claim a release from
fixture or source-only proof.
