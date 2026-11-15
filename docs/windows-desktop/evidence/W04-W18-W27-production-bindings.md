# Evidence: Windows main, player and browser production bindings

- Date: 2026-10-09, source checks through 16:56 Africa/Cairo.
- Source HEAD: `c0218633c43559c8ad1988e5037273970a91f99b`; dirty shared checkout, no commit created.
- Source/test checkpoint: 346 files under `windows-desktop/src` and `windows-desktop/tests`, sorted path plus NUL plus bytes plus NUL, SHA-256 `10b6847b300177d665a84824db12cfe97a464c7e749700fb7bac95d123c178b6`.
- Host: Darwin ARM64, Node 24.18.0; portable source and headless checks only.
- Status: in progress; listed production source bindings and their code checks pass. Windows/native/release acceptance is pending.

## Implemented source

Main now serves the existing sole browser account authority through signed-peer/private-ticket adapters. Its media adapter uses actual Library downloads, pins, file descriptors, fingerprints and SHA-256, with the shared Chrome origin. Explicit Chrome cloud does not call local Prepare, GPU inference, model loading or FFmpeg. The existing signed full-timeline contract permits a null output duration; the trusted input duration is retained in that case. Missing account configuration has an explicit unavailable-account boundary: actual guest cache works, while authorization and cloud intake fail with `CONFIGURATION_REQUIRED`. There is no fabricated endpoint or login.

Browser contribution release requires the existing live native owner proof, exact original peer birth, completion owner, job/video, model/recipe pair receipt and vocal artifact/hash/bytes. The pair is checked again after deferred durable staging. Community reuse never republishes. Only proof-authorized rows receive subscribed saving state. Desktop fresh playback uses the existing desktop owner proof when that live owner is present; historical guest playback uses the actual verified Library descriptor/pin and exact pair identity after its original processing owner is gone. Completion alone does not release contribution bytes.

Personal Quit closes personal UI/audio/preparation work while retaining account authority needed by Chrome. A single event-driven idle grace observes jobs, media grants, pending commands, replies/ACKs, completion work and publication work; an atomic native-authority reservation fences new intake before retirement. Reopening retains the account controller generation. Initialization and IPC share the shutdown barrier; latest resources are drained before native helpers close. Unexpected account-gate loss fences account/cloud intake. One bounded browser transport recovery retains the same account generation.

The account SID gate is acquired before Electron single-instance forwarding and Host/account initialization. A same-session existing process may receive normal activation; another Windows sign-in session is refused. The exact gate remains held through account/broker cleanup. Early entry validates packaged resource trust before browser/account modes. These are production call sites and portable gate fixtures, not executed Win32 mutex/signature proof.

Worker controls can compose against the saved machine while the app is signed out. Worker Advanced has typed main/preload/view bindings for reports, filters/follow, maintenance confirmation/run, capability-based file benchmark, native export, cancellation and recovery. Boolean revoke bypass is removed; dismissing a confirmation invalidates it. Trusted Save destinations use exclusive files, owner/window guards, one-use bounded grants and exact created-file identity checks. Rich benchmark options, credential retirement/purge closure and actual updater/UI bindings remain separate work.

Playback now preserves direct original Library start, Restart without a new accounting session, manual/natural repeat, original Next where available and voice default for selected queue occurrences. Repeated queued IDs remain separate occurrences; removal/Play affects the chosen occurrence. Standalone verified trimmed voice uses explicitly labelled voice-output coordinates when its comparison map is absent/corrupt; source conversion is unavailable. Voice markers have a distinct artifact-derived key and never pretend to be original coordinates. Guest listening metadata stays in the local partition across account changes. A different track cancels sleep; a same-track/source switch retains it.

## Executed code checks

All commands below ran from `windows-desktop/`.

| Command                                                          | Result                                           | Scope and limits                                                                         |
| ---------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `npm test -- --maxWorkers=2`                                     | PASS, 966 tests in 124 files, no skips; 16:53:51 | Desktop source/headless/fake native and isolated byte fixtures. No Windows execution.    |
| `npm run typecheck`                                              | PASS                                             | Current desktop and imported shared TypeScript contracts.                                |
| `npm run lint`                                                   | PASS, 0 warnings/errors in 347 files             | Full desktop source/tests/scripts checkpoint.                                            |
| `npm run build`                                                  | PASS                                             | Source main/preload/renderer/agent bundles; no installer or native compilation.          |
| `npm run test:package-fixtures`                                  | PASS, 2 tests                                    | Renderer/preload import boundaries; no installed sandbox proof.                          |
| Focused player/browser/publication/localization/controller tests | PASS, 102 tests in 12 files                      | Exact media, guest/account/origin fences, playback proof, UI controls and idle lifetime. |
| Focused Advanced/save/account-port/pending/entry tests           | PASS, 41 tests in 7 files                        | Confirm/cancel/export and closed entry/IPC behavior.                                     |
| Scoped Prettier check, 31 affected files                         | PASS                                             | Two unformatted new test files were formatted before the passing rerun.                  |

Earlier focused runs exposed and corrected the Windows path-policy branch, missing Arabic keys and stale player/UI fixture assumptions. No failed run is counted as a pass. Parallel source changes after this checkpoint require their own evidence.

## Remaining gates and continuation

W29 updater Main/preload/UI and actual consumer activity reservation still need binding. W25 rich benchmark/retirement/purge, W28 shortcuts/settings, W30 Diagnostics and W31 installer/harness source remain in progress. The broader feature checklist is still open where a journey has no complete production binding.

No Windows compile/link, signed installer, real registry/DPAPI/ACL/Job Object, actual DirectML inference, codecs/listening, real Chrome/YouTube, account/R2/fleet or native UI checks ran. These are W34 checks after the user connects the machine. Approved release resources/certificates and real publication are independent prerequisites; no placeholders were installed or published.
