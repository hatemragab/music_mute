# I01 closeout report

Date: 2026-09-15
Branch: `deepseek/cross-platform-worker-fleet` (cut from `codex/cross-platform-worker-fleet`)
Scope: the three named I01 closeout gates — native host registration, native
`Retry-After` persistence, aggregate spool bound — plus the install-source
decision those gates depend on.

**I01 remains IN PROGRESS.** No native adapter exists, so nothing installs on any
real machine yet. No GPU, boot, service or native-execution proof is claimed
anywhere in this report.

## Decision: the verified bootstrap stage is the v1 install source

Taken with explicit user approval on 2026-09-15 (option "From verified bootstrap
tarball"). The revised direction already governed this — *"tarball plus SHA-256,
signature/integrity still checked by hash"*, *"W03/W04 … not wired into I01"* —
and the codebase agreed: `worker/package.py` already ships
`profiles/<id>.candidate.json` and `profiles/<id>.lock.json` in the worker tree,
and `installer.install` could not previously complete on any machine because
`verifier.resolve(policy)` needs a published TUF release and every F01 profile is
`unavailable`, so `approvedProfile` was always null and the task always died with
`DEPENDENCY_RECIPE_UNAVAILABLE`.

Consequences:

- `installer.install` no longer calls `services["verifier"].resolve`,
  `downloader.download`, `verify_artifact` or `extract_artifact`.
- New `SharedActivationRuntime.prepare_from_stage(target, stage, final_path)`
  builds the environment from the stage.
- W03's verifier and W04's activation code are untouched and still in the tree.

## Gate 1 — native host registration

New files:

- `worker/musicmute_worker/platforms/registry.py` — static OS→factory bindings.
  Import order is fixed (`windows`, `macos`, `linux`). `load_hosts` tolerates only
  a platform module's own absence; a module that exists but cannot import its
  native dependency propagates, so a broken install cannot masquerade as an
  unimplemented platform. `open_host` validates that the returned host implements
  all fifteen `SetupAdapter` methods and that its `detect()["os"]` matches the
  locally detected OS. Nothing here is selectable from configuration.
- `worker/musicmute_worker/setup_config.py` — `SetupHostConfig`, the protected
  bootstrap configuration the entrypoint writes. Exact field set including the
  newly added `installerBuild`; rejects unknown fields, non-canonical paths, a
  launcher outside the releases root, a stage not named `bootstrap-<sha256>`, a
  non-executable interpreter, a symlinked interpreter, and a trust root outside
  the selected stage.
- `worker/musicmute_worker/bootstrap_release.py` — stage re-authentication.
  Parses both `shasum -a 256` and `sha256sum` inventory formats, rejects unsafe,
  duplicate or self-referencing entries, refuses symlinked or renamed stages, and
  derives the release identity from the payload bytes rather than from the
  descriptor that describes them.

Changed:

- `setup_host.main()` replaces the previous hard stub. It loads the protected
  configuration, resolves the host for the *locally detected* OS, and dispatches
  the action. It prints only allowlisted public reason codes; raw native
  exception text never reaches stdout.
- `hardware.detected_os()` extracted so host selection and hardware detection
  cannot disagree.
- `installer.install` verifies the stage **before** registration, and gates the
  approved-profile check **after** it, so a tampered stage makes no network call
  while an intact-but-unqualified stage is still reportable.
- `install.sh` writes `installerBuild` into `setup-host.json`.

### Integrity scope — stated honestly

`verify_stage` detects corruption, truncation and partial writes against the
entrypoint's recorded inventory. It is **not** a signature: anything able to
write inside the protected root can rewrite the inventory too. Authenticity
rests on the recipe digest checked at download time plus the root-owned 0700
stage, exactly as the light distribution model specifies. The backend never
treats this stage as attestation; admission still comes from the real
qualification report through B05.

## Gate 2 — native `Retry-After` persistence

Previously the entrypoints made one-shot requests with no durable deadline, so a
manual rerun hammered a throttled endpoint and the follow-on error report had no
deadline either.

`worker/install/install.sh`: a protected `state/setup/retry-after.json` holds
`{deadlineEpoch, code, schemaVersion}`. `request()` sends nothing while a
deadline is in the future. The record is validated once at top level, because
`fail` inside a command substitution only ends the subshell and would otherwise
have let a corrupt record through to the request. Headers are cleared before the
deadline check so a blocked call cannot re-persist an already-recorded throttle.
A successful registration clears the record. Only a deadline the server actually
sent is persisted; an HTTP-date header falls back to a bounded 900 s rather than
guessing a wall-clock conversion.

`worker/install/install.ps1`: the equivalent, using `HttpWebRequest` and catching
`WebException` to read `Retry-After`. `ConvertFrom-Json` may yield `Int32` or
`Int64`, so the epoch is bound through text. `REPORTING_UNAVAILABLE` was added to
the preserved safe-code list; `UNSAFE_STATE_PATH` was deliberately **not**, because
it is absent from both the importer and backend allowlists and would have been
rejected as an event code.

## Gate 3 — aggregate spool bound

`EventSpool` previously applied its 20 MiB cap to the SQLite database alone while
`events/bootstrap/` was bounded separately, so total retained bytes could exceed
the stated budget.

`native_bytes()` now counts the bootstrap directory and `budget()` subtracts it
from the cap, floored at 8192 bytes so an oversized bootstrap directory cannot
drive the database budget to zero. Diagnosis and enforcement are deliberately
separated: `inspect()` reports a non-strict count and never raises, because a
linked entry is a rejection case the importer already preserves, while `budget()`
is strict so a link cannot hide retained bytes from the cap. `inspect()` now also
reports `nativeBytes`, `budgetBytes` and `maxBytes`.

## Validation actually run

Interpreter: the private launcher environment `/tmp/musicmute-w04-resume-python/bin/python`
(CPython 3.12.13), because the default system interpreter lacks `securesystemslib`.

```
PYTHONPATH=worker <launcher-python> -m unittest discover -s worker/tests
→ Ran 365 tests, OK (skipped=17)
```

Baseline before this work was 319 tests with 2 import errors from the missing
launcher-only dependency. It is now 365 tests with zero errors; the 17 skips are
the known Windows-native and NumPy/soundfile gates.

```
uvx ruff check  <all changed files>   → All checks passed!
uvx ruff format --check worker/       → only 3 pre-existing files remain
```

New coverage: 11 stage-integrity tests, 13 registration/configuration tests,
5 native-throttling tests (including that a blocked rerun sends **no** request and
that a corrupt record sends none), 6 aggregate-capacity tests.

## Unresolved limits

- **No native adapter exists for any OS.** `registry.load_hosts()` returns `{}`,
  so `setup_host.main()` still exits 2 with `STARTUP_INSTALL_FAILED`. This is the
  remaining blocker for any real installation and is I02/I03/I04's work.
- **Windows is source-only.** No PowerShell is available on this machine, so
  `install.ps1` was not executed or syntax-checked by a parser. Its edits were
  reviewed by hand and by brace/paren balance only.
- **No profile is qualified.** All 12 F01 candidates remain `unavailable`, so an
  install against a real stage would still stop at
  `DEPENDENCY_RECIPE_UNAVAILABLE`. F01 promotion and F02 are separate gates.
- **No GPU, boot, service, containment or reboot proof** of any kind.
- The native bootstrap directory's own byte total is bounded by its 128-file
  entry cap rather than by a byte budget.