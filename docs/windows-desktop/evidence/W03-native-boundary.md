# Evidence: W03 — Windows consumer native boundary

- Date: 2026-10-09.
- Scope: new consumer native/security source only; existing LocalService behavior unchanged.
- Source set SHA-256 before evidence formatting: `05d26aeeb74325e5f0ff4f9f6a0f3f1c59090d0d4eced6fdea79fd18da4b8f7b` (sorted native source files, consumer-native TypeScript, focused tests and parser script, with path/NUL/content/NUL framing).
- Host: macOS; Node `24.18.0`, pnpm `10.14.0`, installed Vitest `4.1.11`, Apple clang++ and component TypeScript/oxlint/Prettier.
- Status: code-written / checks pending — all host-executable checks passed, native compile and native fault checks pending.

## Source

- [Native helper and CMake/CTest sources](../../../worker/native/windows-consumer/README.md): current SID/logon/session/OS/architecture; protected current-user roots; locked canonical ancestors; fixed operations; current-user DPAPI with separate account/fleet records, atomic encrypted staging and bounded explicit recovery; first-instance local pipe peer/birth/nonce authentication; fixed-role Job Object launch/stop; session-end window and controller-loss cleanup.
- [Typed adapter](../../../worker/src/platform/windows/consumer-native.ts), [policy](../../../worker/src/platform/windows/consumer-native-policy.ts), [transport](../../../worker/src/platform/windows/consumer-native-transport.ts): native digest requirement, bounded/versioned private IPC, no credential argv or raw stderr forwarding, safe errors and launch inventory authorization.
- [Policy and adapter tests](../../../worker/tests/windows-consumer-native.spec.ts), [actual isolated Node transport tests](../../../worker/tests/windows-consumer-native-transport.spec.ts), [portable C++ parser check](../../../worker/scripts/consumer-native-json.test.mjs).

## Executed code checks

All commands ran from `worker/`:

| Command                                                                                                                                                                              | Result                       | Scope                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------- | ----------------------------------------------------------------------------- |
| `pnpm exec vitest run tests/windows-consumer-native.spec.ts tests/windows-consumer-native-transport.spec.ts`                                                                         | Exit 0; 72 passed, no skips. | Injected native adapter policy plus actual isolated Node fixture processes.   |
| `node --test scripts/consumer-native-json.test.mjs`                                                                                                                                  | Exit 0; 1 passed, no skips.  | Compiles/runs strict portable C++ parser using clang++; no Win32 compilation. |
| `pnpm exec tsc --noEmit`                                                                                                                                                             | Exit 0.                      | All current worker TypeScript, including new wrappers/tests.                  |
| `pnpm exec oxlint --deny-warnings src/platform/windows/consumer-native*.ts tests/windows-consumer-native*.spec.ts scripts/consumer-native-json.test.mjs`                             | Exit 0.                      | Changed source/test/script lint.                                              |
| `pnpm exec prettier --check src/platform/windows/consumer-native*.ts tests/windows-consumer-native*.spec.ts scripts/consumer-native-json.test.mjs native/windows-consumer/README.md` | Exit 0.                      | Formatting of changed host code and native contract documentation.            |

The initial fixture run caught invalid newline escaping in synthetic child code;
it was corrected with raw templates and the complete focused suite reran. The
first lint run caught an intentional control-character regex and precision-loss
literal; both were replaced without weakening the checks.

## Pending native acceptance

- CMake/MSVC SDK compilation/link and `ctest -C Release --no-tests=error` on an interactive Windows x64 standard user. Source includes real isolated ACL/DPAPI/atomic-write/pipe/Job Object tests; this Mac cannot execute them.
- Two distinct real standard-user accounts: foreign owner/pipe/vault denial, remote pipe denial and same-user/session peer mismatch.
- Actual junction/reparse replacement attacks, native canonical case handling and file-sharing behavior.
- Helper crash/stdin closure and actual Windows logout/shutdown: accepted child/descendant cleanup, no orphan engine/decoder and no UAC prompt.
- Signed `windows-user` inventory packaging and root consumer launch/broker integration. No compiled native executable or release was produced here.

## Continuation

Implementation checkboxes close source work only. The native atomicity and owned
descendant fault-test portion remains unchecked because CTest has not run. The
release layer must supply a verified inventory/digest and fixed agent bundles;
the app/agent must keep secrets in trusted main processes and provide business
authorization above the one-transaction pipe primitives. Continue W10 without
waiting for a Windows machine; preserve the remaining W34 checks.

Reviewed current [Zalando guidelines](https://opensource.zalando.com/restful-api-guidelines/)
on 2026-10-09 for portable security/JSON/error rules 104, 105, 106, 118, 167 and 177. REST URLs/HTTP/OpenAPI endpoint semantics do not apply to this private native
IPC contract.
