# W13/W16/W18 production-source journey audit

Date: 2026-10-09. Source review and portable/headless code checks on the Mac.
No Windows native, installed app, audio device, GPU, live account/backend/R2 or
release-publication proof is asserted. Historical foundation records remain
dated evidence; their earlier “main wiring pending” paragraphs are superseded
only for the source bindings listed here.

The later [exhaustive requirement closure](W13-W16-W18-requirement-closure-2026-10-09.md) supersedes open source-composition statements below. Historical counts remain dated observations. All actual Windows/live cases remain unrun.

## Behavior and verification table

| Accepted journey                 | Current production behavior / boundary                                                                                                                                                                                                                                                                        | Executable code evidence reviewed and run                                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Explicit Local/Cloud             | Main binds `CloudController`/`VaultCloudModeStore`, safe mode snapshots and renderer commands. Saved Cloud stays selected/unavailable without account/configuration; a local failure never starts paid Cloud.                                                                                                 | `cloud-controller`, `cloud-view`, `browser-account`, `browser-provider-service`                                                    |
| Native cloud confirmation        | Selected file descriptor or canonical YouTube identity, frozen owner/request/rights capability, current account/build/policy/quota rechecks before intake. File cloud uses owned CPU media tools; this does not authorize CPU model inference.                                                                | `cloud-controller`, `cloud-transfers`, `cloud-view`                                                                                |
| Cold manual Chrome Cloud         | Sole trusted account authority + raw scoped snapshots + verified account byte cache/grants. No local session/model/FFmpeg is needed for browser Cloud result delivery; no extra per-video native dialog is imposed on the existing manual START protocol.                                                     | `browser-account`, `browser-provider-service`, `browser-media`                                                                     |
| Automatic Chrome / handoff       | Automatic remains saved Local plus the established duration rule. Saved Cloud requires manual START; separate desktop handoff only prefills review. Tokens stay in the native authority. Native link-control hiding does not govern Chrome controls.                                                          | `cloud-controller`, `browser-account`, `browser-provider-service`                                                                  |
| Cloud result / cancel            | Main consumes exact current-owner completed metadata/capability into Library. Known-job cancellation is a request, not backend completion; import cancellation before job creation remains explicitly unavailable. No non-idempotent intake replay after unknown ACK.                                         | `cloud-controller`, `library-controller`, `browser-account`                                                                        |
| Library ownership / paging       | Guest catalog survives account changes. Explicit link + output identity merges account rows; loaded-page full snapshots replace only that page with bounded dedup. History errors/count updates remain independent of valid media.                                                                            | `library-controller`, `library-model`, `library-provider`                                                                          |
| Availability / restoration       | Offline/online refer to voice copies; original availability is separate. Both false renders Unavailable and disables voice Play/queue intake. Only local `ENOENT` permits exact authorized linked hash/size/variant restoration; permissions/integrity errors cause no grant or transfer request.             | New `library-controller` / `library-view` fault and eviction fixtures; `library-provider`                                          |
| Titles / artwork / visible order | Plain text titles; bounded event-driven public-thumbnail hydration and safe fallback. Main selection freezes the exact current visible order; later filters/hide do not silently rebuild an accepted queue, matching the Mac queue model.                                                                     | `library-thumbnails`, `library-controller`, `library-view`, `player-view`, `playback`                                              |
| Direct original / trimmed voice  | Direct original does not require loading voice first. A trimmed voice with known actual duration plays in output time when conversion is absent; original/voice comparison needs validated retained-sample mapping. No proportional conversion.                                                               | `library-provider`, `playback`, `player-view`                                                                                      |
| Trimmed Save / export / share    | Current account ingest is full timeline. A saved guest trimmed voice shows an English/Arabic unavailable explanation for account saving while retaining play/export/share. Original Share is independent of voice availability. No new private trimmed-ingest profile was added.                              | New `library-view` EN/AR/voice-eviction cases; `library-export`, `share-controller`, `library-provider`                            |
| Deletion distinctions            | Hide changes preferences; cache removal preserves server data; local deletion uses exact unpinned owned tombstone/catalog authority. Account DELETE callback runs only after positive ACK and current-scope check, then stops only matching active playback. Failed/stale ACK cannot stop the current track.  | `library-controller` positive/error/stale ACK tests; local/cache source and prior W22 evidence                                     |
| Fresh preparing presentation     | Personal request descriptor appears before awaited staging/reuse, later maps exact owned job. Cancellation awaits copier/late-job teardown; no audio grant or history before verified Ready. Public terminal/idle follows positive child cleanup.                                                             | `personal-preparation-integration`, `preparing-player-view`; [W12 checkpoint](W12-pending-playback-and-cancellation-2026-10-09.md) |
| Playback controls / accounting   | Typed play/pause/stop/restart/seek/rate/volume/mute/source/repeat/shuffle. Actual playing/seek completion controls accounting; buffering/source switches do not add plays. Guest ownership remains independent of ambient account.                                                                            | `playback`, `player-view`, `listening`, `listening-player-integration`                                                             |
| Explicit Up Next edits           | Play next/append/selected Play/remove/move/clear use generation + queue revision + exact occurrence/index; whole-queue renderer replacement is rejected. Mutations retain current source/pin.                                                                                                                 | `playback`, `player-view`, `library-view`; main/preload source binding reviewed                                                    |
| Duplicate Next / late events     | Next during an outstanding source preparation is ignored, so it cannot consume another occurrence, abort the first load or add a play. First Next from prepared/playing/paused, controlled shuffle/repeat and natural-end/sleep handling stay intact.                                                         | New deferred-open `playback` cases, plus existing late media/listening tests                                                       |
| Media / pin lifetime             | Exact artifact pin before hash/open, current-owner/fingerprint checks, bounded opaque loopback ranges and teardown. Paused media retains ownership; scope loss revokes account sources while guest media remains usable. Native Share retains unknown copied consumption until inspected terminal quiescence. | `library-playback-sources`, `playback-media`, `browser-media`, `share-controller`                                                  |

Production composition reviewed: `main/main.ts`, `preload/index.ts`, renderer
`app.tsx`/Library/player/cloud views; trusted Library/controller/provider/export;
player/controller/timeline/media sources; cloud/controller/transfers; browser
account/service/media. The main Electron process itself was not launched. Layered
core/DOM/native-port fixtures do not substitute for actual Windows IPC/ACL/codec
behavior or a live service journey.

## Executed checks

Final scoped regression started at **21:57:06** and passed **226 tests / 23 files**:

```sh
cd windows-desktop
npx vitest run tests/playback.test.ts tests/player-view.test.tsx tests/listening.test.ts tests/listening-player-integration.test.tsx tests/library-controller.test.ts tests/library-view.test.tsx tests/library-provider.test.ts tests/library-export.test.ts tests/library-model.test.ts tests/library-artifacts.test.ts tests/library-thumbnails.test.ts tests/library-playback-sources.test.ts tests/playback-media.test.ts tests/cloud-controller.test.ts tests/cloud-transfers.test.ts tests/cloud-view.test.tsx tests/browser-account.test.ts tests/browser-provider-service.test.ts tests/browser-media.test.ts tests/share-controller.test.ts tests/preparing-player-view.test.tsx tests/personal-preparation-integration.test.tsx tests/localization.test.tsx
```

- Fresh whole-component `npm run typecheck`: passed after concurrent login-worker
  binder/Main symbol edits settled. Earlier intermediate errors belonged to those
  in-progress modules, not this Library/player slice.
- `npm run build`: passed; source bundles only.
- Scoped seven-file `oxlint --deny-warnings`: zero warnings/errors.
- Scoped seven-file Prettier and root `git diff --check`: passed.

The coordinating implementation agent subsequently ran the stable whole-component
checkpoint at **22:19:16**: **1,424 tests / 174 files passed** in **32.87 seconds**.
Whole-component TypeScript, lint (**437 files**, zero warnings/errors), format,
source build and the **two package-boundary tests** also passed. This combined
checkpoint includes the frozen Cloud/Library/player changes above and the final
DELETE-ACK, passive session-control, keyboard and recovery composition. It was
reported by the agent that executed it; this audit did not rerun that full suite.
Neither the full count nor the boundary tests establish actual Windows/native
behavior. Subsequent composed returns are recorded separately below.

The four W16 changes touch only `library/controller.ts` download classification,
`renderer/library-view.tsx`, one Arabic locale entry and focused fixtures. The
concurrent account-deletion hook/main callback was preserved. The W18 source fix
is the existing controller's preparing guard; no command/schema was added.

The [official Zalando API guidelines](https://opensource.zalando.com/restful-api-guidelines/)
were reread on 2026-10-09 before the client error-classification edit. Security
(104), compatible behavior (106/107) and explicit error conditions (151) guided
preserving owner/variant/identity and denying ambiguous fallback. Local `ENOENT`
is not an HTTP 404; no REST route, status, OpenAPI or event schema changed.

## Subsequent composed source returns

[W13 composed Cloud I/O](W13-composed-cloud-io-2026-10-09.md) now joins actual
account/raw realtime/usage/cloud/media/Library classes in seven synthetic-boundary
cases. The file case exposed and corrected prepared/input and result reservations
colliding at the same request path. **142 tests / 11 files passed at 22:38:45**,
with TypeScript/build/scoped lint/format/diff checks. This is separate from the
earlier 1,424-test checkpoint and actual Windows codec/native proof.

The coordinating agent's new `desktop-ipc-transport.test.tsx` also passed in that
11-file run: source-built restricted preload in a VM → production Main command
ingress → actual `DesktopApp` DOM/snapshot subscription. Its three cases cover
input selection/navigation, origin/subframe/schema rejection and sanitized service
errors, using a synthetic trusted service port. The subsequent fourth case joins
the real PlaybackController to that bridge for Add, Play next, Move up, Remove,
selected queued Play and Clear, including stale revision/occurrence rejection and
preserved current URL/generation. The four bridge cases and seven composed Cloud
cases passed together at **22:43:30**, **11 tests / 2 files**. The bridge queue case
uses guest fixture IDs and injected media/source I/O; repeated/account occurrence
edges have separate controller/DOM tests. It does not execute Electron or the real
Windows UI.

## Verification / deliverables

- [x] A single synthetic composed native-cloud journey joining the real account
      adapter + scoped socket lease + prepared/uploaded/downloaded media + Library
      adoption is covered by the separate seven-case evidence. Synthetic native
      codec/process observations are explicitly recorded rather than called native
      acceptance.
- [x] Exercise actual source-built preload/Main ingress together with UI actions
      under a source-only harness; record the synthetic service boundary. No
      Electron launch ran.
- [x] Exercise the specifically named W18/P14 Play next/add/selected Play/remove/
      move/clear through that harness, with stale revision rejection and injected
      media/source ports rather than actual playback.
- [x] The extended fourth bridge case now holds a queued account command while
      an injected owner event revokes that scope through the real PlaybackController;
      the guest source survives and the old account cannot open. It passed 4/1 at
      22:45:48 and in the later exhaustive regression. This bridge does not contain
      the real AccountController, which is exercised separately by W13 composition.
- [ ] Record the real Windows AAC/MP3/other supported codec matrix, audio-device
      loss, long/background playback, grant expiry/retry, sleep/resume and listening
      alignment/quality on the connected x64 target under W34.
- [ ] Validate actual WinRT Share, private ACL/reparse/hardlink/file-lock behavior,
      protected pin/teardown recovery, large/offline Library and native dialogs.
- [ ] Validate authorized real Firebase/backend/R2 reconnect, account/policy/quota
      failures and installed Chrome manual-versus-automatic/cold mode journeys.

No real input processing, account charge, R2 upload/download, model inference,
native Share UI, installed mutation or publication occurred in these checks.
