# F01 execution report

**Date:** 2026-09-13
**Result:** Partial — local recipe admission implemented; native qualification pending

## Implemented

- Added a broad 11-profile candidate matrix covering Windows AMD/Intel/NVIDIA
  DirectML, Windows NVIDIA CUDA, Apple Silicon and Intel Mac CoreML, Linux NVIDIA
  CUDA, Linux AMD MIGraphX/ROCm, Linux Intel OpenVINO GPU, Linux ARM64 Arm NN, and
  Windows ARM64 Qualcomm DirectML.
- Recorded proposed exact dependency versions where an upstream binary line is
  known, explicit driver constraints, required evidence checks, and a reason for
  every unavailable family. Source-build or wheel-availability uncertainty remains
  explicit rather than disguised as a locked recipe.
- Added a pure-Python manifest loader that rejects duplicates and qualified entries
  without exact SHA-256 identities.
- Added fail-closed admission that binds profile/provider/runtime/model/fixture
  to a trusted-store `ApprovedEvidenceRecord`,
  rejects CPU-only and partial neural-graph acceleration, rejects invalid or
  nonfinite output and failed reference comparisons, and requires duration, host
  memory, cancellation, and bounded long-clip evidence.
- Added a separate contract-shaped runtime-report matcher; wire self-attestation
  cannot promote a recipe or establish offline profiling evidence.
- Documented isolated ONNX Runtime environments, upstream provider constraints,
  native evidence fields, and the distinction between GPU-memory `null` and zero.

## Test-first evidence

The qualification tests were written before production code. The initial command
failed with `ModuleNotFoundError: No module named 'qualification'`, confirming the
new API did not exist. Review regressions then failed until strict approval,
schema, evidence, and ARM64 coverage were implemented. The final command passed
all 16 tests:

```sh
PYTHONPATH=worker python3 -m unittest discover -s worker/tests/qualification -p 'test_recipe_manifest.py' -v
```

The passing cases cover required family inventory including Linux ARM64 NVIDIA,
duplicate IDs, strict schema, exact qualified pins, fail-closed status, approval
binding, complete evidence admission, provider and digest mismatch,
CPU-only inference, partial neural inference execution, invalid/nonfinite/reference
failure, unsafe memory, contradictory service evidence, cancellation, long clips,
and the exact wire-report boundary.

## Research and compatibility findings

Primary ONNX Runtime documentation confirms that provider availability represents
a candidate execution provider and that graph partitioning assigns supported
subgraphs. Therefore provider lists and a Boolean accelerator flag are insufficient.
DirectML is broad across DirectX 12 Windows devices but has session constraints;
CoreML may choose CPU/GPU/ANE; CUDA versions are tied to CUDA/cuDNN major lines;
MIGraphX wheels are tied to ROCm; OpenVINO must explicitly target a GPU.

`python3 -m pip index versions audio-separator` on this macOS/Python 3.14 host
confirmed `audio-separator==0.47.0`. Provider-specific ONNX Runtime index commands
returned no matching distribution on this host, which is architecture/interpreter
specific and is not treated as proof that Windows/Linux wheels are absent. Each
candidate requires isolated resolution on its target OS/architecture.

## Unresolved gates

- The upstream Kim Vocal 2 asset identity is independently recorded in
  `model-artifact.md`: 66,759,214 bytes with SHA-256
  `ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b`.
  Candidate entries now bind that digest. Redistribution permission/notices,
  deterministic synthetic fixture, representative clips, measured reference
  tolerance, and dependency locks remain actionable F01/W02 steps. The verified
  model identity alone does not qualify any recipe.
- No target GPU was exercised. There are no graph profiles, cold/warm timings,
  output comparisons, peak-memory observations, cancellation runs, or bounded
  long-clip runs tied to these profiles.
- There is no native service-context or unattended-reboot proof for any candidate.
- Redistribution provenance and required notices must be reviewed against the exact
  downloaded model and runtime artifacts before packaging.

F01 must remain incomplete. W02/B05 can consume the strict schema and validator,
while V01 must supply native evidence before any profile changes to `qualified`.

## Review fix round 2

Regression tests were added before implementation. The red run reproduced the
remaining review findings: the runtime matcher did not accept a trusted approval
record, malformed candidate/approval/policy values raised `TypeError`, malformed
policy Booleans were admitted, and wire numeric cases reached the old unbounded
API. After the fix, the focused command passes 18 tests.

Runtime matching now requires the same authority-loaded `ApprovedEvidenceRecord`
type as offline qualification and verifies its profile binding. A digest string
cannot cross that boundary. H01/V01/B05 remain responsible for loading and
authenticating that record; this local code does not invent signing authority.

The validator now checks the exact qualification-policy shape and every nested
scalar before using it. It applies implementation ceilings of 24 hours for a
reported run, 1 TiB for each memory observation, 24 hours for a media-class limit,
10 million profiled neural nodes, and JavaScript's safe-integer ceiling. Booleans,
NaN, infinity, zero/negative values, malformed collections, and huge integers are
rejected. Nullable wire memory remains valid unknown telemetry; an offline policy
may explicitly require measured GPU memory and block promotion when it is null.

The production validator was expanded from dense compound one-line statements to
readable helpers and validation stages. Final checks for this round:

```sh
PYTHONPATH=worker python3 -m unittest discover -s worker/tests/qualification -p 'test_recipe_manifest.py' -v
python3 -m py_compile worker/qualification/__init__.py worker/qualification/admission.py worker/tests/qualification/test_recipe_manifest.py
python3 -m json.tool worker/qualification/candidates.json
git diff --check -- worker/qualification worker/tests/qualification docs/tasks/cross-platform-workers
```

All completed successfully. Native qualification remains unavailable and no
candidate status was promoted.

## Review fix round 3

The final strict-shape regressions failed first for Boolean `schemaVersion`,
malformed/unsupported GPU vendors, provider/vendor mismatch, and integer/string
offline accelerator flags. The validator now requires schema version to be an
exact integer, enforces an allowlisted vendor set for each provider, and requires
all seven offline evidence flags to be exact Booleans before applying policy.
The focused suite now passes 20 tests. The verified upstream model digest was
applied to all 12 unavailable candidates without changing qualification status.
