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
- The B1 isolated probe and its four focused unit tests pass on native ARM64
  Python 3.13.7.
- The real `Kim_Vocal_2.onnx` graph produced valid output on the M4 Pro, with
  ONNX Runtime profiling assigning six model node events to CoreML and none to
  the CPU provider. See [B evidence](../evidence/B-gpu-feasibility.md).
- The package manifest was refreshed after adding the B evidence; SHA256SUMS
  again covers every package file except itself.

## Not executed or claimed

No RX 580/DirectML inference, Windows SSH access, service installation, actual
S3 integration, listening-quality review, npm publication, signing with
production keys or deployment has occurred. No backend, dashboard, Android or
iOS implementation is part of the feasibility branch.

B3 remains blocked on owner-supplied Windows connection and trusted host-key
details. B4 remains open; Windows support is not claimed. Linux/NVIDIA support
also remains unverified until later actual hardware evidence.

## Source/consistency caveats

Repository inspection was targeted and pinned to the recorded clean-slate/rebuild commit, not a whole-codebase audit. Paths discovered through imports are marked separately in the study map. Missing future host credentials, real performance figures, final compatible package versions and production domains are not fabricated. The chosen optional denoise preset is a documented MVP design decision, not a proven universal quality optimum.
