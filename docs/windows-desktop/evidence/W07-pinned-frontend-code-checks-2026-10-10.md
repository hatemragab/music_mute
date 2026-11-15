# W07 real pinned frontend code-check return

Executed on macOS arm64, 2026-10-10. This closes the three previously unavailable
portable frontend checks. It does not qualify DirectML, test genuine model
inference or install the Windows consumer runtime.

## Dependency authority and execution boundary

A new disposable `/tmp/musicmute-w07-frontend-1791590300385` environment was
created using the existing Worker test interpreter, Python 3.13.7. Installation
used the complete existing
[host-compatible frozen dependency list](../../../tools/worker-gpu-feasibility/requirements-mps-base.lock.txt)
from the official Python package index; project requirements, lockfiles, runtime
roots and the existing `worker/.venv` were unchanged. The real audio-separator
0.47.0, PyTorch 2.14.0, librosa 1.0.0 and ONNX Runtime 1.30.0 packages were
imported. They were not replaced with synthetic success modules.

[The loader tests](../../../worker/engine/tests/test_separator.py) construct the
actual pinned upstream Separator and replace only the MDX model constructor and
discovery/download observations. The verified-model case forbids sockets,
requests and upstream discovery, and checks its temporary directory stays empty.
The direct-loader case compares the application's pinned configuration against
the real upstream loader with injected model metadata. Primary-only math retains
its existing small NumPy/fake-demix fixture. No genuine weights, separation,
DirectML device, ORT model Run or cloud inference was used.

Upstream construction reports this Mac's available MPS/CoreML and CPU library
packages. That report is host frontend inspection, not model execution or
permission for a production Windows CPU fallback. Windows GPU enforcement and
placement remain their separate injected source tests and W34 native acceptance.

## Actual commands and results

- `worker/.venv/bin/python -m venv /tmp/musicmute-w07-frontend-1791590300385`:
  succeeded; only the new disposable test environment was created.
- Its interpreter's isolated pip installation of the exact frozen list succeeded.
  `python -m pip --isolated --disable-pip-version-check check` returned exit 0,
  **no broken requirements**. Every declared installed pin was then compared
  directly with `importlib.metadata.version`: all **65 exact pins** matched.
  Frozen list SHA-256:
  `25ce0d661d0b7df5b58412fdbd1384ce52b080ef5931c8266dd225536f1a5d68`.
- From `worker/engine`, the new interpreter ran
  `python -B -m unittest tests.test_separator -v`: **10/10 passed**, 37.622 seconds,
  final observed loader output at 03:02:58. This includes:
  `test_direct_mdx_configuration_matches_pinned_upstream_loader`,
  `test_primary_only_preserves_vocal_math_without_secondary_pass`, and
  `test_verified_model_load_uses_pinned_metadata_without_network_or_discovery`.
- From `worker`, `MUSICMUTE_PYTHON=/tmp/musicmute-w07-frontend-1791590300385/bin/python
pnpm run test:engine` used the existing dependency preflight and full discovery:
  **131 executed, 130 passed, one existing platform skip**, 6.399 seconds,
  final frontend output at 03:04:05. The skip is the explicit native Windows
  Job Object acceptance case in `test_windows_guardian.py`; it is not a pass.

The earlier seven passes/three import errors are retained as historical evidence
and superseded for these portable checks by this real dependency return. No test
was rewritten, weakened or skipped to conceal the missing packages. The full
suite includes synthetic PCM/codec/DSP and injected provider/guardian/pipeline
fixtures; those do not establish acoustic quality or Windows execution.

## Deferred acceptance

- [ ] Native x64 Windows 10 19045/Windows 11, DXGI/driver/device identity.
- [ ] Real approved model, DirectML placement and zero CPU-model nodes.
- [ ] Actual GPU memory/device loss, multiple adapters and listened output quality.
- [ ] Windows Job/keeper/guardian crash, logon and installed release acceptance.

The [W07 task](../tasks/W07-directml-selection-and-qualification.md) can close its
portable dependency row while every machine-only item remains unchecked. The
disposable interpreter is a code-check input, never an application release input.
