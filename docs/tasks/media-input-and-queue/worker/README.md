# Windows worker implementation tasks

**Status: not started; plan approval required.** Read [scope](../scope.md) and [contracts](../contracts.md). Own worker runtime/tests/docs only. Preserve the existing single-assignment warm separator, machine-wide exclusion, Job Objects, DPAPI setup, ownership selectors, journal, and upload reconciliation. No live worker operation, increased concurrency, fleet creation, or model replacement.

## W01 — Accepted limits, bounded decoding, and capabilities

**Depends on:** B01, B05, R01. **Consumes/produces:** C4 assignment limits and capability agreement; measured input/output duration and bytes for backend reconciliation.

**Modify:** `windows-worker/musicmute_worker/{worker.py,config.py,transport.py}`, `windows-worker/tests/{test_worker.py,test_warm_worker.py}`, `windows-worker/README.md`.

**Create:** `windows-worker/musicmute_worker/media_limits.py`, `windows-worker/tests/test_media_limits.py`. Place effective-limit parsing/validation here rather than scattering another set of numeric constants throughout the worker.

- [ ] Add pure limit tests for legacy exclusive 600-second/30 MB behavior and v2 inclusive 1800-second/100 MB behavior. `effective_media_limits(assignment, verified_capabilities)` must return the stricter compatible policy or reject; unknown versions never become unlimited.
- [ ] Report capability agreement through the existing authenticated identity/claim flow and validate backend-assigned limits. Keep one runtime assignment. Old journals without new fields use the legacy limits.
- [ ] Refactor `inspect_audio` to use effective limits for bounded probe/decode and stream validation. Prepared inputs and output remain audio-only. Check real decoded/presentation duration, finite positive values, unsupported/default-track failures, and decoder errors.
- [ ] Handle priming/padding with documented presentation timing; prove exact 30-minute fixtures pass and genuine excess fails without trimming. Limit decoded sample/frame counts, child duration, bytes, and wall time even when metadata is false.
- [ ] Enforce compatible output size and duration throughout generation/validation/upload. Maintain checksum, MP3 decodability, accepted acoustic output flow, immutable object identity, and output-reuse recovery.
- [ ] Require backend measured-admission acceptance before starting the separator; a reservation adjustment failure must terminate preparation cleanly without consuming AI capacity.

**Test seed, in `test_media_limits.py`:**

```python
limits = effective_media_limits(v2_assignment, verified_capabilities)
self.assertTrue(limits.accepts_duration(1800.0))
self.assertFalse(limits.accepts_duration(1800.001))
self.assertTrue(limits.accepts_input_bytes(100_000_000))
self.assertFalse(limits.accepts_input_bytes(100_000_001))
```

Define `effective_media_limits` and the returned `MediaLimits` methods in `media_limits.py`; fixtures explicitly contain all C4 fields. Add legacy, malformed capability, and byte-versus-duration attack cases.

**Validation (repository root):**

```sh
PYTHONPATH=windows-worker python3 -m unittest discover -s windows-worker/tests -p 'test_media_limits.py' -v
PYTHONPATH=windows-worker python3 -m unittest discover -s windows-worker/tests -p 'test_worker.py' -v
```

**Acceptance:** passing portable unit tests plus separately labeled bounded-media decoding evidence; real Windows/model proof requires the authorized test environment. Source inspection alone cannot establish 30-minute acoustic quality or machine safety.

## W02 — Execution timing, bounded attempts, and cancellation recovery

**Depends on:** W01, R02. **Consumes/produces:** C4 execution evidence, accepted cost-model/timeouts, C2 terminal settlement evidence.

**Modify:** `windows-worker/musicmute_worker/{worker.py,processes.py,engine.py,config.py}`, `windows-worker/tests/{test_worker.py,test_warm_worker.py,test_processes.py}`, and `windows-worker/README.md`.

**Create:** `windows-worker/tests/test_execution_evidence.py` for monotonic execution reporting, interruption/restart, and duplicate event cases. Extend the current journal rather than creating a parallel job store.

- [ ] Test stage timing with a fake clock: queue/transfer/offline/validation intervals must not increase separator execution; actual warm/cold attempts do. Persist enough evidence to recover after restart without resetting attempt usage.
- [ ] Apply accepted duration-based processing timeouts bounded by verified local safety limits. Use R02 evidence for overhead and margin; preserve a hard upper bound for hangs. Retry count and accumulated execution stay bounded across restarts.
- [ ] Emit cumulative execution evidence through existing idempotent events and selectors. Never report stopped merely because the backend heartbeat expired or a local timer fired.
- [ ] Prove cancellation/timeout kills the contained process tree and reconciles the warm engine state before acknowledging stop. If stop cannot be proved, preserve recovery-required state and occupied ownership.
- [ ] Distinguish user cancellation, service failure, invalid input, and upload-only recovery so backend C2 accounting can settle correctly. Preserve a finished output for upload retry; do not rerun AI after an uncertain upload.
- [ ] Verify output cleanup occurs only after durable server receipt/reconciliation and that input cleanup does not destroy material needed by an interrupted attempt.

**Required assertion:** a fixture with 20 seconds queued, 5 seconds validation, 12 seconds separator execution, and 7 seconds upload reports `separatorExecutionSeconds == 12`; replaying the final event does not add another 12 seconds. A timeout followed by unknown child state reports no `stoppedConfirmed=true`.

**Validation:** `PYTHONPATH=windows-worker python3 -m unittest discover -s windows-worker/tests -v`; use the existing offline Windows containment/self-test only in the authorized idle test environment. No claim/release or production benchmark as part of a local test shortcut.

**Acceptance:** bounded worst-case attempt handling, trusted execution accounting, and explicit Windows containment evidence or a documented blocker. These tasks do not make one slot process multiple jobs simultaneously.
