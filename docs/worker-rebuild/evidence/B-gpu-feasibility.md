# B1–B4 GPU feasibility evidence

Observed 2026-09-17. This branch is a bounded feasibility spike; it does not add
worker enrollment, queues, supervisors, installers, dashboard pages or services.

## Checkpoint status

| Checkpoint | Status | Evidence |
| --- | --- | --- |
| B1 reproducible harness | PASS | Isolated probe, deterministic owned fixture, output validation, package lock and focused tests are under `tools/worker-gpu-feasibility/`. |
| B2 Mac mini M4/CoreML | PASS | Native ARM64 M4 Pro run produced valid output and six profiled CoreML provider node events with zero profiled CPU provider node events. |
| B3 Z440/RX 580/DirectML | BLOCKED | The owner has not yet supplied the Windows SSH endpoint, user and trusted host-key information. No connection was guessed or scanned. |
| B4 decision and pins | PARTIAL | CoreML pins are frozen. DirectML pins and the two-platform decision remain open until B3 runs or the maintainer explicitly chooses a one-platform MVP. |

The target classifications required by B4 are therefore:

- Mac mini M4/CoreML: `PASS`.
- Windows Z440/RX 580/DirectML: `BLOCKED`.

Windows/DirectML must not be advertised as supported from this evidence.

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

## Required B3 input

To continue safely, the owner must provide the Windows Z440 SSH host or IP,
SSH username and the expected host-key fingerprint (or another trusted
host-key enrollment method). Credentials stay outside Git. Once connected, the
same model and fixture will be used with an explicit DirectML adapter ID; mere
presence of `DmlExecutionProvider` will not pass B3.
