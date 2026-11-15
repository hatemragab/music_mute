# Evidence: W27 — Shared browser and trusted Windows authority core

- Date: 2026-10-09.
- Source HEAD: `c0218633c43559c8ad1988e5037273970a91f99b`; shared dirty worktree, no commit created.
- Scoped source fingerprint: `9aa87e3fb3e64e48562ee7e96ff2b0000552b8a4dcdc32b09254808c232bf6c1`.
- Host: Darwin ARM64, Node v24.18.0. These are portable code checks on the Mac.
- Status: partial source / core checks pass; production composition and Windows acceptance remain pending.

## Source and contracts

The fingerprint hashes sorted relative filename plus file bytes for
`chrome-extension/src/extension/{background,content}.ts`,
`chrome-extension/src/shared/strict-json.ts`,
`windows-desktop/src/main/browser/{account-authority,account-bridge,account-contracts,service}.ts`,
`windows-desktop/src/main/session/{personal-owner-proof,backend-origin}.ts`,
`worker/native/windows-consumer/{account_authority.hpp,chrome_host.cpp}` and
`worker/src/platform/windows/consumer-native.ts`.

The browser core reuses the existing manual `/media-imports` client and raw
full-snapshot realtime provider. It requires the sole native account controller,
current saved cloud mode, opaque HELLO scope, usage admission and account generation
before intake and result publication. There is no local GPU/model/Prepare
requirement for explicit Cloud. Browser messages contain no tokens, account UID,
backend grants or local paths. Local lookup/recovery uses a separate guest port;
cache-only recovery does not START or acquire new source media.

`SessionClient.provePersonalOwner` is read-only and requires an existing recorded
owner kind, exact original peer birth, ready job, submitted YouTube identity and
vocals byte/hash declaration. Native fixed peer verification binds the caller to
the current published sole account authority, and verifies either the signed
Chrome proxy parent or the same authoritative desktop app parent. Desktop proof
can inspect guest scope and then only the supervisor's current account scope.
The root publisher must additionally verify the protected full pair/model/recipe
receipt before releasing deferred contribution. Reused community media is never
republished. Matching publication updates use subscriptions.

Native link-import visibility policy has been removed from Chrome discovery/UI.
Shared Mac local intent is preserved; validated Windows x64 HELLO selects the
Windows local provider. Host/provider mismatch fails. Strict bounded JSON rejects
duplicate decoded keys, including escaped aliases, malformed UTF-8 and nonfinite
numbers. Concurrent ticket claims and separate event helpers preserve original
caller identity and keep cancellation responsive.

Session activation reads the existing bounded validated packaged public account
configuration to obtain an optional canonical HTTPS community origin. It is
bound into the protected configuration/bootstrap and reaches the actual personal
factory. Missing configuration preserves local cache; malformed existing
configuration fails closed. This is loader/receipt proof, not signed Windows
package or approved live endpoint proof.

## Exact Chrome executable route

The C++ host launches fixed signed installed `MusicMute Local.exe` as normal
Electron with `--native-browser-stdio --origin <approved extension origin>
--resources <fixed installed resources>`. It does not launch downloaded runtime
Node or set `ELECTRON_RUN_AS_NODE`; the filtered environment excludes it and
`NODE_OPTIONS`. The early main branch must validate `process.resourcesPath` and
call side-effect-free `runBrowserHost` before GUI/singleton/account initialization.
The proxy connects or cold-launches fixed `--headless-account` independently of
its Job/stdio lifetime. `browser-host-cli.ts` is the separate standalone bundle
entry. Its inventory hash alone does not authenticate the embedded main code;
real app/ASAR/fuse/signature enforcement remains packaging/native acceptance.

## Executed code checks

| Command and directory                                                                                                                                                                                                                                                                     | Result                                    | Scope / limit                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test` in `chrome-extension/`                                                                                                                                                                                                                                                         | 2,297 passed, 4 skipped, 79 files, exit 0 | Shared companion/extension source fixtures and synthetic DOM; no Chrome/YouTube/device run.                                                     |
| `npm run lint`, `npm run typecheck`, `npm run build` in `chrome-extension/`                                                                                                                                                                                                               | Passed                                    | Source/lint/bundles; no native app or store delivery.                                                                                           |
| `npx vitest run tests/browser-account*.test.ts tests/browser-provider-service.test.ts tests/session-browser.test.ts tests/session-personal-owner-proof.test.ts tests/session-control.test.ts tests/session-backend-origin.test.ts tests/session-supervisor.test.ts` in `windows-desktop/` | 78 passed, 8 files, exit 0                | Injected account/native/session/media ports, peer/caller-kind/source/cancel/transfer/publication/cache/ticket races and temporary origin files. |
| `npm run typecheck`, `npm run build` in `windows-desktop/`                                                                                                                                                                                                                                | Passed after sibling fixture repairs      | Current source/bundles; no Electron UI or Windows execution.                                                                                    |
| Scoped `oxlint --deny-warnings` and Prettier checks on browser/session/entry/fixture files                                                                                                                                                                                                | Passed                                    | Owned source style and lint; does not certify unrelated dirty source.                                                                           |
| `pnpm exec vitest run tests/windows-consumer-native-account.spec.ts tests/windows-consumer-native.spec.ts tests/windows-consumer-native-transport.spec.ts` in `worker/`                                                                                                                   | 93 passed, 3 files, exit 0                | Injected native operation parsing/policy/transport; no Win32 calls.                                                                             |
| `pnpm exec tsc --noEmit`, scoped SDK lint/format in `worker/`                                                                                                                                                                                                                             | Passed                                    | TypeScript SDK, not native helper compilation.                                                                                                  |
| `node --test scripts/consumer-native-json.test.mjs` in `worker/`                                                                                                                                                                                                                          | 1 passed, exit 0                          | Portable C++ JSON parser only; not MSVC/Win32/CTest proof.                                                                                      |

Earlier failed checkpoints were corrected and rerun: popup synthetic DOM selection,
Mac/Windows HELLO mismatch validation, cache fixture's initial HELLO call count,
Buffer fixture typing and native pin error-code expectation. No earlier failed
run is counted as a pass.

## Remaining composition and acceptance

- Root main must bind the sole account/usage/realtime/mode authority, verified
  media publisher, guest cache/community port and proof-bound publication events.
  Saved-mode changes should call `selectionChanged`; the core ignores unchanged
  mode notifications. Keep missing capabilities unavailable.
- Root must retain accepted cloud work, realtime and media/pins through GUI close
  and retire only after actual idle plus acknowledged replies. Crashed peers are
  reaped using actual signed peer liveness; fixture timing is not native proof.
- Historical retained desktop pairs need an authorized library playback/pin proof
  if their original live personal owner no longer exists. Never fabricate the
  original peer or release another Chrome owner's contribution by UUID alone.
- Product policy is now one active account authority/session agent per Windows
  SID across logons. A second simultaneous same-SID logon must be visibly blocked
  before publishing tickets or state. The SID-wide ownership gate and shared
  vault/refresh serialization are still a source return; current wrong-session
  ticket rejection alone is insufficient. No functional multi-session/Server
  promise is made. Native acceptance remains pending after the gate lands.
- Full diagnostics/check/budget capabilities require their real W26/W27 bindings;
  this core does not advertise missing bridges as successful.
- Real signed app/helper/host/publisher resources and ASAR/fuse integrity,
  MSVC/CMake/CTest, Win10 19045/Win11 native x64, registry/DPAPI/ACL/pipe/Job checks,
  binary Electron stdio, real Chrome/YouTube/Cloud/GPU/listening, multi-user/logout,
  updater/installer and live backend acceptance remain not run for W34.

No Windows/native/UI/live/enrollment/install/publish operation was performed.
No global task completion or release-ready status is established by this record.

## Superseding requirement audit — late 2026-10-09

The [W02/W27 named-command ledger](W02-W27-2026-10-09-closure.md) supersedes the earlier partial-source/SID-gate/Root-composition notes for current source. It records all nine commands, preserved manual cloud (not compulsory handoff), the native visibility exception, original peer/job/source/voice publication proof, signed proxy routing, shared full2306/4 skipped checks and dedicated toolkit/Doctor/owned offline probe fixtures. Root final toolkit composition is explicitly open until its actual call site and combined checks are recorded. Every Windows/native/real-account/media/release gate remains unrun.
