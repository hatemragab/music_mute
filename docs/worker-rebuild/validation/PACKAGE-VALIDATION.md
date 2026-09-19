# Package validation record

## Executed during preparation

The following historical checks were completed while preparing the original
documentation package:

- All seven branch task files exist and their ordered checkpoint headings match the manifest and roadmap: **36 unique checkpoints**.
- JSON documents parse; local Markdown links resolve; fenced code blocks are balanced.
- The archived `reference/separate.py` matches the supplied upload byte-for-byte and its documented function line ranges match Python AST locations.
- The original trimmer passed **eight synthetic sample-count cases**. This is not a GPU or refactored-runtime test. See [results](trimmer-reference-tests.json).
- A temporary synthetic Git repository executed all **seven sequential branch/regular-merge/fast-forward milestones**, preserving main and clean-slate. The ignore-pattern regression was also checked. See [Git results](git-workflow-test.json).
- The package directory was checked for expected members, unsafe links, JSON validity, local Markdown links, and content hashes. SHA256SUMS covers all package files except itself.

The package build contains no environment files, credentials, models, audio fixtures, installed dependencies or service binaries. The only Python file is the unchanged user-provided archival reference. Obvious placeholders and synthetic identifiers are intentional documentation, not deployment settings.

## Executed after preparation

- The architecture contracts were reconciled to the clean-slate source, validated,
  reviewed and merged through PR #6.
- The B1 isolated probe and its five focused unit tests pass on native ARM64
  Python 3.13.7.
- The real `Kim_Vocal_2.onnx` graph produced valid output on the M4 Pro, with
  ONNX Runtime profiling assigning six model node events to CoreML and none to
  the CPU provider. See [B evidence](../evidence/B-gpu-feasibility.md).
- The same model and deterministic fixture produced two valid outputs on the
  real Z440/RX 580. The ONNX Runtime profile assigned 672 model node events to
  DirectML and none to the CPU provider; the isolated environment passed
  `pip check` and its full lock was captured.
- The package manifest was refreshed after adding the B evidence; SHA256SUMS
  again covers every package file except itself.
- C1-C6 backend implementation passed formatting, lint, typecheck, tracked
  secret scanning, 107 unit-test files with 727 tests, 22 E2E files with 135
  tests, 12 processing integration tests against isolated local services, and
  a production NestJS build. See [C evidence](../evidence/C-control-plane.md).
- D1 added the standalone worker package and passed protocol drift, formatting,
  lint, typecheck, 10 TypeScript tests, 4 Python IPC tests, production build and
  built-CLI/Python-child handshake checks. See [D evidence](../evidence/D-runtime.md).
- D2 added the four immutable recipe snapshots and safe ordered pipeline. It
  passed 13 Python engine tests, 10 TypeScript tests, 42 focused backend tests,
  the full 729 backend unit and 135 E2E tests under the env-isolated procedure
  recorded in the evidence, reference PCM parity and a real framed M4/CoreML
  Kim-to-MP3 child run. See [D evidence](../evidence/D-runtime.md).

## Not executed or claimed

No worker service installation, live S3 integration, listening-quality review,
npm publication, signing with production keys or deployment has occurred. The
C1-C6 backend and D1-D2 runtime work are locally verified only; dashboard,
Android and iOS were not changed. D3-D6, Linux/NVIDIA and all other hardware
remain unverified until later actual hardware evidence.

## Source/consistency caveats

Repository inspection was targeted and pinned to the recorded clean-slate/rebuild commit, not a whole-codebase audit. Paths discovered through imports are marked separately in the study map. Credentials, production domains and performance claims beyond the two recorded hosts are not fabricated. The chosen optional denoise preset is a documented MVP design decision, not a proven universal quality optimum.
