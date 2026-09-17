# Worker GPU feasibility probe

This directory is a bounded B1–B4 probe, not worker runtime code. It tests the real
`Kim_Vocal_2.onnx` graph with an owned deterministic fixture and records sanitized
evidence. Models, fixture WAVs, output stems and raw ONNX profiles stay outside Git.

## macOS/CoreML setup

Use native ARM64 Python 3.13. CoreML and DirectML must use separate environments;
never install competing ONNX Runtime distributions together.

```bash
python3.13 -m venv /tmp/musicmute-gpu-feasibility-py313
/tmp/musicmute-gpu-feasibility-py313/bin/python -m pip install --upgrade pip
/tmp/musicmute-gpu-feasibility-py313/bin/python -m pip install \
  -r tools/worker-gpu-feasibility/requirements-coreml.lock.txt

mkdir -p /tmp/musicmute-kim-model-cache
curl --fail --location \
  --output /tmp/musicmute-kim-model-cache/Kim_Vocal_2.onnx \
  https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/Kim_Vocal_2.onnx
echo 'ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b  /tmp/musicmute-kim-model-cache/Kim_Vocal_2.onnx' \
  | shasum -a 256 --check

/tmp/musicmute-gpu-feasibility-py313/bin/python \
  tools/worker-gpu-feasibility/probe.py \
  --provider coreml \
  --model-dir /tmp/musicmute-kim-model-cache \
  --output-dir /tmp/musicmute-coreml-probe \
  --report /tmp/musicmute-coreml-probe/report.json
```

The probe rejects Rosetta/x86, requires the official macOS `onnxruntime` wheel,
sets CoreML to `CPUAndGPU`, records cold and warm runs, validates the WAV output,
and reports provider node events from the ONNX Runtime profile. Provider presence
alone cannot produce `PASS`.

`requirements-coreml.txt` documents the direct dependencies. The lock file is
the complete environment captured from the passing B2 run.

## Windows/DirectML setup

The same script supports `--provider directml --directml-device-id N`, but exact
Windows pins are intentionally not frozen until the probe runs on the real Z440 /
RX 580. The Windows environment must contain only `onnxruntime-directml`, and the
probe enforces sequential execution with memory patterns disabled as required by
DirectML. Do not run B3 without owner-supplied SSH details and normal host-key
verification.

## Tests

```bash
/tmp/musicmute-gpu-feasibility-py313/bin/python -m unittest discover \
  -s tools/worker-gpu-feasibility/tests -p 'test_*.py' -v
```
