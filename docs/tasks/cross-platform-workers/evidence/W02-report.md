# W02 implementation and execution report

Date: 2026-09-14. Local implementation and validation completed for review.
**No recipe is qualified or claim-capable.** Native/platform admission remains
open; this report does not mark the task complete.

## Implementation and exported interfaces

- `worker/musicmute_worker/profiles.py`: `Profile.load(path, expected_sha256)`
  consumes the digest authenticated by the W03 release-verification boundary;
  it is not an unsigned checksum-based admission authority. Exact GPU options,
  `Asset`, `verified_asset`, `fetch_asset`, `extract_python`, `prepare_runtime`,
  `PreparedRuntime.assert_claim_ready`, `descriptor`, and `fingerprint` implement
  candidate preparation, immutable identities and fail-closed product admission.
- `hardware.py`: `detect_hardware` and `compatible_profiles` provide bounded
  native inventory and deterministic qualified-only OS/architecture/vendor/OS-floor
  selection. Unknown RAM/VRAM stays unknown; Apple unified RAM is not dedicated
  VRAM. Windows WMI's truncating AdapterRAM is deliberately not trusted.
- `qualification.py`: `QualificationRunner.qualify(profile, fixture_path)` runs
  the sole separator under the existing bounded `ProcessRunner`, validates actual
  execution evidence and audio/reference results, and returns the existing wire
  report. `execution_evidence` rejects CPU, mixed, absent and wrong-provider
  execution. CoreML additionally requires GPU device placement for every observed
  compute-plan operation. `qualify_candidates` bounds fallback to three qualified
  GPU recipes. The optional native service observer defaults to unavailable;
  no local diagnostic manufactures service or boot proof.
- `separation.py` remains the **only model implementation**. `KimSpectrogram`,
  `KimSeparator`, `gpu_session` and the isolated `--qualify` path replace the
  hardcoded audio-separator/DirectML dependency. Product loading requires an
  explicitly qualified runtime descriptor. Session construction disables ORT CPU
  fallback and Python fallback, fixes batch one and checks a real warm inference,
  ORT node assignments and CoreML compute-plan device placement before readiness.
  Registered CPU provider presence alone is neither failure nor proof of use.
- Existing `engine.py`, `worker.py` and `progress.py` consume the selected private
  interpreter, explicit FFmpeg/model paths and runtime descriptor. Checkpoints
  bind all shared Python code, exact model, full profile/fixture/limits, runtime
  lock, provider/options, library versions and installed runtime-file inventory.
  A changed identity invalidates artifact reuse. Installed runtime files are
  rehashed before fresh admission. Assignment/cleanup journals remain unchanged.
- `runtime_types.py` includes the same six exact provider names and all fourteen
  safe setup reasons from the shared/B03 contract. No arbitrary provider string
  or new CPU-only recipe is accepted.

The Kim-specific numerical path preserves the pinned audio-separator v0.47.0
defaults: FFT 7680, hop 1024, 3072 frequency bins, 256 frames, batch one, overlap
0.25, denoise off, normalization threshold 0.9, and vocals-only FLAC intermediate.
The existing silence trimming and MP3 output flow is retained. This supports only
the exact SHA-bound Kim Vocal 2 model and prepared stereo 44100 Hz audio; other
model families and configurable segment/denoise modes are not advertised.
MIT source attribution and the complete notice are in
`worker/qualification/THIRD_PARTY_NOTICES.md`.

## Real preparation and audio execution

The only included installable diagnostic candidate is macOS ARM64. Its manifest
and complete wheel/native-asset lock are in `worker/profiles/`; its status remains
`candidate`, and the corresponding F01 inventory row remains `unavailable`.
The other eleven GPU-family inventory entries were preserved.

Lock SHA-256:
`a20b6f4c70fb81a9f620b615d2a6cfc54ec3d0c2ef96898bfa00914dafcbf0a8` (review round 1).

The final real preparation call completed in
`/private/tmp/musicmute-w02-round1-prepared`, using verified cached downloads under
`/private/tmp/musicmute-w02-cache`. It unpacked the exact CPython 3.12.13 archive,
created a private venv, installed only locally hash-verified wheels with no index,
passed `pip check`, compared the exact installed distribution map, extracted and
verified FFmpeg and FFprobe, verified the model, and inventoried **9435 runtime entries**, including regular files, directories and contained interpreter aliases.
No system Python, worker identity, service or real job was changed.

Exact distributions: cffi 2.1.1, flatbuffers 25.12.19, mpmath 1.3.0, NumPy 2.5.3,
ONNX Runtime 1.24.4, packaging 26.3, pip 26.0.1, protobuf 7.36.1, pycparser 3.0,
SoundFile 0.14.0, sympy 1.14.0 and typing-extensions 4.16.0. Every wheel URL,
length and SHA-256 is in the lock. Only one distribution owns ONNX Runtime.
The runtime excludes audio-separator, Torch, diffq and unrelated model-family
dependencies; this resolves the earlier binary-only diffq dependency blocker.

The verified standalone Python archive contains relative aliases. Preparation
validates names, targets, cycles, dangling links, ancestor type conflicts and
expanded byte limits, then materializes safe aliases as regular files. It emits
no symlinks. This is a narrowly scoped upstream Python preparation operation,
not permission for W03's general signed-release extractor to accept links.

Actual final `QualificationRunner` execution on Apple M4 Pro/macOS 26.6.2 used the
exact two-second integer-generated fixture. It exercised GPU model inference,
FLAC output, silence trimming, MP3 encoding with the pinned FFmpeg and final MP3
decoding. Observed report:

| Observation                          | Result                                        |
| ------------------------------------ | --------------------------------------------- |
| Accelerator / provider               | true / CoreMLExecutionProvider                |
| Device                               | Apple M4 Pro                                  |
| Wall time                            | 1812 ms                                       |
| Peak process host RAM                | 486998016 bytes                               |
| Peak GPU memory                      | null, not measured                            |
| Output valid / finite                | true                                          |
| Approved reference / service context | false / false                                 |
| Safe result                          | GPU_QUALIFICATION_FAILED; remains unqualified |

The four-GiB host-memory and 120-second diagnostic caps are conservative limits,
not measured media capacity. A 100 ms resource sampler terminates the isolated
runtime on excessive host RSS or diagnostic storage; it is not a hard native
allocation reservation or GPU-memory measurement. The existing process owner
enforces subprocess wall time and descendant cleanup. No concurrency or duration
limit was broadened from this short fixture.

The final values above were remeasured after the PCM16 writer correction. Earlier
full-pipeline observations were 4113 ms / 475922432 bytes; these short runs are
not controlled cold/warm benchmarks or a capacity comparison.

Independent [numerical reference evidence](W02-numerical-reference.md) passed
four STFT/ISTFT fixtures, fourteen overlap/padding cases and a real Kim model
comparison. Actual CoreML versus explicitly labelled isolated CPU reference:
relative L2 `9.718199829626781e-05`, maximum absolute error
`1.0145595297217369e-07`, finite stereo 88200-sample output. The CPU reference is
diagnostic-only and is not a product inference option. These comparisons establish
numerical parity on synthetic input, **not representative vocal quality**.

## Fresh admission and owned recovery

`Worker._claim` now checks the actual selected runtime before fresh admission.
Missing, candidate or failed local qualification cannot call the fresh `claim`
endpoint. Already-owned and uncertain same-session work uses the dedicated
`POST /worker/claim/recovery` route added by the root integration task. That route
can return existing ownership or `NO_OWNED_ASSIGNMENT`; it never selects new work,
waits for a queue item or depends on fresh processing availability.

Root-owned integration files: `backend/src/worker/worker.controller.ts`,
`backend/src/worker/dto/worker-request.dto.ts`, the existing
`worker-coordinator.service.ts`, focused HTTP/auth/coordinator tests and API docs.
The [independent recovery review](W02-recovery-review.md) covers those changes.
The direct worker regression proves an unqualified recovered assignment remains
journaled and starts no lease/download/inference. Existing terminal cleanup and
reconcile authority is preserved; no legacy decoder or migration was added.

Provider publication/reporting scope additionally changes
`backend/src/worker-releases/publication-receipt.ts`, its receipt tests,
`backend/src/worker/dto/worker-runtime.dto.ts`, its new provider DTO tests,
the shared Python types and `contracts.md`. MIGraphX, OpenVINO and ArmNN are exact
allowlisted vocabulary, not approval. Their runtime options remain GPU-specific;
CPU/AUTO/heterogeneous fallback is rejected by the actual recipe implementation.
ArmNN remains vocabulary-only: without a verified binary/GPU selector contract,
runtime preparation rejects it outright rather than assuming an unverified
`backend_type` option prevents internal CPU execution.

## Validation actually run

- Initial new profile/qualification/DSP/admission tests failed against absent or
  old behavior. Three signed-publication and three DTO provider cases failed
  before their exact allowlists were expanded.
- `PYTHONPATH=worker /tmp/musicmute-w02-prepared-final/venv/bin/python -m unittest
discover -s worker/tests -v`: **188 tests, OK, 8 skipped**, 41.403 seconds.
  Log: `/tmp/musicmute-w02-tests-final.log`. All skips are Windows-native checks;
  the previously unavailable NumPy/SoundFile tests ran in this prepared runtime.
- Separate F01 admission discovery: **20 tests passed**.
- Focused production admission tests: **4 passed**, including owned recovery
  without starting a lease or media operations. Separator/real FFmpeg/IPC tests:
  **11 passed**. The earlier broad failure used obsolete audio-separator mocks;
  those now substitute the sole loader boundary explicitly. No production test
  mode or runtime bypass was introduced.
- One terminal IPC fixture initially raced POSIX process termination. It now
  observes its expected terminal server exit before cleanup; dedicated process
  lifecycle/race tests remain unchanged. No production containment exception was
  swallowed, and `processes.py` was not edited.
- Combined provider receipt/DTO Vitest tests: **13 passed**. Root separately ran
  **11 HTTP/auth tests plus 1 isolated coordinator integration** for recovery.
- Backend `npm run typecheck`, `npm run build`, scoped Prettier and scoped
  `oxlint --deny-warnings` completed successfully.
- Final writer audit added a failing PCM16 regression against the pinned upstream
  pydub writer and corrected the one-LSB quantization difference: scale by 32767
  and truncate. All **3 focused Kim DSP/writer tests passed** afterward. The
  unchanged W01 trimmed-WAV quantizer still uses its original rounding.
- `python3 -m compileall -q worker/musicmute_worker`, scoped Ruff F/E9 checks,
  scoped formatting, JSON parsing and `git diff --check` passed. An all-package
  formatter check also found an unrelated pre-existing `transport.py` formatting
  difference; it was not changed.
- Source archive creation succeeded. `worker/package.py` now includes the
  candidate manifests/locks and third-party notice, with no model/runtime binaries
  or private state. Existing packaging tests passed in the final suite.

## Review round 1 fixes and validation

Both P1 findings in [the independent review](W02-review.md) were addressed in
`profiles.py`, `worker.py`, `engine.py`, `qualification.py`, the Mac candidate
lock/manifest, F01 candidate lock binding and focused worker tests.

- `runtime_inventory(root)` now records the complete immutable tree: directory
  modes, regular-file modes/lengths/hashes, and each contained alias's raw and
  resolved target. Admission compares the full current inventory and binds the
  actual executable path. Added files, interpreter retargeting, escaped/dangling
  links and links into mutable work fail closed. Python archive extraction still
  emits only regular files for its narrowly validated aliases; this is not a
  change to W03 release-bundle extraction rules.
- Prepared bytecode is included, never ignored. Only `work/` contents may change;
  that directory itself must remain the recorded real directory. Qualification
  output lives there. Runtime descriptors are created before inventory capture;
  product launches use isolated `-I -B` so they neither import the work directory
  nor generate new bytecode in the prepared tree.
- The lock now binds the matching Jellyfin FFmpeg/FFprobe 7.1.4 native pair, exact
  archive/member lengths and hashes. Both binaries participate in runtime
  inventory and checkpoint fingerprint. `inspect_audio` requires explicit paths;
  actual worker input preparation and final output validation supply those paths.
  Missing prepared tools has no PATH fallback. Stream count/type/codec/rate/channel
  and duration validation remain enforced. See [native asset evidence](W02-ffprobe-asset.md).
- Inventory regression tests first failed with the missing inventory API. After
  implementation, all **12 profile tests passed**, including unchanged runtime,
  mutable observations, retargeted interpreter and added Python/PTH/bytecode files.
  A first broad integration run exposed **21 errors** in old synthetic queue
  fixtures with no tool binding; these tests now explicitly resolve their own
  native test tools, without adding a production bypass.
- The corrected broad suite passed **195 tests, 8 Windows-native skips**, in
  **42.513 seconds** (`/tmp/musicmute-w02-round1-final-tests.log`). The actual worker
  orchestration suite passed **16 tests** in **11.803 seconds**. Real native media
  tests ran with `PATH=/nonexistent`, including valid preparation/MP3 validation
  and malformed, non-MP3 output, multistream and surround rejection. A subsequent
  missing-runtime regression checks the no-fallback failure directly. All **3
  focused native-media tests passed** in **1.780 seconds** afterward.
- The real locked preparation completed at
  `/private/tmp/musicmute-w02-round1-prepared`, with **9435 inventory entries**.
  All candidates remain unqualified; this preparation is not native service,
  admission, installation, distribution or capacity approval.
- Root independently ran real `Worker._result` under `PATH=/nonexistent`:
  preparation, actual CoreML inference and final pinned output validation passed
  in **6.288 seconds**, producing a **2.0-second, 49571-byte MP3**. The diagnostic
  engine adapter invoked the existing `--qualify` path, preserving candidate
  status; it did not forge product admission or native qualification. GPU evidence
  showed **178 GPU operations, zero CPU operations**. The complete **9435-entry**
  runtime inventory remained identical after execution. See
  [worker-path diagnostic and preserved harness](W02-worker-path-diagnostic.md).
  This proves the real worker media paths around GPU inference, not production
  SeparatorEngine admission, service boot or capacity qualification.
- Scoped Ruff F/E9, Python compileall and `git diff --check` passed after fixes.

## Remaining platform and distribution gates (unchanged)

No Windows, Linux or Intel Mac dependency lock, native GPU execution, driver floor,
service identity, unattended boot, cancellation-under-GPU-load, long-media capacity
or approved vocal-quality fixture is fabricated here. Those families remain
unavailable. The included interpreter extraction/install recipe is specifically
the verified standalone macOS ARM64 layout; new native formats require their own
verified packaging before additional profiles can be offered.

The Jellyfin FFmpeg/FFprobe 7.1.4 pair is a reproducible local diagnostic candidate. Its portable
archive does not contain the required complete native GPL notices/source package;
H01 must provide a reviewed current native build before shipping. Current official
FFmpeg 9.0.1 source/signature facts and Python provenance are documented in
[portable runtime assets](portable-runtime-assets.md). Kim model redistribution
permission remains unresolved. No binary/model was published or added to source.

W03 must authenticate manifest/lock authority; W04/native adapters must bind real
service/readiness state and activation ownership; H01/V01 must provide reviewed
native/quality/media evidence before any profile becomes qualified. There were
no commits, pushes, publishing, deployment, daemon installation, live-worker
operation, migrations, backfills or changes to unrelated Android edits.
