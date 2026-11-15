# Windows Main integration checkpoint

Date: 2026-10-09. Latest full source suite started at 18:37:30 Africa/Cairo.
Scope: headless/source checks and isolated byte fixtures on the development Mac.

## Implemented composition

- Main/preload/Settings bind the real consumer updater's check, explicit install,
  recovery and saved optional discovery. Cold app updates preserve absent runtime,
  model and Ready state. No preparation or inference is fabricated for an update.
- A common synchronous intake reservation checks actual commands, account refresh,
  playback/media grants, cloud/personal/preparation, completion/publication/outbox,
  Advanced, retained CPU scratch and diagnostic writers. Uncertain retirement keeps
  the fence held. Consumers reopen only after the update command/Prepare lock settles.
- Installer startup has a closed early argument grammar, actual authenticated
  maintenance route, existing-session drain/commit and exact process-exit wait.
  Nested updater assistance requires the protected journal/WAL and actual running
  signed certificate. Pipe ACK does not make the authority await its own shutdown.
- Browser transport recovery preserves the same account generation, accepted jobs,
  media and authority; only the failed private transport/helper is replaced once.
- Worker benchmarks bind readonly input/baseline capabilities, an approved installed
  candidate, supported group size and separately chosen report/audio destinations.
  Confirmation claims destinations before drain; streaming checks source descriptors,
  hashes, names, bounds and CRC. No entire audio archive is buffered or sent to UI.
  The stored ZIP follows [PKWARE APPNOTE](https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT).
- Readonly readiness checks complete journals and actual cached identity under the
  Prepare mutex without downloading, model inference, registration or activation.
  Settings render the same shortcut catalog used by dispatch, including volume and
  System text reset. Incoming storage scans preserve an unsaved budget draft.
- Windows account unlink guards retain a supported password/Google method even when
  another client's Apple method is listed. Device history identifies this Windows PC
  and distinguishes past-entry hiding from logout/worker actions.
- Diagnostics have real local journal/CPU Doctor/storage activity, narrow copy/export,
  fixed owned log reveal and successful saved-report receipts. Report reveal checks
  owner, exact file birth/metadata and bytes; altered/replaced files remain untouched.
  Setup/update/personal/player/lifecycle transitions record safe fields and measured
  Main RSS/heap only. Expected model identity is separate from verified evidence.

## Checks actually run

| Command                         | Result                                           | Scope                                         |
| ------------------------------- | ------------------------------------------------ | --------------------------------------------- |
| `npm test -- --maxWorkers=2`    | PASS, 1,106 tests / 145 files, no skips, 26.40 s | Full desktop source/headless fixture snapshot |
| `npm run typecheck`             | PASS                                             | Desktop/imported shared TypeScript            |
| `npm run lint`                  | PASS, zero warnings/errors, 387 files            | Current desktop source/tests/scripts          |
| `npm run build`                 | PASS                                             | Main/preload/renderer/agent source bundles    |
| `npm run test:package-fixtures` | PASS, 2 tests                                    | Executed bundle import boundaries             |

Focused fixtures caught and corrected a missing shortcut translation, a split-text
UI assertion and a large-buffer assertion timeout. Failed attempts are not passes.
Later edits need their own checks; formatting and overall closure remain separately
recorded in the task pack.

## Remaining evidence

Final macOS parity/production closure, native media controls and dialog localization,
dashboard policy integration, final installer/harness review and related code checks
continue. Tasks are not blanket checked from a passing aggregate suite.

No Windows C++ compilation, signed installer, actual registry/DPAPI/ACL/Job Objects,
DirectML inference, Windows codecs/UI/Narrator/DPI, live Chrome/YouTube, real account,
R2 or fleet acceptance ran. W34 runs after the user connects the Windows target.
No commit, push, release signing, publication, deployment or enrollment was performed.
