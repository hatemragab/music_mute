# Local development diagnostics

The MVP keeps diagnostics on the Mac. It does not initialize Sentry, contact the
MusicMute backend, upload a report, or send telemetry elsewhere. Local evidence
helps an engineer investigate a particular run; it does not detect every bug,
prove listening quality, or notify Codex after the active chat ends.

## Storage and privacy

`Diagnostics` writes `events.jsonl` and three rotated generations beneath the
companion's configured logs directory. Each file is at most 5 MiB; total log
retention is at most 20 MiB. Directories use mode `0700`, files use `0600`, and
unsafe symlink, hard-linked, non-owned or nonprivate files are rejected. Only
the known event generations and export names participate in retention;
unrecognized files are preserved. One companion process must own the store.
The native host's lifecycle lock supplies that single-writer boundary.

CLI Doctor and diagnostic exports construct `Diagnostics` with
`{ readOnly: true }` so they can inspect a running native host safely. Read-only
construction does not create/chmod a logs directory, open the active append
file, truncate a partial tail, rotate generations or emit recovery records.
`record()` is a no-op in this mode. The CLI can still explicitly export a new
exclusive report in the separate exports directory. A partial tail observed
during an active write is reported as incomplete coverage; only the writer may
repair it when starting. Reports mark `coverage.read_only`.

Records contain UTC time, a process-session UUID, an ordered sequence, monotonic
elapsed time, component, severity, optional random job/request UUIDs, a typed
event/code and approved measurements. Monotonic time drives elapsed durations;
clock changes are recorded separately. A terminal job event, error event and
clean close flush the file to disk. Other events flush at most five seconds
apart while events arrive.

The writer uses a field and value allowlist. Raw source URLs/video IDs, media,
cookies, tokens, configuration/environment values, raw stderr, exception text,
stack traces and personal paths are excluded. New event names, error codes or
string measurement values must be deliberately added to the allowlist. Unknown
codes become `UNKNOWN_ERROR`; unknown events become
`diagnostic_event_rejected`. This makes rejected metadata visible without
retaining its content. Never send sensitive strings into this API expecting
redaction to compensate for an unsafe caller.

The source projection now retains only the fixed browser context values `content`,
`background`, `offscreen` and `popup` in the approved stage field, plus a bounded
numeric playback generation. These survive the writer/reopen/export projection;
arbitrary context strings, exception text and paths remain excluded. Older
`UNCAUGHT_ERROR` records without this context remain unknown. A newer export must
not infer their originating browser context or rewrite them as post-fix evidence.
The current source passes 448 tests in 21 files, typecheck, 67-file lint with zero
warnings/errors, build and formatting. The new generated package is
`output/macos/build-67960e3f-97ec-44bf-a29b-662357b28677.noindex/`, with
1,113,057,345 bytes and 303 ARM64 native files; it is ad hoc signed and not
notarized. It is installed at the same `/Applications/MusicMute Local.app` path:
21 source/package/installed hash checks and strict code-signature validation
pass, with inventory prefix `1a3f1f61a192`. Spotlight shows the sole canonical
app, the prior app is preserved in a private backup, registration is unchanged
and the reopened Overview shows Mac ready. The proof is
`output/panel-controls-proof/5b59b489-8cb1-40a1-bca0-ad7a2abb76b5/installed-alignment.json`.
Its directory also contains `source-verify.json` with 88 source pins and the
448-test/21-file checks, plus `installed-app-ready.ax.txt` and
`installed-app-ready.jpg` confirming the reopened canonical Overview.
The user completed the new manual Chrome Reload and ordinary YouTube page refresh;
narrow new-build live panel acceptance is recorded below. Prior `cb26daf3`
installed and Reload evidence retains its own scope. An older screenshot showing a `send` line-111
stack may be historical or stale; it does not establish a new-build failure or
successful UI acceptance. Capturing a new real Chrome failure remains a
separate acceptance check.

Browser diagnostic delivery catches both synchronous `sendMessage` failures and
rejected promises without reading, logging or exporting exception text. The
error/unhandled-rejection capture returns an idempotent disposer. Content
recognizes only the exact Chrome extension-context invalidation message, with an
optional final period; missing-receiver and transient port errors follow the
ordinary connection-failure path. Invalidation retires content handlers, clock
timers, observers and pointer capture, restores the owned original mute state,
and presents a safe instruction to refresh YouTube. It cannot recursively throw
while trying to report the invalidated context.

The compact panel is at most 304px wide and starts at the top right. During an
active session the waveform toggles it; Close and Escape dismiss it without
changing the job, generation, mute ownership or clocks. Progress, READY and
playback updates preserve dismissal. Cancel and Stop remain separate actions;
only the context-invalidation safety notice may reopen the panel. Its clamped
pointer/keyboard movement and ResizeObserver use no timers or persisted position;
hide/dispose releases capture and disposal removes the movement listeners and
observer. Panel visibility is not a playback or diagnostic failure.

New native records, app-shell journal entries and report metadata include a
recorder-owned identity: software version, packaged/development scope and expected
model SHA-256. A packaged process reads the owned bundle inventory once, with an
8 MiB bound, and includes its fingerprint when safe. Only approved scalar values
are exported; inventory filenames and contents are not. Missing or unsafe
inventory leaves the fingerprint unknown without blocking audio processing.
The fingerprint identifies the inventory, not fresh verification of every
installed byte, the code signature or Chrome's loaded extension.

Retained records keep their original validated identifiers. Older records without
identifiers remain unknown, even when a newer app exports them. Successful native
pipeline and validated cache records can separately carry
`verified_model_sha256` through a trusted native recorder method. Generic browser
events cannot set it. Cache verification requires retained provenance written
by the trusted native pipeline after validation; legacy, fixture and provider
result fields cannot create that provenance. An expected model is not a verified
run, and a cache hit does not imply new inference. The Diagnostics screen labels the report recorder
and expected model; exported events contain their own historical identity.

Completed native processing records whether a full upstream audio-track ID was
known as `source_audio_track_id_known`. If the upstream supplied a boolean
default flag, `source_audio_is_default` retains that value; omission means unknown.
Raw track IDs are excluded. These observations describe extractor metadata,
not original-track or browser-selected-track verification.

## Summary and export

`snapshot()` provides a bounded summary under 24 KiB for the native control
channel. It includes recent errors/warnings, event counters, observed peaks,
up to ten job summaries, stage durations and coverage markers. It deliberately
omits older detail; `snapshot_is_summary` and truncation flags make that visible.
Counters and peaks summarize the retained history loaded at startup plus the
current session's events. They can include events whose log generation was
subsequently evicted. They are not lifetime application statistics.

`export()` saves a more detailed JSON report under `logs/exports/` and returns
its local path. Reports include up to 500 recent sanitized events and 100 job
summaries. Each export is capped at 5 MiB and the four newest known exports are
retained. Export destinations are generated internally, opened exclusively,
and never overwrite another file. The returned report is too large for some
native messages: send `snapshot()` and the export path through that channel.
Opening or sharing the exported file is an explicit local user action.

The Mac app combines processing, setup and app-shell evidence. Its control reply
measures the complete 64 KiB envelope, including protocol metadata, newline and
export path. It trims older activity/job summaries and journal entries as needed,
sets the existing history/truncation markers, and keeps recent alerts when space
allows. This compact reply does not modify the separately saved full export.

On startup a torn final line is removed from the active log, valid records are
recovered, malformed records are skipped, and the sequence advances past valid
retained evidence. Coverage reports missing sequences, malformed records,
discarded tail bytes, rotation/truncation, unavailable storage and rejected
fields. A write failure does not throw into the processing pipeline or silently
hang a job: reports explicitly change to `diagnostics_unavailable` with a safe
reason code. A bounded in-memory summary remains available for inspection.

## Performance observations

`beginSample(pid, callback)` samples a known owned process every five seconds and
returns a stop function. Always call it in the corresponding `finally` block.
The companion sample records RSS, JavaScript heap, CPU over the sample interval
and the count of active Node resources. Child-process samples use the Mac's
`/bin/ps` with a numeric PID, bounded output and a two-second timeout; its CPU
value is the operating system's process CPU statistic, not an instantaneous
inference benchmark. Callers add the owning job UUID before forwarding a child
sample. No process inventory, command line or environment is collected.

Warnings are observations with explicit thresholds:

- `PLAYBACK_DRIFT_SUSTAINED`: at least three samples with absolute drift at least
  150 ms across at least two seconds. An observed recovery below 75 ms starts a
  new episode. This tests media clocks, not acoustic lip-sync at the speakers.
- `JOB_STALLED`: at least 120 seconds without a new stage or changing progress
  value while further job observations arrive. Some legitimate model operations
  have no intermediate progress; inspect CPU, stage and child evidence before
  diagnosing a deadlock.
- `JOB_LONG_RUNNING`: an observed active job exceeds five minutes. This is not
  a hard timeout or a prediction of completion time.
- `RESOURCE_RSS_GROWTH`: at least six samples spanning 30 seconds, RSS growth of
  at least 256 MiB and at least 50 percent above the first sample. Model loading,
  decoding and allocator caching can explain growth. This warning does not prove
  a memory leak. It identifies a run to investigate with repeated idle baselines.
- `RESOURCE_COUNT_HIGH`: more than 128 active Node resources. The count alone
  does not identify a leaked handle.

GPU memory, browser frame memory, unsampled descendants, audio quality and
operating system output latency remain explicit coverage gaps. The engine's
optional MPS allocation figures are boundary measurements; driver allocation
is not a measured peak. Every independent child process needs an explicit
sample if its memory is to be covered.

After the user's manual Reload of prior `cb26daf3`, an ordinary HTTPS YouTube
check used a cached 219.521-second source: Play showed original mute true, Pause
was at 82.98 seconds, Home moved to 0, ArrowRight to 5 seconds, playback resumed
at 1.5x, then returned to 1x and Stop restored original mute false. This is partial
prior-build controls evidence. It does not establish physical listening,
selected-track matching, measured offscreen closure beyond 30 seconds or the
restart matrix. `prior-cb26-host-summary.json` is the latest bounded history,
not a report correlated to that UI cycle, and must not be cited as proof that
the cycle had zero errors. Pre-fix long-pause/retry and navigation failures retain
their historical identity.

The new ordinary HTTP fixture runs actual compiled `content.js` and CSS against
a fake Chrome runtime. It covers panel hide/progress/READY/playback/reopen,
arrows with Shift, Home, 430px/320px player resizing and icon centering, without
extension loading or real audio. Native pointer attempts missed the intended
coordinates, so dragging has only the helper's 24 unit cases. Hidden-fixture clock
messages advanced from 9 to 2,394 with one Start and zero Stop/Cancel; explicit
Stop sent one Stop and restored mute.
Saved `fixture-cases.json` in the proof directory covers actual compiled
Cancel/Stop handlers and simulated context invalidation with restored mute and
no fixture errors. This remains fake-runtime evidence.

The installed `67960e3f` controls were separately observed on actual YouTube after
the user's manual Reload and an ordinary page refresh, with the new
`aria-controls`/expanded state present. A cached 219.521-second source showed
Preparing; Close hid the panel while playback continued at 142.796858 then
176.52433 seconds, paused false and original mute true, without Stop or restart.
Pause/reopen at 176.588492 seconds preserved pressed/muted true. ArrowLeft and
Shift+ArrowDown moved within a 1282.975 × 721.669px player, Escape hid the panel and
focused the waveform without changing the session, and Home restored the 12px
top-right anchor. The panel measured 304 × 127.70px and both icon-center offsets
were zero. The evidence is
`output/panel-controls-proof/5b59b489-8cb1-40a1-bca0-ad7a2abb76b5/real-youtube-panel-cases.json`
and `real-youtube-compact-controls.jpg` in that directory.

The updated `real-youtube-panel-cases.json` separately records actual context
revocation during an active session: the waveform was disabled, the Refresh
YouTube notice appeared and the video paused with original mute false.
`real-youtube-reload-notice.jpg` preserves the notice. An ordinary HTTPS page
refresh and retry restored cached voice-only playback at 93.725681 seconds,
paused false and original mute true. Final Pause/Stop at 135.563223 seconds left
paused true, original mute false and waveform pressed false. This narrowly
verifies revocation and reconnect after page refresh; the cause of revocation is
not inferred from the UI.

The final `real-youtube-console-summary.json` is a bounded 491-record snapshot:
all records are in the older 13:52:36–13:53:33 range, with zero errors/warnings
after the installed alignment cutoff `14:19:33.362Z`. This is only a cutoff-scoped
console observation, not a claim that the profile was cleared or its entire
history is error-free. Exact synchronous/rejected invalidation and safe diagnostic
capture also have handler tests. The saved `new-build-host-summary.json` contains
the latest 117 bounded rows across two hosts, four cache READY results and
`code_counts: {}`; it is not necessarily a report for one UI cycle and does not
prove new inference. Physical listening, source identity, native pointer UI
dragging, the measured >30-second offscreen case and the full browser restart,
offscreen and sleep/wake recovery matrix remain open.

## Development investigation cycle

1. Reproduce with a synthetic fixture, short owned media, or an explicitly
   selected test video. Preserve the job UUID and start/end time.
2. Export diagnostics after the run and inspect the terminal job state, stage
   durations, peaks, warnings and coverage before assuming a cause.
3. For browser failures inspect the extension service worker, offscreen document
   and content script consoles through Chrome's extension inspector. Structured
   errors record the component and typed code, never raw exception details.
4. Fix the identified behavior and rerun the same fixture. Compare timings and
   idle resource baselines after repeated start/cancel/finish/navigation cycles.
5. Keep fixture/unit checks distinct from a real YouTube download, native host
   installation, model inference and audible synchronization proof.

During an active development chat Codex can inspect the local report using file
tools and correlate it with test output. There is no background service that
sends messages to Codex, and a diagnostic report never automatically opens a
remote issue or notifies another person.

Run the focused privacy, retention, recovery and resource timer tests with:

```sh
npm test -- tests/diagnostics.test.ts tests/extension-diagnostics.test.ts tests/panel-movement.test.ts tests/resource-monitor.test.ts
```
