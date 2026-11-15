# W03 — Implement current-user Windows security and native adapters

- Status: code-complete / Windows pending; native compilation, approved release inputs and actual acceptance remain unrun.
- Code dependencies: [W02](W02-shared-core-and-contracts.md).
- Accepted scope points: P02, P20, P22, P28.
- Execution phase: A — implement now once authorized; native checks later.
- Evidence: [requirement-by-requirement source ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md) plus dated historical records below.

Implementation has been explicitly authorized and source checks executed. This ledger is source-only: no Windows compiler, install, signing, Chrome/GPU/device or live release operation ran. Checked source rows below cite the actual production chain and portable proof; all native acceptance rows stay open.

## Existing behavior and design consequence

The existing Windows private-data policy admits LocalService/SYSTEM/Administrators, not the consumer's SID. POSIX modes and UID ownership cannot establish Windows privacy. Electron account encryption alone cannot serve an independent fleet process.

## Read before editing

- [worker/src/platform/windows/private-data.ts](../../../worker/src/platform/windows/private-data.ts)
- [worker/src/platform/windows/native-service.ts](../../../worker/src/platform/windows/native-service.ts)
- [worker/engine/musicmute_engine/windows_guardian.py](../../../worker/engine/musicmute_engine/windows_guardian.py)
- [chrome-extension/src/companion/process-start.ts](../../../chrome-extension/src/companion/process-start.ts)
- [chrome-extension/macos/DesktopAuth.swift](../../../chrome-extension/macos/DesktopAuth.swift)

Also read [architecture](../ARCHITECTURE.md), [AI handoff](../AI-HANDOFF.md),
[validation](../VALIDATION.md), and the affected component instructions/manifests.

For the sequential execution order, checkbox rules and current partial-source gaps, read [execution plan](../EXECUTION-PLAN.md), [feature acceptance](../FEATURE-ACCEPTANCE.md) and [resume gaps](../RESUME-GAPS.md).

## Implementation checklist

- [x] Implement a narrow native helper boundary for current SID/session/native architecture, process creation identity, explicit ACLs, local named pipes, Job Objects and current-user credential encryption. Reuse suitable existing native code; otherwise implement the C++ Win32 source/build files described in ARCHITECTURE.md. **Source proof: N-wire** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w03-security-and-native-source)).
- [x] Create and validate current-user data directories and pipe DACLs without broad Everyone/Users access. Reject remote pipe clients, unauthorized peers, instance squatting and unexpected owner/session identities; distinguish service-profile ACLs from consumer ACLs. **Source proof: N-path** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w03-security-and-native-source)).
- [x] Provide separate account and fleet vault namespaces with atomic writes, versioned records, bounded recovery and explicit unavailable/corrupt-vault errors. Do not store plaintext fallback credentials or promise protection from all same-user processes. **Source proof: N-vault** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w03-security-and-native-source)).
- [x] Use fixed native operations and argv-safe process creation; never accept arbitrary shell commands. Bind process ownership to SID/session/PID/creation time and a nonce. Terminate only owned child trees with Job Objects. **Source proof: N-job** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w03-security-and-native-source)).
- [x] Validate app-owned paths against reparse-point escape, alternate streams, unsafe replacement and case collisions before extraction, credential writes, cleanup or update. Handle Unicode and spaces without shell interpolation. **Source proof: N-path** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w03-security-and-native-source)).
- [x] Implement the full native source plus Windows test harness now; provide injected fakes solely for Mac code tests, never production success stubs. Record any unavailable native compiler/linker as a pending Phase B check. **Source proof: N-build** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w03-security-and-native-source)).

## Code validation checklist

- [x] Test SID/ACL policy construction, rejected owners, pipe authentication, replay/oversize/timeout handling and all native result/error mapping with fake adapters. **Source proof: N-wire** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w03-security-and-native-source)).
- [x] Portable-fault-test vault failure/corruption mapping, helper version mismatch, unsafe path policy, PID reuse and child shutdown escalation without installed state; provide actual vault/path/Job fault CTest source for the deferred Windows run. **Source proof: N-vault** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w03-security-and-native-source)).
- [x] Compile/typecheck every host-buildable wrapper and check that secret fields never reach renderer/log/export serializers. **Source proof: N-wire** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w03-security-and-native-source)).

The checked fault-test row has portable corruption/version/path/PID/timeout
coverage. Actual DPAPI atomic commit failure and Job Object descendant termination
have an isolated native CTest harness, which has not compiled or run on this Mac.

## Windows acceptance — deferred until W34

- [ ] Prove ACLs and DPAPI using two real standard-user contexts, pipe remote/foreign-peer denial, junction/reparse attacks and real process identity.
- [ ] Compile/link/run the helper and verify Job Object child cleanup on crash and logout, with no UAC prompt or orphan FFmpeg/Python process.

## Detailed AI-agent handoff — reviewed 2026-10-09

### Current source review and native gate

The per-requirement source ledger and final 2026-10-10 supplement below supersede the initial review-needed checkpoint. Fixed-role launch, current-user vault/ACL operations, authenticated two-step pipes, GPU inventory/guards, independent guardians, startup/browser registration, update primitives and exact cleanup receivers have source review and portable proofs. These checks do not certify a working Windows binary; native compilation and acceptance remain open.

Read [native source](../../../worker/native/windows-consumer/), [SDK](../../../worker/src/platform/windows/consumer-native.ts), [transport](../../../worker/src/platform/windows/consumer-native-transport.ts), and [native build gate](../../../windows-desktop/scripts/native-check.mjs). Preserve the existing legacy-service adapter; the consumer profile is explicitly `windows-user`.

### Component boundaries

| Component                | Responsibility                                                                     | Required boundary                                                                |
| ------------------------ | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Native helper            | Win32 identities, ACLs, DPAPI, fixed named objects, handles and exact owned Jobs   | No arbitrary executable, command, registry key or object-name API                |
| TypeScript SDK/transport | Strict request/result parsing, pinned helper bytes, bounded lifetime/error mapping | No success fallback when the helper, OS or proof is unavailable                  |
| Session agent / W10      | Personal/fleet authority and persistent session lifetime                           | UI helper closure must not terminate the independent session agent               |
| GPU broker / W11         | Logical scheduling and verified handover                                           | Physical mutex ownership belongs to the role guardian; no second competing mutex |
| Prepare/update/installer | Signed inventory, approved operation/configuration and activation policy           | Native path validation does not replace signature or business authorization      |

### Ordered implementation/review sequence after authorization

- [x] Review the operation allowlist and schemas first; update the SDK, native parser and fixtures together. Keep commands at 4 KiB, replies at 32 KiB and helper frames at 64 KiB unless a measured requirement changes the contract. Reject duplicate keys, malformed UTF-8, unknown fields, invalid numeric ranges and unsafe errors. **Source proof: N-wire** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w03-security-and-native-source)).
- [x] Validate native AMD64 independently of the process architecture, minimum Windows 10 build 19045, actual interactive SID/logon/session and elevation policy. Accept real local/domain/Azure AD user identities; deny service identities, ARM emulation and unsupported hosts before mutation or launch. **Source proof: N-identity** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w03-security-and-native-source)).
- [x] Review private directory/file/pipe DACLs, owner checks and canonical path/handle validation. Deny remote clients, reparse traversal, alternate streams, hardlink substitution, reserved names and case collisions. Retain validated ancestor handles during the operation rather than trusting an earlier path check. **Source proof: N-path** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w03-security-and-native-source)).
- [x] Review atomic versioned DPAPI records for separate account and fleet namespaces. Flush encrypted staging, commit atomically and bound stale recovery. Missing, corrupt and inaccessible records remain distinct; no plaintext fallback or automatic adoption of legacy service credentials. **Source proof: N-vault** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w03-security-and-native-source)).
- [x] Complete authenticated `pipeAccept` → dispatch → one-use `pipeReply`/close. Bind capability, timeout, peer PID/creation time/SID/session, channel and nonce; send a state-changing reply only after dispatch completes. ACK loss must not cause an unbounded replay or a second mutation. **Source proof: N-pipe** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w03-security-and-native-source)).
- [x] Keep long `pipeConnect` exchanges concurrent while mutex/guard operations retain their owner thread. Bound pending threads/handles. Test event waits alongside cancel/stop, ticket discovery and normal commands without changing the original caller's identity. **Source proof: N-pipe** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w03-security-and-native-source)).
- [x] Review suspended fixed-role Node launch and assign all required Job Objects before resume. Fixed entries are `agent/session-agent.cjs`, `personal.cjs`, `fleet.cjs` and `prepare.cjs`, with `runtime/node/node.exe` under the verified release root. Capture and remove ownership environment secrets before launching tools; emit exactly one final environment-block terminator. **Source proof: N-job** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w03-security-and-native-source)).
- [x] Finish the independent Job guardian and whole-tree exit certificate. A Node exit, helper transport closure, PID absence or process-name match cannot authorize descendant cleanup, GPU release or scratch deletion. Record the exact owner nonce, SID/session and PID/creation identity; certify only after the exact Job has zero active processes. **Source proof: N-job** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w03-security-and-native-source)).
- [x] Review the independent GPU keeper/watchdog protocol with W11. Bind a guard to the exact role Job or prelaunch Prepare Job before inference; retain the named mutex object while any accepted descendant survives a keeper crash. Treat abandoned ownership without trusted prior-tree proof as busy. **Source proof: N-gpu** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w03-security-and-native-source)).
- [x] Audit fixed mutex scopes separately: SID-wide session/account/activation exclusion with logon-bound IPC, Prepare/acquisition/cache/metadata serialization across the current SID's sessions, and GPU contention across users. Private IPC/data never receive the public contention ACL used only for the GPU mutex. **Source proof: N-lock** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w03-security-and-native-source)).
- [x] Review later fixed startup, Chrome registration, Authenticode installer and unused-release cleanup operations with W26/W29/W31. `waitProcessExit` proves one process exit only; it must not be substituted for `ownedTreeExited`. **Source proof: N-later** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w03-security-and-native-source)).
- [x] Reserve a final review for handle inheritance, bounds, RAII cleanup, timeout/error exits and DLL search/environment rules. Missing native compilation remains a visible prerequisite for Windows acceptance, not a production success stub. **Source proof: N-build** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w03-security-and-native-source)).

### Failure and race cases to implement as tests

| Trigger                                                                             | Required result/proof                                                                     |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Foreign pipe instance or same PID with a different creation time                    | Deny before dispatch; do not terminate the foreign process                                |
| Native child server is a descendant helper rather than its owning Node PID          | Verify exact Job membership/owner receipt; PID equality alone is insufficient             |
| Vault write interrupted before/after rename, corrupted ciphertext or future version | Preserve last committed record or return bounded recovery/corruption error                |
| Junction/ADS/hardlink swap between validation and write/delete                      | Refuse or operate through retained validated handles; no escape from the owned root       |
| UI exits while the session agent is running                                         | Close only UI-owned transport; fleet/session lifetime remains independent                 |
| Role Node/helper/keeper/watchdog fails with Python or FFmpeg alive                  | Stop only the exact owned Job; hold/poison GPU admission until trusted zero-process proof |
| Two helpers hold a global mutex handle and its owner dies                           | Abandonment alone must not grant a new inference lease                                    |
| 20-second event wait plus cancel and oversized multi-job reply                      | Cancel remains responsive; bounded replies fit the agreed frame limit                     |
| Cleanup races with another launch or encounters an unknown/open file                | Preserve the release and report cleanup pending; never broaden deletion scope             |

### Code-only validation and deliverables

- [x] Run focused SDK/transport fixtures using injected native adapters, including all new operations and cancellation/closure races; then worker typecheck and scoped lint/format checks. Portable fakes prove policy/error mapping, not real Windows ACL/DPAPI/Job behavior. **Source proof: N-wire** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w03-security-and-native-source)).
- [x] Run the portable C++ JSON parser test; label it as parser compilation only. Review CMake dependencies, output paths, `asInvoker` and x64 flags without claiming an MSVC build. **Source proof: N-build** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w03-security-and-native-source)).
- [x] Provide isolated CTest fixtures that never touch installed data: private temporary vault/path attacks, foreign peer, suspended child assignment, descendant cleanup and GPU keeper/watchdog failure, plus separate manual confirmed/cancelled-logout scenarios. OS logout delivery is not simulated as native CTest success. **Source proof: N-build** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w03-security-and-native-source)).
- [x] Deliver an operation/schema inventory, required runtime libraries/build flags, ownership/handle diagram, exact commands/results and remaining native checks. Update existing evidence with a new dated record only when future authorized work actually runs. **Source proof: N-wire** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w03-security-and-native-source)).

Historical records include 72 and then 86 SDK/transport fixtures. Newer full SDK/account/boot/installer/login/Share tests now cover the later process-wait/cleanup contracts; exact current commands are in the requirement ledger. No Win32 compile/link or CTest execution has occurred.

### Deferred Windows checks

- [ ] Build x64 with MSVC/CMake and run isolated CTest on the connected standard-user machine before installing the helper. Verify imports, CRT/dependency packaging and native architecture under real Windows.
- [ ] Use two authorized standard users and fast user switching to prove private ACL/DPAPI/pipe denial, global GPU contention, current-SID locks, remote-client rejection and owner creation-time checks.
- [ ] Kill each guardian component separately with live nested children; record Job active-process counts, mutex lifetime and second-process admission. Test logout and simultaneous crash separately; a missing trustworthy proof must remain busy.
- [ ] Exercise real filesystem replacement/open-file/antivirus failures and signed installer verification in temporary profiles before any installed-data cleanup.

### Primary references and their consequence

- [Named-pipe security](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights): avoid generic write permissions that also allow creating a pipe instance; use logon-scoped access and explicit peer checks.
- [CryptProtectData](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata): current-user DPAPI is the credential boundary; do not claim protection from every process under that user.
- [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects): retain exact Job handles and query accounting for whole-tree proof; a missing notification is not proof that an event occurred.
- [Kernel-object namespaces](https://learn.microsoft.com/en-us/windows/win32/termserv/kernel-object-namespaces) and [mutex semantics](https://learn.microsoft.com/en-us/windows/win32/sync/mutex-objects): global mutex contention is feasible without the file-mapping creation privilege, but abandonment is a recovery condition.

## Account-authority native boundary return

- [x] Include fixed signed app proxy/headless launch, original signed parent/ **Source proof: N-trust** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w03-security-and-native-source)).
      PID/birth peer verification and atomic ticket claim in the closed native
      inventory. No arbitrary executable/arguments.
- [x] Retain verified file/ancestor handles through launch; enforce filtered **Source proof: N-job** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w03-security-and-native-source)).
      environment/DLL policy and narrow independent headless lifetime. Same-user
      DPAPI alone does not authenticate caller or installed code.
- [x] Test forged parent, same PID/new birth, stale hash/publisher, concurrent **Source proof: N-trust** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w03-security-and-native-source)).
      ticket use, expiry, duplicate-key JSON and partial replies with portable
      fixtures. Require real WinTrust/Job/pipe enforcement in W34.

## Completion record — historical evidence retained

### Final source-only checkpoint — 2026-10-09

- [x] Implement narrow SDK/private frames and portable policy fixtures for exact signed login lineage, retained shim, closed capsule, fixed session/Prepare tree proof and lease publication/retention.
- [x] Complete Desktop/Worker typechecks and focused source/package fixtures recorded in [audit evidence](../evidence/W03-W31-W33-2026-10-09-audit.md); Root whole Desktop checkpoint passed 1,424 tests / 174 files.
- [ ] Compile/link/run native fixtures and validate actual WinTrust, witness, Job/controller retirement, temporary cross-logon ownership, pipe peers and Share callbacks on connected Windows.

The isolated native fixture injects authentication only in its test target; it is not a production bypass or proof of a signed installed shim.

Later source audit: [2026-10-09 native/package audit](../evidence/W03-W31-W33-2026-10-09-audit.md)
records 126 portable SDK fixtures, strict PE/XML trust, sorted environments,
Share callback/source lifetime changes, fixed installer directory retention and
the volatile user-hive witness. These supersede the earlier source count, without
claiming MSVC/WinRT/WinTrust/NSIS or connected Windows proof. The witness is not a
BCD/kernel GUID; cached installed trust retains revocation checks and never
authorizes a new installer/package.

Historical initial boundary checkpoint: `worker/native/windows-consumer/`, SDK/transport
and portable parser sources passed 72 TypeScript fixtures and Worker type/lint/format.
That dated source result is retained in [W03 original evidence](../evidence/W03-native-boundary.md).
The expanded current integration and per-requirement proofs supersede its earlier
“review needed” state. CMake/MSVC/CTest, actual two-user ACL/DPAPI, remote/junction,
crash/logout and signed packaging are still unrun.

Task/index/progress reconciliation is Root-owned; this task’s source proofs are recorded individually above. Use `code-complete / Windows pending` only when
the required source work and executable code checks are complete; unavailable
native compilation remains explicitly recorded. Do not claim a release from
fixture or source-only proof.

## Requirement ledger return — 2026-10-09

Every source/code checklist above cites the production-entry, resource/authority,
actual implementation, portable test and native-only gate in [W03 security and native source](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w03-security-and-native-source).
Historical checked evidence is retained with its date. Current native compiler,
registry/PE/Job/Chrome/GPU/logon and signed candidate checks remain unrun.

## Final source closure supplement — 2026-10-10

The [latest receiver ledger](../evidence/W22-final-native-library-cleanup-2026-10-10.md)
records current Native Source digest
`64699a82b582061626a2fac619d8f35a9d2ac14c63e93839bd26fdbd208234fd`,
current executed source checks and the remaining native gates. Historical
`2399865...`, `3bf83...` and `64714e9f...` checkpoints retain their date and do
not cover later changes. Source/test-source receipt is separate from compiling
C++ or installing a signed candidate. No Windows checkbox is promoted.

The closed Native authorities now cover fixed cache eviction; protected Share/report
retirement; exact created-export preflight/discard/ACK; fixed runtime-quarantine
cleanup; pure copier partial/whole-Job marker metadata; and Library publication,
local tombstone moves, exact inventory/disposition and bounded ACK recovery.
Each validates its own source record/peer/lease/birth and excludes unrelated
paths; there is no general filesystem/shell/delete endpoint. SDK optional fixture
ports fail closed for byte effects; actual Main/roles consume WindowsConsumerNative.
Same-SID duplicate owned mutex acquisition yields contention. Win32 tests include
real isolated held-object, reader, registry, Job/GPU keeper/watchdog and QA
descendant sources; all those C++ targets remain uncompiled/unrun.
