# Connected Windows target and fixture specification

Prepared as source on 2026-10-10. Every installed/native observation below is
pending W34. This specification creates no Windows machine, account, media,
installation or release artifact. The runner's planning mode remains code-only.

## Target matrix

Record one actual target descriptor per OS/GPU/driver/candidate combination.
Use the existing [strict target schema](plan.ts) and [runner](README.md). Obtain
OS/native architecture and DXGI identity from actual native observations; fill
candidate hashes from reviewed artifacts. Descriptive labels are not evidence.

For the first isolated `native-build` / `native-security-fixtures` run before a
candidate exists, use the exact version-2 `scope:'isolated-native'` target in
[the runner guide](README.md), with genuine OS/source identity and `gpu:null` or
the actual full DXGI identity. Omit `package` entirely. All installed/manual
journeys stay `candidate-required`; no claimed pass for them can be imported on
that target. The original version-1 candidate schema still requires every actual
candidate hash, and cannot inherit native-only evidence under a different target
fingerprint.

| Dimension   | Required recorded target or scenario                                                                                                                                                |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Minimum OS  | Windows 10 22H2, workstation build 19045, native/process x64.                                                                                                                       |
| Windows 11  | The supplied Windows 11 workstation build, native/process x64. A result does not carry to Windows 10.                                                                               |
| Unsupported | Earlier Windows, x86, native ARM with x64 emulation, and Server refusal. Portable fixtures precede any separately authorized available native target.                               |
| GPU         | Actual eligible NVIDIA, AMD and Intel examples when supplied; physical LUID, vendor/device IDs, driver and selected ordinal. Unavailable vendors remain uncovered.                  |
| Contention  | Same-session personal/Chrome/fleet, simultaneous same-SID logons, separate SIDs and another application using the physical GPU. Do not create users/sessions without authorization. |
| Fresh user  | A designated standard-user profile without preinstalled developer tools or global runtime prerequisites. No UAC requirement.                                                        |
| Candidate   | App version/numeric build, payload and installer hashes, signed consumer runtime/manifest/model/fixture identities, publisher and current native source digest.                     |

No VM, replacement machine, GPU driver, compiler or SDK is provisioned by this
plan. Native build/CTest uses existing approved tools plus the separately built
and approved QA tool guard described in [the runner](README.md); its bootstrap
must precede the first automated compiler action. Keep unsupported or
unavailable matrix entries pending rather than inferring a pass from another
target.

## Fixture inventory

Create fixtures only within a later authorized disposable acceptance workspace.
For each record a safe fixture ID, byte count, SHA-256, format/duration and the
rights/authorization basis. Keep raw paths and identities outside exported reports.

| Fixture group     | Required data and use                                                                                                                                                                                                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GPU qualification | The exact approved [preparation fixture](../src/main/prepare/fixture.ts), model, recipe and signed consumer runtime. Inspect actual inference placement and output; provider availability alone is insufficient.                                                                   |
| Local media       | Authorized speech/music audio and audio from each supported video container; Unicode/Arabic and long filenames; corrupt, empty and unsupported inputs. Preserve originals and record source/output hash correlation.                                                               |
| Duration          | Inputs below, exactly at and above 1,200 seconds; Chrome saved auto limits at 1 and 20 minutes with below/equal/above boundary inputs, paused playback and saved automatic-off state.                                                                                              |
| Listening         | Full timeline, a verified trimmed voice with a trusted map, valid standalone trimmed voice without a map, quiet speech edges and all-silent/all-audible examples. Verify original/output coordinates, rates, AB, timer, queue and bookmarks audibly.                               |
| Storage           | Disposable owned voices, originals, scratch and partials; live pins and durable outbox copies; enough data to exercise the selected budget, 256 MiB pending-original cap, low disk and open-file refusal. Never fill the host volume or use real user files as cleanup candidates. |
| Runtime/update    | Approved signed old/new app/runtime/model inputs and disposable copies corrupted at known bytes. Preserve hashes/births at every transfer, WAL, staging, backup, activation and rollback boundary.                                                                                 |
| Chrome            | The same production extension ID/host, a designated Chrome profile and approved public YouTube items. Cover reload/SPA/ads/background, one audible tab, current mode and original browser peer. Do not copy a personal profile.                                                    |
| Accounts          | Designated guest, account A and account B; approved Google/email/linked-method cases, verified/unverified states, expired/revoked sessions and quota/policy boundaries. Secrets stay in the native vault/backend.                                                                  |
| Fleet             | Designated Google/admin eligibility and a separately authorized disposable machine enrollment. Cover running/stopped/paused/draining intent, GUI-absent login and boot/hive-bound installed-only requalification; accepted work without production claims.                         |
| Faults            | Deterministic cancellation, delayed/lost ACK, process/guardian failure, network interruption, missing/corrupt records, changed file/directory birth and denied cleanup. Crash/kill/power/antivirus scenarios need target-specific authorization and bounded safe setup.            |

Account deletion/recovery, logout-all, enrollment/claims, force operations,
revoke/purge, uninstall, low-space setup and publication require their relevant
explicit authorization and disposable ownership. A case being in the manifest
does not perform or authorize it.

## Case and journey evidence

The [manifest](manifest.ts) assigns manual cases to the original accepted point
numbers and owning tasks in [COVERAGE](../../docs/windows-desktop/COVERAGE.md).
`guest-local` proves P08; `gpu-coordination` proves P22; `login-lifetime` proves
P25. Chrome registration is P23, accessibility P24, backend/dashboard P26,
updates P27, security/diagnostics P28, and distribution P29. The corrected case
revisions invalidate older evidence whose case digest has changed.

Before marking a grouped case passed, expand every applicable
[feature journey](../../docs/windows-desktop/FEATURE-ACCEPTANCE.md) and owning
task's Windows checklist into observed subcases. Record initial, loading, empty,
success, failure, offline, cancellation/retry, restart and owner-change branches
where applicable. An unrun required branch keeps the grouped case pending.

Use the strict [evidence schema](plan.ts) with exact target/case fingerprints,
actual observation time, a bounded redacted observation, an independently hashed
artifact and confirmed cleanup. The artifact should list each subcase's safe ID,
expected/actual outcome and whether source/native/live evidence was obtained.
No native pass may be minted from injected ports, planning, a generated EXE,
compile-only output or a previous OS/GPU/candidate result.

Retain failed or unknown cleanup owners and their exact disposable workspace.
Reconcile them before retry or removal. Record unavailable tests and release
inputs separately; do not replace them with successful fixtures.

## Required fault subcases after the final source returns

These are procedures to execute on the connected target, not observed results.
Use only designated disposable files/registrations and exact owned child trees.
Do not mutate foreign bindings, personal profiles or production GPU objects as
an isolated test. The GUID-only CTest validates its isolated seam; real
cross-user/session Global namespace behavior remains separately required.

| Case IDs                                                         | Required observed subcases                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chrome-registration`, `native-peer-isolation`                   | Same bytes/path with a new manifest birth; original-generation reader held; both HKCU views and manifest stage/publish/retire boundaries interrupted; lost commit ACK/restart; stale prefix/receipt preserves every foreign or replacement generation.                                                                                                                                                                      |
| `storage`, `cache-deletion-lost-ack`                             | Private partial and workspace-marker disposal separately from ordinary cache leaves; same-path marker/header/file replacement, unbound live/unknown old Node, child handoff and unknown launch ACK. Normal marker cleanup needs exact bound-role owner plus actual inference/tools idle; restart/unbound callers require whole-Job proof. Lost deletion/certificate ACK retains truthful pins/reservations/idle/free-space. |
| `login-lifetime`, `ipc-event-concurrency`                        | Actual Prepare mutex and every protected `prepare_maintenance` phase versus simultaneous Chrome/login/new-role starts; final authenticated personal activity with no GUI watcher; changed boot/hive triggers installed-only guarded qualification while restoring running/paused/draining and preserving stopped intent.                                                                                                    |
| `gpu-guardian-crashes`, `gpu-coordination`, `gpu-handover-races` | Watchdog-first, multiple guardians, simultaneous loss of all references and logout with live descendants; physical ownership cannot free on unknown cleanup. Separately qualified secondary fleet/primary personal, current approved secondary after reboot and accepted-work handover require their own actual GPU observations.                                                                                           |
| `library`, `native-security-fixtures`                            | WinRT ShareCompleted, ShareCanceled, missing/lost/unknown callback; exact quiesced receipt and unchanged staged-file generation; HWND owner retirement and restart inspection without another Share UI. Keep the source pinned until confirmed completion and cleanup.                                                                                                                                                      |
| `installer`, `fresh-prerequisites`                               | Actual downloaded MOTW/SmartScreen, timestamp/revocation and reputation observations; genuine app-local DLL/notices with no global VC/developer-runtime rescue; ordinary GUI uninstall followed by independent approved-worker next login with retained Run/data/runtime.                                                                                                                                                   |

Expanded procedures are included in the manifest's corresponding case definitions
and revision changes. `caseDigest` hashes that definition; editing only this
document cannot invalidate a prior partial attestation. Keep the manifest and
owning task procedures aligned before planning/resuming evidence.
