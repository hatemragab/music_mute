# macOS CoreML model-session smoke evidence

Observed 2026-09-14 on the local Apple M4 Pro (16 GPU cores), arm64, macOS
26.6.2 / build 25G83. No launch daemon, worker identity, live job, database or
service configuration was installed or changed. Python packages were resolved in
an isolated `uv` tool environment; system Python was not modified.

This is model-session and compute-plan evidence, **not a qualified installer
recipe**, audio-separation reference comparison, resource capacity result, service
account proof, or unattended boot proof. All candidate admission status remains
unchanged.

## Exact observed runtime

- CPython 3.12.13, ONNX Runtime 1.24.4, ONNX 1.20.1, NumPy 2.5.3.
- Additional resolved distributions: flatbuffers 25.12.19, ml_dtypes 0.6.0,
  mpmath 1.3.0, packaging 26.3, pip 26.0.1, protobuf 7.36.1, sympy 1.14.0,
  typing_extensions 4.16.0.
- Available providers: CoreML, Azure, CPU. Availability is not execution evidence.
- Model: Kim Vocal 2, exactly 66,759,214 bytes and SHA-256
  `ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b`.
  The probe downloaded and verified bytes in memory before model/session loading.
- The official ONNX checker with `full_check=True` passed. Original model input:
  `input`, shape `[batch_size, 4, 3072, 256]`.

These are observed resolved versions, not a complete hash-locked release recipe.
No audio-separator, PyTorch, FFmpeg or full separator environment was installed in
this probe.

## Session settings and result

The [CoreML provider documentation](https://onnxruntime.ai/docs/execution-providers/CoreML-ExecutionProvider.html)
describes `CPUAndGPU` as allowing both compute devices; it is not proof of exclusive
GPU placement. Its `ProfileComputePlan` option exposes per-operation device
placement, which this probe inspected in addition to ONNX Runtime profiling.

The passing session used `ModelFormat=MLProgram`, `MLComputeUnits=CPUAndGPU`,
`RequireStaticInputShapes=1`, `EnableOnSubgraphs=0`, `ProfileComputePlan=1` and a
session free-dimension override of `batch_size=1`. The original model bytes were
not rewritten. ONNX Runtime CPU fallback was disabled through
`session.disable_cpu_ep_fallback=1`; Python runtime fallback was also disabled.

- Session construction: 0.682 seconds in this observation.
- One zero-valued float32 tensor inference: 1.397 seconds.
- Output shape `[1, 4, 3072, 256]`, all values finite.
- ONNX Runtime profiling: one fused CoreML execution event, zero CPU-provider
  execution events.
- CoreML compute plan: 178 operations, all assigned to `MLGPUComputeDevice`
  Apple M4 Pro: 40 conv, 66 relu, 2 transpose, 22 matmul, 27 batch_norm, 11 add,
  5 conv_transpose and 5 mul.

These single-run timings are not a benchmark or safe concurrency/media limit.
Compute-plan placement and one synthetic inference do not establish quality or
coverage across real audio lengths, service contexts or other Macs.

## Initial probe correction

The first probe left the symbolic batch unbounded. CoreML emitted an unbounded
input-dimension diagnostic. That probe then stopped before inference because its
overly strict assertion rejected `CPUExecutionProvider` appearing in the registered
provider list. Registered providers are not node placement. The corrected probe
uses a static batch-one override, disables fallback, and checks actual profiling
and compute-plan placement. It does not enable CPU inference to get a passing run.

## Reproduction and evidence

[Probe source](coreml-session-probe.py) is a diagnostic fixture, not installer code.
From the repository root, the executed command used the same script bytes at
`/tmp/musicmute-f01-coreml-probe.py`:

```sh
uv run --no-project --python 3.12 --with onnxruntime==1.24.4 --with onnx==1.20.1 python /tmp/musicmute-f01-coreml-probe.py > /tmp/musicmute-f01-coreml-static-probe.log 2>&1
```

The saved source can be run directly at its repository path with the same options.
The successful process exited 0. Local verbose log:
`/tmp/musicmute-f01-coreml-static-probe.log`, SHA-256
`a3401645859e22c9078e5c6f76b9a151a6bbcc3eae4c8d01f464ad614bf23e92`.
Runtime profile: `/tmp/musicmute-f01-coreml-profile_2026-09-14_01-42-32.json`.
The model binary and verbose logs were not copied into the repository.

W02 must carry the static batch choice and both placement checks into the full
recipe/qualification design, then verify actual audio output, memory, duration and
native service operation. W01's unchanged DirectML separator is not made portable
by this diagnostic alone. Model redistribution terms remain unresolved.
