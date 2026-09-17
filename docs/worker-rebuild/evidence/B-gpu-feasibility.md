# B1–B4 GPU feasibility evidence

Observed 2026-09-17. This branch is a bounded feasibility spike; it does not add
worker enrollment, queues, supervisors, installers, dashboard pages or services.

## Checkpoint status

| Checkpoint | Status | Evidence |
| --- | --- | --- |
| B1 reproducible harness | PASS | Isolated probe, deterministic owned fixture, output validation, package lock and focused tests are under `tools/worker-gpu-feasibility/`. |
| B2 Mac mini M4/CoreML | PASS | Native ARM64 M4 Pro run produced valid output and six profiled CoreML provider node events with zero profiled CPU provider node events. |
| B3 Z440/RX 580/DirectML | PASS | The real Kim graph produced two valid outputs on adapter 0 and the profile assigned 672 node events to DirectML with no profiled CPU-provider node events. |
| B4 decision and pins | PASS | Both intended MVP platforms passed on their real hosts. Platform-specific direct pins and complete passing-environment locks are frozen. |

The target classifications required by B4 are therefore:

- Mac mini M4/CoreML: `PASS`.
- Windows Z440/RX 580/DirectML: `PASS`.

Both targets may proceed to the runtime implementation branch as qualified MVP
targets. This feasibility result is not service, installer, fleet, deployment,
quality-listening or production-support evidence.

## B1 harness

The probe generates `musicmute-owned-synthetic-v1`, an eight-second, stereo,
44.1 kHz PCM fixture made only from deterministic mathematical signals. Its
SHA-256 is `dd1c139a6353ba06075a4216b3e83ac8ae8ddc0601c434105dcece5486bf28c1`.
No third-party audio is stored or used.

The probe refuses incompatible host architectures and mixed ONNX Runtime
distributions. A pass requires all of the following:

- the requested provider is available and active in the session;
- the real Kim graph loads and completes at least two separations;
- every output is finite, non-empty, non-silent, stereo 44.1 kHz and within
  100 ms of the fixture duration;
- the ONNX Runtime profile contains at least one node event assigned to the
  requested provider.

The upstream `audio-separator==0.47.0` wheel imports `audioread` but does not
declare it. A clean installation failed at import until `audioread==3.1.0` was
added explicitly. Both the direct dependency file and the complete passing
environment lock preserve that finding.

## B2 Mac/CoreML result

Sanitized machine evidence is committed in
`gpu-feasibility/macos-coreml-2026-09-17.json`. The run used native Python
3.13.7 on Darwin ARM64, Apple M4 Pro with a 16-core GPU and 24 GB unified memory.
It did not run through Rosetta.

CoreML session policy:

- `MLComputeUnits=CPUAndGPU`
- `ModelFormat=MLProgram`
- `RequireStaticInputShapes=0`
- `EnableOnSubgraphs=0`

The ONNX Runtime profile contained six `CoreMLExecutionProvider` node events
covering 1.902778 seconds of model execution and no profiled CPU-provider node
events. This is substantive provider-dispatch proof, not merely provider-list
availability. It does not claim a GPU utilization percentage, and it does not
claim MPS as the ONNX inference provider.

Observed measurements:

| Measurement | Result |
| --- | ---: |
| Cold model load | 10.899 s |
| First end-to-end separation | 7.984 s |
| Warm end-to-end separation | 0.866 s |
| Maximum RSS after load | 989,937,664 bytes |
| Maximum RSS after inference | 1,097,678,848 bytes |
| Output | 8.0 s stereo, 44.1 kHz, PCM 16-bit WAV, finite and non-zero |

The real model artifact was 66,759,214 bytes with SHA-256
`ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b`.
It came from the canonical public UVR model release URL used by
python-audio-separator. The source repository has no license file or useful
redistribution grant, so the artifact is deliberately excluded from Git and
redistribution remains unresolved for a later release gate.

## B3 Windows/DirectML result

Sanitized machine evidence is committed in
`gpu-feasibility/windows-directml-2026-09-17.json` and the independent repeat
`gpu-feasibility/windows-directml-repeat-2026-09-17.json`. The runs used native
Python 3.12.10 on Windows 11 Pro build 26200, an Intel Xeon E5-1660 v3, 24 GB
RAM and a Radeon RX 580 with driver `31.0.21925.1001`.

The isolated environment contained only `onnxruntime-directml==1.24.4` as its
ONNX Runtime distribution. The instrumented session used explicit DirectML
device ID 0 followed by the CPU fallback provider, `ORT_SEQUENTIAL` execution
and disabled memory patterns. The ONNX Runtime profile assigned all 672 node
events to `DmlExecutionProvider`, covering 0.283309 seconds, with no profiled
CPU-provider node events. Provider availability alone was not used as proof.

Observed measurements:

| Measurement | Result |
| --- | ---: |
| Cold model load | 17.508 s |
| First end-to-end separation | 16.974 s |
| Warm end-to-end separation | 1.808 s |
| Peak working set after load | 465,854,464 bytes |
| Peak working set after inference | 695,123,968 bytes |
| Output | 8.0 s stereo, 44.1 kHz, PCM 16-bit WAV, finite and non-zero |

Both output runs were byte-identical with SHA-256
`a5a893182f04273f61a77048364813f4dccac3db7a1cb7c07e216b5a2347f6b8`.
The model and fixture identities exactly match B2. Measurements are not treated
as an equivalent cross-platform benchmark: host hardware, provider partitioning
and cold-start behavior differ. A new-process confirmation also passed with 672
DirectML events, 2.120 s model load, 2.375 s first separation, 1.711 s warm
separation and a 711,569,408-byte peak working set; the improvement reflects
machine/provider caches and is not presented as a fresh-machine cold result.

## B4 decision

The accepted feasibility baseline is:

- Mac mini M4/CoreML: Python 3.13, `audio-separator==0.47.0`,
  `onnxruntime==1.30.0` and the complete CoreML lock.
- Windows Z440/RX 580/DirectML: Python 3.12,
  `audio-separator==0.47.0`, `onnxruntime-directml==1.24.4`,
  `torch-directml==0.2.5.dev240914` transitively and the complete DirectML lock.
- Both platforms use the exact Kim Vocal 2 artifact and owned fixture identities
  recorded above.

These pins are inputs to the later runtime branch, not a compatibility promise
for newer packages or other Apple, AMD, NVIDIA, Linux or Windows machines.

## Reproduction

Follow `tools/worker-gpu-feasibility/README.md`. The sanitized proof command was:

```bash
/tmp/musicmute-gpu-feasibility-py313/bin/python \
  tools/worker-gpu-feasibility/probe.py \
  --provider coreml \
  --model-dir /tmp/musicmute-kim-model-cache \
  --output-dir /tmp/musicmute-coreml-probe \
  --report /tmp/musicmute-coreml-probe/report.json
```

Generated WAV files, the model and raw ONNX profile remained in `/tmp`. The
probe reduced the raw profile to provider counts/durations and removed it after
hashing. No hostname, serial number, hardware UUID, username or secret appears
in the committed evidence.

Primary references:

- [ONNX Runtime CoreML provider](https://onnxruntime.ai/docs/execution-providers/CoreML-ExecutionProvider.html)
- [ONNX Runtime DirectML provider](https://onnxruntime.ai/docs/execution-providers/DirectML-ExecutionProvider.html)
- [python-audio-separator upstream](https://github.com/nomadkaraoke/python-audio-separator)
- [Kim Vocal 2 public model asset](https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/Kim_Vocal_2.onnx)

The Windows proof used an isolated directory under `%TEMP%` and this command:

```powershell
$root = "$env:TEMP\musicmute-gpu-feasibility"
& "$root\.venv\Scripts\python.exe" "$root\probe.py" `
  --provider directml `
  --model-dir "$root\models" `
  --output-dir "$root\run-20260917-b3-2" `
  --report "$root\directml-report.json" `
  --directml-device-id 0 `
  --runs 2
```

The SSH endpoint, username, host identity and credentials are not committed.
