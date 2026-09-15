# Target dependency metadata inspection

Observed from public PyPI release JSON on 2026-09-13. These are package metadata and wheel-tag checks, not a successful dependency solve, installation, ABI check, GPU run, or redistribution review. All candidates remain unavailable.

## Known candidate corrections for W02

- [NumPy 2.5.3 metadata](https://pypi.org/pypi/numpy/2.5.3/json) requires Python >=3.12 and has no cp311 wheel. Current proposed Python 3.11 + NumPy 2.5.3 candidates are incompatible. W02 must use a fully resolved exact Python 3.12+ runtime or select a compatible older NumPy before packaging; a `3.11` or `3.12` minor-only label is not an immutable interpreter pin.
- [ONNX Runtime 1.24.4 metadata](https://pypi.org/pypi/onnxruntime/1.24.4/json) includes macOS 14+ ARM64 wheels but no macOS x64 wheel. The Intel Mac candidate cannot use this proposed binary recipe. Investigate a separately compatible locked recipe or report the platform unsupported; never fall back silently to CPU.
- [audio-separator 0.47.0 metadata](https://pypi.org/pypi/audio-separator/0.47.0/json) requires NumPy >=2, ONNX weekly, onnx2torch-py313 >=1.6, and Torch >=2.13,<3 on macOS ARM64 (>=2.3,<3 elsewhere). Its `dml` extra also adds torch_directml. Verify the complete transitive solve rather than installing only the five top-level candidate pins.
- Only one ONNX Runtime distribution may own the `onnxruntime` package in a recipe. Avoid CPU and provider-specific extras that overwrite the same module.

## Python 3.12 wheel observations

| Distribution                                                                          | Observed cp312 target wheels                                                       |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| [onnxruntime-directml 1.24.4](https://pypi.org/pypi/onnxruntime-directml/1.24.4/json) | win_amd64                                                                          |
| [onnxruntime 1.24.4](https://pypi.org/pypi/onnxruntime/1.24.4/json)                   | macosx_14_0_arm64; manylinux_2_27/2_28 x86_64 and aarch64; win_amd64 and win_arm64 |
| [onnxruntime-gpu 1.26.0](https://pypi.org/pypi/onnxruntime-gpu/1.26.0/json)           | manylinux_2_27/2_28 x86_64; win_amd64                                              |
| [onnxruntime-openvino 1.22.0](https://pypi.org/pypi/onnxruntime-openvino/1.22.0/json) | manylinux_2_28 x86_64; win_amd64                                                   |

[SoundFile 0.14.0](https://pypi.org/pypi/soundfile/0.14.0/json) publishes `py2.py3` wheels for macOS x64/ARM64, Linux x64/aarch64 and Windows x86/x64/ARM64, as well as a platform-independent wheel. Do not mistakenly treat the absence of a `cp311` filename as absence of Python 3.11 support for a pure-Python wheel tag. A generic wheel may still need native libsndfile provisioning.

Next: resolve and hash all transitive wheels and the exact interpreter per target; check CUDA/cuDNN, ROCm and OpenVINO device dependencies independently; preserve artifact notices; then exercise the exact model under the native service identity. Package metadata alone cannot qualify a recipe.

Additional exact-version observations: ONNX Runtime GPU 1.26.0 declares optional CUDA-12 packages (`nvidia-cuda-nvrtc-cu12`, `nvidia-cuda-runtime-cu12`, `nvidia-cufft-cu12`, `nvidia-curand-cu12`) and optional cuDNN-9 through `nvidia-cudnn-cu12`; these are version ranges, not a lock. [torch-directml 0.2.5.dev240914](https://pypi.org/pypi/torch-directml/0.2.5.dev240914/json) requires exactly Torch 2.4.1 and torchvision 0.19.1. Resolve the DML extra with those constraints and measure its actual NumPy/ONNX/Torch compatibility; do not upgrade Torch independently in a DML recipe.

## Native macOS binary-only solve — 2026-09-14

The [isolated CoreML session](macos-coreml-smoke.md) successfully installed and ran
the model with Python 3.12.13 / ONNX Runtime 1.24.4, but that small environment does
not establish the full audio-separator dependency set.

A subsequent real `uv pip compile` attempt used these exact top-level requirements:

```text
audio-separator==0.47.0
onnxruntime==1.24.4
numpy==2.5.3
soundfile==0.14.0
```

The first cross-platform solve with `--python-platform aarch64-apple-darwin`
implicitly targeted macOS 13 and rejected ONNX Runtime's macOS 14 wheel. This was
a target-configuration failure, not evidence against the successful local session.
The [uv CLI reference](https://docs.astral.sh/uv/reference/cli/) documents the
`MACOSX_DEPLOYMENT_TARGET` override. The corrected command was:

```sh
MACOSX_DEPLOYMENT_TARGET=14.0 uv pip compile /tmp/musicmute-f01-macos-runtime.in --python-version 3.12.13 --python-platform aarch64-apple-darwin --only-binary :all: --no-header --no-annotate
```

That solve exited 1: audio-separator requires `diffq>=0.2` on non-Windows targets,
and none of its available versions had a usable target wheel. The resolver found
CPython 3.6–3.9 wheels for diffq 0.2.1, but no matching CPython 3.12 wheel; other
available versions had no usable wheels. No lock was produced. Local log:
`/tmp/musicmute-f01-macos14-resolve.log`.

W02/H01 must resolve this before claiming a binary-only complete install. Options
to evaluate include building and verifying required wheels during native release
packaging, or a carefully scoped Kim Vocal 2 dependency path that does not need
unrelated model-family dependencies. Do not silently bypass dependency checks or
claim the small CoreML probe proves full separation. No source build or full
separator installation was attempted in this observation.
