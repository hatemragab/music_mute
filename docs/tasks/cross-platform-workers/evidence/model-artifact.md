# Kim Vocal 2 artifact observation

Observed 2026-09-13. This is artifact identity evidence, not model execution, licensing approval, or GPU qualification.

- The [pinned audio-separator v0.47.0 source](https://github.com/nomadkaraoke/python-audio-separator/blob/v0.47.0/audio_separator/separator/separator.py) resolves public UVR models from the TRvlvr model repository.
- The [upstream release API](https://api.github.com/repos/TRvlvr/model_repo/releases/tags/all_public_uvr_models) identifies `Kim_Vocal_2.onnx`, asset ID `108817997`, size `66759214` bytes. Its digest field was null.
- The [upstream model catalog](https://raw.githubusercontent.com/TRvlvr/application_data/main/filelists/download_checks.json) maps “MDX-Net Model: Kim Vocal 2” to that filename.
- Streamed the entire [model asset](https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/Kim_Vocal_2.onnx) through Python SHA-256, counting every byte. Result: `66759214` bytes and SHA-256 `ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b`.
- The model was streamed for hashing and not written into the repository. Later packaging must download it and verify both this byte length and digest before use. A mutable release URL is not itself an immutable identity.

Still required: exact model redistribution permission/notices, full ONNX checker and shape/provider compatibility validation, representative qualification-fixture identities, dependency lock, reference tolerances, and actual GPU/service/boot evidence. Do not mark any candidate qualified from this observation.

## Graph inventory

Downloaded the exact model again and verified both byte length and SHA-256 before inspection. Read its protobuf fields using the [ONNX v1.18.0 schema](https://github.com/onnx/onnx/blob/v1.18.0/onnx/onnx.proto); this was a bounded read-only inventory, not ONNX Runtime execution or the official ONNX checker.

Observed IR version 6, default-domain opset 13, 178 graph nodes, 220 initializers, and no non-default node domain. Operator counts:

| Operator           | Nodes |
| ------------------ | ----: |
| Add                |    11 |
| BatchNormalization |    27 |
| Conv               |    40 |
| ConvTranspose      |     5 |
| MatMul             |    22 |
| Mul                |     5 |
| Relu               |    66 |
| Transpose          |     2 |

W02 must use this model identity when measuring actual provider assignments. Graph optimizations can fuse nodes, so raw counts are inventory and must not be treated as the required count of runtime profiling events. Supported operator names alone do not prove provider execution, acceptable output, resource usage, or service-context availability.

## Notice inspection

The repository-root contents APIs for `TRvlvr/model_repo` and `TRvlvr/application_data` showed no root license, copying, or notice file. The model repository's [README.rd](https://github.com/TRvlvr/model_repo/blob/main/README.rd) contained only `model_repo`. This limited inspection does not establish a model redistribution grant. Inspect the original model author's terms and exact artifact notices before hosting a model copy; do not infer model permissions from the separator program's software license.
