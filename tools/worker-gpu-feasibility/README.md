# Worker GPU feasibility probe

This directory is a bounded B1–B4 probe, not worker runtime code. It tests the real
`Kim_Vocal_2.onnx` graph with an owned deterministic fixture and records sanitized
evidence. Models, fixture WAVs, output stems and raw ONNX profiles stay outside Git.

## macOS UVR-compatible MPS worker setup

The current worker uses native ARM64 Python 3.13, PyTorch MPS, and the
`onnx2torch` module from the frozen `onnx2torch-py313` package. The direct
MP3-in/MP3-out path matches the setup in
[`kim-vocal-2-m4-fast-setup.md`](../../kim-vocal-2-m4-fast-setup.md). Install the
frozen base:

```bash
python3.13 -m venv /tmp/musicmute-mps-py313
/tmp/musicmute-mps-py313/bin/python -m pip install --upgrade pip
/tmp/musicmute-mps-py313/bin/python -m pip install \
  -r tools/worker-gpu-feasibility/requirements-mps-base.lock.txt
```

## Windows/DirectML setup

Use native 64-bit Python 3.12. The passing Z440 environment must contain only
`onnxruntime-directml` as its ONNX Runtime distribution.

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
python -m unittest discover \
  -s tools/worker-gpu-feasibility/tests -p 'test_*.py' -v
```
