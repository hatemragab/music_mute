# W33 final safe Worker source checks

Executed on the existing macOS host after the Worker SDK/TypeScript receiving
source freeze. Node24.18.0 and pnpm10.14.0 match the component's declared tools.
Root/component instructions, Worker README/RELEASING, manifests, build/protocol/
package scripts and test configuration were read before execution. No dependencies
were changed and no implementation repair was needed for these checks.

## Commands and observed results

All commands ran from `worker/`.

| Command                       | Actual result / boundary                                                                                                                                                                                                                           |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm run protocol:check`     | PASS; canonical backend protocol matches the generated Worker copy. No synchronization or wire edit ran.                                                                                                                                           |
| `pnpm run typecheck`          | PASS; strict whole Worker TypeScript, no emit.                                                                                                                                                                                                     |
| `pnpm run lint`               | PASS; full source/tests/protocol/scripts lint, deny warnings.                                                                                                                                                                                      |
| `pnpm run format:check`       | PASS; every supported component file matches existing Prettier style. No broad formatting mutation.                                                                                                                                                |
| `pnpm test -- --maxWorkers=2` | Start 04:15:30; 44.22s; **1,006 passed / 21 skipped**, 112 passed / 5 skipped files (117 total; 1,027 declarations). pnpm forwarded `vitest run -- --maxWorkers=2`; the worker limit is not claimed as applied. All files ran. Skips remain below. |
| `pnpm run test:packaging`     | **16/16 PASS, 0 skips; 1.166s.** Strict package policy, synthetic loopback service/transfer/completion fixtures and consumer recipe checks. The portable C++ JSON parser compiled/executed on macOS; no Win32 source was compiled.                 |
| `pnpm run prepack`            | PASS after the final SDK freeze; actual source build and dry npm package inventory/secret-pattern checks: **432 files, 557,738 compressed bytes**. Only generated `dist/` is replaced after unsafe-link checks. No package publication.            |

The npm dry inventory emitted warnings about inherited pnpm configuration-option
names; it exited zero and verified inventory. They are tool deprecation warnings,
not causal Windows source failures. No configuration or unrelated dirty source
was changed to silence them.

## Exact skipped and omitted boundaries

| Existing conditional cases                                                 | Count | Why unrun here                                                                                          |
| -------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------- |
| `windows-operation-recovery.spec.ts`                                       | 11    | Native Windows legacy operation/SCM/private-file recovery requires Windows.                             |
| `local-runtime-status.windows.spec.ts`                                     | 2     | Actual Windows file-sharing semantics.                                                                  |
| `windows-private-data.spec.ts`                                             | 1     | Real NTFS/Windows ACL checks.                                                                           |
| `windows-service-stop.integration.spec.ts`                                 | 1     | Windows and an explicitly supplied WinSW fixture; no SCM/elevated service action authorized or enabled. |
| `macos-launch-agent.integration.spec.ts`                                   | 2     | Existing live launchd opt-in remains disabled; no installed/test service was started.                   |
| Windows-only cases in `native-lock.spec.ts`                                | 2     | Actual Windows lock/PowerShell behavior.                                                                |
| Windows-only case in `macos-user-benchmark.spec.ts`                        | 1     | Windows refusal of POSIX benchmark launch.                                                              |
| Supplied signed-service-payload case in `app-installation-binding.spec.ts` | 1     | Existing explicit packaging-payload opt-in was not supplied/enabled.                                    |

These21 existing cases were not replaced with passing stubs or new broad skips.
Other legacy Mac binding tests use explicit disposable layout/host authority;
where applicable their existing approved model is borrowed read-only into the
fixture. No genuine inference or prepared model/runtime modification ran.

The optional `scripts/test-package.mjs` packed-CLI consumer install/help/version
probe was **omitted**: its current script replaces `HOME` in the child environment,
which the coordinator explicitly forbids for this phase. Required packaging
fixtures, source build and dry inventory still ran. This evidence therefore does
not claim isolated installed-CLI smoke or a dependency registry audit.

Root separately executed the [real pinned frontend/engine return](W07-pinned-frontend-code-checks-2026-10-10.md):
10/10separator checks and131engine declarations /130passed /one existing Windows
Job skip in a disposable declared environment. That engine run was not duplicated
here. Neither run loads a real model or invokes ORT Run/GPU inference.

## Native receiving and historical checkpoints

The earlier 03:17:10 whole checkpoint was 1,004 passed / 21 skipped (78.68s),
with packaging 16/16 (1.522s) and dry inventory 432 files / 555,801 bytes. It
predates the final native SDK additions and is retained as historical evidence.
Root refreshed protocol, whole typecheck, lint and formatting after that SDK
freeze, then ran the current whole tests, packaging and prepack results above.

Current uncompiled native source digest:
`64699a82b582061626a2fac619d8f35a9d2ac14c63e93839bd26fdbd208234fd`.

Native's earlier C++ review found that normal personal workspace-marker retirement
must accept only the exact bound role owner plus a positive `gpuRoleIdle` census;
requiring full-role retirement would block completed jobs while their trusted
Node/helper lives. Unbound/restart cleanup must still require the durable exact
whole-Job-zero certificate. That native receiving correction has its own W03/W22
review. The current portable SDK checks cover the frozen source but do not compile
or establish its effect, and do not close aggregate W12 by themselves.

The [W11/W12 matrix](W11-W12-current-admission-and-personal-closure-2026-10-10.md)
also records the new GUID-only GPU keeper CTest source/CMake target. Unsafe
DACL/type squatting, current/foreign ACE policy, watchdog-first and two lost
guardians with a surviving production watchdog are written assertions, not
executed native results. Every actual Windows/GPU/ACL/registry/logon/Share/Job/
installed candidate/codec/listening/live-account/publication acceptance remains
unrun W34. No worker start, installed runtime/service change, model download,
live job, enrollment, private credential mutation or publication ran in this return.
