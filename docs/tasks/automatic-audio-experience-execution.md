# Automatic audio experience execution

The user authorized implementation of all task plans on 2026-09-10, starting with backend tasks and a CapRover tar archive. Preserve unrelated checkout changes; do not commit, push, or deploy. The earlier planning-only notices describe the preceding planning turn and no longer block implementation.

## Execution choices

- Work directly in the existing codex/backend-auth-users-devices checkout as requested; native app and backend sources are already untracked work here, so a clean HEAD worktree would omit the actual baseline.
- Use focused behavior tests while editing, then one backend validation/build pass and a scoped integration run. Avoid repeatedly running broad suites. This follows the user's request for wise, limited testing.
- B03 is delegated with ownership limited to new client-errors files/tests; shared schema/module/job edits remain with the primary implementer.
- B01/B02/B04 share job schema/presenter and lifecycle services and are implemented sequentially/integrated by the primary implementer. Their interface names are defined by the shared spec. B03 only consumes the existing owner/requestId job identity.
- The detailed plans' no-code/no-commit planning notices are superseded only for application changes and packaging by the latest request. No commit, push, deployment or real-data deletion is authorized.

## Status

- Backend B01: complete locally.
- Backend B02: complete locally.
- Backend B03: complete locally, reviewed and wired.
- Backend B04: complete locally; real S3 deletion remains unverified.
- Backend B05 and CapRover archive: complete locally; archive link and checksum in validation report.
- Android A01–A07: complete locally; connected-phone installation and launch also verified under the user's later explicit authorization.
- iOS I01–I07: complete locally, source reviewed, with scoped simulator validation.

## Evidence

Backend: [validation report](../../backend/docs/validation/audio-experience.md).
`npm run verify` passed 378 unit tests, 35 HTTP tests, formatting/lint/typecheck/build.
One consolidated real-database/HTTP integration scenario passed with fake S3/messaging.
The focused scenario was extended after review to cover concurrent delete/retry,
competing cleanup claims, expired claims, and attempt pagination; it passed again.
The CapRover tar has 133 members matching source; no deployment was performed.

Review fixes: shared Unicode name validator (DTO/schema agree for emoji), exact-key
cleanup pagination completion when the prefix listing advances to sibling keys.

Testing adjustment: combine the planned new metadata/diagnostics/deletion integration
files into one fixture run, preserving the important behavior coverage while avoiding
repeated service startup. This follows the user's explicit limited-testing preference.

Android: [validation report](../validation/android-audio-experience.md). The latest
combined local gate passed 132 unit tests, lint and debug APK assembly. Final source
review findings were corrected and the follow-up review found no remaining substantive
issue in the reviewed scope.
Review already corrected durable input publication/replay, preservation of unowned
files, AAC staging identity, exact source-work recovery and task timing/timeline.
Final review also corrected cloud-only action routing, source retries, cancellation
that awaits import teardown, playback cleanup and synchronous URL event consumption.
The user subsequently requested running Android on the connected phone while iOS
work continued. `adb install -r` succeeded on Xiaomi 23043RP34G, Android 14/API 34,
serial `$ANDROID_DEVICE_SERIAL`. The resolved launcher started successfully and was verified
visible/top-resumed; visual inspection showed the new task timeline. No uninstall,
app-data clearing, real processing submission or full workflow test was performed.

iOS: [validation report](../validation/ios-audio-experience.md). Implementation and
the focused source review are complete. Focused runs passed pipeline coordination (4), background
restoration (4), task presentation (10), diagnostic outbox (2), job actions (8),
and artifact/history behavior (16). A deadlocked test was corrected to start
session rebinding concurrently before releasing its suspended create operation.
The unsigned generic-iOS Release build and simulator build-for-testing passed.
Five UI scenarios passed on the exact authorized simulator: Arabic dark large-text
with Dynamic Type/text-clipping audits, offline history, cancellation/retry, and
rename/on-demand native sharing/playback/seek/Save-to-Files/cache reuse/deletion.
The fifth scenario passed after correcting native picker test navigation: two
independent URL paste submissions, actual native Files selection, a third automatic
job create, and a local-file timeline without URL-download stages. The final bundle
is `/tmp/MusicMute-ProcessingUI-Import-Complete.xcresult` (1 passed, 0 failed/skipped).
All five UI scenarios have passing scoped-run evidence; no all-target suite pass
is claimed. Both same-named installed MusicMute apps and their data were preserved.
No live-service or arbitrary OS background-execution success is claimed.
