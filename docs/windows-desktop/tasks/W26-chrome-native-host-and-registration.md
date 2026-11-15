# W26 — Implement Windows native messaging host and registration

- Status: code-complete / Windows pending; native compilation, approved release inputs and actual acceptance remain unrun.
- Code dependencies: [W02](W02-shared-core-and-contracts.md), [W03](W03-windows-native-security-adapters.md), [W09](W09-startup-and-readiness-receipts.md), [W10](W10-per-user-agent-and-worker-lifetime.md).
- Accepted scope points: P06, P23, P25, P29.
- Execution phase: A — implement now once authorized; native checks later.
- Evidence: [requirement-by-requirement source ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md) plus dated historical records below.

Implementation has been explicitly authorized and source checks executed. This ledger is source-only: no Windows compiler, install, signing, Chrome/GPU/device or live release operation ran. Checked source rows below cite the actual production chain and portable proof; all native acceptance rows stay open.

## Existing behavior and design consequence

One extension can use the same host name across platforms, but Windows host registration, binary stdio and launch/recovery behavior are platform-specific. The launcher must explain missing Prepare even when the large runtime is absent.

## Read before editing

- [chrome-extension/src/extension/static/manifest.json](../../../chrome-extension/src/extension/static/manifest.json)
- [chrome-extension/src/companion/host.ts](../../../chrome-extension/src/companion/host.ts)
- [chrome-extension/src/companion/native-protocol.ts](../../../chrome-extension/src/companion/native-protocol.ts)
- [chrome-extension/src/companion/installation-check.ts](../../../chrome-extension/src/companion/installation-check.ts)
- [chrome-extension/src/companion/media-server.ts](../../../chrome-extension/src/companion/media-server.ts)

Also read [architecture](../ARCHITECTURE.md), [AI handoff](../AI-HANDOFF.md),
[validation](../VALIDATION.md), and the affected component instructions/manifests.

For the sequential execution order, checkbox rules and current partial-source gaps, read [execution plan](../EXECUTION-PLAN.md), [feature acceptance](../FEATURE-ACCEPTANCE.md) and [resume gaps](../RESUME-GAPS.md).

## Implementation checklist

- [x] Bundle a small real Windows x64 native host/launcher with the app. Preserve com.musicmute.local and the approved extension ID; verify caller origin and reject unknown senders. **Source proof: C-proxy** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w26-chrome-host-and-registration-source)).
- [x] Register an app-owned manifest through HKCU only, with correctly quoted stable paths and explicit registry-view handling. Repair only owned keys/manifests; avoid HKLM/admin changes and unrelated extensions. **Source proof: C-registry** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w26-chrome-host-and-registration-source)).
- [x] Implement binary UTF-8 JSON framing with native 32-bit lengths, partial/multiple frames, strict internal bounds, clean stdout and safe stderr. Native debug output must never corrupt framing or expose secrets. **Source proof: C-frame** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w26-chrome-host-and-registration-source)).
- [x] Connect to or start the session agent on demand without opening a visible UI for every browser request. Return safe Setup needed/Unsupported/Busy statuses when runtime or GPU is unavailable. **Source proof: C-connect** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w26-chrome-host-and-registration-source)).
- [x] Keep one shared extension manifest/source/package identity; platform-specific assets belong in app/native packaging. Preserve browser-token-free local and cloud handoff boundaries. **Source proof: C-shared** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w26-chrome-host-and-registration-source)).
- [x] Handle disconnect/reconnect, crashed host/agent, update/reinstall path changes, missing registration and uninstall cleanup. Use bounded retry and avoid duplicate helpers. **Source proof: C-event** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w26-chrome-host-and-registration-source)).
- [x] Enforce media capability/origin/path restrictions through the existing media server and reject browser attempts to access arbitrary files or privileged worker commands. **Source proof: C-media** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w26-chrome-host-and-registration-source)).

## Code validation checklist

- [x] Test binary framing including Windows CR/LF-sensitive bytes, split headers/bodies, oversized messages, bad UTF-8/JSON, foreign origins and stray logging. **Source proof: C-frame** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w26-chrome-host-and-registration-source)).
- [x] Test HKCU manifest/registry generation, views, spaces/Unicode paths, repair ownership, missing runtime and launcher/agent version mismatch. **Source proof: C-registry** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w26-chrome-host-and-registration-source)).
- [x] Test host lifecycle and capabilities using fake native transports; verify no auth/fleet secrets appear in browser messages. **Source proof: C-command** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w26-chrome-host-and-registration-source)).

## Windows acceptance — deferred until W34

- [ ] Verify real Chrome native messaging registration and framing, including UI closed, fresh install, Prepare missing and reinstall/repair.
- [ ] Confirm one shared extension works with the Windows host, no UAC occurs and uninstall removes only owned registration.

## Detailed AI-agent handoff — reviewed 2026-10-09

### Current source and boundaries

Production source exists in [browser modules](../../../windows-desktop/src/main/browser/), [browser-host entry](../../../windows-desktop/src/agent/browser-host.ts), [native Chrome host](../../../worker/native/windows-consumer/chrome_host.cpp) and native registry operations. Registration/framing fixtures are source evidence only; no real HKCU registration or Windows Chrome handshake has run. The source ledger names actual mode/reuse/media/account bindings; W27 shared-extension and live parity remain separately checked rather than inferred from host source.

| Component                         | Owns                                                                      | Excluded authority                                                |
| --------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Installed native launcher         | Exact extension origin, binary stdio, verified Node/host entry            | Arbitrary argv/shell launch or Firebase login                     |
| Current-user registration adapter | Owned manifest and HKCU 32/64-bit views                                   | HKLM, enterprise-policy edits or another extension's keys         |
| Browser host service              | Public protocol, original peer-bound personal owner and safe capabilities | Fleet commands, account tokens or renderer-selected account scope |
| Session/personal authority        | Guest jobs, event snapshots, cleanup and GPU admission                    | Browser lifetime as fleet lifetime                                |
| Scoped media bridge               | Origin/owner/generation-bound grant and actual consuming-process pin      | Arbitrary filesystem URL or unpinned share-delete access          |

### Ordered implementation/review sequence

- [x] Derive the approved extension ID from the existing shared manifest public key and verify packaged parity. Preserve `com.musicmute.local` and the same Chrome store/source identity; do not invent a second Windows key or broad host permission. **Source proof: C-shared** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w26-chrome-host-and-registration-source)).
- [x] Bind the installed `MusicMuteChromeHost.exe`, verified `browser-host.cjs`, exact shared extension origin and their hash/size receipts in approved package resources. Reject placeholders/missing resources as unavailable instead of registering a fake functional host. **Source proof: C-proxy** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w26-chrome-host-and-registration-source)).
- [x] Parse Chrome's exact origin argument and the optional decimal `--parent-window` argument safely. Validate service-worker/content-script sender, active video identity and command schema again at the service boundary; the allowed origin manifest alone is not sufficient authorization. **Source proof: C-command** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w26-chrome-host-and-registration-source)).
- [x] Write the owned `stdio` host manifest with absolute stable path and explicit `allowed_origins`, then register only HKCU in both views. Store/validate an ownership receipt. Repair and unregister only exact owned bindings; unknown/stale foreign paths require a conflict result, not deletion. **Source proof: C-registry** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w26-chrome-host-and-registration-source)).
- [x] Implement strict binary DWORD length + UTF-8 JSON framing with partial headers/bodies and multiple frames. Windows stdio must be binary. Keep the internal 64 KiB cap below Chrome's larger transport limits; stdout contains frames only, while safe stderr must contain no tokens, media URLs or plaintext credentials. **Source proof: C-frame** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w26-chrome-host-and-registration-source)).
- [x] Support the shared public JSON grammar, including finite fractional durations, while keeping private command integer/range contracts strict. Reject duplicate keys, malformed UTF-8, truncation, oversized frames and unknown privileged actions before allocating/dispatching work. **Source proof: C-frame** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w26-chrome-host-and-registration-source)).
- [x] Connect fresh Local to the verified current-logon session agent. Missing runtime/GPU blocks fresh Local only; browser connection and saved manual Cloud use the sole account authority without local Prepare. Report connection, local readiness and cloud availability separately; no visible UI for probes. **Source proof: C-connect** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w26-chrome-host-and-registration-source)).
- [x] Expose capabilities only for real bridges: local Windows Ready, mode/policy, cache reuse, diagnostics/check, publication and native cloud handoff must each have a functioning authorized adapter. A static `available:true` or successful HELLO does not establish all features. **Source proof: C-command** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w26-chrome-host-and-registration-source)).
- [x] Route local START through the trusted guest personal gateway with null captured account scope, rights confirmation and full timeline. Manual Cloud uses the same trusted account authority as Electron via the private bridge. Browser commands cannot reach internal scope/guard/fleet operations, attach a UID or obtain tokens. **Source proof: C-command** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w26-chrome-host-and-registration-source)).
- [x] Subscribe to actual personal progress and send bounded full snapshots; use separate event/control lanes so cancel/stop stays responsive. Reconnect recovers only an existing matching job/result; it must not submit duplicate processing or automatic cloud billing. **Source proof: C-event** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w26-chrome-host-and-registration-source)).
- [x] Serve processed media through the existing origin-restricted server. Hold the unified LibraryPins entry for the actual consuming host Node PID/creation time throughout grant/FD/range lifetime. Verify authorized job/artifact/hash/timeline, revoke on scope/video/owner change, and close only that browser owner's resources. **Source proof: C-media** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w26-chrome-host-and-registration-source)).
- [x] Implement read-only warm-start registration verification separately from explicit register/repair. Check owned bindings and small pinned files cheaply; enterprise policy or a removed extension remains a distinct browser-unavailable state until real handshake. **Source proof: C-registry** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w26-chrome-host-and-registration-source)).
- [x] Make disconnect/update/uninstall cleanup idempotent. Closing Chrome detaches its owner/media/events and never stops the independently enrolled fleet. Registration changes coordinate with W29/W31 while preserving user data and unrelated installations. **Source proof: C-lifetime** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w26-chrome-host-and-registration-source)).

### Failure/race cases and test expectations

| Trigger                                                                    | Expected outcome                                                                                    |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 32-bit registry contains stale/foreign path while 64-bit path is correct   | Report conflict; do not claim Chrome readiness from the second view alone                           |
| Missing runtime but launcher is installed                                  | Valid framed Setup needed HELLO, no large runtime prerequisite or silent success                    |
| Replaced launcher/entry or malformed packaged manifest                     | Refuse execution/registration and require explicit repair                                           |
| Foreign extension/page, changed peer birth or browser-supplied account UID | Deny authority and return only safe bounded error                                                   |
| Partial/truncated length/body, invalid UTF-8 or debug text on stdout       | Reject/close the protocol without unbounded buffering                                               |
| Event wait runs while user stops a job                                     | Stop dispatches promptly; no serial-helper starvation or ticket replay                              |
| Scope/video changes during a ranged media read                             | Existing authorized FD/grant follows the explicit revoke policy; no new access to old-account media |
| Host crashes or Chrome port closes mid-job                                 | Recover/stop only the original guest owner; fleet lifetime stays independent                        |
| Cached Ready remains but owned registry entry is removed/policy blocked    | Local app may remain Ready; Chrome availability must be separately honest                           |

### Code-only checks and deliverables

- [x] Expand binary framing fixtures for one-byte splits, combined frames, CR/LF-sensitive bytes, zero/oversize length, fractional duration, bad UTF-8, duplicate keys and stray logs. **Source proof: C-frame** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w26-chrome-host-and-registration-source)).
- [x] Test registration parser/view/ownership/pinning decisions with temporary fixtures, spaces/Unicode, changed extension key and missing packaged files. Do not mutate real HKCU during portable tests. **Source proof: C-registry** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w26-chrome-host-and-registration-source)).
- [x] Test service command/capability branches, no-token public serialization, guest scope, actual event recovery, app/cloud handoff restrictions and source-generation cancellation using injected transports. **Source proof: C-command** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w26-chrome-host-and-registration-source)).
- [x] Test media grant origin/path/hash/range fences and pin acquisition/release under disconnect, cleanup and concurrent cache eviction. **Source proof: C-media** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w26-chrome-host-and-registration-source)).
- [x] Deliver exact public protocol/capability map, owned registration manifest schema, packaged resource inventory, scoped lifecycle diagram and separate portable/native evidence. **Source proof: C-proxy** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w26-chrome-host-and-registration-source)).

Historical focused session/update run: 56 fixtures across five files. The newer source ledger supersedes that partial-code checkpoint; real Windows host/Chrome behavior remains pending.

### Deferred Windows scenarios

- [ ] Verify the same extension's real connectNative handshake with binary stdio on a fresh standard-user install, missing Prepare, UI closed, runtime Ready and disabled startup.
- [ ] Read back both registry views and owned manifest; test reinstall/repair, foreign key conflict, spaces/Unicode, Chrome profiles and enterprise-policy denial without elevation or policy edits.
- [ ] Exercise live local progress/cancel/media ranges, host/agent crash and extension disconnect/reconnect; record no fleet stop or orphan tools.
- [ ] Test update/uninstall replacement and registration cleanup while preserving runtime/data and unrelated keys. Do not equate read-only registration checks with Chrome policy/handshake proof.

### Primary reference

[Chrome native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging) defines HKCU registration, registry view lookup order, exact allowed origins, length-prefixed UTF-8 messages, caller arguments and port lifetime. The project deliberately uses stricter frame limits and peer/media authorization above that transport. Chrome's documentation also requires validating content-script sender origin/URL before forwarding.

## Fixed app proxy and cold cloud launch closure

- [x] Handle fixed `--native-browser-stdio` entry before UI/account initialization **Source proof: C-proxy** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w26-chrome-host-and-registration-source)).
      or Prepare; validate exact origin and resources equal to installed
      `process.resourcesPath`. No browser-selected executable/resource root.
- [x] Keep the host import side-effect-free and standalone CLI wrapper separate. **Source proof: C-proxy** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w26-chrome-host-and-registration-source)).
      Audit built entries for framed stdout only: no Electron banners/logs or
      Windows text-mode translation.
- [x] Pin signed app proxy, independent `--headless-account` launch, helper/host/ **Source proof: C-proxy** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w26-chrome-host-and-registration-source)).
      CLI resources. Do not discover executable paths from PATH or arbitrary argv.
- [x] Test mixed/unknown flags, bad resources/origin, stale pin, launch failure, **Source proof: C-connect** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w26-chrome-host-and-registration-source)).
      Unicode frames and Cloud with bootstrap/model/GPU absent. Native PE/stdout
      execution remains W34.

## Completion record

### Proven source checkpoint — 2026-10-09

- [x] Include private browser/account/installer source in Root whole Desktop checks: 1,424 tests / 174 files, typecheck/lint/format/source build and two renderer/preload boundary fixtures passed.
- [x] Code-test standalone authenticated GUI uninstall retaining independent worker Run while removing only owned browser/protocol integration; no absent session is started to satisfy uninstall.
- [ ] Execute real Chrome stdio/normal-Electron routing, signed installed peers, both HKCU views, policy, cold account authority, logout and extension parity on Windows in W34.

See [source evidence](../evidence/W03-W31-W33-2026-10-09-audit.md). Injected peers and package fixtures do not establish Chrome/native success or real account/backend availability.

Task/index/progress reconciliation is Root-owned; this task’s source proofs are recorded individually above. Use `code-complete / Windows pending` only when
the required source work and executable code checks are complete; unavailable
native compilation remains explicitly recorded. Do not claim a release from
fixture or source-only proof.

## Requirement ledger return — 2026-10-09

Every source/code checklist above cites the production-entry, resource/authority,
actual implementation, portable test and native-only gate in [W26 Chrome host and registration source](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w26-chrome-host-and-registration-source).
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

`browser_registration.hpp` uses v2 exact manifest birth/raw SHA ownership, held
GENERIC_READ/DELETE leaf and ancestors, staged/old-submitted/old-removed/published
continuation, and non-replacing handle rename. A copied/foreign generation is not
adopted or unlinked. Both HKCU views are validated/mutated in one bounded KTM
transaction; failure/foreign values roll back. Owned missing FileNotFound or
PathNotFound may repair only beneath the trusted private root. Legacy v1 has no
generation proof and is explicitly fail closed; no Windows consumer release has
installed that source schema. SDK 35-second bounds/strict result shapes and isolated
CTest sources cover reader/clone/ACK/missing-parent/both-view rollback, with Native
execution still W34. Normal Electron stdio/cold headless routing and one shared
extension identity are unchanged.
