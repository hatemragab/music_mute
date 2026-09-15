# W04 local implementation report

Status: **source held for independent review**. This is local shared-core evidence,
not native installation, GPU qualification, unattended boot, signed publication,
deployment, or production evidence. No native profile was promoted.

## Implemented source

- `worker/musicmute_worker/update/coordinator.py`: permanent versioned environment
  preparation from the W03-resolved target, verified archive before native prepare,
  retained artifact references, ordered durable status payloads, local claim hold,
  strict four-part safe boundary, refreshed selection/floor/fallback authority,
  model/service/auth callback acknowledgement, complete active pointer, actual
  runtime observation, and backend readiness before claims resume.
- `update/journal.py`: schema-3 bounded records, atomic replacement, file fsync and
  parent-directory fsync, injectable native directory flush and fault boundaries;
  read-only worker hold observation uses the same `paths.state / "updates"` root.
- `update/activation.py`: validated complete runtime/model descriptors, no state
  conversion, explicit native boundary protocol, atomic active release and separate
  retained launcher handoff/recovery records with acknowledged self-test.
- `launcher.py`: lifecycle callback executes within the existing machine lock;
  lock-bound factory and verifier reject calls after the callback returns. A child
  factory may resolve the selected active version after recovery. Startup requires
  an explicit callback acknowledgement; no nested native lock is acquired.
- `worker.py`: persistent operational hold sends recovery-only ownership discovery,
  preserving terminal cleanup/reconciliation; worker boundary never asserts native
  descendant-stop evidence itself.
- `update/policy.py`: bounded existing control methods for authoritative update
  status, runtime, qualification and readiness. See the separate root-owned wire
  integration report below.

Rollback first holds claims and obtains stopped/reconciled ownership. Both current
backend permission and signed source compatibility (or an identical code-only
runtime tuple) are required. It restores the entire retained old environment,
reports that observed runtime, and waits for readiness. Missing permission retains
repair-required quarantine; offline calls retain the hold. A backend retry/newer
revision can prepare again only after reconciliation, preserving the previous
transaction in an activation-history record. Local restart alone never clears
quarantine. Startup only reaches `running`; `verified` requires the existing
backend's independent successful processing-attempt check.

## Executed validation (2026-09-15)

Interpreter: `/tmp/musicmute-w04-resume-python/bin/python`, CPython 3.12.13,
root-created isolated launcher lock environment; no active dependencies changed.

- Combined unittest discovery of `test_update_*.py`, `test_launcher.py`,
  `test_runtime_claims.py`, `test_worker.py`, `test_execution_worker.py`, and
  `test_reliability.py`: **110 passed**, 0 failed, 20.866 seconds.
- Within that run, **47 update tests**: 25 retained W03 tests plus 12 activation and
  10 recovery tests. Launcher tests: 23 passed. Runtime claim tests: 7 passed.
- Activation fault matrix restarts after **108 fault positions / 27 durable writes**;
  rollback matrix restarts after **64 positions / 16 writes**. Each write is
  interrupted before write, before replacement, after replacement and after parent
  sync. Tests check consistent actual temporary environment markers, runtime build,
  persistent hold, retained old files and duplicate recovery.
- Launcher handoff injects all **16 positions / 4 writes** and retains both files;
  explicit false/None/integer callback answers cannot authorize startup.
- Lost acknowledgements at downloading/prepared/waiting/validating/activating/running
  replay the identical event ID and payload loaded from the actual durable journal.
- Stale/paused/superseded/floor/offline policy, boundary fields with false/unknown or
  integer values, candidate checks failing, readiness rejection, owned candidate
  rollback, quarantine retry, schema incompatibility, symlink paths and parent sync
  contracts are exercised.
- `uvx ruff format --check` on the ten touched Python source/test files: passed.
- `uvx ruff check ... --ignore TRY004,SIM117`: passed. Unfiltered scoped lint reports
  three pre-existing findings: launcher.py `read_record` TRY004 and two older nested
  context blocks in test_launcher.py SIM117. These were not behaviorally rewritten.
- `PYTHONPATH=worker .../python -m compileall -q worker/musicmute_worker`: passed.

The combined command used `unittest.TestLoader().discover('worker/tests',
pattern=...)` for the six patterns above and a single `TextTestRunner`. The W03 ZIP
traversal suite intentionally emits a duplicate `worker.py` ZIP warning.

Root separately rebuilt the actual backend and ran the Python HTTP control-client
fixture and rollout suite. See [W04-control-client-integration.md](W04-control-client-integration.md)
for precise results, rate-limit header fix, scopes and synthetic fixture limits.
Those wire tests and this real-journal replay matrix establish different layers.

## Integration obligations and limits

`UpdateCoordinator` runs under the launcher's lifecycle lock. Native integrations
must construct `DurableRecords(paths.state / "updates")` there, supply their real
`ActivationRuntime`, and use the supplied lock-bound W03 services. The runtime's
prepare operation must use the authenticated W03 bundle extractor with its disk
reservation at the permanent versioned location; it must not move a venv or mutate
an active runtime. W03's downloader already checks disk headroom before transfer.

The injected native runtime must validate the complete installed tree, model,
service/authentication, actual runtime/readiness body and native containment. It
must provide strict `True` check acknowledgements and `SafeBoundary` evidence;
unknown ownership or unverified descendants remain unsafe. Synthetic test callbacks
and marker files do not establish GPU or boot approval. The backend remains the
qualification and fresh-claim authority; the tests grant no production approval.

Windows needs a real directory-flush adapter; the default fails closed there.
POSIX fsync/fault injection proves the exercised local ordering, not physical power
loss on every filesystem. Native bootstrap must consume the launcher handoff record
and retain the previous executable. Installers, service containment, real versioned
GPU environments and unattended boot remain I01–I04/V01 obligations. No migration,
legacy adapter, actual service operation, commit, push or deployment occurred.

## Independent review correction — round 1/5

The reviewer reproduced a P2 aliasing bug at the native `prepare` boundary: the
callback could mutate the journal's signed target and make the later identity
comparison compare against that changed target. Added a regression first; it
failed with `ValueError not raised` against the held source. The regression now
requires mutation rejection, unchanged signed/policy target, no candidate commit,
and the intact old active pointer.

The same scoped inspection found direct candidate references passed to native
`stop_and_reconcile` during rollback/recovery. A second red regression reproduced
an invalid persisted candidate identity after callback mutation. Those callbacks
now receive copies too. Native validation/runtime/readiness callbacks already
received copies; the retry stop callback receives a freshly read pointer, with no
alias to its journal. Preparation receives a deep copy, and its returned candidate
is detached before comparing against the untouched verified target and persisting.

Executed after correction with the same isolated interpreter:

- `PYTHONPATH=worker /tmp/musicmute-w04-resume-python/bin/python -m unittest discover -s worker/tests -p 'test_update_activation.py' -q`: **14 passed**.
- Equivalent discovery for `test_update_recovery.py`: **10 passed** (including the
  existing activation/rollback/launcher durable-write fault matrices).
- `uvx ruff format` on coordinator.py and test_update_activation.py completed;
  `uvx ruff check` on those two files passed without ignored rules.

Only coordinator.py, test_update_activation.py and this report changed in this
correction round. Source is held again for bounded independent re-review. Native
integration obligations and all earlier evidence limits remain unchanged.
