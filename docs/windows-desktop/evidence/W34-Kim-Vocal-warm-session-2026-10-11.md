# Evidence: W34 — retained GPU model between personal songs

Date: 2026-10-11, Cairo client date. Scope: source implementation and isolated
production-engine acceptance on the connected Z440, Windows 11 build 26200 x64,
AMD RX580, driver `31.0.21925.1001`. The requested minimum remains Windows 10
22H2 x64; this target does not establish Windows 10 acceptance.

**Final-source physical timing passed:** warm-03/v15 measured 50.6495230 seconds
for the first call and 33.4283341 seconds for the second call in the same engine.
Pinned inspection, complete decoding, independent output readback and exact task
retirement passed. Native-38/source-42 also passed all eight build targets and four
CTests. The separate seven-case physical guardian cohort passed on the same Z440.

## Implemented behavior and proof boundary

The [desktop runner](../../../windows-desktop/src/main/personal/runner.ts) retains
one personal engine for serial jobs. The
[Python session executor](../../../worker/engine/musicmute_engine/consumer_personal.py)
shares its pipeline and prepared model while each job receives a fresh workspace.
The [pipeline](../../../worker/engine/musicmute_engine/pipeline.py) reuses the loaded
separator; the [separator](../../../worker/engine/musicmute_engine/separator.py)
clears source, output and callback state before a detached completion is acknowledged.
Session/job identities, native quiescence, GPU identity and model/configuration
checks fence reuse. Failure, cancellation and explicit retirement preserve the
existing cleanup requirements. The
[native retained-engine owner](../../../worker/native/windows-consumer/retained_engine.hpp)
belongs to the standard user's logged-in session.

This records source behavior. The isolated Python QA run calls the production
`PersonalSessionExecutor.execute` twice in one owned process; it does not run the
installed Electron app or prove Windows logout, Chrome or account journeys.

## Fixed input, recipe and quality requirements

The same anonymous media015 private copy is used, source duration 283.562 seconds.
The production recipe remains `kim-vocals-v2`, revision 6: trim and denoise disabled,
MP3 160 kbit/s, 44,100 Hz stereo. DirectML GPU0 is required with CPU inference
fallback disabled. Decoding, DSP and encoding can use the CPU. Provider profiling
is disabled in this timing run; per-node GPU counts remain unproved.

| Item                  |      Bytes | SHA-256                                                            |
| --------------------- | ---------: | ------------------------------------------------------------------ |
| Input                 | 12,634,231 | `b6bdbddde76c864c8c00f67ba697058396b3f211177009509fc490c79df19c8e` |
| Kim model             | 66,759,214 | `ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b` |
| Recipe                |          — | `23e22a5fe3b9a604f7ff5241f0fa7194bacf153fc37df83d83898949610a89d9` |
| Baseline MP3          |  5,672,272 | `77d2e6a8c29ca0e52731a5ad134b68ffa048d3bb9c4110fd14a8397d149c1960` |
| Baseline original AAC |  5,764,901 | `ad4a9fe23fa71bbef08154e81e584b33b91be8440ed858b6b24546486dd2d4c0` |

Both final-source warm-03 jobs matched these output byte counts and hashes, retained the same
full-coverage edit map, passed complete FFmpeg decoding and independent held-handle
whole-file readback, and preserved the input. Readback verified the same handle's
birth identity, canonical owned path, single link and non-reparse regular file.

The final unsigned candidate's exact 24-file Python source census and `engineDigest` are
`928aafa9a20913c9202d5b51d83f94452b225c4d4421697086b2f9801cb65144`.
That digest hashes compact sorted-key ASCII JSON records of source path, bytes and
SHA-256. The historical release engine digest
`1475d4120cf10ea3563ec1dec5727c6f7b7cd0cfb87471b8dde2e832593dd6e0`
is recorded separately; it does not identify this unsigned candidate.
The final census includes changes to `consumer_personal.py`, `media.py`,
`qualification.py` and `windows_guardian.py` for detached-console tool/guardian
launching. Pipeline, separator and recipe files are byte-identical to the earlier
warm candidate.

## Timing comparison

| Production execute scope                          |      Elapsed | Model load or retained lookup | Status          |
| ------------------------------------------------- | -----------: | ----------------------------: | --------------- |
| Functional-02, original fresh engine              | 53.2763663 s |                  16.0141488 s | Passed          |
| Functional-06, repeated fresh engine              | 49.8113884 s |                  15.0878792 s | Passed          |
| Warm-02/v14, first call before tool-flag updates  | 50.7306438 s |                  15.1095838 s | Historical pass |
| Warm-02/v14, second call before tool-flag updates | 32.3840927 s |            0.0000037 s lookup | Historical pass |
| Warm-03/v15, final-source first call              | 50.6495230 s |                  15.8295115 s | Passed          |
| Warm-03/v15, final-source second call             | 33.4283341 s |            0.0000041 s lookup | Passed          |

The final-source warm call took 17.2211889 seconds less than its paired cold call,
a 34.0% reduction, and 37.3% less than the original 53.2763663-second run. These are
measured results for this song and pair. Final-source separation took 23.9687653
seconds cold and 23.1718192 seconds warm; the warm call's primary demix took
21.3179540 seconds, included within separation, and encoding took 2.7498024 seconds.
The historical v14 pair used the earlier candidate census
`03088db1ac577b64373aa551c9c6c0d39087ee3376c507c98ed755b6a769e24e`;
its 32.3840927-second result is not the final-source timing.

The same pipeline, warmed separator and ONNX Runtime session objects were retained.
Both results acknowledged detached job state; `modelReused` changed from false to
true. The second call created no new model session or warm-up and returned no
`startupTimings`. DirectML session policy and disabled CPU inference fallback
passed. Provider profiling remained off; these observations do not establish
per-node GPU execution counts.

The timer surrounds production `execute`, including validation, preparation,
model loading when needed, separation and encoding. Python startup, QA setup and
checks after the call are outside that timer. A fresh engine is a cold model/session
load; the operating system's file-cache state was not established. See the
[prior timing repeat](W34-Kim-Vocal-timing-rerun-2026-10-11.md) for its verified
receipts, output readback and exact task retirement.

Final-source warm-03/v15 run UUID: `e83ce6f1-4c6d-4b43-8f8a-875a6c24c7c7`.
Controller receipt SHA-256:
`7f7ccbbba8d84a73323579561775e180e004db0661625b86d0af5d76744a4128`.
Production report SHA-256:
`f62299c487ee858cbcf3cf7330c0df6b069fbe85647a26e405792c33d8e49418`.
The pinned PowerShell inspector and independent held-file auditor accepted both
jobs. Execution used limited Session 1; actual owned Job-zero was confirmed.
The pinned v15 retirement helper passed `ValidateOnly`, then retired only the
exact warm-03 task at **19:08:17 UTC / 22:08:17 Cairo**. Exact task removal and
preservation of evidence artifacts passed.

Warm-02/v14 run UUID: `ee4887db-fe70-4308-83b1-a38143b630b7`.
Controller receipt SHA-256:
`6f742f4b26c07c6f382ec452b0817af015491575fbf7bfe0305d2d8e04638051`.
Production report SHA-256:
`4cb29863071ebddab596a39824a93b6c1378fe391c9480b4dac2e02e7b28b3a6`.
The pinned PowerShell inspector and independent held-file auditor accepted both
jobs. Execution used limited Session 1; actual owned Job-zero was confirmed.
The pinned v14 retirement helper passed `ValidateOnly`, then retired only the
exact warm-02 task at **18:44:45 UTC / 21:44:45 Cairo**. Task removal readback,
actual Job-zero confirmation and preservation of evidence artifacts passed.

## Preserved QA and native failures

Warm-01/v13 used the actual limited Session 1 desktop token and reached the first
job's `output-ready` stage, then failed the QA assertion
`QA_WARM_SAMPLE_RESULT_REJECTED`. No second job ran and no warm timing passed.
The assertion incorrectly equated the media-duration sample count with decoded
separation samples. The pinned functional-02 report establishes:

| Counter                   |  Verified value |
| ------------------------- | --------------: |
| Measured input samples    |      12,504,114 |
| Source and output samples | 12,504,373 each |
| Removed samples           |               0 |
| Measured input duration   |        283.54 s |
| Measured output duration  |    283.545873 s |

The single edit-map range remains source/output `[0, 12504373)`. v14 changes only
the QA counter assertion and dependent helper pins/fixtures. Candidate Python,
recipe, model, edit map and output hash requirements remain unchanged. The failed
run and its artifacts are retained: UUID `8577b286-f3b0-4e5a-8ac1-c448cd5da61c`,
controller receipt SHA-256
`58027cf9c4b01a6ba9b0c9bcbd20156255b84a6b4875f2dfbc632d87dcd0a21c`.
Actual owned Job-zero cleanup was confirmed; this is not a successful processing
acceptance result.

Native-36 and native-37 compiled all eight targets but passed only three of four
CTests. The strict unknown-peer guard fixture failed; those failures were retained,
and the exact completed tasks were retired with actual Job-zero confirmation.
Native-38/source-42 then passed all eight build targets, `describe` and four of four
CTests: runner exit 0, elapsed 133,327 ms. Actual owned Job-zero was confirmed.
After `ValidateOnly` passed, only its exact task was retired at approximately
**18:58 UTC / 21:58 Cairo** (minute precision); artifacts were preserved.
Source-41 remains an exclusive, unactivated local archive.

| Native-38 evidence | SHA-256                                                            |
| ------------------ | ------------------------------------------------------------------ |
| Native source-42   | `9c70a3e65f3287fdeba270404e06b24fee3c96a793831000d69f6c75ae2ee1bb` |
| Target record      | `da4dc5e9b12b7271285fa8024c26070d98ea82b137dfb05f814b1fb78a37377a` |
| Artifact record    | `99f4f42ed9a0e1816366a061c9da5250e500453438e5539db19214e99a87e33d` |

## Recorded code checks

| Root-recorded check                                                   | Result                                                      | Scope                                                                   |
| --------------------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------- |
| Desktop `npm test -- --maxWorkers 2`                                  | 2,213 passed / 234 files                                    | Final local code fixtures                                               |
| Desktop `npm run typecheck`, `npm run lint`, `npm run build`          | Passed                                                      | Local source/build checks                                               |
| Worker `pnpm test`                                                    | 1,049 passed, 21 skipped; 115 passed files, 5 skipped files | Final local code fixtures; skips preserved                              |
| Python engine unittest discovery with the qualified local interpreter | 160 run: 158 passed, 2 Windows-only guardian skips          | Final local source checks; physical guardian cases remain separate      |
| v15 QA controls                                                       | 30 positive / 118 negative passed                           | Pure recorders; no inference or native starts                           |
| Separate seven-case guardian cohort on Z440                           | 7 passed, 0 skipped; 2 native cases                         | Limited Session 1, non-admin x64; separate physical supervisor fixtures |

The final Python command ran from `worker/engine` in 8.213 seconds. Only the local
home-directory username is redacted below; the qualified release path is retained:

```sh
'/Users/<local-user>/Library/Application Support/MusicMuteLocal/runtime/releases/macos-arm64-v1-c923b1be1f135d8c48ef81c9/runtime/runtime/python/bin/python3.13' -B -m unittest discover -s tests -p 'test_*.py'
```

v15 controls include the corrected measured-input counter and rejection of v13's
incorrect value, stale sibling-job paths, changed recipe/quality, invalid detached
ACKs, fallback/profiling policy and malformed types. The PowerShell inspector uses
the same strict functions in its synthetic fixtures and accepted the pinned
warm-03 report as recorded above. Added flag controls accept only typed 0 or 8
after existing caller, argument and environment fences, reject unknown flags and
retain the upstream version query's original absent-flag semantics. The receiving
controller keeps suspended creation, owned Job assignment and detached-console
launching without a breakaway flag.

## Physical guardian validation

Guardian-code-03 passed seven tests with zero skips, including both Windows-native
cases, using the actual limited Session 1 / non-admin x64 token. Independent pinned
PowerShell inspection and retirement `ValidateOnly` passed. The exact task was
retired at **19:21:33 UTC / 22:21:33 Cairo**, with actual owned Job-zero confirmed
and zero evidence files removed. This separate unit cohort used no model or network
and did not touch songs.

Run UUID: `1ba514ec-ff1e-4b6b-a7e3-9974df1b7c72`; source root: `source-03`.

| Guardian evidence                |  Bytes | SHA-256                                                            |
| -------------------------------- | -----: | ------------------------------------------------------------------ |
| Controller receipt               |      — | `f08299bbeb0d7a06138f5de41eec4b8fe0130f2921beb632b1200719c8e3f458` |
| Test report                      |    888 | `04eafd64827f99eefdf70209ea257adc97d59411b7f3559b5e8424ef3978f7fc` |
| QA source-03 digest              |      — | `2af640950afc480b84a3ccf82f7a0f2b061685bcc84bef8ad64daa6629a32523` |
| Production `windows_guardian.py` |  6,224 | `f5fed65f4280dac98accd0404b59ad82deafbee50f48790630b9e69163576e29` |
| `test_windows_guardian.py`       | 12,957 | `ed61568610df0d26458ef56a48ab81416062b825aa47d41e7624dc1d8d305e4f` |

All six PowerShell files parsed with zero errors. Scalar controls passed eleven
positive and eleven singleton-array negative cases without task mutations.
The separate physical run verifies the two Windows-only guardian cases skipped
locally. The full local discovery result remains **158 passed / 2 skipped out of
160**; it is not rewritten as 160 Windows passes. Guardian process shutdown
fixtures do not establish actual Windows user logout or operating-system shutdown.

## Protocol review and remaining gates

The private STDIO protocol preserves v1 behavior and explicitly selects retained
v2 sessions. Applicable JSON/UTF-8, unique-member, compatibility and security
guidance was reviewed against the
[official Zalando guidelines](https://opensource.zalando.com/restful-api-guidelines/).
Explicit closed command/result field allowlists are a deliberate authority boundary
for this private protocol; they are not a claim that Zalando requires closed schemas
for public REST responses. HTTP routing, media-type versioning and OAuth rules do
not apply to this STDIO exchange.

Signed runtime/installer inputs, installed-app Prepare/processing/cleanup,
account/Chrome/playback, logout behavior, Windows 10 and the remaining filesystem
containment gates stay open. No external journey checkbox is closed by this page.
The final v15 timing candidate includes the production tool/guardian flag changes.
Production Node, native-helper and Python-guardian spawning changes select
`DETACHED_PROCESS` to avoid a console-host descendant. Owned Job, STDIO,
parent/session watching and disabled CPU inference fallback remain required.
The final local checks and native-38 result cover their recorded source/fixture
scope. The direct-executor timing run and separate guardian cohort provide their
respective processing and supervisor evidence. No recipe change accompanies the
flag changes.

- [x] Retained-model source implementation and per-job detach fences.
- [x] Final local desktop, worker and Python checks; recorded skips preserved.
- [x] Recorded Windows native build: eight targets and four CTests passed.
- [x] Paired final-source song timing and byte-identical quality/readback checks.
- [x] Windows guardian process shutdown fixtures: seven passed, including two native cases.
- [ ] Signed runtime/installer and installed-app Prepare/processing/cleanup acceptance.
- [ ] Installed Chrome, account and playback journeys.
- [ ] Windows 10 22H2 x64 physical acceptance.
- [ ] Actual Windows user logout and operating-system shutdown acceptance.
- [ ] Remaining filesystem containment gates outside the recorded fixture scope.
