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

Use native 64-bit Python 3.12. The passing Z440 environment is frozen separately
from CoreML and must contain only `onnxruntime-directml` as its ONNX Runtime
distribution.

```powershell
$root = "$env:TEMP\musicmute-gpu-feasibility"
py -3.12 -m venv "$root\.venv"
& "$root\.venv\Scripts\python.exe" -m pip install --upgrade pip
& "$root\.venv\Scripts\python.exe" -m pip install `
  -r tools\worker-gpu-feasibility\requirements-directml.lock.txt

New-Item -ItemType Directory -Force "$root\models" | Out-Null
Invoke-WebRequest `
  'https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/Kim_Vocal_2.onnx' `
  -OutFile "$root\models\Kim_Vocal_2.onnx"
if ((Get-FileHash "$root\models\Kim_Vocal_2.onnx").Hash -ne `
    'CE74EF3B6A6024CE44211A07BE9CF8BC6D87728CC852A68AB34EB8E58CDE9C8B') {
  throw 'Kim_Vocal_2.onnx checksum mismatch'
}

& "$root\.venv\Scripts\python.exe" `
  tools\worker-gpu-feasibility\probe.py `
  --provider directml `
  --model-dir "$root\models" `
  --output-dir "$root\output" `
  --report "$root\output\report.json" `
  --directml-device-id 0
```

The probe enforces sequential execution, disables memory patterns, records the
Windows peak working set and requires profiled DirectML node dispatch. Provider
presence alone cannot produce `PASS`. `requirements-directml.txt` documents the
direct dependencies; the lock captures the complete passing B3 environment.

## Tests

```bash
/tmp/musicmute-gpu-feasibility-py313/bin/python -m unittest discover \
  -s tools/worker-gpu-feasibility/tests -p 'test_*.py' -v
```
