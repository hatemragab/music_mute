# GPU qualification recipes

`candidates.json` is an inventory, not a support list. A recipe becomes admissible
only after its status is changed to `qualified` with real native evidence and exact
SHA-256 identities for the runtime lock, Kim Vocal 2 model, and public/synthetic
fixture. W02 may package fully specified recipes; V01 owns native qualification.

The packages in one recipe belong in a fresh isolated environment. Never install
`onnxruntime`, `onnxruntime-gpu`, `onnxruntime-directml`, or a provider-specific
ONNX Runtime build together because they expose the same `onnxruntime` module.

## Two records and their trust boundary

Offline qualification evidence is the strict internal record consumed by
`validate_qualification`. It includes the runtime lock, profiling method and neural
node counts, finite/reference metrics, cold/warm timings, resources, cancellation,
long-clip, and service-context results. V01 must authenticate the supplied
`ApprovedEvidenceRecord` from its trusted evidence store; its canonical digest
binds approval to the exact evidence. Editing manifest status is not approval.

The wire `QualificationReport` remains exactly the shape in `contracts.md`.
`validate_runtime_report` matches it to an already-qualified profile and an
authority-loaded `ApprovedEvidenceRecord` bound to that profile. A bare digest
cannot substitute for that record. Nullable wire memory remains unknown. A contributor
report cannot promote a recipe or self-attest runtime-lock, graph, tolerance,
cancellation, or long-clip evidence.

All time, memory, media-limit, profiling-count, and reference values have absolute
implementation ceilings and reject values outside JavaScript's safe-integer range.
Malformed nested values, Booleans used as numbers, NaN, and infinity fail closed.

## Offline admission contract

`validate_qualification(profile, report)` fails closed. It requires:

- an already approved `qualified` manifest entry;
- exact profile, provider, runtime-lock, model, and fixture identity matches;
- provider profiling showing every neural inference node assigned to the declared
  accelerator, rather than provider availability or a Boolean GPU flag;
- finite, structurally valid output within measured reference tolerances;
- positive duration and observed host-memory evidence;
- cancellation and a resource-bounded long-clip result.

GPU memory can remain unavailable when the platform cannot observe it, but that
absence must remain `null`; it must never be reported as zero. If a recipe policy
requires that measurement, null blocks offline promotion. The native runner
must additionally record cold/warm timings and the service/reboot evidence defined
in `BootReport`. Those boot gates are deliberately outside this local admission
function and remain required before jobs can be claimed.

No reference tolerance is encoded yet. It must be measured from the trusted
separation output using the exact fixture/model pair. Bit-identical MP3 bytes are
not required; decoded output must be finite and compared using recorded metrics.

## Upstream constraints used for the candidate inventory

- [ONNX Runtime execution providers](https://onnxruntime.ai/docs/execution-providers/)
  explains graph partitioning and identifies CUDA, DirectML, CoreML, OpenVINO,
  MIGraphX, and Arm NN provider families.
- [DirectML EP](https://onnxruntime.ai/docs/execution-providers/DirectML-ExecutionProvider.html)
  requires DirectX 12 hardware and Windows support; it also requires sequential
  execution with memory patterns disabled.
- [CUDA EP](https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html)
  is the source for the proposed ONNX Runtime, CUDA, and cuDNN major pairing.
- [CoreML EP](https://onnxruntime.ai/docs/execution-providers/CoreML-ExecutionProvider.html)
  documents macOS wheels and platform constraints. Provider presence does not
  prove Apple GPU/ANE rather than CPU allocation.
- [MIGraphX EP](https://onnxruntime.ai/docs/execution-providers/MIGraphX-ExecutionProvider.html)
  documents AMD-hosted Linux wheels and ROCm coupling.
- [OpenVINO EP](https://onnxruntime.ai/docs/execution-providers/OpenVINO-ExecutionProvider.html)
  requires explicitly selecting a GPU device for this use case.
- [audio-separator v0.47.0 provider selection](https://github.com/nomadkaraoke/python-audio-separator/blob/v0.47.0/audio_separator/separator/separator.py)
  is the separator integration baseline already selected by this repository.

These references establish candidates only. Exact wheel availability for each OS,
architecture, and Python version, redistribution notices, driver floors, graph
coverage, output quality, resources, cancellation, service context, and reboot
behavior all require native evidence before qualification.

Run the local contract checks from the repository root:

```sh
PYTHONPATH=worker python3 -m unittest discover -s worker/tests/qualification -p 'test_recipe_manifest.py' -v
```
