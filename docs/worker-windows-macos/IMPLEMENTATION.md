# Windows and macOS worker implementation

Started 2026-09-29. This ledger distinguishes implementation, fixture checks,
native hardware evidence and release/publication. No publication is authorized.

## Requested outcome

- Extend the current `mw` CLI and shared processing core for Windows and macOS.
- Remove retired MusicMute Windows installations; work in the existing Windows
  build location rather than creating another experimental checkout.
- Provide native lifecycle, diagnostics, installation/update recovery and benchmarks.
- Support two independent DirectML workers with hardware-bound capacity evidence.
- Preserve a small native adapter boundary for a future Ubuntu implementation.
- Use direct implementations, with no old-installation migration or compatibility
  bridge added for this work. Preserve unrelated repository edits.

## Architecture and external references

The existing Node supervisor and Python engine remain shared. Native adapters own
service management, paths, permissions, process containment, locks and GPU identity.
Common CLI operations/reporting and benchmark validation must not depend on macOS
paths or launchd. Each GPU worker owns a separate inference session and process.

- [DirectML session configuration, concurrency and fixed-shape tuning](https://onnxruntime.ai/docs/execution-providers/DirectML-ExecutionProvider.html)
- [Windows service access control](https://learn.microsoft.com/en-us/windows/win32/services/service-security-and-access-rights)
- [Windows Job Objects and child ownership](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)

DirectML sessions retain sequential execution and disabled memory patterns. Two
workers are distinct sessions, never concurrent calls into one session. Qualification
must prove actual accelerated dispatch, valid output, bounded resources and measured
throughput benefit. CPU fallback must not silently qualify an accelerated worker.

## Delivery and evidence checklist

- [x] Remove retired Windows installations and verify the exact removed scope.
- [x] Rebuild a current native Windows runtime with verified pinned dependencies.
- [x] Share reusable operator/reporting code and route normal commands by platform.
- [x] Windows native permissions, exclusive locks and abandoned-owner recovery.
- [x] Windows local lifecycle/status, graceful drain and idempotent start/resume.
- [x] Windows durable install/update recovery and verified rollback.
- [x] Common repeated file benchmark with DirectML measurements and progress.
- [x] Windows hardware-bound two-worker qualification and activation support.
- [x] TypeScript/Python regression, packaging and native process-ownership tests.
- [x] Windows one/two-worker measurements and output comparisons on the 12-second fixture.
- [x] macOS command/runtime regression and native benchmark validation.
- [x] Native Windows service, restart and interruption acceptance.
- [x] Current backend/storage integration with synthetic jobs and failure cases.
- [x] Final source/diff, package inventory, security and requirement audit.

## Initial live inventory

Windows 11 Pro x64, Xeon E5-1660 v3 (8 cores/16 threads), approximately 24 GiB RAM,
Radeon RX 580, driver 31.0.21925.1001. The CIM AdapterRAM field is not accepted as
proof of dedicated VRAM capacity. Administrator token confirmed. No MusicMute
service, matching executable process or scheduled task was found. Retired installed
releases 0.1.0 through 0.1.3 and old build/download artifacts were present.

At the initial inventory, no new Windows runtime or benchmark had passed. The
dated evidence below records subsequent candidates and validation. Linux runtime
support is future work.

## Current implementation evidence

SSH access was rechecked against `DESKTOP-QKJDJ2G`. The retired
`C:\ProgramData\MusicMuteWorker` tree is absent after removal. The two retired
MusicMute download directories and the 0.1.2/0.1.3 source, packaged runtime,
archive and build-result files were removed. The existing `C:\MusicMuteBuild`
location retains `incoming`, `media-runtime` and `winsw-runtime`; retained
dependencies still require verification before use in the new build.

Operational logs, investigations, performance reporting and drain handling now
live under `worker/src/platform/shared`. Windows lifecycle and diagnostic locking
use an exclusive OS-owned named pipe; macOS retains its existing advisory lock.
Windows native lock acceptance remains pending.

DirectML progress instrumentation observes the original pinned MDX window loop.
Its regression test executes the upstream windowing implementation with identity
inference, checking exact output equivalence at partial and complete window
boundaries, warmup exclusion and failure cleanup. This is a CPU fixture test,
not proof of native DirectML inference.

`MUSICMUTE_PYTHON=<installed private macOS Python> pnpm run test:engine` passed:
78 tests ran, with the Windows-only test skipped on macOS. Native Windows
service, GPU throughput, two-worker capacity and current backend/storage
acceptance remain unchecked.

## Native build and lifecycle progress

- Fresh build dependencies in the existing `C:\MusicMuteBuild`: Node 24.18.0
  (official Windows ZIP SHA-256 checked), Python 3.12.10 (official NuGet package;
  executable Authenticode signature verified as Python Software Foundation),
  pnpm 10.14.0 and the repository's exact DirectML dependency lock.
- Private Python import verification reports ONNX Runtime 1.24.4 with
  `DmlExecutionProvider`; `pip check` passes. Provider availability is not a
  measured inference qualification.
- Windows compilation passed. Six focused suites passed on the Z440: 24 tests,
  including exclusive native lock release after a sacrificial process dies.
  Windows operator tests use an injected service controller; real SCM inspection,
  installation, service transitions and GPU processing require separate proof.
- Normal CLI start/stop/restart/pause/drain/resume/status now dispatch to the
  Windows adapter. The adapter checks service executable/account identity and
  private installation ACLs. Status matches the supervisor PID and creation time.
- Shared drain now requires the requested lifecycle revision to be acknowledged
  by the serialized claim loop. Regression coverage holds a claim in flight,
  changes intent, and checks that acknowledgement cannot precede its return.
- Qualification timing now uses `perf_counter()`; Windows Python 3.12's coarse
  `monotonic()` clock produced zero elapsed time in short fixture operations.
- Windows release packaging uses `pnpm run package:windows`; it invokes pnpm's
  JavaScript entry through Node, without attempting to execute a `.cmd` file or
  constructing shell command strings.
- Local macOS checks passed: protocol, formatting, lint, TypeScript, 432 tests
  with three platform-specific skips, seven packaging tests, build, and 78
  Python tests with the Windows native guardian test skipped.

- Full native Windows Python suite now passes: 78 tests, no skips, including
  guardian-owned Job Object cleanup after parent death. The native SCM adapter
  correctly reports the absent service before installation.

The first current Windows release package built successfully as
`0.1.0-win.20260929.1`, with 18,672 manifest entries. Native installation exposed
a Windows PowerShell 5 `Copy-Item` path-length failure before the qualification
service started. The installer now uses bounded
[Robocopy](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/robocopy)
with long-path support, no source ACL copying, no alternate streams, no junction
traversal and no destination mirroring/deletion. It still verifies the complete
staged manifest before activation. Candidate `0.1.0-win.20260929.2` subsequently
built and ran native LocalService qualification, with the failure described below.
The build-source dependency inventory found stale NuGet pip 25.0.1 metadata next
to the pinned pip 26.2.1 code. The stale metadata was removed from the private
build runtime; the resulting dependency audit reports no mismatches, extra
packages or missing packages. Candidate 2 includes that clean inventory.
The first immutable candidate is retained temporarily as failure evidence.
No throughput claim, two-worker capacity activation or final readiness is implied.

## Candidate 2 native qualification result

SSH was rechecked successfully as `DESKTOP-QKJDJ2G\hatem`. Candidate 2 built and
ran both canonical recipes under LocalService (`S-1-5-19`). Its preserved engine
report at `C:\MusicMuteBuild\qualification-candidate2-engine-evidence.json`
records 1,008 accelerated DirectML node events and zero CPU node events. Both
outputs passed the engine's media checks. This proves accelerated execution for
that qualification input, not general performance or two-worker readiness.

Installation did not qualify successfully. The strict report validator rejected
zero `modelLoad` stage duration; cached model validation also measured zero.
The pipeline still used Python 3.12's coarse Windows monotonic clock even though
outer qualification timing had already switched to `perf_counter`. Pipeline
timing now uses the high-resolution counter without fabricated minimum durations.
Regression tests cover sub-millisecond cached work and exception timing.
All 12 pipeline tests passed on macOS and the native Z440; TypeScript checking
also passed. A rebuilt immutable candidate and full service qualification rerun
are still required. The temporary qualification service was stopped and removed
after the failed install; no current operational service is running.

The installer also no longer duplicates an obsolete four-recipe count. Its
existing canonical report verifier establishes completeness; the PowerShell
result check requires a nonempty validated recipe set. Candidate 2 predates
this source correction.

## Candidate 3 qualification and shared operator commands

Candidate `0.1.0-win.20260929.3` passed the complete native Stage command. The
validated report is `C:\MusicMuteBuild\qualification-service-3.json`: LocalService
SID `S-1-5-19`, DirectML adapter 0, 1,008 accelerated node events, zero CPU node
events, both canonical recipes accepted. The installer stopped and unregistered
the temporary service after exporting the report. Live SCM inspection confirms
there is no operational MusicMute service running.

The 12-second fixture took 12.678 seconds for the first recipe and 4.125 seconds
for the second, with 61.197 seconds of separate model preload. These are two
qualification observations, not repeated comparable throughput measurements.
Cached model timing now retains microsecond precision and passes validation.

Follow-up source changes are newer than candidate 3 and need another package:

- Repeated file-benchmark Python execution and report validation now support
  DirectML as well as MPS. DirectML requires group size 1, proven accelerated
  dispatch and zero CPU node events. Reports distinguish registered CPU fallback
  from measured CPU use, identify the adapter through native DXGI, and explicitly
  leave unmeasured allocation data unavailable. Windows CLI/service benchmark
  orchestration remains open; no new native repeated benchmark is claimed.
- `logs`, `job`, `errors`, `explain` and `perf`, their argument parsing and output
  rendering now share implementation across Windows and macOS. Windows reads
  require private installation ACLs. Native source-build invocations of `logs`,
  `errors` and `perf` each returned valid JSON with exit code 0 on the Z440.
- Corrected tail-line counting for LF and CRLF logs; a trailing terminator no
  longer consumes one requested line. Duplicate log flags are rejected.
- PowerShell installer commands now acquire the same named-pipe lock as the
  Node CLI. Native tests prove exclusion in both directions and recovery after
  killing a sacrificial lock owner. The pipe accepts no commands or data.
  The implementation uses
  [CreateNamedPipe first-instance exclusivity](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createnamedpipea).
  The retained installer mutex also handles acquired-but-abandoned ownership
  according to [the Windows/.NET contract](https://learn.microsoft.com/en-us/dotnet/standard/threading/mutexes).
  Durable installation transaction recovery remains separate unfinished work.

Native focused validation: 14 tests passed across Windows operator, installer
contract and cross-process locking suites; six Python benchmark tests passed
using the private FFmpeg build. The test fixture generator uses native Opus
encoding, so testing Opus input no longer requires a production `libopus` encoder.
No decoder coverage was skipped. The transferred source tree also had the four
retired macOS-only modules removed after their shared replacements were copied;
immutable older candidates are unchanged.

Post-change regression: 436 TypeScript tests passed, with four platform-specific
skips, across 72 passing suites and one skipped suite on macOS. Lint, typecheck,
protocol consistency, seven package-inventory tests and local build passed.
Python: 82 tests ran on macOS with its one Windows-only test skipped; all 82
passed on the Z440 using the private Python and FFmpeg roots. Native source
compilation also passed. These checks do not close the remaining Windows
benchmark, recovery, two-worker, backend/storage or final package gates.

## Candidate 4: native repeated CLI benchmark and recovery

Candidate `0.1.0-win.20260929.4` packaged 18,701 manifest entries and passed
native Stage qualification. Its private evidence is
`C:\MusicMuteBuild\qualification-service-4.json`. The one-shot Python service
task owns its descendants through a Windows Job Object before loading the engine.
An allowlist restricts the wrapper to qualification and file benchmarking.

The normal CLI `benchmark-file` then passed against that installed candidate.
`C:\MusicMuteBuild\benchmark-file-service-4.json` records LocalService
`S-1-5-19`, Radeon RX 580, 2,352 accelerated DirectML node events and zero CPU
node events. For the 12-second synthetic fixture and `kim-vocals-v2`:

| Measurement                              |               Seconds |
| ---------------------------------------- | --------------------: |
| Model preload                            |                34.170 |
| Cold processing                          |                 7.409 |
| Warmup processing                        |                 4.121 |
| Three measured runs                      | 4.108 / 4.130 / 4.270 |
| Measured median                          |                 4.130 |
| Service launch through report validation |                67.362 |

Release inventory verification and CLI setup occur outside that last timing.
These numbers are single-worker synthetic-input observations, not two-worker
capacity, representative speech quality or backend/S3 latency. Independent checks
confirmed the original fixture SHA-256 was unchanged, no temporary service or
recovery journal remained, and both private benchmark input and work directories
were removed. Candidate 4 is immutable and predates the offline-loader fix below.

The manager now journals bounded, hashed snapshots before replacing runtime
configuration, credential, service wrapper, service definition or active-release
marker. Recovery validates the complete inventory before restoration; commit
removes the recovery obligation atomically. Native fixture tests passed for a
killed installer, corrupted snapshot refusal, idempotence and committed-state
preservation. This is fixture recovery proof, not a full SCM crash/reboot test.

## Offline model loading and report destination protection

Source inspection found that upstream model discovery can fetch model catalogs
and inference parameters from mutable GitHub URLs. The source now constructs
the pinned MDX architecture directly with the settings associated with our
full-SHA-256-verified Kim model. It retains upstream device selection, execution
policy, separation and cleanup. Parameters match the owner's
[MDX metadata](https://github.com/TRvlvr/application_data/blob/main/mdx_model_data/model_data_new.json)
entry `970b3f9492014d18fefeedfe4773cb42`; this tail MD5 identifies provenance only.
Model admission continues to require the full SHA-256 and byte count.

Tests prove exact constructor-configuration equivalence and forbid socket/HTTP
access during loading. A native MPS comparison ran both loaders twice with
network calls blocked and real GPU inference. All compared maximum differences
were one PCM16 quantization step (0.000030517578125), including old-loader versus
old-loader repeatability. Outputs retained all 529,200 stereo samples at 44.1 kHz.
No bit-identical or perceptual-quality claim is made. This source change needs a
new immutable Windows candidate; earlier benchmark `networkUsed: false` fields
are not accepted as evidence that the old loader was offline.

The same comparison subsequently passed on the Z440 using the private Python
and FFmpeg roots: two cached-upstream loads and two direct offline loads all
produced byte-identical PCM WAVs. Each run proved 560 accelerated DirectML node
events and zero CPU node events with socket/HTTP access blocked. This was a
source-engine test under the SSH administrator account, not LocalService release
qualification. Its initial harness attempt failed before inference because the
profile directory had not been created; the corrected run completed all four.

Benchmark report destinations now reject changes inside installed releases,
service files and arbitrary state files, while allowing uniquely named private
benchmark reports. The manager checks every output-directory ancestor for a
reparse point. Native tests cover a real directory junction and protected paths.
Seven native report/recovery tests passed. Local typecheck, lint and 15 focused
TypeScript tests passed. Python regression ran 87 tests: 86 passed and one
Windows-only test skipped on macOS; all 87 passed natively on Windows.

The subsequent full macOS TypeScript run passed 442 tests with eight
platform-specific skips (73 passing suites, two skipped suites). Source formatting
and whitespace checks passed. The new offline loader and destination guards are
not yet in a new immutable Windows package. Two-worker qualification, normal CLI
recovery/update completion, SCM interruption/reboot, current backend/storage
acceptance and final package checks remain open.

## Synchronized two-worker measurement

The shared Python capacity coordinator now measures every canonical recipe with
one baseline process followed by two independent processes. All participating
processes complete a cold run and one or two warmup runs before the coordinator
releases their measured-run barrier. Each process then executes three to ten
measured runs with one preloaded model. Model startup, report finalization and
decoded-output comparison are outside the cohort clock. The parent measures
elapsed cohort time, and each child separately measures its workload duration.

Throughput is twice the baseline cohort time divided by the two-worker cohort
time; every recipe must reach 1.1x. Every measured output, including baseline
repeatability, is compared with the first measured baseline output using bounded
decoded blocks. Equal frame counts, sample rate and channels are mandatory;
maximum absolute difference is 0.01 and RMS difference is 0.0001. These are
numerical regression gates, not listening or transcription-quality acceptance.
Reports include individual lifetime peak resident bytes, explicitly excluding
GPU allocation and media subprocesses; these peaks are not simultaneous usage.

Workers have independent lifetime pipes and native process ownership. Windows
uses a private Job Object per worker; POSIX uses a private process group. A
coordinator crash closes the lifetime pipes, terminating workers and descendants
even during startup or inference. Native coordinator tests passed on both Mac
and Windows for common-start timing, deadlines, failed-worker descendant cleanup,
coordinator death, decoded-output changes and the resident-memory measurement.
The Mac CLI additionally owns the coordinator's stdin lifetime pipe.

Shared TypeScript validation recalculates throughput and verdicts; verifies every
worker's runtime, fixture, model, recipe and provider evidence; rejects CPU
inference, reused concurrent process IDs and duplicate/missing output comparisons;
and checks the normalized report again when it is read from disk. The native
Windows command is `mw benchmark --workers 2 --input <path>` with the same
release/output/warmup/measured-run flags as file benchmarks. A valid report may
fail the performance gate and remain available for inspection. It does not yet
activate a second slot.

Candidate `0.1.0-win.20260929.5` packaged 18,708 entries after 25 focused native
TypeScript tests passed. Its Stage qualification and subsequent normal CLI
capacity benchmark are running; no hardware throughput verdict is recorded yet.
The candidate includes offline model loading, destination guards and Windows
capacity orchestration. Later local macOS orchestration and CLI-lifetime changes
will require the final package rebuild. The broad TypeScript run before those Mac
changes passed 447 tests with eight platform skips; the Mac command regression
then passed 49 focused tests. Native coordinator tests passed six cases; the
additional CLI-lifetime case also passed locally.

Candidate 5 passed native Stage qualification, then failed capacity startup with
`PicklingError`, before producing GPU throughput measurements. The preserved
private failure report is
`state/qualification-918fc688-7de2-4d20-9431-edf173bb1bc6.json` under the Windows
installation. Cleanup independently confirmed no temporary service, recovery
journal, copied benchmark input or benchmark workspace remained.

The wrapper's `runpy.run_module` call did not expose the executed task as
`__main__`, so Windows multiprocessing could not resolve its task function.
It now uses `alter_sys=True` for the lifetime of the one-shot task, following
the [Python runpy contract](https://docs.python.org/3.12/library/runpy.html).
A regression test executes a real two-process cohort through the wrapper and
checks distinct process IDs. It passed locally. Candidate 6 is being rebuilt;
candidate 5 remains immutable failure evidence. The Mac CLI-lifetime test and
all seven coordinator cases passed locally. Full local Python regression before
the wrapper fix ran 94 tests with one Windows-only skip; build, package inventory
and protocol checks also passed.

Candidate 6's first rebuild stopped at the new native CLI-lifetime regression:
a blocking stdin watcher prevented the Windows spawned worker from starting.
The watcher now uses nonblocking pipe reads. All seven coordinator tests passed
natively, followed by all 95 Python tests. The Mac private Python regression ran
the same 95 tests with one Windows-only skip. The default local test command first
failed because no development interpreter was configured; selecting the installed
private interpreter explicitly resolved that setup failure. The Mac run used
FFmpeg 9.0.2 from PATH; the native Windows run used private FFmpeg 8.0.3.

Candidate `0.1.0-win.20260929.6` packaged 18,708 entries and passed LocalService
Stage qualification for both canonical recipes: 1,008 DirectML node events and
zero CPU node events. The exported report is
`C:\MusicMuteBuild\qualification-service-6.json`. Its normal CLI two-worker
capacity benchmark is in progress; no throughput verdict is recorded yet.

Later source changes add `mw recover [--release-version <installed-version>]`.
Recovery verifies the installed package before executing its manager, does not
load runtime configuration, and leaves locking and journal validation to the
existing transaction implementation. An explicit version supports an interrupted
first installation with no active marker. The normal status command reports
pending maintenance as unhealthy, even when its child is ready.

Operational runtimes now defer reconciliation, remote commands and claims while
the Windows recovery journal exists. This allows service startup health checks
before the installer commits without exposing uncommitted configuration to jobs.
Journal IO errors fail closed, and the guard runs again before each claim. It
does not change the existing backend transport or scheduling contract. The tests
cover blocked admission, commit release, a journal appearing before a claim and
unreadable state. Native SCM interrupted-install admission acceptance remains open.

Capacity report validation now requires installed-engine measurements, bounds
cohort/task clocks by their contained run durations, and compares recipe, runtime
and input identity across each cohort. These changes and normal CLI recovery are
newer than candidate 6 and require a later immutable package. Focused regression
passed 59 tests after restoring a missing path import caught by the restart test;
typecheck, lint and build passed. The subsequent full local TypeScript run passed
456 tests with eight platform skips across 75 passing suites and two skipped
suites. Seven package-inventory tests and protocol consistency also passed.

Mac package preparation initially rejected the active release's inventory. A full
comparison found every manifest-listed file unchanged, no missing entries and
3,155 added Python cache files/directories only. The active release was left
untouched. A copy containing only its original manifest-listed inputs passed full
verification and supplied the private runtimes for a fresh source build. The new
`0.1.0-macos.20260929.1` package has 20,147 entries, passed full verification, and
is at `/tmp/musicmute-macos-current-0V5S2Q/release`. It has not been activated or
GPU-qualified. The existing Mac worker remained running, idle and model-ready at
the status check. Resolving its extra cache inventory and controlled native Mac
benchmark/service validation remain open.

## First passing native Windows two-worker cohort

Candidate 6's normal CLI capacity benchmark completed with exit 0 and status PASS.
`C:\MusicMuteBuild\capacity-service-6.json` contains the normalized measurements;
`capacity-cli-6.json` contains the CLI response. The later, stricter source parser
also accepted the exported report after an independent local read.

| Recipe               | One worker, three runs | Two workers, three runs each | Throughput gain |
| -------------------- | ---------------------: | ---------------------------: | --------------: |
| `kim-vocals-v2`      |              13.3293 s |                    16.0091 s |         1.6652x |
| `kim-vocals-v2-trim` |              12.9455 s |                    16.6425 s |         1.5557x |

These are common-barrier cohort durations on the 12-second fixture, excluding
model preload, cold runs, warmup, report finalization and comparison. They are not
end-to-end backend/S3 job times or a long-audio capacity guarantee. Each recipe
completed nine decoded-output comparisons with maximum absolute and RMS
difference both zero. Across its baseline and concurrent worker reports, each
recipe proved 7,056 DirectML node events and zero CPU node events. Every worker
used LocalService SID `S-1-5-19` and adapter 0 on the RX 580.

Individual process lifetime resident-memory peaks ranged from 669,437,952 to
693,391,360 bytes. They exclude GPU allocation and media subprocesses and are not
a simultaneous aggregate. Cleanup independently confirmed service absent,
recovery journal absent, zero benchmark fixture/workspace leftovers, and unchanged
original input SHA-256. This proves the measured two-worker engine gain; operational
two-slot configuration, hardware/release-bound admission evidence and broader
service/backend/storage acceptance remain incomplete.

The source recovery/admission/report tests subsequently passed 66 cases natively,
with typecheck and build passing. The initial shared-runtime run failed before
execution because its mocked executable paths were Unix literals; temporary-root
paths fixed the fixture on both hosts. A real source CLI invocation of
`mw recover --release-version 0.1.0-win.20260929.6 --json` succeeded and confirmed
the service remained absent.

The first broad native TypeScript run is **not passing**: 326 tests passed, 120
failed and 18 skipped. Its private JSON is
`C:\MusicMuteBuild\native-all-after6.tests.json`. Most failures exercise macOS
permissions/layouts/UID assumptions on Windows; shared lock, POSIX-mode expectation,
child-pipe and fixture-path cases also need review. Do not equate the focused
native pass with full native regression. The HTTP integration fixture's executable
paths have since been made portable as well.

That broad run also found 76 AppleDouble metadata files discovered as test suites.
The source archive had transported Mac extended-attribute sidecars. All 299 such
files under the known transferred source paths were checked for AppleDouble magic
and a corresponding original before removal. Transfers now use
`COPYFILE_DISABLE=1`, `tar --no-xattrs`, and `--exclude='._*'`. The release tree
filter also rejects AppleDouble entries, with a regression test. Existing candidate
packages remain unchanged; the final Windows package must be rebuilt from the
clean source tree. The existing Mac package also predates this filter-only change.

The portable HTTP fixture and AppleDouble filter tests passed on both hosts, and
the cleaned Windows source rebuilt successfully. Local typecheck, lint, build,
touched-file formatting and final whitespace checks passed. The complete native
suite has not been rerun after those two focused fixes; its remaining failures
are still open.

## Portable regression and operational capacity implementation

After removing transfer metadata and separating Darwin-only filesystem/launchd
fixtures, the full native Windows TypeScript suite passed 330 tests with 139
platform skips. Shared report validation, logs, native locks and child ownership
still execute on Windows. The Mac fake-service lifecycle observer was made to
stop and finish its last write before teardown. The final Mac rerun passed 460
tests with nine skips; typecheck, lint and build passed. Those results precede
the capacity changes below.

Capacity approval now uses schema 3 and contains the full normalized measurements,
not summary timings. Startup rechecks both canonical recipes, output comparisons,
provider dispatch, clocks, release/model/fixture identity, machine identity and
expiry. Older approvals require requalification. The new shared
`mw capacity --workers 1|2` writes a validated configuration atomically while the
service is stopped, preserves existing worker IDs, and supports returning to one
slot after evidence expires. Backend capability and policy gates remain in force.
Windows installer validation now allows the two qualified adapter-0 slots.

The Windows approval path runs after the benchmark service has been restored,
under the service manager's operator lock. It only approves an installed stopped
service with matching active release and installed qualification fixture. Other
benchmark contexts retain measurement-only status. A two-worker rerun invalidates
previous approval before GPU work. This implementation has not yet been packaged
or exercised as a complete native two-slot service transaction.

GPU identity now reads the installed driver through
[IDXGIAdapter::CheckInterfaceSupport with IDXGIDevice](https://learn.microsoft.com/en-us/windows/win32/api/dxgi/nf-dxgi-idxgiadapter-checkinterfacesupport).
The source probe executed natively on the Z440 and returned RX 580 driver
`31.0.21925.1001`. Capacity identity excludes the reboot-scoped adapter LUID but
includes the adapter hardware, driver, CPU/memory and OS kernel. Receipt reads on
Windows check the actual file and parent NTFS permissions and reject reparse
ancestors; POSIX mode bits are not used as Windows ACL evidence. Native ACL and
new regression outcomes are recorded below when their runs complete.

The complete source regression after these changes passed 468 tests with ten
platform skips on macOS, and 339 tests with 139 skips on native Windows (478
tests total on each host). The new native NTFS fixture accepted an administrator-
owned private receipt and rejected an explicit Everyone read grant. The five
native recovery/service-layout cases also passed after adding real PowerShell
execution for valid two-slot configuration and rejected receipt/device/index/
provider/count changes. Typecheck, lint and build passed on both hosts; local
protocol consistency and all seven package-inventory tests passed. The last
native-only service-layout test was added after the full suites and passed in
the five-case native focused run. Touched-file formatting and whitespace checks
passed. These tests do not substitute for the installed two-worker service run.

Candidate 7 initially failed because it was invoked through `node` without the
Windows pnpm entry-point environment. The builder removed its incomplete staging
tree. The retry uses the documented `pnpm run package:windows` entry point and is
assembling `0.1.0-win.20260929.7` in `C:\MusicMuteBuild\runtime-current-7`.
The source-map upload token is absent on the Windows build host. No immutable
candidate was overwritten. Package completion and native Stage/operational
acceptance are still pending at this point in the ledger.

Candidate `0.1.0-win.20260929.7` completed successfully with 18,702 manifest
entries. The initial direct `.ps1` Stage invocation was rejected by the host's
script policy before running. Stage was then started with the same process-scoped
`RemoteSigned` invocation used by the normal CLI; the machine policy was not
changed. Native Stage is still running, with the installation copy in progress
at the last observation. No operational Windows enrollment has been created.

Candidate 7 completed LocalService Stage successfully for both canonical recipes:
1,008 DirectML events, zero CPU events, with service absent and recovery journal
absent after cleanup. Its packaged `installedCapacityIdentity` also verified the
full installed file inventory, model and fixture and read RX 580 driver
`31.0.21925.1001` successfully. The report is
`C:\MusicMuteBuild\qualification-service-7.json`.

Native installation exposed a path mismatch in the new approval code: Windows
stores `qualification-fixture-<sha256>.wav`, while macOS uses `qualification.wav`.
The source now uses the existing Windows content-addressed fixture in both
approval generation and startup validation. A regression covers approval with
that filename, measurement-only contexts and changed fixture bytes; the shared
configuration test also asserts the platform-specific lookup path. Ten focused
local tests passed, with typecheck, lint and build passing. The corresponding
native focused run passed eight tests with two Darwin skips; native typecheck
and build also succeeded. Candidate 7 remains immutable and predates this
correction; candidate `0.1.0-win.20260929.8` is building from corrected source
through `pnpm run package:windows`. Full native operational two-slot acceptance
remains open.

## Candidate 8 and two-slot service fixture

Candidate `0.1.0-win.20260929.8` finished packaging successfully with 18,702
manifest entries in `C:\MusicMuteBuild\runtime-current-8`. SSH was rechecked on
the Z440 as `hatem` at `192.168.1.123`; the host reported
`DESKTOP-QKJDJ2G` and 128.8 GiB free before this acceptance run. The service was
absent before Stage. Native LocalService Stage subsequently completed with exit
0 and status PASS for both recipes: 1,008 DirectML events, zero CPU events,
service identity `S-1-5-19`. Its report is
`C:\MusicMuteBuild\qualification-service-8.json`; total qualification time was
75.365 seconds. The temporary qualification service was uninstalled successfully.
An operational Install against the loopback fixture is now in progress, with
claiming disabled.

The loopback acceptance server now reads current recipe snapshots from the
configured engine instead of using the old hardcoded recipe. Claims are gated
until explicitly enabled, and two different worker slots receive separate jobs.
The fixture records server-observed attempt overlap, verifies capability URLs,
conditional uploads and SHA-256 checksums, and rejects completion before a valid
upload. Evidence omits credentials and transfer capabilities. It also supports
a corrupted download to exercise worker checksum failures. The fixture is not
the NestJS API or S3, and its timestamps do not measure GPU utilization.

The three new HTTP fixture tests passed locally and on native Windows. The local
packaging suite passed all ten cases and lint passed. A focused test caught and
corrected the observation phase to the protocol's `separating` value.

For this test API work, the official
[Zalando REST guidelines](https://opensource.zalando.com/restful-api-guidelines/)
were read on 2026-09-29: contract compatibility (101/106), security (104),
standard formats and snake_case (238/118), HTTP methods (148), problem responses
(176), and content headers (178). The fixture follows the existing worker wire
contract; no production endpoint or schema was changed.

Candidate 8 Install completed with exit 0 against the synthetic loopback backend.
The operational LocalService runtime reached `childState: ready`, registered its
first slot, and retained no active attempts while claims were disabled. Normal
installed `mw stop --json` acknowledged graceful stop with exit 0. The installed
`mw benchmark --workers 2` is now running, targeting
`C:\MusicMuteBuild\capacity-service-8.json`. This is the first candidate-8
measurement intended to issue a hardware-bound receipt for an installed service;
no receipt or operational two-slot success is claimed before it finishes.

That installed benchmark completed with exit 0 and status PASS. Candidate 8's
manifest digest is
`dd6921b5c860b91e4c194835cc529fadb20e41b90cf4877a93aba979138f04a8`.
The service was restored stopped, and the private schema-3 capacity receipt now
has status PASS, validated maximum 2, and expiry `2026-10-06T03:26:47.180Z`.

| Recipe               | One-process cohort | Two-process cohort | Combined throughput gain |
| -------------------- | -----------------: | -----------------: | -----------------------: |
| `kim-vocals-v2`      |       13.0463713 s |       17.2202225 s |               1.5152384x |
| `kim-vocals-v2-trim` |       13.3296460 s |       16.9941695 s |               1.5687317x |

These are common-barrier cohort times for three measured runs per process on
the 12-second synthetic fixture, after warm-up. All 18 decoded-audio comparisons
had zero maximum absolute and RMS differences. Each recipe's three process
reports recorded 7,056 DirectML events in total and zero CPU events. Individual
process peak resident memory ranged from 673,914,880 to 682,147,840 bytes; this
does not measure GPU memory or simultaneous aggregate memory. The measured GPU
was RX 580 with driver `31.0.21925.1001`. The next pending check is applying this
receipt through normal `mw capacity --workers 2` and completing two service jobs.

Long-audio validation also needs to cover the existing independent limits:
`MAX_DURATION_SECONDS = 1800` and `MAX_OUTPUT_BYTES = 30000000`, while the
pipeline encodes at 160 kbps. An untrimmed 30-minute output requires roughly
36 MB before metadata. No change to that worker/backend output contract has
been made here, and successful 30-minute output is not established.

## Native installed two-slot job acceptance

Normal `mw capacity --workers 2 --json` completed with exit 0, preserving the
first worker ID and adding a distinct second ID. Normal `mw start --json`
succeeded. Startup initially reported `healthy: false` and `childState: loading`,
then both model-ready events, both slot registrations and native CLI health
confirmed readiness. CIM showed two separate guardian/processing-child pairs
under the same service supervisor. Claims were enabled only after those checks.

Both synthetic jobs completed successfully with `maxActiveAttempts: 2`. The
fixture's server-observed claim-to-completion windows were 10.220933 and
10.149870 seconds, overlapping by 10.110097 seconds. These windows include the
local HTTP/download/processing/upload flow; they do not measure internet/S3
latency or direct GPU utilization. Both capability-authorized uploads matched
their reserved checksums, and both completion acknowledgements succeeded.

The installed private ffprobe independently verified both saved MP3s as 44.1 kHz,
stereo, 12.000000 seconds and 241,415 bytes. Both file SHA-256 hashes were
`af9ae4f82cc61c4b74e85dd4d007b99cae9ddd65fe04c4696781627f374b9c22`.
Post-job `mw status --local --json` returned healthy, two ready slots and zero
active attempts. Normal `mw stop --json` then completed with exit 0.
Evidence is preserved in
`C:\MusicMuteBuild\acceptance-private-8\two-worker.evidence.json` and the two
adjacent `.0.mp3` / `.1.mp3` files; a local review copy of the evidence is at
`/tmp/musicmute-windows-two-worker-8.evidence.json`.

This establishes the installed candidate's positive two-slot path with a
synthetic backend/storage fixture. It does not establish real NestJS/S3,
WebSocket hints, long-audio output, reboot behavior or interruption recovery.
The test service remains installed for further acceptance, with synthetic
credentials. Cleanup confirmed the service is stopped with startup set to
Manual, the exact fixture listener process was stopped, and no Python processing
children remain. The fixture's SSH command ended with exit 255 after its owned
remote process was intentionally stopped; that is cleanup, not a failed job.
Manual startup prevents a reboot from automatically starting the worker against
this temporary server.

The final read-only cleanup check confirmed no pending `service/operation-recovery`
directory, no loopback listener and an unchanged source-fixture SHA-256. The two
operational attempt directories are gone. Eight older `qualification-*`
directories remain under `state/attempts`, including Stage/Install qualification
artifacts; they were preserved for the remaining qualification-cleanup review.

## Failure acceptance and shared CLI readiness

The next turn rechecked the native service as stopped/manual, with no Python
children, listener or recovery journal. Source tracing confirmed qualification's
`uploadCandidate` is consumed by enrollment's upload/confirm step, so deleting
the qualification directory at pipeline return would break enrollment. Retained
qualification artifacts require cleanup after their consumer, not unconditional
pipeline cleanup.

The loopback fixture now supports explicit corrupt-input and cancellation-during-
separation scenarios. Cancellation is returned only through an owned lease
renewal after a separation progress event; it denies later publication and
records issuance separately from a worker completion. Four fixture tests passed
locally and natively, with eleven local packaging/fixture cases passing overall.
The installed candidate-8 corrupt-input scenario produced `DOWNLOAD_FAILED` on
slot 0 before separation, with no upload, while slot 1 completed normally.
Evidence is `C:\MusicMuteBuild\acceptance-private-8\corrupt-input.evidence.json`.

Status watching and readiness waiting now share `platform/shared/status-watch.ts`
between macOS and Windows. Windows accepts `status --watch` and
`start --wait-ready`; readiness waiting uses a monotonic deadline, reports phase
changes and preserves the service on timeout. Windows status also rejects stale
heartbeats from the same process instead of treating PID identity alone as
current readiness. Focused coverage verifies loading-to-ready, timeout, stale
heartbeats and signal-handler cleanup.

The full local macOS source suite passed 475 cases with eleven platform skips.
All 52 focused CLI cases passed locally; native Windows passed sixteen with 36
macOS skips. Typecheck/build passed on both hosts and local lint passed. These
CLI changes are compiled in `C:\MusicMuteBuild\source-current` but are not in
immutable candidate 8. Native source-CLI `start --wait-ready` is being exercised
against candidate 8 before its two-minute cancellation test.

Native source-CLI `start --wait-ready --json` completed with exit 0 after
observing starting/loading/warming/ready states. It did not return success while
the models were still loading. A real Windows ConPTY SSH session subsequently
ran `status --local --watch --json`; Ctrl-C ended the watch with exit 0. The
service remained running with its same supervisor and draining intent afterward.

The cancellation scenario used a generated 120-second WAV (21,168,078 bytes).
Both attempts overlapped. Slot 0 received a cancelled lease 20.025619 seconds
after claim, after separation progress had been observed; no output grant/upload
or completion was accepted. The runtime logged `attempt-stopped` with code
`cancelled`, then `child-restarted` after model recovery. Its original guardian
8744/child 16620 pair disappeared and was replaced by guardian 4600/child 14324.
The other slot retained guardian 9432/child 11440 under supervisor 5632 and
completed successfully in a server-observed 31.843185 seconds. These are
operational fixture windows, not a warmed benchmark or internet timing.

The surviving output independently passed installed ffprobe checks: MP3,
44.1 kHz stereo, 120.000000 seconds, 2,401,219 bytes, SHA-256
`a01865e5c37f0480d6cd984490766fcfb0316bb5e3f7380c797d5b9c06181c4c`.
The cancelled output does not exist and both operational workspaces were removed.
Repeated pause preserved revision 8; resume advanced to revision 9. Drain was
acknowledged at revision 10 with zero active attempts and ready children. The
runtime was already idle before that drain command, so this is not evidence of
draining an in-flight job. Evidence is
`C:\MusicMuteBuild\acceptance-private-8\cancel-120s.evidence.json` with process
inventory in `cancel-120s.processes-before.json`.

The corrupt-input diagnostic was generic, not checksum-specific: its persisted
detail was `transfer-process-failed`. Source inspection found that the transfer
client created checksum/size errors without diagnostics; the IPC layer already
preserves safe diagnostic strings. The shared transfer client now emits fixed
codes for checksum, size, encoding/type, expired grants and stalled writes,
without copying URLs, headers or response bodies. The existing failure code and
retry semantics are unchanged. Seventeen focused transfer cases passed locally,
including real transfer-child IPC for corrupt, truncated and oversized downloads
and removal of invalid input files. Native regression and the next immutable
package remain pending for this diagnostic change.

The complete native Windows TypeScript suite after the readiness and transfer
diagnostic changes passed 350 tests with 139 platform skips (489 total, zero
failures), including the new real transfer-subprocess cases. Native typecheck,
lint and build passed. The report is
`C:\MusicMuteBuild\readiness-transfer-full-native.json`. Local typecheck, lint,
build, touched-file formatting, protocol consistency and whitespace checks
passed. The previous full macOS run was 475/11 before the three new transfer
cases; the later seventeen-case local transfer run covered that change.

The cancellation test cleanup stopped the service through the normal source
CLI, stopped the exact fixture process, and confirmed stopped/manual service
state, zero Python children and no operation-recovery journal. Readiness,
watching and transfer diagnostic changes still require inclusion in the next
immutable package; candidate 8 was not modified. The remaining overall goal
includes other Windows CLI commands, broader long-audio/interruption acceptance,
fresh macOS packaging/native validation and final integration/security review.

## Windows doctor and shared diagnostic export

The next implementation pass added normal Windows `doctor [--full] [--json]`.
Health result types, bounded check reporting and human-readable formatting now
live in shared platform code; macOS retains its native checks. Windows checks
installation and file ACLs before consuming private configuration, lifecycle or
status, detects native-process/heartbeat mismatch and pending recovery, and
checks the active release inventory before executing its Python doctor. The
private Python process uses a filtered environment and explicit DirectML mode;
this checks provider availability and model/media integrity without inference.
Doctor never starts or stops the service. Raw exceptions/stderr are excluded.

Native source-CLI `doctor --full --json` on the Z440 passed thirteen installation,
configuration, lifecycle, recovery, release and Python checks. It returned exit
1 with only `SERVICE_NOT_RUNNING`, correctly reflecting the stopped service.
Evidence: `C:\MusicMuteBuild\doctor-full-native.json`. This is current source-CLI
inspection of immutable candidate 8, not a new installed release or another GPU
service benchmark. Native typecheck/lint/build and focused health/CLI tests
passed before this run.

Both platforms now use shared allowlisted diagnostic content generation.
Windows `diagnostics` adds general/job exports with the existing time filter
and 8 MiB bound. Windows ZIP creation uses the framework archive API and a
CreateNew FileStream with private ACLs at creation, before content is written;
existing targets are not replaced. Default output is under private state, with
explicit local paths supported outside installed code. Native implementation
was checked against Microsoft's FileStream constructor and ZipFile
CreateFromDirectory documentation on 2026-09-29:
https://learn.microsoft.com/en-us/dotnet/api/system.io.filestream.-ctor
https://learn.microsoft.com/en-us/dotnet/api/system.io.compression.zipfile.createfromdirectory

The macOS archive adapter now builds in private staging and copies with
COPYFILE_EXCL. It no longer overwrites or deletes an output concurrently created
by another writer. A race regression test preserves that writer's contents.
Focused tests also cover Windows trust-gated execution, offline inspection,
recovery detection, destination restrictions and sanitized contents. The full
local macOS TypeScript suite passed 490 tests with eleven platform skips and
zero failures (`/tmp/musicmute-doctor-diagnostics-full-mac.json`). Local build,
typecheck, lint, touched formatting, protocol consistency and whitespace checks
passed. The native Windows ZIP command remains under observation in this entry;
its final archive evidence is recorded below when independently checked.

The native general ZIP command completed with exit 0. Independent framework ZIP
inspection found exactly the six allowlisted files, 7,734 compressed bytes, a
protected Administrators/SYSTEM-only ACL, and neither the actual installed
credential nor the configured loopback backend URL. Its SHA-256 is
`47b313827e556fb3717543bbbb3c248ad1597b28909e7b69a19a92e063db0604`;
archive: `C:\MusicMuteBuild\diagnostics-native-current.zip`. The service remained
stopped/manual with zero Python children.

Follow-up tests added safe unavailable-status output for corrupt local status
and an explicit missing-section marker when configuration field names cannot
be read safely. The complete native Windows suite then passed 363 tests with
140 platform skips and zero failures
(`C:\MusicMuteBuild\doctor-diagnostics-full-native.json`). The normal source CLI
also completed `diagnostics --job 64b000000000000000000001 --since 1d --json`;
its result is `C:\MusicMuteBuild\diagnostics-job-native-result.json`. The last
full macOS run preceded these two small follow-ups; a subsequent focused local
run passed all 24 affected export/Windows-CLI/macOS-export cases.

Review then strengthened Windows staging and default output placement: both
now live under the service directory, whose ACL denies LocalService write
access. Staging is created with protected Administrators/SYSTEM permissions
before any contents, using Directory.CreateDirectory with DirectorySecurity.
This avoids relying on the processing account's writable scratch parent for
administrator exports. Explicit archive destinations still receive private
permissions atomically when created. The earlier native job export used the
then-default state directory; final protected-staging acceptance is recorded
separately and must not be inferred from that earlier output.

Final native protected-staging acceptance passed through the compiled Windows
bundle adapter. It exported general diagnostics, refused an existing filename
without changing its SHA-256, and exported the selected job to the new default
service-directory location. A native filesystem observer sampled nine staging
ACL events; all had inheritance disabled and allowed only SYSTEM and
Administrators. The existing general archive hash remained
`c29e7c14bdebff93a3881382e423bd0b5fc6a58c1d097b17aa077f54c2947e1b`.
Result: `C:\MusicMuteBuild\diagnostics-hardened-result.json`; reusable native
acceptance script: `C:\MusicMuteBuild\musicmute-native-diagnostics-acceptance.mjs`.
The adapter acceptance used the previously captured doctor report; normal CLI
full-doctor and job-export execution were independently verified above. It does
not represent a fresh service GPU benchmark or deployed package. Native
focused tests, typecheck, lint and build passed after the staging change.

These CLI changes still need inclusion in the next immutable release. The
remaining goal includes Windows update/unpair/uninstall command parity and
native recovery acceptance, broader audio/interruption coverage, fresh macOS
package/MPS validation, backend/storage integration and final requirement audit.
No production enrollment, deployment, package publication or Git commit was
performed during this pass.

Independent ZIP inspection of the final archives verified six entries each,
7,696 bytes for general diagnostics and 5,616 for the selected job, protected
private ACLs and exclusion of the actual credential. Job scope included the
requested `...001` job and excluded sibling `...002`. The final focused native
suite passed 29 tests with zero failures. Cleanup confirmed stopped/manual
service state, zero Python processes and zero staging directories under the
service root. Both final ZIP outputs were retained for review.

## Windows unpair and uninstall

The next pass added normal Windows `unpair [--force]` and
`uninstall [--purge]`, with JSON output. Unpair drains/stops local work and uses
the existing machine-authenticated control-plane operation. A confirmation must
match the configured machine ID before a receipt is written or credentials are
removed. Failed requests preserve credentials; a saved receipt resumes partial
cleanup without contacting the backend again and cannot clean a different
pairing. Receipts live under the service directory and are rejected when
LocalService owns or can write the file or its parent. Plain uninstall removes
the stopped SCM registration and only the stable wrapper/XML/activation files;
purge additionally requires a confirmed receipt and absent configuration and
credentials. Both operations refuse pending maintenance recovery. Purge refuses
to delete the Node executable currently running inside the managed root.

Unpair receipt serialization/storage and graceful conflict handling now live in
shared platform modules, with macOS importing them directly. The retry deadline
uses a monotonic clock; invalid timeouts and unrelated backend failures do not
retry. Maintenance connection data now also includes the validated machine ID
for confirmation matching; it still excludes slot/admission configuration.
One macOS assertion of the exact maintenance key set required updating for
this intentional identity field. Its 32-case focused regression passed, then
the full macOS suite passed 504 tests with eleven platform skips and zero
failures (`/tmp/musicmute-removal-full-mac-final.json`).

The native Windows suite passed 375 tests with 140 platform skips and zero
failures (`C:\MusicMuteBuild\removal-full-native.json`). This includes real NTFS
checks proving an ordinary service-writable private file is refused as an
administrator-controlled unpair receipt. Typecheck, lint and build passed on
both hosts. Removal ordering/state tests cover backend rejection, mismatched
identity, receipt replay, recovery fences, paired-data preservation, purge
preconditions and SCM failure. WMI deletion follows the current Microsoft
Win32_Service Delete contract: stop first, check the return value, and verify
actual service disappearance before removing its stable files:
https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/delete-method-in-class-win32-service

A native normal-CLI acceptance harness is exercising the actual stopped Z440
service with a loopback-only unpair backend. It refuses production/non-loopback
configuration and captures a private, allowlisted restoration backup. Its first
preflight stopped without mutation because the fixture origin contained a
trailing slash; parsed-origin validation confirmed the same localhost endpoint
and the harness was corrected. Final operation/restoration evidence follows.

Native normal-CLI removal acceptance completed successfully. Before unpairing,
`uninstall --purge --json` refused an unconfirmed purge. Plain `uninstall --json`
then removed the real SCM registration while leaving the paired configuration
and credential byte-for-byte intact; the harness restored the stopped service
from its verified wrapper and private saved files. A denied loopback unpair
request preserved both files. A successful unpair wrote the matching receipt,
removed credential/config, and replayed without a second backend request. The
receipt was owned by Administrators and was not writable by LocalService.
A subsequent uninstall again removed the actual SCM registration and stable
service files while retaining release/model directories. The fixture observed
two unpair requests total: one denied and one confirmed.

Evidence: `C:\MusicMuteBuild\removal-native-result.json`; acceptance harness:
`C:\MusicMuteBuild\musicmute-native-removal-acceptance.mjs`. This is real Windows
service/filesystem execution with a synthetic HTTP backend, not production
unpair/re-enrollment proof. The harness validates loopback-only configuration,
verifies the service wrapper against the release manifest, records original
file hashes/ACLs in an administrator-only backup, refuses unrelated changed
files during restoration, and provides an explicit restore mode for interrupted
acceptance. It restores the fake pairing solely as fixture cleanup.

Independent final inspection confirmed candidate `0.1.0-win.20260929.8`, two
configured slots, the credential present, stopped/manual SCM service under
LocalService with PID 0, no Python processes, no fixture listener, no unpair
receipt and no acceptance-backup directory. The allowlisted config, credential,
wrapper, XML and active marker were restored with their original bytes and ACLs;
the service was not started for this removal test. The real backend source also
explicitly permits revoked credentials only on the unpair replay route, covering
the contract needed when an accepted unpair response is lost before receipt
persistence; that source check is distinct from the synthetic native test.

Windows update/catalog support, preserved-install reactivation, package refresh,
boot/interruption coverage, fresh native macOS qualification and final integration
review remain open. The new removal commands are compiled in source-current;
immutable candidate 8 has not been rewritten or repackaged.

## Shared update verification and preserved Windows reactivation

The update metadata verifier, built-in public trust key, trust parser and release
version comparison now live under `worker/src/platform/shared/`. Both platform
adapters call the explicit-platform control-plane update method. Windows
`mw update --check [--json]` verifies signed Windows ZIP metadata, expiry,
sequence and local quarantine state without requesting a download grant. The
CLI prints only the public version/sequence/status result. Windows update state
and optional public trust keys use administrator-controlled files under
`service`; service-writable files cannot supply update authority. Full download,
activation, sequence commit and rollback orchestration remain to be implemented.

Windows `mw install [--json]` without enrollment flags now inspects a preserved
paired installation. It resolves only the exact installed release and private
state paths, verifies ACLs and the complete manifest, and enforces the current
release/host-bound capacity receipt before reactivation. Existing registered
installations return `already-installed` without a lifecycle mutation. When
the registration is absent, the verified packaged manager's new `Reactivate`
action repeats validation under both native locks, journals the prior files,
registers/starts the preserved release and commits only after runtime checks.
Failed activation uses the existing durable rollback. No enrollment exchange,
credential replacement, release download or configuration migration is used.

The manager also accepts `-LeaveStopped` for Install/Repair. This retains the
LocalService qualification phase but skips operational service startup after
activation, providing the stopped-service behavior needed by the updater. The
default Install/Repair behavior remains startup plus runtime checks. End-to-end
acceptance of this option belongs with the forthcoming update transaction.

Native tests exercise reactivation journal commit and rollback using actual
NTFS files/ACLs with substituted SCM/health operations: a synthetic health
failure restores the pre-activation file state; success commits the marker;
config, credential and paused lifecycle bytes remain unchanged. This is native
filesystem recovery evidence, not a real service re-registration test. The full
normal reactivation route still needs a new package containing `Reactivate` and
`windows config-check`; immutable candidate 8 does not contain these commands.

The normal compiled source CLI did run `install --json` against the actual Z440
candidate 8 installation. After verifying its preserved inventory and capacity
receipt it returned `already-installed`, version `0.1.0-win.20260929.8`.
Independent CIM inspection confirmed Stopped/Manual/PID 0 and no recovery
journal afterward. No real service registration or processing was started.

Validation: the focused Windows suite passed 38 tests; the full native Windows
suite passed 389 tests with 140 platform skips and no failures
(`C:\MusicMuteBuild\reactivation-native.json`,
`C:\MusicMuteBuild\reactivation-full-native.json`). The full macOS suite passed
517 tests with twelve Windows-only skips and no failures
(`/tmp/musicmute-reactivation-full-mac.json`); the focused cross-platform
update/reactivation suite passed 86 tests. Typecheck, lint and build passed on
both hosts. Formatting, generated-protocol consistency and diff whitespace
checks passed locally. An older source-text ordering assertion initially
matched the newly added reactivation function rather than the install flow;
its search now starts at that flow's consistency check, and reruns passed.

Native service status and bounded wait behavior were reviewed against
Microsoft's Win32_Service and ServiceController contracts:
https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-service
and https://learn.microsoft.com/en-us/dotnet/api/system.serviceprocess.servicecontroller.waitforstatus.
SCM Running alone is not used as processing readiness evidence.

Next: complete signed Windows update activation under the native transaction,
including sequence commit, rollback, recovery after installer termination,
preserved running/stopped state and explicit capacity requalification for a
changed release. Then build the next immutable package and run real service
reactivation/update acceptance, followed by the remaining broader Windows and
macOS qualification/integration gates. No Git commit, publication or production
deployment was performed in this pass.

## Windows signed update activation

The normal Windows `update [--force] [--json]` route now downloads and verifies
the signed ZIP, prepares a private release and invokes its verified manager.
Under the native installer and operator locks, the manager revalidates the
signature, sequence, quarantine state, original config/credential hashes, exact
managed paths and both release inventories before activation. Download grants
and raw credentials are not persisted in the update request. The update preserves
pairing and the first stable worker identity; a changed release initially uses
one slot and requires fresh capacity qualification before enabling two.

The native transaction journals lifecycle and update sequence state alongside
the activation files. Graceful update requires a current service-process
snapshot acknowledging the requested drain revision with no active attempts.
The manager then qualifies the candidate as LocalService and preserves the
original running/stopped state and lifecycle intent. Sequence advances only at
commit; rollback restores the original files and quarantines the failed
candidate. Recovery selects the journal's installed, verified manager and accepts
`--leave-stopped` for offline repair. Recovery still depends on that candidate's
intact verified inventory; recovery from an arbitrarily corrupted runtime is not
established by these changes.

The journal now uses schema version 2 directly, without a migration path. The
Z440 had no pending operation before using this format. Private file copies now
stream into a new file, flush to disk, apply the destination ACL and rename.

Validation before native activation: the focused local suite passed 55 tests;
the full macOS suite passed 523 tests with thirteen platform skips and no failures
(`/tmp/musicmute-update-activation-focused.json`,
`/tmp/musicmute-update-activation-full-mac.json`). The focused native Windows
suite passed 26 tests with no skips or failures
(`C:\MusicMuteBuild\update-activation-native.json`). Typecheck, lint and build
passed on both hosts. These include native NTFS/journal tests with substituted
SCM operations; they do not by themselves establish actual service activation.

Immutable Windows candidate `0.1.0-win.20260929.9` was built with 18,738 manifest
entries. `C:\MusicMuteBuild\runtime-current-9.zip` is 354,459,134 bytes with
SHA-256 `50de784cb9bcb7e4a2a1885398d33412024b108d6d8134ceb870db007461221c`.
The source README was subsequently updated. The immutable runtime payload has
not been overwritten; the Windows runtime builder does not copy that README
into the archive.

Native acceptance uses the actual Z440 service/filesystem and a loopback-only
metadata API plus HTTPS archive server with a process-scoped test CA. Its first
fixture attempt incorrectly renamed fields inside the signed metadata; that
attempt is not signature-verification proof. The fixture now uses the production
wire-format helper, which preserves the signed payload. A second attempt passed
specific signature rejection and read-only checking, then stopped because the
test classifier did not recognize the downloader's actual integrity-error text.
Both attempts restored the machine to candidate 8, Stopped/Manual/PID 0, with no
pending recovery or synthetic trust/sequence state. The corrected acceptance
rerun and real activation results are recorded below when complete.

### Native rollback exposed persisted SCM restart actions

The corrected candidate 9 acceptance run passed specific signature rejection,
read-only checking and archive integrity rejection. The deliberately invalid
qualification WAV then exposed a real service transaction defect: changing the
WinSW XML to `onfailure none` did not change the restart actions already stored
in the existing SCM registration. The qualification process failed, Windows
restarted it, and a queued restart raced rollback. The journal correctly recorded
`wasRunning: false`, but the old runtime was briefly started anyway. This run
does not establish successful rollback or activation.

The harness's explicit recovery completed and independently verified candidate 8
Stopped/Manual/PID 0, no pending journal, no synthetic trust/update state and the
original qualification fixture restored. Evidence is
`C:\MusicMuteBuild\update-native-result.json` (failed at qualification rollback),
plus the private service wrapper/error logs. The archive was requested twice:
once for integrity rejection and once for the failed qualification transaction.
The acceptance backup and transaction scratch are retained until checked cleanup.

The root cause matches the pinned WinSW 2.12.0 source: failure actions and delayed
startup are configured by `install`; `start` does not refresh them. Microsoft
also documents that an already queued SCM restart cannot be canceled by stopping
the service and requires disabling the service to prevent execution:
https://raw.githubusercontent.com/winsw/winsw/v2.12.0/src/WinSW/Program.cs
and https://learn.microsoft.com/en-us/windows/win32/api/winsvc/nf-winsvc-changeserviceconfig2w.

The manager now uses the native SCM configuration APIs to snapshot and restore
startup mode, delayed startup, reset period, failure actions and non-crash failure
behavior. Before qualification it disables the registration, removes restart
actions and waits out the greatest previously configured restart delay, then
enables only a manual qualification service with no restart action. Rollback and
successful replacement restore the saved SCM policy. Unsupported reboot/command
actions or restart delays over one minute are rejected before service mutation.
This uses journal schema version 3 directly; no pending journal existed before
the format changed. Recovery validates integer types and bounded action arrays.

All eight focused native recovery tests passed, including a temporary real SCM
registration that is never started: it proves policy read/write, durable journal
capture, disabled qualification settings, queued-delay waiting and exact policy
restoration. Existing filesystem rollback and killed-installer tests also passed.
The local focused CLI suite passed 19 tests with eight Windows-only skips.
Typecheck, lint and build passed on both hosts. The subsequent full Windows
suite passed 397 tests with 140 skips, and the full macOS suite passed 523 tests
with fourteen skips, with no failures (`scm-recovery-full-native.json` under
`C:\MusicMuteBuild`, `/tmp/musicmute-scm-recovery-full-mac.json`). Generated
protocol consistency and diff whitespace checks passed. Candidate 9's failed
fixture backup and transaction scratch were removed only after another successful
restoration check; its result is retained as
`C:\MusicMuteBuild\update-native-scm-failure.json`.

Candidate 10 packaging initially refused a direct Node invocation because it
did not receive pnpm's JavaScript entry point. The failed build cleaned its
temporary tree and created no release/archive. Packaging was retried through
the documented `pnpm run package:windows` entry point. Candidate 9 remains
immutable and unactivated. The remaining normal stop/unpair/uninstall audit must
also cover an already queued SCM restart; the maintenance-policy tests alone do
not establish that broader lifecycle guarantee.

Candidate `0.1.0-win.20260929.10` packaged successfully with 18,738 manifest
entries. `C:\MusicMuteBuild\runtime-current-10.zip` is 354,461,561 bytes,
SHA-256 `b88fb9623c1dfd132e095e145986d66873895c616ecf73564d54c65c0beaac89`.
The next native update harness additionally compares the original SCM policy
after rejection, rollback and successful stopped activation. It is
`C:\MusicMuteBuild\musicmute-native-update-acceptance-next.mjs`; the candidate 9
harness remains preserved under its original filename. A separate prepared
`musicmute-native-reactivation-acceptance.mjs` exercises the packaged CLI's
paired uninstall, preserved installation, automatic startup configuration and
runtime readiness with an idle synthetic backend. Neither new acceptance route
is recorded as passed until its actual result is inspected.

### Fresh macOS artifact for native parity acceptance

Read-only inspection found Mac16,11 with 24 GiB RAM and twelve physical/logical
CPU cores. The existing `com.musicmute.worker` LaunchAgent remained PID 18037,
using `0.1.0-mvp.45-limits.local.20260929.2`, one configured MPS slot and capacity
one. Its fresh runtime snapshot reported no active attempts. No operational
service/configuration change was made for this artifact build.

The previously clean build at
`/tmp/musicmute-macos-current-0V5S2Q/release` passed its complete 20,147-entry
inventory verification before reusing its private Node/Python/media inputs.
Current source was packaged as `0.1.0-native.20260929.1` under
`/tmp/musicmute-macos-native-JbpeVb/release`, with 20,198 manifest entries.
The archive `/tmp/musicmute-macos-native-JbpeVb/runtime.tar.gz` is 330,921,344 bytes,
SHA-256 `5c4ca847cc7796526814e2d89ef697731f83e651e6a8a5c5326a90db2142a058`.
Its package evidence is saved in that build directory. This establishes artifact
construction/inventory integrity; fresh native MPS qualification, two-worker
throughput/output comparisons and CLI lifecycle acceptance are still required.

### Candidate 10 signed update acceptance and native Mac teardown

The actual Windows update acceptance completed successfully for
`0.1.0-win.20260929.10`. The normal CLI rejected a wrong metadata signature and
a corrupted archive, checked valid metadata without downloading, rolled back a
failed native qualification, refused the quarantined candidate, and then
activated the valid candidate while leaving the service Stopped/Manual. It
committed sequence 1, retained the original machine credential and first slot,
required fresh two-worker capacity approval, and preserved the original SCM
policy. The fixture made three archive requests and removed its temporary trust
and sequence state. Evidence: `C:\MusicMuteBuild\update-native-result.json`.
The separately chained paired-uninstall/reactivation acceptance is still pending
until its result is inspected.

Before fresh Mac qualification, the old idle operational LaunchAgent was stopped
with its own packaged CLI. All 20,105 declared release entries matched; 3,155
extra entries were exclusively generated Python caches. Those exact extras were
removed after checking no runtime process still owned the release. The active
release then passed its complete inventory check. The stale installation record
was corrected to the actual active version. Private backup:
`~/Library/Application Support/MusicMuteWorker/state/native-acceptance-nBrTiW`.
Configuration and credential were preserved, and the active pointer stayed on
`0.1.0-mvp.45-limits.local.20260929.2`.

Candidate `0.1.0-native.20260929.1` passed real launchd/MPS qualification with the
canonical 12-second fixture and both recipes. The report recorded 27.897 seconds
of preload, 8.667 and 2.582 seconds per recipe, and 39.167 seconds overall. Both
outputs were 12-second, 160-kbps MP3 files of 241,415 bytes. These are qualification
observations, not repeated throughput benchmarks or a two-worker approval.
The report is `candidate-qualification.json` in the private backup.

The harness's final assertion exposed an asynchronous teardown race:
`launchctl bootout` returned before the registration disappeared. Qualification
had passed, but the original complete harness did not pass. A subsequent
authoritative launchctl check returned 113 (label absent); the original plist was
restored and configuration/pointer preservation rechecked. Evidence:
`cleanup-verification.json` beside the report. The result's earlier
`serviceLeftStopped` field alone must not be read as a passed cleanup assertion.

The unload wait now belongs to `MacLaunchAgentController.bootout`, covering all
native callers instead of only normal CLI stop. It uses a monotonic thirty-second
deadline and propagates status errors; ENOENT for a missing executable no longer
means an unloaded registration. Regression tests cover delayed removal, timeout
and inspection failures. Real launchd tests passed both one-shot qualification
teardown and persistent-service crash restart followed by delayed SIGTERM exit;
they verified the replacement process was gone after bootout. The one-shot
fixture was also corrected to place its executable under the release root used
by the generated qualification plist. Native report:
`/tmp/musicmute-launchd-teardown-native.json` (2 passed, no skips).

The first focused run had 85 passes and one CLI fixture failure because its
mocked status sequence still included the moved unload check. After correcting
that fixture, all 36 CLI tests passed
(`/tmp/musicmute-launchd-teardown-cli.json`). Typecheck, lint, build, targeted
formatting, generated protocol consistency and diff whitespace checks passed.
The installed macOS launchctl manual and Apple's
[launchd guide](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html)
were consulted; the teardown race itself was observed on the native host.

The corrected Mac runtime is immutable candidate `0.1.0-native.20260929.2`,
20,198 entries, under `/tmp/musicmute-macos-native-JbpeVb/release-2`.
`runtime-2.tar.gz` is 330,920,434 bytes, SHA-256
`c8e2268a16ed188b2a531c08926b00452bc79ab574457939e66ca59da80765c8`.
Its signed normal-CLI update acceptance is being run with loopback-only metadata,
a process-scoped HTTPS fixture CA, protected metadata backups and exact
configuration/credential restoration. It is not yet recorded as passed.

The subsequent Windows reactivation result passed all cases: existing-install
idempotence, paired uninstall, preserved-install reactivation without enrollment,
automatic startup configuration, runtime readiness and zero job claims. The
fixture restored the service to Stopped/Manual and removed its private metadata
backup. Evidence: `C:\MusicMuteBuild\reactivation-native-result.json` and the
synthetic fixture evidence under its recorded output prefix. Automatic startup
configuration is not a reboot test.

Mac candidate 2 then passed the normal packaged CLI's signed update acceptance.
It rejected the wrong signature, checked metadata without downloading, fetched
one HTTPS archive, qualified both recipes under real launchd/MPS, activated the
candidate, committed its sequence and remained unloaded. The actual qualification
took 39.366 seconds including 28.571 seconds of preload. Backup/evidence:
`~/Library/Application Support/MusicMuteWorker/state/native-update-eT5bF3`,
specifically `result.json`, `qualification.json` and `cleanup.json`. Cleanup
verified the original configuration and credential, removed the fixture signing
trust, and restored the original sequence authority while recording the new
installed version as known good. No production update catalog was changed.
The local acceptance harness is `/tmp/musicmute-mac-update-native.mjs`; its
initial attempt stopped at a fixture path typo before any configuration mutation.

The full macOS TypeScript regression suite after the teardown fix passed
527 tests with fourteen skips and no failures
(`/tmp/musicmute-launchd-teardown-full.json`). The native launchd integration
tests above were enabled and run separately, rather than counted as passed skips.
The normal packaged Mac CLI has now started two-worker MPS benchmarking with
private evidence under `state/native-capacity-V0CrDy`; it will enable capacity
two only after qualification and repeated quality/throughput checks pass.
Windows candidate 10's normal packaged CLI has likewise started its fresh
two-worker DirectML benchmark, targeting
`C:\MusicMuteBuild\capacity-native-10.json`. These running benchmarks do not yet
establish fresh capacity approval.

Mac candidate 2's fresh two-worker benchmark subsequently passed and the normal
CLI successfully applied `capacity --workers 2`. The configuration now contains
two stable slots, validated capacity two and a schema-3 receipt expiring
2026-10-06T07:00:58.096Z, bound to manifest digest
`afd051e73018545abe92901353b937357df9ec5b21482c3fa5141f6c25668900`.
The canonical 12-second input, group size two, one warm-up and three measured
runs per worker produced the following post-warmup measurements:

| Recipe               | One worker, three files | Two workers, six files | Throughput gain |
| -------------------- | ----------------------: | ---------------------: | --------------: |
| `kim-vocals-v2`      |                3.3231 s |               5.5336 s |         1.2011x |
| `kim-vocals-v2-trim` |                3.2858 s |               5.4638 s |         1.2028x |

All eighteen decoded comparisons passed. Maximum absolute differences were
0.00003220 and 0.00002994, and maximum RMS differences were 0.000003123 and
0.000003414 respectively. These small MPS numerical differences are within the
existing quality limits; the outputs are not byte-identical. Individual process
lifetime peak resident memory was approximately 1.00-1.01 GB. That measurement
excludes GPU allocation and media subprocesses and is not a simultaneous system
memory peak. The report confirms MPS execution with fallback disabled.

Evidence: `state/capacity-measurements.json`, `state/capacity-validation.json` and
`state/native-capacity-V0CrDy/{benchmark,capacity,result}.json` under the actual
Mac installation. Independent read-back confirmed two configured workers and
launchctl exit 113 after completion. The first slot, machine identity, backend
origin and credential were preserved. Lifecycle remains draining and the service
unloaded for subsequent native job/lifecycle tests. This is local engine capacity
proof on this host and fixture, not live backend/S3 or long-audio acceptance.

### 2026-09-29: fresh Windows capacity, Mac active drain and Windows explicit stop

Windows candidate `0.1.0-win.20260929.10` completed its fresh normal-CLI
DirectML two-worker benchmark and applied capacity two. Evidence:
`C:\MusicMuteBuild\capacity-native-10.json` and `capacity-native-10-cli.json`.
The manifest digest is
`2fe01bbb3fed2b2bc9b15b6b958108ada0f19263e403796cac9d0a36d250d664`.
With the canonical 12-second fixture, one warm-up and three measured runs,
the untrimmed recipe processed three files in 12.8796 seconds with one worker
and six files in 16.6225 seconds with two workers (1.5497x throughput).
The trimmed recipe measured 12.3645 and 16.6057 seconds (1.4892x).
All eighteen decoded comparisons had zero absolute and RMS difference.
This is fixture throughput under the native LocalService/WinSW execution path,
not a guarantee for long recordings. Memory scope excludes GPU and media children.

Mac candidate `0.1.0-native.20260929.2` also completed two concurrent 120-second
synthetic jobs through the real managed LaunchAgent and two MPS children.
The normal packaged CLI acknowledged draining while both attempts were active,
then returned after 17.2685 seconds with `forced=false` and zero active attempts.
Both jobs reached `ready`; their server-observed claim-to-completion windows were
16.6870 and 16.6560 seconds, overlapping for 16.6360 seconds. Each output was
120-second, 44.1 kHz stereo MP3, 2,401,219 bytes. Evidence is under the actual
Mac installation's `state/native-jobs-qvXbBC`: `result.json`,
`drain-observation.json`, `drain-command.json`, `cleanup.json` and fixture evidence.
Cleanup verified original configuration, plist and credential preservation,
restored draining intent, and unloaded the service. Loopback backend/storage and
a private diagnostic spool kept the test separate from production traffic.
Two earlier harness runs completed both jobs but failed their drain assertion:
they awaited the blocking drain command before trying to observe active work.
Those runs are not acceptance passes; the corrected harness observed concurrently.

The Windows service functions now live in the shared packaged
`installer/windows-service-functions.ps1`, imported by the installer and native
CLI controller. Explicit stop journals the original SCM policy, disables recovery
while any previously queued restart can expire, waits for Stopped/PID 0, then
restores the policy and commits. Interrupted explicit stop records stopped
recovery intent. CLI stop/restart/removal also call this path when SCM already
reports Stopped, since that state alone does not rule out a queued crash restart.
The helper is manifest-verified before execution and PowerShell uses the
installer's process-scoped RemoteSigned policy.

A real temporary WinSW/LocalService integration test passed on the Z440:
`C:\MusicMuteBuild\stop-queued-restart-native-4.json` (one pass, no skips).
It force-terminated its owned wrapper, verified SCM crash event 7031, invoked the
actual stop helper, checked exact recovery-policy restoration and no journal,
and confirmed the service stayed stopped after another six seconds.
It removed its unique service registration and owned child. Earlier attempts
failed fixture setup (execution policy, account XML and Start Pending timing);
those failures do not establish stop behavior. Their owned registrations were
cleaned up before the successful run.

Local typecheck, lint, targeted formatting and build passed after the final
fixture correction. This stop implementation is source/native-fixture validated;
installed Windows candidate 10 does not contain it yet. A new immutable package
and normal-CLI installation/update acceptance remain required.

The subsequent full native Windows TypeScript suite passed 397 tests, with
145 platform/opt-in skips and no failures
(`C:\MusicMuteBuild\stop-policy-native-full.json`). The real queued-restart
integration above was enabled separately and passed, rather than counted as a
passed skip. Native typecheck, lint and build also passed. Independent SCM
read-back found only the managed worker, Stopped/Manual/PID 0, with no remaining
`MusicMuteStopFixture-*` registration. Candidate 11 packaging is the next gate;
these results do not establish that the installed candidate 10 includes the fix.

Candidate 11 packaging subsequently passed through the documented native
`pnpm run package:windows` entry point. The immutable runtime is
`C:\MusicMuteBuild\runtime-current-11`, version `0.1.0-win.20260929.11`,
18,742 manifest entries. Its ZIP is 354,465,394 bytes with SHA-256
`8b3945fb2665b63b711ba576ec3f4908a92274bbbf7fa78feed478cfc88a31f0`.
This package includes the shared stop helper. It has not yet replaced installed
candidate 10. Next acceptance must update to 11, exercise normal packaged stop,
requalify two-worker capacity against its manifest, then continue active-job,
interruption and unattended-startup checks. The direct low-level manager
Uninstall path also remains part of the final lifecycle audit.

### 2026-09-29: low-level uninstall audit and native rollback coverage

The low-level PowerShell `Uninstall` action previously ignored `stopwait` failure
and removed activation files immediately after requesting service deletion.
It now snapshots the installation before drain, disables queued recovery,
requires graceful drain and Stopped/PID 0, and waits up to thirty seconds for
SCM deletion before removing activation files. A failed drain restores original
files and policy; an interrupted removal uses the existing durable journal to
recover a stopped installation. No journal schema migration was introduced.
This follows Microsoft's documented
[queued restart behavior](https://learn.microsoft.com/en-us/windows/win32/api/winsvc/nf-winsvc-changeserviceconfig2w)
and [deferred service deletion](https://learn.microsoft.com/en-us/windows/win32/api/winsvc/nf-winsvc-deleteservice).

Nine native Windows tests passed with no skips against the final source:
`C:\MusicMuteBuild\uninstall-native-final.json`. These cover SCM policy and
journal recovery, a rejected uninstall drain restoring original state, real
WinSW/LocalService crash restart suppression, removal preserving retained state,
and repeated removal. The source-contract test, local typecheck, lint, targeted
formatting and diff whitespace checks also passed. Native fixture registrations
were absent after cleanup. An earlier nine-test pass was followed by the final
Stopped/PID 0 assertion and the complete focused rerun recorded above.

Candidate 11's update acceptance uses its packaged Node and CLI, with synthetic
loopback metadata/storage and process-scoped fixture trust. Its signature,
read-only and corrupted-download checks have passed; qualification rollback and
successful activation are still running. The immutable `.11` package remains
unchanged. Candidate `.12` packaging has started from the source that adds the
low-level uninstall correction; neither packaging intent nor these fixture tests
establish final installed-package acceptance.

Candidate 11's packaged update acceptance subsequently passed all nine recorded
cases: invalid signature, read-only metadata, corrupt archive, failed qualification
rollback, quarantine rejection, stopped activation, sequence commit, capacity
invalidation and exact SCM-policy preservation. Evidence:
`C:\MusicMuteBuild\update-native-result-11.json`. Three archive requests were
expected across corrupt, failed-qualification and successful attempts. Cleanup
removed synthetic trust/sequence state and the private backup. Read-back confirmed
active version 11, one configured/validated slot and Stopped/Manual/PID 0.
This does not apply the later maintenance drain changes described below.

Candidate 12 packaging also completed (18,742 entries; 354,465,636-byte ZIP;
SHA-256 `405583286607e6568ebb8131a04298b005b3f7653b46d5052375d310c5ba8488`).
It was not installed. Further review found that beginning the recovery journal
before drain acknowledgement could make rollback stop still-active work after a
refused drain. The subsequent source separates `Wait-WorkerDrain` from native stop,
performs acknowledgement before journaling, and retains original lifecycle bytes
in the same schema-3 snapshot for a successful update. Removal waits before its
transaction as well. A failed or interrupted pre-transaction drain cannot invoke
transaction rollback. Candidate 12 must not be promoted as the final artifact.

Drain intent is also published for an initially stopped service, and service
identity is inspected again afterward. This fences claims by a queued replacement
before journal preparation. The normal Windows CLI and removal paths likewise
reinspect after publishing intent; stopped removal no longer skips that step.
Regression cases cover a restart crossing the initial stopped snapshot, removal
without a stale runtime-status dependency when the service stays stopped, and
preservation of the original paused intent in the post-drain update snapshot.
Local focused source tests passed 31 cases. Typecheck, lint and build passed.
The full macOS-host TypeScript suite passed 529 tests with fifteen platform/opt-in
skips and no failures (`/tmp/musicmute-maintenance-final-macos-full.json`).
The final native Windows full-suite result is still pending.

Mac candidate 2 passed actual two-worker failure isolation with 120-second input:
slot zero rejected corrupted transfer bytes with `DOWNLOAD_FAILED` and no upload;
slot one completed a 120-second stereo MP3 of 2,401,219 bytes. Its server-observed
claim-to-completion window was 12.4534 seconds. Evidence under the actual Mac
installation: `state/native-jobs-REJa8S/{result,cleanup}.json` and fixture evidence.
The first harness expected `INPUT_CHECKSUM_MISMATCH`; source inspection confirmed
that transfer checksum rejection is classified as `DOWNLOAD_FAILED`. That first
run was not counted as a pass, and the corrected harness was rerun.

Mac cancellation isolation then passed with 600-second inputs. The fixture sent
cancellation 20.0108 seconds after slot zero's claim, while separation was active.
That slot uploaded nothing. Slot one completed in a server-observed 50.0443 seconds
and produced a 600-second, 44.1 kHz stereo MP3 of 12,001,219 bytes. Evidence:
`state/native-jobs-guo6A6/{result,cleanup}.json` and fixture evidence.
The initial 120-second cancellation trial finished before the next lease renewal;
its observation timed out and it was not counted as cancellation proof. The
600-second rerun exercised the normal lease-renewal cancellation route.

Both passed Mac scenarios used the real managed LaunchAgent and MPS children with
loopback-only backend/storage and isolated diagnostic spools. Each cleanup verified
original configuration and credential preservation and an unloaded service.
The native harness is `/tmp/musicmute-mac-failure-native.mjs`; source/fixture
results do not establish production backend/S3 acceptance or Windows long-audio
performance.

The final native Windows suite passed 400 tests with 144 platform/opt-in skips
and no failures (`C:\MusicMuteBuild\maintenance-final-windows-full.json`).
`MUSICMUTE_WINSW_TEST_BINARY` was set to the pinned WinSW executable, so the real
crash-stop/uninstall fixture was enabled in this run. Native typecheck, lint and
build also passed. The exact source was then used to start immutable candidate
13 packaging; candidate 11 remains the installed stopped runtime until the new
artifact and its own installation acceptance complete.

A read-only power-policy check found the Z440 on the Power saver scheme, with
AC `STANDBYIDLE` set to zero (disabled), and DC timeout 600 seconds. No power
settings were changed. This observation describes the current host; historical
benchmark reports did not capture the active power scheme. Subsequent performance
reports should include that condition, and a controlled power-plan comparison
remains available if needed before selecting operating settings.

Candidate 13 packaging completed successfully: version `0.1.0-win.20260929.13`,
18,742 manifest entries, `C:\MusicMuteBuild\runtime-current-13.zip`,
354,466,081 bytes, SHA-256
`374961518b3d64fc52244d37917777e5ae7a95845a8e9e312318bfb89d50cec9`.
This package includes the final pre-transaction drain and fresh service inspection
changes covered by the 529-test macOS-host and 400-test Windows runs above.
Its own packaged read-only/update acceptance has now started against stopped
candidate 11 using `C:\MusicMuteBuild\musicmute-native-update-acceptance-13.mjs`.
The intended evidence output is `update-native-result-13.json`; it is not yet a
passed installation result. The prepared native two-worker active-drain harness is
`C:\MusicMuteBuild\musicmute-windows-jobs-native.mjs`; it must run only after
candidate 13 is installed and its manifest-bound two-worker capacity is approved.

Candidate 13 packaged update acceptance passed. Fresh SSH readback confirms
`DESKTOP-QKJDJ2G`, user `desktop-qkjdj2g\hatem`, active release
`0.1.0-win.20260929.13`, and service `MusicMuteWorker` stopped/manual with PID zero.
`C:\MusicMuteBuild\update-native-result-13.json` reports read-only check, stopped
update, sequence commit, capacity remaining unapproved and exact SCM policy
preservation all passed; one archive request. The private backup was removed and
synthetic trust/sequence state was removed. Its canonical two-worker benchmark
was then started using the installed packaged Node/CLI, with report paths
`capacity-native-13.json` and `capacity-native-13-cli.json`. Power saver was the
observed active scheme at benchmark start. No power-policy mutation was made.

Candidate 13 canonical two-worker qualification completed with exit zero and
`PASS` in `C:\MusicMuteBuild\capacity-native-13.json`. The installed manifest
digest is `520813a82bbd87eecd2d3611876c309f887081bd337eb5aec88b09e7ea121e52`.
DirectML under LocalService ran one warmup and three measured runs per worker
for both recipes, using the canonical 12-second fixture. `kim-vocals-v2` measured
12.4446705 seconds for three serial outputs versus 16.8398393 seconds for six
concurrent outputs (1.47800347x throughput). `kim-vocals-v2-trim` measured
12.6324540 versus 16.7772302 seconds (1.50590459x). All eighteen decoded quality
comparisons passed, with zero maximum absolute and RMS differences. Power saver
was confirmed before and after the command; this is the measured operating
condition, not a claim about other plans or arbitrary input quality. The normal
packaged `capacity --workers 2 --json` command was started after this PASS.

The packaged capacity command completed successfully and fresh configuration
readback confirms two slots and `validatedMaxWorkersPerGpu: 2`. The receipt
remains PASS and expires `2026-10-06T08:41:40.313Z`. The first existing slot was
preserved. Service startup was not performed by capacity activation; production
backend admission remains authoritative. The prepared 600-second two-job native
harness was then started using the installed candidate 13 Node executable.

For the remaining boot acceptance, a read-only session probe was prepared using
Microsoft's documented [WTSEnumerateSessionsW](https://learn.microsoft.com/en-us/windows/win32/api/wtsapi32/nf-wtsapi32-wtsenumeratesessionsw)
and [WTSQuerySessionInformationW](https://learn.microsoft.com/en-us/windows/win32/api/wtsapi32/nf-wtsapi32-wtsquerysessioninformationw)
interfaces. It reports only session IDs, connection state and whether a username
is present, together with boot time; usernames are not emitted. The initial
direct script invocation was rejected by the host execution policy. The probe
was retried with the same process-scoped RemoteSigned policy used by the native
installer, without changing system policy. No reboot has been performed yet.

The session probe passed under process-scoped RemoteSigned: at
`2026-09-29T08:45:33.1521358Z`, Windows reported boot time
`2026-09-28T23:15:31.8421400Z`, session zero without a user and an active
interactive session one with a user. This is pre-reboot inventory only.
The native long-job test subsequently observed lifecycle revision 15, draining,
with two active separation attempts and window progress 63/106 and 61/106.
Completion and teardown remain pending; this intermediate observation alone is
not a passed long-job acceptance result.

The first 600-second Windows harness run was not counted as a pass. After the
drain command returned, its harness incorrectly expected Mac-style `forced` and
`activeAttempts` response fields. Windows returns `status` and `action`. The
actual runtime had acknowledged revision 15 and reached zero active attempts.
The corrected harness checks the Windows response and a fresh runtime snapshot
for zero attempts and the same draining revision. Its first cleanup passed,
preserving configuration, credential, XML and service policy, and leaving the
service stopped/manual/PID zero. Evidence: `service/job-acceptance-f883630a-c5f0-4dbf-8705-d42d279adde9/cleanup.json`.
The corrected test was started as a new run after confirming the first process
was terminal. No product code or installed artifact was changed for this
harness-only correction.

The installed interruption harness is prepared at
`C:\MusicMuteBuild\musicmute-windows-interruption-native.mjs`. It owns a normal
CLI stop process, waits for its durable journal and disabled SCM state,
terminates only that process's native maintenance child, then exercises the
packaged recover command twice and checks preserved files and policy. It has
not yet run. The boot harness (`musicmute-windows-boot-native.mjs`) is likewise
prepared but not executed: it records original settings, observes a fresh boot
and Session 0 workers without issuing a service-start command, and restores
temporary settings. Neither an actual reboot nor boot acceptance is claimed.

### 2026-09-29: real Windows status-file sharing failure and source correction

The corrected 600-second test exposed a product failure in candidate 13. The
service logged `EPERM` replacing `runtime-status.json` and restarted. At that
point one synthetic job had uploaded its 600-second output and completed; the
other had not uploaded. The harness later timed out and was not counted as a
pass. Its cleanup passed and restored original configuration, credential, XML
and service policy, leaving the service stopped. Evidence:
`service/job-acceptance-bd964410-667a-4d9a-bd68-bc5e42f6612f/cleanup.json`,
`C:\MusicMuteBuild\jobs-64cd6fbd-0089-4cef-9d47-bb6f5a0cdb64.evidence.json`,
and the native stderr log. The failure happened during read-only status
inspection; the precise conflicting handle was not traced.

Windows permits a reader to deny delete sharing, which also prevents rename
until that handle closes; see Microsoft's
[CreateFile sharing contract](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew).
`local-runtime-status.ts` now retries Windows EPERM/EACCES/EBUSY rename failures
with a monotonic two-second deadline, retaining the previous complete snapshot.
It never removes the destination to evade the sharing contract. Persistent
failures still propagate, and owned unpublished temporary files are removed.
POSIX publication retains immediate rename behavior.

The new native regression tests hold an actual Windows FileStream without
FILE_SHARE_DELETE. They prove old-snapshot visibility until release, successful
publication afterward, and bounded failure plus temporary-file cleanup when the
reader keeps its handle. Focused macOS-host checks passed 48 tests, with the two
Windows cases skipped; local typecheck/lint passed. The same focused suite on
Windows passed all 50 tests with no skips (`C:\MusicMuteBuild\status-sharing-native.json`).
The release artifact has not yet been rebuilt for this correction, so candidate
13's earlier benchmark remains historical evidence for that manifest, not
acceptance of the corrected source.

The corrected source also passed the full macOS-host TypeScript suite:
529 passed, 17 platform/opt-in skips, no failures, followed by a successful build
(`/tmp/musicmute-status-sharing-macos-full.json`). Native Windows typecheck,
lint and build passed. The full native Windows suite is running with the pinned
WinSW integration fixture enabled. No new candidate has been packaged yet.

The first full Windows run after the status-file fix finished with 401 passes,
144 platform/opt-in skips and one failure in the existing crash/restart fixture.
The helper refused its stable-service precondition during the fixture's five-
second queued restart window. Cleanup removed the owned fixture service. The
test now allows thirty seconds before SCM's queued restart, while still asserting
that stop waits the entire configured delay, preserves policy and suppresses
restart. Its command/test deadlines were increased to accommodate the deliberate
waits. This changes only the test's SCM fixture policy, not installed service
behavior. Local typecheck/lint/formatting passed and the full native suite was
started again (`status-sharing-windows-full-2.json`).

The rerun of the full native Windows suite passed 402 tests with 144
platform/opt-in skips and zero failures, including the enabled WinSW crash/stop/
uninstall fixture (`C:\MusicMuteBuild\status-sharing-windows-full-2.json`).
Candidate `0.1.0-win.20260929.14` packaging was then started in the existing
`C:\MusicMuteBuild\source-current` workspace with the same verified private
Node, Python, FFmpeg and WinSW roots. It contains the status-file sharing fix.

Candidate 14 packaging passed: `0.1.0-win.20260929.14`, 18,742 entries,
`C:\MusicMuteBuild\runtime-current-14.zip`, 354,466,499 bytes, SHA-256
`7fe12a67354a69c49398a1bc50fac822b784e4834e7a568b62b7da5adcf64e4a`.
Its packaged signed-update acceptance was started against stopped candidate 13
with two configured slots. Successful update must invalidate prior capacity,
preserve the first slot and private identity, and restore the original SCM
policy. Result path: `C:\MusicMuteBuild\update-native-result-14.json`.
This is a started test, not yet a passed installed release.

Candidate 14 signed-update acceptance passed with one archive request: read-only
check, stopped update, sequence commit, invalidation of prior capacity and exact
SCM policy preservation. The result confirms synthetic trust/sequence removal
and no retained private update backup. Live readback confirmed active `.14`,
Stopped/Manual/PID zero and no pending operation journal. Fresh two-worker
qualification was then started with `qualification.wav`, writing
`C:\MusicMuteBuild\capacity-native-14.json` and `capacity-native-14-cli.json`.

Final local protocol and formatting checks passed, as did all 11 packaging and
acceptance-fixture tests (`pnpm run protocol:check`, `pnpm run format:check`,
`pnpm run test:packaging`). No product source changed after packaging `.14`.

A fresh installed macOS status read confirmed active release
`0.1.0-native.20260929.2`, unloaded/stopped launchd service, draining intent and
no active attempts. The command returned exit 1 because the intentionally stopped
service is not ready; this is not recorded as a healthy running worker. The
configuration still has two slots and validated capacity two, and the receipt
remains PASS through `2026-10-06T07:00:58.096Z`. Windows cleanup inventory found
11 older installed candidates and 13 older build directories; removal remains
deferred until final candidate acceptance. The C: drive had 124,295,114,752 bytes
free at this inspection.

Candidate 14 fresh two-worker qualification completed with exit zero and PASS.
The report `C:\MusicMuteBuild\capacity-native-14.json` binds manifest
`3f0dbb03e73d4db914bc93a4fbf235130311b8f503bd07c9aa7d4a121e6db758`
and the canonical 12-second fixture to DirectML/LocalService on the RX 580.
After one warmup, three measured files per worker gave:

| Recipe               | One worker, 3 files | Two workers, 6 files | Throughput ratio |
| -------------------- | ------------------- | -------------------- | ---------------- |
| `kim-vocals-v2`      | 13.3201420 s        | 17.2503999 s         | 1.5443284883x    |
| `kim-vocals-v2-trim` | 13.2553051 s        | 17.3946545 s         | 1.5240664999x    |

All 18 decoded comparisons passed with zero maximum absolute and RMS
differences. Power saver was confirmed before and after; no power policy changed.
The normal packaged `capacity --workers 2 --json` activation was then started.
These measurements qualify this fixture and exact manifest, not every workload.

Candidate 14 normal capacity activation passed with exit zero. Readback confirmed
two slots and validated capacity two, PASS receipt expiring
`2026-10-06T09:40:11.544Z`, and no service start by the capacity command. The
retained first slot is `50b3b4f9-dd82-4f32-bfdd-55e6f32e5617`; the new second
slot is `51e31a33-9088-4e21-8a65-9d0d1599ed6c`. The installed-runtime 600-second
two-job/drain/repeated-stop harness was then started. Its strengthened assertions
require the service wrapper and supervisor identity to remain stable throughout
the jobs. This run is pending, not yet accepted.

### 2026-09-29: candidate 14 long jobs and graceful drain accepted

The installed `.14` long-job harness passed with exit zero. Evidence is under
`service/job-acceptance-3f2e0dd2-c798-45f8-b556-c71c1496fd4d/`
(`result.json`, `drain-command.json`, `drain-observation.json`, `cleanup.json`),
with synthetic transfer evidence at
`C:\MusicMuteBuild\jobs-bb0cdb64-28cb-4a24-ba98-7c2a4b794567.evidence.json`.

- Two simultaneous 600-second jobs completed and uploaded validated outputs.
  Both decoded durations are 600.000000 seconds; each MP3 is 12,001,219 bytes.
- Drain revision 23 was acknowledged with two active attempts and returned with
  zero attempts after 150.9283512 seconds. Read-only PowerShell status reads
  during separation observed the same supervisor without a publication crash.
- The harness verified unchanged wrapper/supervisor identity throughout jobs
  (wrapper 17036, supervisor 4772, supervisor creation
  `2026-09-29T09:41:54.4209980Z`).
- Normal and repeated stop passed. Final readback was Stopped/Manual/PID zero
  with no pending journal. Cleanup verified original configuration, credential,
  service XML and SCM policy.

Corrupt-input isolation, cancellation isolation and installed stop interruption/
recovery were then started sequentially, with a nonzero result stopping the
sequence. They remain pending until their own result and cleanup records pass.

Candidate 14 corrupt-input isolation passed. Evidence is under
`service/job-acceptance-54d46677-2f6d-4d59-afd7-aa63b3750ad0/`
(`result.json`, `cleanup.json`) and
`C:\MusicMuteBuild\jobs-76fb1ab9-2928-4fb1-8227-ed6d06b398e0.evidence.json`.
The corrupt slot failed `DOWNLOAD_FAILED` without upload; its sibling completed
in 27.2785538 seconds from claim, producing 120.000000 seconds of audio and
2,401,219 bytes. The wrapper/supervisor identity remained unchanged. Cleanup
passed for configuration, credential, service XML, stopped service and SCM
policy. The sequential runner then started 600-second cancellation isolation
with backup `service/job-acceptance-51e5901a-3a2b-4448-afd1-b702bcaa9677/`.

Final installed macOS `doctor --full --json` verified all 12 integrity and
configuration checks, including the release manifest and private runtime doctor.
The sole failed check was `SERVICE_NOT_RUNNING` for the intentionally unloaded
LaunchAgent, so the command correctly returned exit 1 and `healthy: false`.
Report: `/tmp/musicmute-macos-final-doctor.json`. No running-service health is
claimed from this offline audit.

Candidate 14 cancellation isolation passed. Evidence is under
`service/job-acceptance-51e5901a-3a2b-4448-afd1-b702bcaa9677/` and
`C:\MusicMuteBuild\jobs-3d2d5d67-b42a-4ac0-86f5-b0b7540b1a27.evidence.json`.
Cancellation was issued through the normal lease after separation was observed,
20.0388260 seconds after claim. The cancelled slot did not upload or complete.
Its sibling completed in 113.7447394 seconds, producing a 600.000000-second,
12,001,219-byte output. Stable wrapper/supervisor identity and all restoration
checks passed. The sequential runner started installed stop interruption/recovery
with backup `service/interruption-acceptance-82675075-aafd-41bc-8b0c-23c00b737466/`
and owned CLI PID 12164. Recovery acceptance remains pending.

Installed candidate 14 interruption/recovery passed with exit zero. The fixture
terminated only its owned maintenance PowerShell process (PID 16844) after the
durable stop journal and disabled service policy existed. The outer CLI returned
exit 1, leaving recovery pending as expected. Two normal packaged
`recover --leave-stopped --json` calls then passed. Original SCM policy and
configuration/credential/XML/active-release/capacity hashes were preserved; final
service state was stopped and the operation journal was absent. Both result and
cleanup records passed under
`service/interruption-acceptance-82675075-aafd-41bc-8b0c-23c00b737466/`.

Boot acceptance preparation was then started. The fixture preserves original
settings and temporarily selects automatic service startup. Verification requires
a fresh boot, no interactive user session, two ready registered slots, stable
service identity and the full recursive worker process tree in Session 0.
The planned restart uses `shutdown /r /t 0` without forced application closure,
following [Microsoft's shutdown contract](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/shutdown).
No boot result is claimed yet.

Boot fixture preparation passed with backup
`service/boot-acceptance-c5562fe1-2ce5-4e94-91ab-09677d116362/`.
The recorded previous boot time is `2026-09-28T23:15:31.8421400Z`.
Live preflight confirmed Stopped/Auto/PID zero, no operation journal and no
MusicMute Python processing. The normal restart request returned success and
SSH disconnected. As of `2026-09-29T10:16:36Z`, TCP port 22 remains unavailable;
new-boot/session/service verification and restoration have not run. The
prepared fixture intentionally remains available for verification or explicit
restore after reconnection. No boot acceptance is claimed from the restart
request alone.

### 2026-09-29: completion audit while reconnecting after reboot

The lifecycle, recovery/rollback and synthetic integration checklist items now
reference their accumulated evidence: current `.14` update/long-job/failure/
interruption results, native `.11` rollback/quarantine checks, and the corrected
source regression suites. This does not relabel earlier-package tests as fresh
`.14` executions. Saved local full-suite results were inspected again: macOS
CLI 36 tests, macOS updater 32, Windows CLI 17, Windows removal 11 and Windows
updater 10 all passed without skips in those suites. Native-only recovery
coverage remains attributed to the Windows run and installed interruption test,
not the macOS-host suite.

The rebooted host still times out on TCP port 22. An asynchronous question asks
for its visible boot state without signing in. Boot verification/restoration,
unused candidate removal, final Windows integrity readback and the final overall
audit remain incomplete. The existing reboot fixture and original settings
backup must be used after reconnecting; do not start another reboot or recreate
the fixture merely because observation timed out.

At `2026-09-29T10:22:20Z`, a fresh direct SSH attempt with a ten-second
connection deadline still returned exit 255 / connection timeout. The same
post-reboot connectivity blocker has persisted through three consecutive goal
turns. The goal was marked blocked, not complete. Source and completed native
validation evidence are preserved. Required remaining work depends on reconnecting
to the Z440 or obtaining its visible boot state; the readiness page records the
exact prepared fixture and restoration commands.

### 2026-09-29: SSH restored on the current Wi-Fi address

SSH authentication succeeded at `192.168.1.124`; its pinned ED25519 key matches
the prior Z440 address, and hostname remains `DESKTOP-QKJDJ2G`. Readback found
Wi-Fi 4 at `.124/24`, MAC `50-3E-AA-BF-03-3E`, both `sshd` and MusicMute running
with automatic startup, active candidate `.14`, two validated slots and the
expected synthetic loopback configuration. WTS observed an interactive signed-in
user after boot `2026-09-29T10:42:37.5000000Z`. That boot is not accepted as
no-sign-in proof. The original boot fixture's guarded restore mode was started;
no claim is made about which network change resolved the earlier timeout.

Previous boot fixture restoration passed, preserving configuration, credential,
XML and SCM policy and leaving MusicMute Stopped/Manual/PID zero. A direct WLAN
interface query was denied by Windows location privacy; no privacy setting was
changed. The saved active connection profile query succeeded and confirmed an
all-user, automatically connecting Wi-Fi profile (current network category Public).
SSH was confirmed Running/Auto and listening on both `0.0.0.0:22` and `[::]:22`;
Winlogon automatic interactive sign-in was not enabled.

A fresh boot fixture was prepared at
`service/boot-acceptance-c969e4f1-cb0f-4ab9-b584-cd13b0d29bd5/`, recording prior
boot `2026-09-29T10:42:37.5000000Z`. With MusicMute Stopped/Auto/PID zero, no
operation journal and no MusicMute Python processes, a normal non-forced restart
was requested at approximately `2026-09-29T12:25:42Z`. The user was asked to leave
Windows at its sign-in screen. Verification and restoration are pending for
this new fixture; the earlier inconclusive fixture has already been restored.

### 2026-09-29: native automatic boot without interactive sign-in passed

The fresh controlled reboot passed the installed `.14` boot harness. SSH returned
after an observed disconnect. The new boot time was
`2026-09-29T12:26:13.5000000Z`; WTS before and after readiness reported no signed-in
user. Without any service-start command, two slots registered and became ready.
The recursive nine-process tree (WinSW, Node, console hosts, two Python guardians
and two Python engines) ran entirely in Session 0. Service identity stayed stable
and capacity survived the reboot. The fixture allowed no claims.

Result and cleanup: `service/boot-acceptance-c969e4f1-cb0f-4ab9-b584-cd13b0d29bd5/`.
Both passed; configuration, credential, XML and SCM policy were restored and the
service was left stopped. A separate two-job 120-second processing acceptance
was then started while the machine remains signed out. It requires WTS proof
before/after processing, Session 0 descendants, stable service identity, complete
outputs, active drain and repeated stop. Its backup is
`service/job-acceptance-9c5939a5-ee31-44a2-bb1b-1fdef9482975/`. This additional
processing test is pending; the successful boot test proves startup/model loading
but is not relabeled as completed-job evidence.

### 2026-09-29: signed-out processing and final CLI package passed

The additional installed `.14` two-job test completed successfully under
`service/job-acceptance-9c5939a5-ee31-44a2-bb1b-1fdef9482975/`.
`result.json`, `headless-proof.json` and `cleanup.json` all passed. WTS before
and after processing reported no signed-in user on the same boot. All nine
worker processes ran in Session 0. Both 120-second jobs completed and uploaded
validated stereo 44.1 kHz MP3 outputs of 2,401,219 bytes. Separation took
27.398/27.405 seconds; claim-to-completion took approximately 32.94/33.28 seconds.
The wrapper/supervisor identity stayed stable; drain acknowledged two active
attempts, then normal and repeated stop passed. Original configuration,
credential, XML and SCM policy were restored; the service was left stopped.
These are real DirectML jobs with synthetic loopback backend/storage.

Final npm package creation and fresh-consumer smoke passed using
`pnpm run prepack` and `node scripts/test-package.mjs <output-directory>`.
Evidence is `/tmp/musicmute-cli-final.8w1UtQ/package/package-evidence.json`.
The 337-file `music-mute-worker-0.1.0-rc.1.tgz` has SHA-256
`8e98e3f449066b5be494f7db676201f3787f5aa4e15d936fad2e76272e1c2973`.
Fresh installation with lifecycle scripts disabled, CLI help/version and the
production dependency audit passed. Production acceptance was explicitly not
run; the package was not published or installed globally on Windows.

### 2026-09-29: final integrity audit and stopped-service budget reset

Installed Windows candidate 14 full doctor passed thirteen checks; only the
expected `SERVICE_NOT_RUNNING` check failed, because acceptance deliberately
restored Stopped/Manual/PID zero. macOS full doctor likewise passed twelve checks
with its sole expected unloaded-service failure. Current installed version
reporting returned CLI `0.1.0-rc.1` and Windows runtime `.14`. Saved full-suite
JSON was reread: macOS 529 passed/17 skipped, Windows 402 passed/144 skipped,
zero failures in both. Current Mac configuration retains two slots and its PASS
receipt expires `2026-10-06T07:00:58.096Z`.

Native `ResetRestartBudget` acceptance passed on the installed candidate 14
manager. A synthetic exhausted budget was moved to a unique preserved record
with identical SHA-256 and SDDL. Repeated reset passed and never started the
service; the original budget and ACL were restored. Evidence:
`C:\MusicMuteBuild\reset-budget-native-14.json`. This directly verifies the
stopped-service path; running-service rejection remains covered by the source
contract and service-state guard, not relabeled as a live running-service test.

Obsolete candidate cleanup was applied after reviewing its read-only plan of 29
exact paths. The accepted candidate 14, source workspace, private dependencies
and evidence are excluded. Removal is still running; final success requires
its report and preserved-file hash checks.

### 2026-09-29: obsolete candidate cleanup and final handoff

`C:\MusicMuteBuild\cleanup-native-14.json` reports PASS at
`2026-09-29T12:50:24.6958349Z`: all 29 allowlisted obsolete installed releases,
versioned build trees and ZIPs were removed. Eight protected files retained
identical hashes (active release, runtime config, credential, capacity receipt,
service XML/executable, current manifest and candidate 14 ZIP). Final independent
readback showed only installed `.14` and `runtime-current-14`, two validated slots,
a PASS receipt expiring `2026-10-06T09:40:11.544Z`, Stopped/Manual/PID zero, and
no operation-recovery journal. Original retired installation cleanup remains
documented separately above. The existing source workspace, current private
dependencies and native test evidence were preserved.

The README now references current candidate 14 native evidence. The final
337-file npm package was rebuilt and smoke-tested after these documentation
edits at `/tmp/musicmute-cli-handoff-package/`. SHA-256:
`41a34b7e0df945bbafb631d89c469f3c1894a7900460a05231ba489b41fc1adb`.
Inventory, fresh-consumer help/version and dependency audit passed; production
acceptance remains `not-run`. No runtime source changed after native candidate
14 was packaged, and no new native release was fabricated for documentation.

The requirement audit is closed for shared CLI development, native Windows/macOS
lifecycle and diagnostics, update/recovery, repeated benchmarks, qualified
two-worker execution, failure isolation, Windows signed-out boot/processing and
obsolete Windows installation removal. Scope is bounded by the exact test
reports: synthetic control plane/storage, canonical comparison fixture, real
DirectML/MPS hardware, no production enrollment/publication and no Ubuntu adapter.
Windows is left stopped/manual with its synthetic pairing; Mac is unloaded with
its original pairing. Neither is claimed to be an operating production fleet.
