# W02 execution brief

Read W02's task card, F01 admission/report/evidence, the reviewed W01 report, and
the actual dependency metadata observations before constructing runtime locks.
Candidate labels are not installable environments or hardware qualification.

## Cross-component provider gap found during integration preparation

F01's inventory includes `MIGraphXExecutionProvider`, `OpenVINOExecutionProvider`
and `ArmNNExecutionProvider` in addition to CUDA, DirectML and CoreML. The current
backend `ApprovedWorkerProfile.provider` type and publication verifier in
`backend/src/worker-releases/publication-receipt.ts` only accept the latter three.
The shared contract reflects that current limitation. W02 must align the signed
provider contract and its tests with the actual qualified recipe vocabulary;
otherwise future AMD/Intel/Arm Linux qualification cannot be published at all.

This alignment does not promote a candidate or permit CPU inference. All F01
candidates are currently unavailable. Only reviewed evidence plus exact artifact,
model/runtime, provider configuration and service-context checks can qualify a
recipe. Providers capable of selecting CPU devices must be explicitly configured
and verified for GPU execution, with CPU fallback refused. Do not add an arbitrary
free-form provider acceptance path or trust an accelerator Boolean alone.

## Dependency and artifact facts already established

`dependency-metadata.md` records a Python 3.11 versus NumPy 2.5.3 conflict and no
macOS x64 wheel for the proposed ONNX Runtime 1.24.4. Resolve full platform-specific
locks, including exact Python patch/runtime assets and native dependencies; do not
reuse that unverified candidate combination. Keep one ONNX Runtime distribution
per environment. Do not install into system Python or import GPU dependencies into
the stable launcher.

`model-artifact.md` records the independently measured Kim Vocal 2 SHA-256 and byte
length, plus the remaining redistribution-terms uncertainty. `synthetic-fixture.md`
defines a deterministic smoke fixture; it is not reference vocal-quality evidence
or a long-media capacity measurement. Native reference/service/reboot evidence
remains V01, and unavailable evidence must remain unavailable in published status.

Report exact recipe resolution/install checks separately from actual GPU execution
and boot proof. Coordinate the narrow backend provider-contract edits and tests in
this task's review; no legacy decoder, migration or backfill is needed.

## New local CoreML session evidence

[macOS smoke evidence](macos-coreml-smoke.md) records a successful pinned Kim Vocal
2 model session on an M4 Pro with Python 3.12.13 / ONNX Runtime 1.24.4. A free
dimension override fixes `batch_size=1` without changing the model bytes.
`MLProgram`, `CPUAndGPU`, static shapes and disabled ORT/Python fallback produced
one CoreML execution event; CoreML's compute plan placed all 178 operations on the
GPU. Do not reject a recipe merely because CPU appears in the registered provider
list, or accept it merely because CoreML appears there: inspect actual assignment
and CoreML device placement. The diagnostic does not yet establish full separator
dependencies, audio quality, capacity, service/reboot behavior or signed admission.

[Portable runtime asset observations](portable-runtime-assets.md) contains the
verified CPython archive and binary identity, its nine symlink aliases, an exact
FFmpeg wheel/member usable only as a local test candidate, and verified current
FFmpeg source/signature inputs for native release packaging. Do not turn the old
wheel's wrapper BSD notice into a claim about its GPL-enabled executable, or
promote source-only signature checks into a qualified native binary.
