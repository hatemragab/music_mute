# W12 immediate pending playback and truthful cancellation

Source checkpoint: 2026-10-09. Implementation and portable fixtures are complete
for this slice; native Windows/GPU/installed import acceptance remains unrun.
This record supplements the earlier W12 foundation without rewriting its dated
test counts or claiming complete Windows product acceptance.

## Source and invariants

`PersonalPlaybackIntents` exposes a bounded current-window/scope/playback-epoch
`view()` plus change subscription. The descriptor is exactly
`{requestId, jobId: null|string}` in `personal-playback-contracts.ts`; it never
declares an audio source, filesystem path, history count or successful output.
`DesktopPersonalController` creates the UUID and lifecycle event before awaiting
file quarantine or reuse, then maps the same request to its exact owned job.
Failure/cancellation/retirement consume that intent. Existing sealed completion
receipts and full-verified Ready output hashes still control one-use autoplay;
startup backfill, Chrome/fleet jobs and unrelated account history have no fresh
desktop intent.

Current application composition in `main.ts` subscribes the descriptor into the
snapshot, binds lifecycle hooks, reconciles a completion that may precede submit
acknowledgement, and checks current window/account/playback epoch/output digest
before real Library/player selection. `DesktopApp` renders the preparing panel
before there is playable media and routes cancellation to request UUID during
intake or exact job ID after acknowledgement. Main/renderer are separate owned
source changes; this slice reviewed their actual binding and tests it through
the real controller/intents/React composition with injected IPC/copy authority.

Strict `CANCEL_REQUEST` parsing denies renderer account/owner/path/job injection.
Cancellation waits for the actual staging operation to settle. If an owned
submit acknowledgement arrives late, the controller publishes that exact job,
issues its exact private cancel and waits for cleanup acknowledgement. Unknown
submit or cancel acknowledgement retains the intake and busy activity. A failed
cancel also publishes `STOP_UNCONFIRMED` on the exact owned job and restarts the
event-driven owner watch; no status/HTTP polling is introduced. Empty or
scope-filtered snapshots cannot erase this retained activity. Positive exact
cancel or positive owner-detach cleanup is required to retire it.

The personal child now awaits each job's genuine completion and
`cleanupConfirmed` in cancel, owner detach and stop, including terminal Ready or
failed presentations. Failed cleanup keeps `idle_proof` false and still occupies
one of the existing 16 active intake slots. Presentation failure never grants
replacement work a free retained-ownership slot. The existing staged-input
64-entry/512-MiB aggregate and native inference-idle/exit fences remain intact.
These fixes preserve guest null captures through account changes and keep
account-A captures fenced from account B.

The final child lifecycle refinement also closes the earlier public
Ready-before-teardown window. A durably committed pair remains publicly
`preparing`/`output-validation` while genuine stop/cleanup/release is outstanding.
Processing failure and cancellation likewise retain preparing activity until
positive teardown; uncertain cleanup becomes retained `STOP_UNCONFIRMED` instead.
After proof, current successful results publish Ready. Cancel-after-pair-commit
preserves the exact valid pair/catalog (`cleanup(jobId, true)`), retires autoplay
and waits for cleanup; it does not roll back or delete that successful media.

## Executed code checks

From `windows-desktop`, the first focused run started at 21:18:34 and passed
**130 tests across 10 files**:

```sh
npx vitest run tests/desktop-personal.test.ts tests/personal-controller.test.ts tests/personal-playback-intents.test.ts tests/personal-events.test.ts tests/personal-ui-contracts.test.ts tests/personal-preparation-integration.test.tsx tests/preparing-player-view.test.tsx tests/contracts.test.ts tests/session-control.test.ts tests/session-supervisor.test.ts
```

The new cases cover actual controller/intents/React preparing presentation,
cancellation while copier cleanup is deferred, late exact owned job
acknowledgement, failed cancel/detach acknowledgements, retained terminal cleanup
through scope-filtered snapshots, positive exact retry, and 16 failed-cleanup
jobs blocking replacement intake. Private workers/native peers/copying are
injected; no device, real Win32 or inference was executed.

The follow-up regression started at 21:27:01 and passed **171 tests across 17
files**, broadening that checkpoint to actual runner, reuse, intake-journal,
private storage, outbox/completion and exact timeline regressions:

```sh
npx vitest run tests/desktop-personal.test.ts tests/personal-controller.test.ts tests/personal-playback-intents.test.ts tests/personal-events.test.ts tests/personal-ui-contracts.test.ts tests/personal-preparation-integration.test.tsx tests/preparing-player-view.test.tsx tests/contracts.test.ts tests/session-control.test.ts tests/session-supervisor.test.ts tests/personal-intake-journal.test.ts tests/personal-storage.test.ts tests/personal-control.test.ts tests/outbox-completion.test.ts tests/personal-runner.test.ts tests/personal-reuse.test.ts tests/personal-timeline.test.ts
```

New genuine controller-lifecycle fixtures hold the injected teardown promise
open after pair commit or failed processing and verify no public terminal/idle
state precedes positive proof. The cancel case preserves the committed media and
never emits Ready. These are code fixtures, not actual Windows tree/GPU proof.

- Scoped ten-file `oxlint --deny-warnings`: zero warnings/errors.
- Scoped ten-file Prettier check: passed.
- `npm run build`: passed; source bundle build only.
- `git diff --check`: passed.
- `npm run typecheck`: passed on the fresh whole-component recheck after the
  concurrently edited updater fixture was corrected. The intermediate 21:18:34
  check had found only that fixture's `ConsumerUpdateView.current` references;
  those were not personal source errors. The passing recheck was actually run.
- The later whole-component typecheck after the final teardown refinement found
  only the concurrently added fleet recovery's optional native `processIdentity`
  call. Its owning implementation added a fail-closed availability guard. The
  final fresh `npm run typecheck` recheck then passed with the frozen personal
  source. The intermediate failure remains recorded separately from that pass.
- The two affected documentation files' relative links: validated.

Private command guideline review used the current [official Zalando
guidelines](https://opensource.zalando.com/restful-api-guidelines/) before the
additive discriminant. Rules 104, 106/107, 123 and 151 support strict caller
authority, compatible extension, explicit absence/null semantics and meaningful
errors. Existing private camelCase naming is retained; HTTP routes, transport
status codes and authentication endpoints were not changed.

## Deferred Windows acceptance

- [ ] Actual standard-user picker/drop + private quarantine and immediate
      preparing UI on Windows 10 22H2/Windows 11 x64.
- [ ] Actual cancellation during source download, DirectML inference, encoding
      and cleanup; verify the complete native child tree and physical guard lifetime.
- [ ] Actual helper-loss/lost-ACK recovery retains ownership until positive native
      proof; never infer cleanup from terminal UI state, dead PID or elapsed time.
- [ ] Current boot-witness, protected storage, codecs, quality, long paths and
      signed-out/offline imports after installed relaunch.

No Windows runtime/model download, installation, native compile, actual GPU
inference, interactive UI/device operation or live account/community publication
ran for this checkpoint.
