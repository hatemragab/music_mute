# W02 — Extract platform boundaries and preserve shared contracts

- Status: code-complete / Windows pending.
- Code dependencies: [W01](W01-inventory-and-build-foundation.md).
- Accepted scope points: P01, P02, P09, P23.
- Execution phase: A — implement now once authorized; native checks later.
- Evidence: [source authority and complete named-command ledger](../evidence/W02-W27-2026-10-09-closure.md).

Implementation was explicitly authorized. Source and portable contract checks are recorded below; native C++ compilation and Windows acceptance remain W34. A pending native dependency does not stop source work. The W27 Main toolkit composition and retained-cleanup returns now have actual production call sites in the ledger; the coherent combined source checkpoint is recorded in the ledger; native checks remain explicit.

## Existing behavior and design consequence

The original companion configuration assumed Darwin/ARM64 and static Windows availability was false. Current adapters use explicit profiles and validated host capabilities; the static provider constant still cannot establish Ready. Path, permission, lock and process behavior is implemented behind native Windows authority. Existing desktop IPC contains trusted-native session material and remains separate from renderer/Chrome messages.

## Read before editing

- [chrome-extension/src/shared/desktop-protocol.ts](../../../chrome-extension/src/shared/desktop-protocol.ts)
- [chrome-extension/src/shared/providers.ts](../../../chrome-extension/src/shared/providers.ts)
- [chrome-extension/src/companion/config.ts](../../../chrome-extension/src/companion/config.ts)
- [chrome-extension/src/companion/desktop-service.ts](../../../chrome-extension/src/companion/desktop-service.ts)
- [chrome-extension/src/companion/native-protocol.ts](../../../chrome-extension/src/companion/native-protocol.ts)
- [worker/src/platform/runtime-adapter.ts](../../../worker/src/platform/runtime-adapter.ts)

Also read [architecture](../ARCHITECTURE.md), [AI handoff](../AI-HANDOFF.md),
[validation](../VALIDATION.md), and the affected component instructions/manifests.

## Implementation checklist

- [x] Introduce typed platform interfaces for paths, private storage, locks, process supervision, GPU discovery, runtime installation, native registration and control transport. Keep portable acquisition/cache/sync/business rules shared.
- [x] Keep the macOS adapter behavior and existing protocol envelope compatible. Add an explicit Windows consumer profile distinct from the legacy service profile; avoid selecting a profile solely by win32/x64 when two installation models exist.
- [x] Separate renderer-safe commands, browser-native messages and trusted desktop/worker control messages. Preserve request IDs, version checks, account owner/generation/installation fences, bounded frames and sanitized error codes.
- [x] Implement explicit Windows path validation with path.win32 fixtures on any host; distinguish selected input paths from managed paths. Do not weaken existing Mac path validation.
- [x] Define capability-based readiness and platform discovery so the shared extension can display Setup needed, GPU unsupported, busy or ready truthfully. Do not enable local Windows processing until actual preparation succeeds.
- [x] Document contract changes and consumer compatibility tests; follow the repository's existing protocol generation/check mechanism rather than inventing duplicate schemas.

## Code validation checklist

- [x] Run portable contract tests for both platforms, malformed/oversized/unknown-version messages, mismatched generations and unsupported capability combinations.
- [x] Exercise Windows drive paths, UNC/device paths, reserved names, case aliases and traversal on the Mac; assert renderer/browser responses contain no trusted-native session tokens.
- [x] Run existing companion/worker contract regressions and affected type/build checks.

## Windows acceptance — deferred until W34

- [ ] Verify real native IPC framing and Windows path behavior against the generated fixtures.
- [ ] Confirm unchanged Mac behavior separately if shared-source changes require native regression acceptance; Mac source tests alone do not establish it.

## Detailed execution plan

1. Trace each existing shared import before extracting it. Share domain rules,
   validation, acquisition, cache identity and sync semantics; implement Windows
   filesystem, vault, process, registration and transport behavior in adapters.
2. Define explicit consumer and legacy-service profiles. The current-user product
   must never invoke SCM/WinSW installation or apply LocalService ACL assumptions.
3. Keep three separate public surfaces: renderer commands, browser messages and
   trusted session/native commands. Validate request IDs, versions, enumerations,
   sizes, owner generations and capability lifetime at each receiving boundary.
4. Keep snapshots immutable and serializable. Public readiness reports safe states
   such as setup needed, GPU unsupported, busy or ready; no credential, path,
   native nonce, backend grant or arbitrary executable crosses into Chrome/UI.
5. Preserve old macOS clients and fixtures. Add Windows provider/platform members
   only where the receiving validator and routing implementation exist together.
6. Bind real implementations in main/session composition. A passing injected
   fake proves orchestration; it cannot close a missing production adapter.

## Boundary ownership and outputs

| Boundary               | Trusted owner                          | Permitted output                                                            |
| ---------------------- | -------------------------------------- | --------------------------------------------------------------------------- |
| Selected input file    | Main file-capability registry          | Opaque, expiring selection capability and display-safe metadata.            |
| Account authority      | Main account controller                | Safe account view and explicit commands; no refresh token.                  |
| Fleet lifetime         | Session agent                          | Revisioned state and fixed worker commands independent of UI login.         |
| Physical GPU ownership | Native guard plus admission broker     | Qualified GPU identity and lease state; no renderer-controlled ordinal.     |
| Media playback/export  | Main artifact/pin service              | Bounded media capability or explicit destination action.                    |
| Chrome bridge          | Native host/session personal authority | Framed public protocol, validated extension origin and public handoff data. |

## Additional closure checklist

- [x] Audit every cross-component import for `import.meta`, filesystem assumptions,
      POSIX permissions and process APIs before bundling it into Windows entries.
- [x] Add compatibility fixtures for both provider identifiers and legacy envelopes;
      keep the shared extension identity and macOS behavior intact.
- [x] Document exact authority for saved processing mode, account scope and worker
      intent so separate stores do not silently override each other.
- [x] Record each source-only/native-only gap in its owning task, with no duplicate
      contract or success-returning stub used to bypass that gap.

## Specific code-only fixtures

Malformed JSON, duplicate/unknown fields, unexpected enum/version, oversized
strings/frames, revoked/expired capabilities, UID generation changes, mismatched
installation identity, Windows case aliases/reserved names/alternate streams,
UNC/device paths and traversal must yield bounded typed failures. Test that a
browser request cannot select another user's scope, call worker controls, open an
arbitrary path or acquire native secrets. Compare Mac and Windows fixtures where
behavior is shared; retain platform-specific security policies.

## Deliverables to review

Typed ports and validators, compatible shared contracts, production factory
bindings, source-level regression tests and a table of native checks left for
W34. Future platform-routing changes must repeat the affected current checks
before their source completion is marked.

## Complete named command inventory

- [x] Record command → Windows receiver/API → authority → side effect → discovery
      state → code fixture → W34 case for every existing Mac/shared command.
      The following groups are required, not illustrative substitutes:

| Existing command group                             | Required receiving boundary and authority                                                                                                     |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| App status/setup/snapshot/export                   | Trusted main/Prepare/local diagnostics; cheap read versus setup mutation versus private chosen export remain distinct.                        |
| Desktop LOCAL_START/CLOUD_START/SYNC               | Personal session guest/captured-owner intake, sole account cloud controller and owner-bound outbox; renderer never chooses a bearer or owner. |
| Desktop CLEAR_CACHE/LIBRARY_CACHE/SET_CACHE_BUDGET | Existing storage mutation authority/pins and versioned shared budget; no parallel preference or broad filesystem cleanup.                     |
| Desktop LIBRARY_DOWNLOAD/LIBRARY_ORIGINAL_PLAYBACK | Trusted account grant/hash/pin and direct original playback with visible-order queue; no raw renderer paths.                                  |
| Chrome HELLO/START/CANCEL/STATUS                   | Fixed origin/peer-owned browser/session authority; capability negotiation, local guest versus manual native cloud and no duplicate Start.     |
| Chrome DIAGNOSTICS/CLEAR_CACHE/CHECK               | Sanitized bounded local adapters; inspection/full check/mutation are separate, no privileged worker forwarding.                               |
| Chrome PLAYBACK_STARTED/EVENT                      | Original peer/job/source/sealed media proof, exact generation and first-voice acknowledgement/full snapshots.                                 |

- [x] Implement each binding or expose truthful unavailable discovery; successful
      parser/controller tests cannot advertise an absent production adapter. **Production proof:** actual Root Main toolkit binding plus retained cleanup and explicit retry are recorded in the ledger; fake ports alone do not close a binding.
- [x] Keep shared desktop session bearer material inside trusted native services;
      test platform enum/error/payload compatibility, including negotiated optional
      Windows STATUS cache metadata and unchanged legacy Mac grammar.

## Completion record

- Implementation: explicit shared local/browser platform helpers, legacy-compatible desktop parser with existing strict JSON, bounded public/private/renderer schemas, current-user SDK/session/Prepare/account/media ports; actual source paths and every named command are in the [ledger](../evidence/W02-W27-2026-10-09-closure.md).
- Code checks: shared 2306 passed/4 skipped/79 files at 23:48:04 plus typecheck/lint 218/build/format; Desktop55 focused browser/toolkit tests/7 files plus tsc/scoped lint/build/2 boundaries. Worker affected adapter/package/SDK checks are recorded in the same ledger.
- Unrun: C++/Win32 compilation, native Mac regression and all W34 installed/Chrome/GPU/account/UI cases.
- Combined source return: Root passed 1,764 tests / 205 files at 00:21:56, whole tsc/lint 484/format/build and 2 boundaries; no counterfeit production Ready or release claim.

Check completed items individually and update [TASKS](../TASKS.md) and
[PROGRESS](../PROGRESS.md). Use `code-complete / Windows pending` only when
the required source work and executable code checks are complete; unavailable
native compilation remains explicitly recorded. Do not claim a release from
fixture or source-only proof.

## Coherent source return — 2026-10-10

- [x] Record Root's actual Main/toolkit/activity/positive cleanup/shutdown retry
      composition and the 00:21:56 whole Desktop source checkpoint: 1,764 tests /
      205 files, whole tsc, lint 484, full format, source build and 2 boundaries.
      Shared extension source independently passed 2,306 tests with 4 existing
      skips / 79 files plus typecheck/lint 218/build/format at 23:48:04.
- [ ] Run W34 native/installed/Chrome/GPU/audio acceptance and separately required
      installed Mac regression. Source counts do not establish those results.

See the [complete command and lifetime ledger](../evidence/W02-W27-2026-10-09-closure.md#combined-source-checkpoint-received--2026-10-10-002156-cairo).
Historical source failures and pre-change counts remain dated, not promoted.
