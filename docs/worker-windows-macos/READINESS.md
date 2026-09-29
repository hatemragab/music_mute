# Windows and macOS CLI readiness

Snapshot: 2026-09-29. The [implementation ledger](IMPLEMENTATION.md) contains
artifact identities, commands, reports and historical failures. This page records
the completed development/native acceptance scope and its operational limits.
SSH is reachable at `192.168.1.124`. Publication and production integration are
not included in this acceptance.

## Shared architecture

The existing Node supervisor remains the owner of authentication, backend
reconciliation, leases, transfers, local lifecycle and diagnostics. The Python
engine remains the owner of media validation, model inference, encoding and
output validation. Each worker slot has its own child process and inference
session. Credentials stay in the supervisor and do not enter the engine pipe.

| Layer                                                         | Source                                                                         | Platform boundary                                     |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------- |
| CLI entry and routing                                         | `worker/src/cli/main.ts`                                                       | Selects the native command adapter                    |
| Operator reports, update signatures, drain and capacity rules | `worker/src/platform/shared/`                                                  | Shared behavior and data contracts                    |
| Supervisor, leases, transfers and process lifecycle           | `worker/src/runtime/`                                                          | Shared runtime with native containment and locking    |
| Processing and repeated capacity measurement                  | `worker/engine/musicmute_engine/`                                              | Common recipes; MPS on Mac, DirectML on Windows       |
| macOS integration                                             | `worker/src/platform/macos/`                                                   | Per-user launchd, paths and permissions               |
| Windows integration                                           | `worker/src/platform/windows/`, `worker/scripts/windows-service-functions.ps1` | LocalService/SCM, ACLs, named-pipe locks and recovery |

Ubuntu remains a future native adapter. No Ubuntu runtime or GPU support is
claimed by this work. The shared supervisor and engine are retained so that an
Ubuntu adapter does not require another application core.

## Evidence by requirement

| Requirement                                      | Verified evidence                                                                                                                                         | Remaining scope                                                                            |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Extend the current CLI in the existing workspace | Shared implementation and native adapters; no separate Windows checkout                                                                                   | Fresh-consumer package smoke and native command audit passed                               |
| Native Windows release                           | Candidate `.14` built with verified private dependencies and 18,742 manifest entries                                                                      | Signed update, headless processing and recovery passed                                     |
| Native macOS behavior                            | Installed `.2`; signed update, launchd teardown, two-worker MPS qualification and actual jobs passed                                                      | Full integrity checks passed; intentionally unloaded                                       |
| Two Windows workers                              | Installed `.14` passed repeated DirectML qualification; 1.52–1.54x throughput on the canonical fixture                                                    | Two slots activated; 600-second two-job/drain/repeated-stop acceptance passed              |
| Two Mac workers                                  | Installed `.2` retains two qualified slots; approximately 1.20x measured throughput gain                                                                  | Receipt expires 2026-10-06T07:00:58.096Z                                                   |
| Preserve audio quality                           | Eighteen decoded comparisons passed per platform; DirectML comparisons were equal and MPS differences stayed within the existing limits                   | Fresh `.14` comparisons passed; short-fixture results are not universal quality guarantees |
| Graceful lifecycle                               | Native Mac drain observed with two active attempts; Windows source checks cover fresh identity, stale snapshots and queued restart races                  | `.14` active-job drain, repeated stop and interrupted-stop recovery passed                 |
| Failure isolation                                | Mac corruption rejection and 600-second cancellation isolation passed; earlier Windows candidate covered corruption/cancellation                          | `.14` corruption and cancellation isolation passed                                         |
| Update integrity and recovery                    | Packaged `.11` passed signature, checksum, rollback, quarantine, sequence and policy checks; final native source tests cover the corrected drain ordering | Installed `.14` interruption/repeated recovery passed                                      |
| Unattended Windows operation                     | Native LocalService service execution; automatic-start configuration checked previously; current AC sleep timeout disabled                                | Fresh `.14` boot and two-job processing passed without sign-in                             |
| Regression checks                                | Corrected source: 529 macOS-host passes/17 skips; 402 native Windows passes/144 skips, including real sharing and SCM fixtures                            | Any further source changes require appropriate revalidation                                |
| Clean obsolete installations                     | Original retired Windows versions `0.1.0`–`0.1.3` and their documented old scope were removed                                                             | 29 obsolete paths removed; protected hashes preserved; only candidate 14 remains           |

The current Windows installation is `.14`. Its packaged signed update passed,
preserving private identity, lifecycle and the original SCM policy. The service
was verified stopped/manual with PID zero and no pending recovery journal.
The test trust and sequence records were removed. Capacity correctly reset to
one slot because the manifest changed. Fresh two-worker qualification passed;
two slots were activated and read back, with receipt expiry
`2026-10-06T09:40:11.544Z`.

The later boot fixture temporarily configured automatic startup and requested a
normal reboot. SSH later returned at `.124`, with the same pinned host key and
hostname. Live readback found a signed-in interactive user, so that boot cannot
pass the no-sign-in fixture. The saved fixture is
`service/boot-acceptance-c5562fe1-2ce5-4e94-91ab-09677d116362/`; its explicit
restoration passed. The saved Wi-Fi profile supports automatic connection for
all users, SSH starts automatically and listens on all interfaces, and automatic
interactive sign-in is disabled. A fresh controlled restart passed with no signed-in user and two ready slots,
using `service/boot-acceptance-c969e4f1-cb0f-4ab9-b584-cd13b0d29bd5/`. Restoration
also passed. The separate signed-out processing test passed: both 120-second outputs completed,
all nine processes ran in Session 0, and drain/repeated stop plus restoration passed.
Allowlisted obsolete candidate cleanup passed for all 29 reviewed paths.
Only candidate 14 remains in installed releases and versioned build directories;
protected configuration, credentials, receipt, service and artifact hashes matched.

Candidate `.13` long-job acceptance exposed the status-file sharing failure fixed
in `.14`; its earlier benchmark does not qualify the new manifest. Candidate
`.12` was built but not installed and must not be promoted.

The Mac is left unloaded after controlled tests. Its original configuration,
credential and plist were restored. The macOS implementation is the existing
logged-in-user LaunchAgent; it is not a system daemon.

## Final acceptance

1. Completed: `.14` packaged update, cleanup, policy and installed identity verified.
2. Completed: fresh `.14` benchmark, capacity-two activation and readback.
3. Validate the installed status-file sharing correction.
   Completed: two 600-second synthetic Windows jobs, drain during work, validated
   outputs and repeated stop. Corruption and cancellation isolation passed. Installed interruption and repeated recovery passed.
4. Completed: Windows boot startup without sign-in, the Session 0 process tree
   and restoration. The additional signed-out two-job processing test also passed.
5. Completed: final manifests, private state, command/package checks, native
   restart-budget reset, obsolete candidate deletion, preserved-file hashes and
   final inventory. No pending recovery journal remains.

Native job tests use a synthetic loopback control plane and storage. They exercise
the real worker, GPU and transfer paths, but do not establish production backend,
S3 or enrollment readiness. Publication and production permission changes remain
outside the authorized scope. The current Windows power plan is Power saver;
subsequent benchmark evidence should record that condition. No power setting was
changed by the read-only inspection.

## Operational handoff

SSH is reachable at `hatem@192.168.1.124`. Windows uses its installed private
runtime; the npm `mw` command is not installed globally. Invoke the private CLI:

```powershell
$root = 'C:\ProgramData\MusicMuteWorker'
$active = Get-Content "$root\state\active-release.json" -Raw | ConvertFrom-Json
$release = Join-Path "$root\releases" $active.releaseVersion
& "$release\runtime\node\node.exe" "$release\app\dist\src\cli\main.js" --version --json
```

Windows retains its synthetic loopback acceptance pairing and is stopped/manual.
macOS retains its original private pairing and is unloaded. Automatic Windows
startup was verified using a temporary automatic policy, then the original policy
was restored. These machines are not being presented as a running production fleet.

The installed Windows full doctor passed thirteen checks; macOS passed twelve.
Both returned only the expected `SERVICE_NOT_RUNNING` failure. Final Windows
version reporting confirmed CLI `0.1.0-rc.1` and runtime `.14`. The final npm
package passed inventory, fresh-consumer smoke and production dependency audit;
see the ledger for `/tmp/musicmute-cli-handoff-package/` and its digest.
Local typecheck, lint, protocol synchronization, formatting and diff checks passed.
Final cleanup readback and consolidated requirement audit passed. The final CLI
tarball SHA-256 is
`41a34b7e0df945bbafb631d89c469f3c1894a7900460a05231ba489b41fc1adb`.
No commit, push, publication, production enrollment or production permission change
was performed. Passing these finite checks does not imply universal reliability
or audio-quality guarantees for every input.
