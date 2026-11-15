# Implementation inputs and external prerequisites

Use this alongside EXECUTION-PLAN.md. Missing Windows hardware does not stop
portable implementation or meaningful code checks. Missing real release inputs
does prevent claiming a working fresh-user package or release. Build the real
loader, validation, failure and recovery behavior now; exercise it with clearly
identified temporary fixtures and keep actual configuration/native proof open.

## Required input inventory

| Input                                                       | Owning tasks               | Required handling                                                                                                                                                                                                                                           |
| ----------------------------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Current macOS behavior and existing contracts               | W01/W02, all feature tasks | Trace the source map and feature acceptance inventory. Reuse current recipes, commands, account fences and full-snapshot subscriptions. Historical installed evidence is not Windows evidence.                                                              |
| Component manifests, lockfiles and licenses                 | W01/W06/W31                | Build shared entries from source. Record the selected versions' Windows 10 compatibility, native dependencies and redistribution notices; use the existing component install boundaries.                                                                    |
| Real Windows native helpers                                 | W03/W10/W26/W31            | Write the narrow Win32 source and build recipe now. Bundle actual x64 helpers and their dependencies only after native build/signature/inventory checks. A placeholder binary cannot close packaging.                                                       |
| Consumer runtime artifact and inventory                     | W06/W08/W29/W31            | Require a genuine consumer-profile runtime identity, immutable approved HTTPS transfer metadata, exact size/hash, inventory and trusted manifest signature. Never fall back to a machine-service artifact or accept an adjacent unsigned checksum as trust. |
| Model artifact and recipe                                   | W06/W07/W08/W29            | Bind approved model bytes/hash/size, compatible runtime and exact processing recipe. Implement fresh bounded transfer, verification and recovery. Keep old verified bytes while rollback may need them.                                                     |
| Public desktop account configuration                        | W05/W14/W32                | Package only the allowlisted public API/Firebase/OAuth settings. Keep server exchange secrets backend-only. Missing configuration exposes a truthful account/cloud unavailable state while guest local features remain available.                           |
| Signed app/update metadata and publisher identity           | W29/W31                    | Connect actual trust roots, artifact target/version/sequence, expected publisher and rollback policy. Reject placeholder hosts, missing pins, downgrade and profile mismatch. Temporary signing keys belong only in test fixtures.                          |
| Approved consumer fleet catalog and backend capability      | W05/W23/W24/W29/W32        | Preserve Google/admin eligibility and installation identity. Implement absent-catalog and activated-runtime refresh states; do not enroll a real worker, invent grants or deploy backend changes during code work.                                          |
| Chrome identity and production browser host resources       | W26/W27/W31                | Reuse the existing shared extension identity, manifest and provider contracts. Build host resources from source and verify their exact inventory; installation/registry/browser execution remains W34.                                                      |
| Release artwork, localization and legal notices             | W01/W28/W31/W32            | Reuse the current MusicMute assets and licensed marks/fonts. Check all final feature views, dialogs, errors and installer states in English/Arabic; do not scatter unverified product URLs.                                                                 |
| Signing credential access and publication destination       | W31, later release         | Tooling can be implemented without exposing credentials. Actual signing-account changes, upload and publication require their separate authorized release action and verified inputs.                                                                       |
| Connected Windows target and authorized acceptance fixtures | W33/W34                    | Prepare the runner, cases and safe dry-run now. Later record the named machine's OS/native architecture/GPU/driver and exact package/runtime/model hashes. Do not invent coverage for absent OS/GPU combinations.                                           |

Resource filenames and schema versions must follow the current production loader
and checked source. This inventory describes required responsibilities; it is not
a claim that all resources are already present or deployed.

Current concrete resource returns include sealed `runtime/runtime-source.json`
and the fixed signed app/account-authority peer manifest under native resources.
Their hashes/sizes/publisher and inventory must describe actual final signed
artifacts. W31 defines the signing order; no self-referential installer/app hash,
temporary fixture key or adjacent unsigned checksum can establish trust.
Numeric desktop account-policy build IDs and updater semantic versions are
different fields; W05/W29/W31/W32 must reconcile both without inventing releases.

## How the agent proceeds when something is missing

1. Inspect the current source, manifests and task evidence to identify the exact
   missing contract, file, toolchain or external configuration. Search existing
   implementations and primary documentation before adding a second mechanism.
2. Finish the real portable implementation, adapters and tests that do not depend
   on the missing external fact. Test both valid fixtures and absent, corrupt,
   mismatched, stale, revoked and cancelled input. Never replace missing authority
   with a success stub, fabricated URL, CPU inference or silent cloud fallback.
3. Record the exact unavailable check/input in the owning task, RESUME-GAPS.md
   and PROGRESS.md. Keep its checkbox open. Continue the next safe code slice;
   native acceptance waiting for Windows is not a reason to stop unrelated work.
4. At W33, enumerate source gaps separately from native-toolchain checks and
   operator/release prerequisites. Fix remaining code gaps before W34. Record
   source as written but checks pending if its required compiler is unavailable.
5. At W34, use the actual supplied target and designated fixtures. New native
   failures require source repair and regression checks. Account destruction,
   real enrollment, production writes, purge or publication remain separate
   authorized actions; a test-harness plan does not execute them.

## Prerequisite and evidence checklist

- [ ] Record approved public inputs and exact loader/schema ownership without
      reading or copying private credentials into this folder.
- [ ] Prove production loaders reject absent trust, placeholder assets, wrong
      platform/profile/version and unsupported native host architecture.
- [ ] Exercise fresh transfer, interruption, disk pressure, integrity mismatch,
      requalification and rollback with temporary code-only fixtures.
- [ ] Inspect the release candidate's real inputs, bundled native dependencies,
      signature/publisher identity and license inventory when available.
- [ ] Record all unavailable external/native checks and the named W34 scenario
      needed to close each one; do not substitute a mock result for native proof.

These are implementation/release checks, intentionally open during planning.
